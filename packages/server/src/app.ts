import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { LabError, Platform, RegisterRequest, SAFE, ScreenProfileName, type CommandName } from '@lab/shared';
import type { ServerConfig } from './config.ts';
import { type Db, audit, defaultProjectId, nowIso } from './db.ts';
import { Registry } from './registry.ts';
import { LeaseManager } from './leases.ts';
import { EventBus } from './events.ts';
import { WorkerHub } from './workerHub.ts';
import { Scheduler } from './scheduler.ts';
import { FileStore, safeFileName } from './store.ts';
import { LiveFrames } from './live.ts';
import { bearer, safeEqual, signWorkerToken, verifyWorkerToken } from './auth.ts';

const MAX_BUILD_BYTES = 2 * 1024 ** 3;
const MAX_ARTIFACT_BYTES = 200 * 1024 ** 2;
const VERSION = '0.1.0';

const HTTP_STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  BAD_ARGS: 400,
  UNSUPPORTED_PLATFORM: 400,
  WORKER_LOST: 503,
  TIMEOUT: 504,
  LOW_DISK: 507,
};

/** Dashboard device actions -> worker commands, and whether they mutate the device (need the lease). */
const DEVICE_ACTIONS: Record<string, { cmd: CommandName; mutates: boolean; timeoutMs: number }> = {
  boot: { cmd: 'device.boot', mutates: true, timeoutMs: 6 * 60_000 },
  shutdown: { cmd: 'device.shutdown', mutates: true, timeoutMs: 120_000 },
  restart: { cmd: 'device.restart', mutates: true, timeoutMs: 8 * 60_000 },
  install: { cmd: 'device.install', mutates: true, timeoutMs: 5 * 60_000 },
  uninstall: { cmd: 'device.uninstall', mutates: true, timeoutMs: 120_000 },
  launch: { cmd: 'device.launch', mutates: true, timeoutMs: 60_000 },
  terminate: { cmd: 'device.terminate', mutates: true, timeoutMs: 60_000 },
  'screen-profile': { cmd: 'device.screenProfile', mutates: true, timeoutMs: 60_000 },
  screenshot: { cmd: 'device.screenshot', mutates: false, timeoutMs: 60_000 },
  logs: { cmd: 'device.logs', mutates: false, timeoutMs: 60_000 },
};

export interface App {
  fastify: FastifyInstance;
  scheduler: Scheduler;
  live: LiveFrames;
  hub: WorkerHub;
  db: Db;
}

export async function buildApp(cfg: ServerConfig, db: Db, opts: { logger?: boolean } = {}): Promise<App> {
  const fastify = Fastify({
    logger: opts.logger === false ? false : { redact: ['req.headers.authorization', 'enrollmentSecret'] },
    bodyLimit: 1024 * 1024,
  });
  const bus = new EventBus();
  const registry = new Registry(db);
  const leases = new LeaseManager(db, cfg.leaseSeconds);
  const hub = new WorkerHub(registry, bus, cfg.serverSecret, cfg.workerTokenTtlSeconds, fastify.log);
  const scheduler = new Scheduler(db, registry, leases, hub, bus, { maxParallel: cfg.maxParallelTasks, leaseSeconds: cfg.leaseSeconds }, fastify.log);
  const store = new FileStore(cfg.dataDir);
  const live = new LiveFrames(registry, hub, bus);

  // Raw binary bodies (builds, artifacts) are streamed to disk, never buffered.
  fastify.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  fastify.setErrorHandler((err, _req, reply) => {
    if (err instanceof LabError) return reply.code(HTTP_STATUS[err.code] ?? 500).send({ error: err.code, message: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'BAD_ARGS', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) fastify.log.error(err);
    return reply.code(status).send({ error: 'ERROR', message: status >= 500 ? 'internal error' : String((err as Error).message) });
  });

  // ---------- auth ----------
  const requireUser = async (req: FastifyRequest, reply: FastifyReply) => {
    const t = bearer(req.headers.authorization);
    if (!t || !safeEqual(t, cfg.dashboardToken)) return reply.code(401).send({ error: 'UNAUTHORIZED' });
  };
  const workerClaims = (req: FastifyRequest) => {
    const t = bearer(req.headers.authorization);
    return t ? verifyWorkerToken(cfg.serverSecret, t) : null;
  };
  const actor = () => 'dashboard'; // single shared token for now; per-user identities in Phase 3 (SECURITY.md)

  await fastify.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  // ---------- public ----------
  fastify.get('/api/health', async () => ({ ok: true, version: VERSION }));

  // ---------- worker enrollment + socket ----------
  // Failed enrollments per IP per minute - slows down guessing the enrollment secret.
  const failedEnroll = new Map<string, { n: number; resetAt: number }>();
  fastify.post('/api/workers/register', async (req, reply) => {
    const slot = failedEnroll.get(req.ip);
    if (slot && slot.resetAt > Date.now() && slot.n >= 10) return reply.code(429).send({ error: 'TOO_MANY_ATTEMPTS' });
    const body = RegisterRequest.parse(req.body);
    if (!safeEqual(body.enrollmentSecret, cfg.enrollmentSecret)) {
      const cur = slot && slot.resetAt > Date.now() ? slot : { n: 0, resetAt: Date.now() + 60_000 };
      failedEnroll.set(req.ip, { ...cur, n: cur.n + 1 });
      audit(db, `worker:${body.name}`, 'worker.register.denied', null, { ip: req.ip });
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }
    if (body.os !== 'darwin' && body.capabilities.includes('ios')) {
      return reply.code(400).send({ error: 'BAD_ARGS', message: 'iOS capability requires a macOS worker' });
    }
    const w = registry.upsertWorker(body.name, body.os, body.capabilities);
    audit(db, `worker:${body.name}`, 'worker.register', w.id, { os: body.os, capabilities: body.capabilities });
    return { workerId: w.id, ...signWorkerToken(cfg.serverSecret, w.id, cfg.workerTokenTtlSeconds) };
  });

  fastify.get('/ws/worker', { websocket: true }, (socket, req) => {
    const claims = workerClaims(req);
    if (!claims || !registry.getWorker(claims.workerId)) {
      socket.close(4001, 'unauthorized');
      return;
    }
    hub.attach(claims.workerId, claims.exp, socket);
  });

  fastify.get('/ws/dashboard', { websocket: true }, (socket) => {
    let off: (() => void) | undefined;
    const authTimer = setTimeout(() => socket.close(4001, 'auth timeout'), 5000);
    socket.once('message', (raw) => {
      clearTimeout(authTimer);
      let ok = false;
      try {
        const m = JSON.parse(String(raw)) as { type?: string; token?: string };
        ok = m.type === 'auth' && typeof m.token === 'string' && safeEqual(m.token, cfg.dashboardToken);
      } catch {
        /* fallthrough */
      }
      if (!ok) return socket.close(4001, 'unauthorized');
      socket.send(JSON.stringify({ type: 'ready' }));
      off = bus.on((e) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(e)));
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
      off?.();
    });
  });

  // Worker-authenticated file routes.
  fastify.get('/api/builds/:id/file', async (req, reply) => {
    if (!workerClaims(req)) return reply.code(401).send({ error: 'UNAUTHORIZED' });
    const { id } = req.params as { id: string };
    const b = db.prepare('SELECT file_path, file_name FROM builds WHERE id = ?').get(id) as { file_path: string; file_name: string } | undefined;
    if (!b) return reply.code(404).send({ error: 'NOT_FOUND' });
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="${b.file_name}"`);
    return reply.send(fs.createReadStream(b.file_path));
  });

  fastify.post('/api/artifacts', async (req, reply) => {
    const claims = workerClaims(req);
    if (!claims) return reply.code(401).send({ error: 'UNAUTHORIZED' });
    const h = z
      .object({
        'x-kind': z.enum(['screenshot', 'junit', 'log', 'maestro-output']),
        'x-file-name': z.string().min(1).max(200),
        'x-task-id': z.string().uuid().optional(),
        'x-device-key': z.string().regex(SAFE.deviceKey).optional(),
        'x-platform': Platform.optional(),
      })
      .parse(req.headers);
    let runId: string | null = null;
    let deviceId: string | null = null;
    if (h['x-task-id']) {
      // A worker may only attach artifacts to tasks running on its own devices.
      const t = db
        .prepare('SELECT t.run_id, t.device_id, d.worker_id FROM test_tasks t JOIN devices d ON d.id = t.device_id WHERE t.id = ?')
        .get(h['x-task-id']) as { run_id: string; device_id: string; worker_id: string } | undefined;
      if (!t || t.worker_id !== claims.workerId) return reply.code(403).send({ error: 'FORBIDDEN' });
      runId = t.run_id;
      deviceId = t.device_id;
    } else if (h['x-device-key'] && h['x-platform']) {
      deviceId = `${claims.workerId}:${h['x-platform']}:${h['x-device-key']}`;
      if (!registry.getDevice(deviceId)) deviceId = null;
    }
    const id = randomUUID();
    const stored = await store.write(path.join('artifacts', id), h['x-file-name'], req.body as Readable, MAX_ARTIFACT_BYTES);
    db.prepare(
      'INSERT INTO artifacts (id, run_id, task_id, device_id, kind, file_path, file_name, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, runId, h['x-task-id'] ?? null, deviceId, h['x-kind'], stored.filePath, safeFileName(h['x-file-name']), stored.sizeBytes, nowIso());
    bus.emit({ type: 'artifact.created', runId, taskId: h['x-task-id'] ?? null, artifactId: id });
    return { artifactId: id };
  });

  // Live Wall frames: worker -> memory. Never written to disk.
  fastify.post('/api/live/frames', async (req, reply) => {
    const claims = workerClaims(req);
    if (!claims) return reply.code(401).send({ error: 'UNAUTHORIZED' });
    const h = z
      .object({ 'x-device-key': z.string().regex(SAFE.deviceKey), 'x-platform': Platform, 'x-image-type': z.enum(['jpeg', 'png']) })
      .parse(req.headers);
    // The id embeds the worker id, so a worker can only publish frames for its own devices.
    const deviceId = `${claims.workerId}:${h['x-platform']}:${h['x-device-key']}`;
    if (!registry.getDevice(deviceId)) return reply.code(403).send({ error: 'FORBIDDEN' });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req.body as Readable) {
      size += (c as Buffer).length;
      if (size > live.opts.maxFrameBytes) return reply.code(413).send({ error: 'TOO_LARGE' });
      chunks.push(c as Buffer);
    }
    live.put(deviceId, { data: Buffer.concat(chunks), contentType: h['x-image-type'] === 'png' ? 'image/png' : 'image/jpeg', at: Date.now() });
    return { ok: true };
  });

  // ---------- dashboard / CLI API ----------
  await fastify.register(async (api) => {
    api.addHook('onRequest', requireUser);

    api.get('/api/overview', async () => {
      const count = (sql: string, ...args: string[]) => (db.prepare(sql).get(...args) as { n: number }).n;
      return {
        workersOnline: count("SELECT COUNT(*) n FROM workers WHERE status = 'online'"),
        workers: count('SELECT COUNT(*) n FROM workers'),
        devicesConnected: count('SELECT COUNT(*) n FROM devices WHERE connected = 1'),
        devicesBooted: count("SELECT COUNT(*) n FROM devices WHERE connected = 1 AND state = 'booted'"),
        devicesLeased: count('SELECT COUNT(*) n FROM device_leases WHERE expires_at > ?', nowIso()),
        runsActive: count("SELECT COUNT(*) n FROM test_runs WHERE status IN ('queued','running')"),
        builds: count('SELECT COUNT(*) n FROM builds'),
        recentRuns: db
          .prepare('SELECT r.id, r.status, r.created_at, s.name suite FROM test_runs r JOIN test_suites s ON s.id = r.suite_id ORDER BY r.created_at DESC LIMIT 5')
          .all(),
      };
    });

    api.get('/api/workers', async () =>
      registry.listWorkers().map((w) => ({ ...w, capabilities: JSON.parse(w.capabilities), load: w.load ? JSON.parse(w.load) : null, online: hub.isOnline(w.id) })),
    );

    api.get('/api/devices', async (req) => {
      const q = z.object({ platform: Platform.optional(), state: z.string().optional() }).parse(req.query);
      return registry.listDevices(q);
    });

    api.post('/api/devices/:id/actions/:action', async (req, reply) => {
      const { id, action } = req.params as { id: string; action: string };
      const spec = DEVICE_ACTIONS[action];
      if (!spec) return reply.code(404).send({ error: 'NOT_FOUND', message: `unknown action ${action}` });
      const device = registry.getDevice(id);
      if (!device) return reply.code(404).send({ error: 'NOT_FOUND' });
      const body = (req.body ?? {}) as { args?: Record<string, unknown> };
      let args: Record<string, unknown> = body.args ?? {};
      if (action === 'install') {
        const buildId = z.string().uuid().parse(args.buildId);
        const b = db.prepare('SELECT id, platform, sha256 FROM builds WHERE id = ?').get(buildId) as { id: string; platform: string; sha256: string } | undefined;
        if (!b) throw new LabError('NOT_FOUND', 'build not found');
        if (b.platform !== device.platform) throw new LabError('BAD_ARGS', `a ${b.platform} build can't go on a ${device.platform} device`);
        args = { buildId: b.id, sha256: b.sha256 };
      }
      if (action === 'screen-profile') {
        if (device.platform !== 'android') throw new LabError('UNSUPPORTED_PLATFORM', 'screen profiles are Android-only; boot a different iOS simulator model instead');
        args = { profile: ScreenProfileName.parse(args.profile) };
      }
      const holder = `manual:${randomUUID()}`;
      if (spec.mutates && !leases.acquire(device.id, holder)) {
        return reply.code(409).send({ error: 'DEVICE_BUSY', message: 'device is reserved by a running task' });
      }
      try {
        audit(db, actor(), `device.${action}`, device.id, args);
        const data = await hub.send(device.worker_id, spec.cmd, args, { platform: device.platform, deviceKey: device.device_key, timeoutMs: spec.timeoutMs });
        return { ok: true, data };
      } finally {
        if (spec.mutates) leases.release(device.id, holder);
        bus.emit({ type: 'device.updated', deviceId: device.id });
      }
    });

    api.post('/api/workers/:id/discover', async (req) => {
      const { id } = req.params as { id: string };
      return hub.send(id, 'device.discover', {}, { timeoutMs: 60_000 });
    });

    // Builds
    api.get('/api/builds', async () => db.prepare('SELECT id, name, platform, app_id, file_name, size_bytes, sha256, created_at FROM builds ORDER BY created_at DESC').all());

    api.post('/api/builds', async (req) => {
      const h = z
        .object({
          'x-build-name': z.string().min(1).max(120),
          'x-platform': Platform,
          'x-app-id': z.string().regex(SAFE.appId, 'app id must look like com.example.app'),
          'x-file-name': z.string().min(1).max(200),
        })
        .parse(req.headers);
      const fileName = safeFileName(h['x-file-name']);
      if (h['x-platform'] === 'android' && !fileName.endsWith('.apk')) throw new LabError('BAD_ARGS', 'Android builds must be .apk');
      if (h['x-platform'] === 'ios' && !fileName.endsWith('.zip')) throw new LabError('BAD_ARGS', 'iOS simulator builds must be a zipped .app (the CLI does this for you)');
      const id = randomUUID();
      const stored = await store.write(path.join('builds', id), fileName, req.body as Readable, MAX_BUILD_BYTES);
      db.prepare(
        'INSERT INTO builds (id, project_id, name, platform, app_id, file_path, file_name, size_bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, defaultProjectId(db), h['x-build-name'], h['x-platform'], h['x-app-id'], stored.filePath, fileName, stored.sizeBytes, stored.sha256, nowIso());
      audit(db, actor(), 'build.upload', id, { name: h['x-build-name'], platform: h['x-platform'], sha256: stored.sha256 });
      return db.prepare('SELECT id, name, platform, app_id, file_name, size_bytes, sha256, created_at FROM builds WHERE id = ?').get(id);
    });

    // One-click distribution: install on the given (or all compatible, booted) devices in parallel.
    api.post('/api/builds/:id/distribute', async (req) => {
      const { id } = req.params as { id: string };
      const { deviceIds } = z.object({ deviceIds: z.array(z.string()).optional() }).parse(req.body ?? {});
      const b = db.prepare('SELECT id, platform, sha256 FROM builds WHERE id = ?').get(id) as { id: string; platform: Platform; sha256: string } | undefined;
      if (!b) throw new LabError('NOT_FOUND', 'build not found');
      const targets = deviceIds
        ? deviceIds.map((d) => registry.getDevice(d)).filter((d) => d !== undefined)
        : registry.listDevices({ platform: b.platform }).filter((d) => d.connected && d.state === 'booted');
      const results = await Promise.all(
        targets.map(async (d) => {
          if (d.platform !== b.platform) return { deviceId: d.id, ok: false, error: 'platform mismatch' };
          const holder = `manual:${randomUUID()}`;
          if (!leases.acquire(d.id, holder)) return { deviceId: d.id, ok: false, error: 'device busy' };
          try {
            await hub.send(d.worker_id, 'device.install', { buildId: b.id, sha256: b.sha256 }, { platform: d.platform, deviceKey: d.device_key, timeoutMs: 5 * 60_000 });
            return { deviceId: d.id, ok: true };
          } catch (e) {
            return { deviceId: d.id, ok: false, error: (e as Error).message };
          } finally {
            leases.release(d.id, holder);
          }
        }),
      );
      audit(db, actor(), 'build.distribute', b.id, results);
      return { results };
    });

    // Suites
    api.get('/api/suites', async () => db.prepare('SELECT * FROM test_suites ORDER BY name').all());
    api.post('/api/suites', async (req) => {
      const body = z.object({ name: z.string().min(1).max(120), flowYaml: z.string().min(1).max(200_000) }).parse(req.body);
      const id = randomUUID();
      db.prepare(
        `INSERT INTO test_suites (id, project_id, name, flow_yaml, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, name) DO UPDATE SET flow_yaml = excluded.flow_yaml`,
      ).run(id, defaultProjectId(db), body.name, body.flowYaml, nowIso());
      audit(db, actor(), 'suite.save', body.name);
      return db.prepare('SELECT * FROM test_suites WHERE name = ?').get(body.name);
    });

    // Runs
    api.post('/api/runs', async (req) => {
      const body = z
        .object({
          suiteId: z.string().uuid(),
          deviceIds: z.array(z.string()).min(1).max(50),
          builds: z.object({ ios: z.string().uuid().optional(), android: z.string().uuid().optional() }).optional(),
          appIds: z.object({ ios: z.string().regex(SAFE.appId).optional(), android: z.string().regex(SAFE.appId).optional() }).optional(),
          env: z.record(z.string().regex(SAFE.envKey), z.string().regex(SAFE.envValue)).optional(),
        })
        .parse(req.body);
      return scheduler.createRun({ ...body, actor: actor() });
    });
    api.get('/api/runs', async () =>
      db
        .prepare(
          `SELECT r.*, s.name suite_name,
            (SELECT COUNT(*) FROM test_tasks t WHERE t.run_id = r.id) task_count,
            (SELECT COUNT(*) FROM test_tasks t WHERE t.run_id = r.id AND t.status = 'passed') passed_count
           FROM test_runs r JOIN test_suites s ON s.id = r.suite_id ORDER BY r.created_at DESC LIMIT 100`,
        )
        .all(),
    );
    api.get('/api/runs/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const run = db.prepare('SELECT r.*, s.name suite_name FROM test_runs r JOIN test_suites s ON s.id = r.suite_id WHERE r.id = ?').get(id);
      if (!run) return reply.code(404).send({ error: 'NOT_FOUND' });
      const tasks = db
        .prepare(
          `SELECT t.*, d.name device_name, d.platform, d.os_version, d.model, d.screen_w, d.screen_h, d.screen_density
           FROM test_tasks t JOIN devices d ON d.id = t.device_id WHERE t.run_id = ? ORDER BY d.platform, d.name`,
        )
        .all(id);
      const artifacts = db.prepare('SELECT id, task_id, kind, file_name, size_bytes, created_at FROM artifacts WHERE run_id = ? ORDER BY created_at').all(id);
      return { run, tasks, artifacts };
    });
    api.post('/api/runs/:id/cancel', async (req) => {
      const { id } = req.params as { id: string };
      scheduler.cancelRun(id, actor());
      return { ok: true };
    });

    api.post('/api/live/watch', async (req) => {
      const { deviceIds } = z.object({ deviceIds: z.array(z.string().max(300)).max(100) }).parse(req.body);
      live.watch(deviceIds);
      return { intervalMs: live.opts.intervalMs, watchTtlMs: live.opts.watchTtlMs };
    });
    api.get('/api/live/frames/:deviceId', async (req, reply) => {
      const { deviceId } = req.params as { deviceId: string };
      const f = live.get(deviceId);
      if (!f) return reply.code(404).send({ error: 'NOT_FOUND' });
      reply.header('content-type', f.contentType);
      reply.header('cache-control', 'no-store');
      reply.header('x-frame-at', String(f.at));
      return reply.send(f.data);
    });

    api.get('/api/artifacts/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const a = db.prepare('SELECT file_path, file_name, kind FROM artifacts WHERE id = ?').get(id) as { file_path: string; file_name: string; kind: string } | undefined;
      if (!a) return reply.code(404).send({ error: 'NOT_FOUND' });
      const type = a.file_name.endsWith('.png') ? 'image/png' : a.file_name.endsWith('.xml') ? 'application/xml' : 'text/plain; charset=utf-8';
      reply.header('content-type', type);
      reply.header('cache-control', 'private, max-age=86400, immutable');
      return reply.send(fs.createReadStream(a.file_path));
    });
  });

  // Built dashboard (npm run build:dashboard) served from the same origin.
  const dist = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../dashboard/dist');
  if (fs.existsSync(dist)) {
    await fastify.register(fastifyStatic, { root: dist, wildcard: false });
    fastify.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') || req.url.startsWith('/ws/') ? reply.code(404).send({ error: 'NOT_FOUND' }) : reply.sendFile('index.html'),
    );
  }

  return { fastify, scheduler, hub, db, live };
}
