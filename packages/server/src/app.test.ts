/**
 * End-to-end over the real HTTP + WebSocket protocol, with a scripted fake
 * worker standing in for simctl/adb/Maestro.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { openDb } from './db.ts';
import { buildApp } from './app.ts';
import type { ServerConfig } from './config.ts';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-e2e-'));
const cfg: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  dataDir,
  serverSecret: 's'.repeat(32),
  dashboardToken: 'dash-token',
  enrollmentSecret: 'enroll-secret',
  maxParallelTasks: 4,
  leaseSeconds: 60,
  workerTokenTtlSeconds: 900,
};
const app = await buildApp(cfg, openDb(':memory:'), { logger: false });
app.scheduler.start();
app.live.start();
await app.fastify.listen({ host: '127.0.0.1', port: 0 });
const addr = app.fastify.server.address() as { port: number };
const base = `http://127.0.0.1:${addr.port}`;

after(async () => {
  app.scheduler.stop();
  app.live.stop();
  app.hub.closeAll();
  await app.fastify.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const api = async (method: string, p: string, body?: unknown, token = cfg.dashboardToken) => {
  const res = await fetch(base + p, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

/** A worker that answers commands from a script. */
async function fakeWorker(name: string, handlers: Record<string, (f: any, token: string) => Promise<unknown>>) {
  const reg = await fetch(`${base}/api/workers/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, os: 'darwin', enrollmentSecret: cfg.enrollmentSecret, capabilities: ['ios', 'android', 'maestro'] }),
  });
  const { workerId, token } = (await reg.json()) as { workerId: string; token: string };
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws/worker`, { headers: { authorization: `Bearer ${token}` } });
  await new Promise((r) => ws.on('open', r));
  const commands: string[] = [];
  ws.on('message', async (raw) => {
    const f = JSON.parse(String(raw));
    if (f.type !== 'command') return;
    commands.push(`${f.name}:${f.deviceKey ?? ''}`);
    try {
      const data = await (handlers[f.name] ?? (async () => ({})))(f, token);
      ws.send(JSON.stringify({ type: 'command.result', commandId: f.commandId, ok: true, data }));
    } catch (e) {
      ws.send(JSON.stringify({ type: 'command.result', commandId: f.commandId, ok: false, error: { code: 'EXEC_FAILED', message: String(e) } }));
    }
  });
  ws.send(JSON.stringify({ type: 'hello', workerId, version: 1, os: 'darwin', capabilities: ['ios', 'android', 'maestro'] }));
  ws.send(
    JSON.stringify({
      type: 'devices.report',
      devices: [
        { platform: 'ios', deviceKey: 'AAAA-1111', name: 'iPhone 16', model: 'iPhone 16', osVersion: '18.5', state: 'booted', screen: { width: 1179, height: 2556, density: 3 } },
        { platform: 'ios', deviceKey: 'BBBB-2222', name: 'iPad Air', model: 'iPad Air', osVersion: '18.5', state: 'shutdown' },
        { platform: 'android', deviceKey: 'Pixel_6', serial: 'emulator-5554', name: 'Pixel 6', model: 'pixel_6', osVersion: 'API 33', state: 'booted' },
      ],
    }),
  );
  await new Promise((r) => setTimeout(r, 100));
  return { workerId, token, ws, commands };
}

const upload = (token: string, taskId: string, name: string) =>
  fetch(`${base}/api/artifacts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'x-kind': 'screenshot', 'x-file-name': name, 'x-task-id': taskId },
    body: Buffer.from('PNGDATA'),
  });

async function waitForRun(id: string, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const r = await api('GET', `/api/runs/${id}`);
    if (['passed', 'failed', 'error', 'cancelled'].includes(r.body.run.status)) return r.body;
    if (Date.now() > deadline) throw new Error(`run still ${r.body.run.status}`);
    await new Promise((res) => setTimeout(res, 50));
  }
}

test('dashboard API requires the bearer token', async () => {
  assert.equal((await api('GET', '/api/devices', undefined, 'wrong')).status, 401);
  assert.equal((await api('GET', '/api/health', undefined, 'wrong')).status, 200);
});

test('enrollment: wrong secret is refused, iOS on a non-mac is refused', async () => {
  const bad = await fetch(`${base}/api/workers/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x', os: 'darwin', enrollmentSecret: 'nope', capabilities: [] }),
  });
  assert.equal(bad.status, 401);
  const winIos = await fetch(`${base}/api/workers/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'win', os: 'win32', enrollmentSecret: cfg.enrollmentSecret, capabilities: ['ios'] }),
  });
  assert.equal(winIos.status, 400);
});

test('worker socket without a valid token is closed with 4001', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws/worker`, { headers: { authorization: 'Bearer forged.token' } });
  const code = await new Promise((r) => ws.on('close', (c) => r(c)));
  assert.equal(code, 4001);
});

test('shared run: same flow on every device, per-device results and screenshots', async () => {
  const w = await fakeWorker('mac-1', {
    'maestro.run': async (f, token) => {
      await upload(token, f.args.taskId, 'launch.png');
      // Android "fails" so we see mixed per-device outcomes.
      return { exitCode: f.platform === 'android' ? 1 : 0, durationMs: 10, artifactIds: [] };
    },
    'device.screenshot': async (f, token) => {
      const r = await upload(token, f.args.taskId, 'final.png');
      return { artifactId: ((await r.json()) as { artifactId: string }).artifactId };
    },
  });

  const devices = (await api('GET', '/api/devices')).body as any[];
  assert.equal(devices.length, 3);
  const ids = devices.map((d) => d.id);

  const suite = (await api('POST', '/api/suites', { name: 'smoke', flowYaml: 'appId: ${APP_ID}\n---\n- launchApp' })).body;
  const missingApp = await api('POST', '/api/runs', { suiteId: suite.id, deviceIds: ids });
  assert.equal(missingApp.status, 400, 'a run needs a build or appId per platform');

  const run = (await api('POST', '/api/runs', { suiteId: suite.id, deviceIds: ids, appIds: { ios: 'com.example.app', android: 'com.example.app' } })).body;
  const done = await waitForRun(run.id);

  const byName = Object.fromEntries(done.tasks.map((t: any) => [t.device_name, t]));
  assert.equal(byName['iPhone 16'].status, 'passed');
  assert.equal(byName['iPad Air'].status, 'passed');
  assert.equal(byName['Pixel 6'].status, 'failed');
  assert.equal(done.run.status, 'failed');
  // Shut-down iPad was booted first; booted devices were not.
  assert.ok(w.commands.includes('device.boot:BBBB-2222'));
  assert.ok(!w.commands.includes('device.boot:AAAA-1111'));
  // launch + final screenshot for each of the 3 devices.
  assert.equal(done.artifacts.filter((a: any) => a.kind === 'screenshot').length, 6);
  // Leases are released afterwards.
  const after = (await api('GET', '/api/devices')).body as any[];
  assert.ok(after.every((d) => d.lease_holder === null));
  w.ws.close();
});

test('a worker cannot attach artifacts to another worker\'s task', async () => {
  const owner = await fakeWorker('mac-owner', {
    'maestro.run': () => new Promise(() => undefined), // hangs: keeps the task running
  });
  const intruder = await fakeWorker('mac-intruder', {});
  const devices = ((await api('GET', '/api/devices')).body as any[]).filter((d) => d.worker_id === owner.workerId && d.platform === 'ios' && d.state === 'booted');
  const suite = (await api('GET', '/api/suites')).body[0];
  const run = (await api('POST', '/api/runs', { suiteId: suite.id, deviceIds: [devices[0].id], appIds: { ios: 'com.example.app' } })).body;
  let taskId = '';
  for (let i = 0; i < 50 && !taskId; i++) {
    const r = (await api('GET', `/api/runs/${run.id}`)).body;
    if (r.tasks[0].status === 'running') taskId = r.tasks[0].id;
    else await new Promise((res) => setTimeout(res, 20));
  }
  assert.ok(taskId);
  assert.equal((await upload(intruder.token, taskId, 'x.png')).status, 403);
  assert.equal((await upload(owner.token, taskId, 'x.png')).status, 200);

  // Device is leased by the running task: a manual mutating action is refused, a screenshot is not.
  assert.equal((await api('POST', `/api/devices/${encodeURIComponent(devices[0].id)}/actions/shutdown`, {})).status, 409);

  // Worker dies mid-task -> task errors with WORKER_LOST and the lease is freed.
  owner.ws.close();
  const done = await waitForRun(run.id);
  assert.equal(done.tasks[0].status, 'error');
  assert.match(done.tasks[0].error, /WORKER_LOST/);
  intruder.ws.close();
});

test('screen profiles are refused for iOS devices', async () => {
  const w = await fakeWorker('mac-3', {});
  const ios = ((await api('GET', '/api/devices')).body as any[]).find((d) => d.worker_id === w.workerId && d.platform === 'ios');
  const r = await api('POST', `/api/devices/${encodeURIComponent(ios.id)}/actions/screen-profile`, { args: { profile: 'tablet-10' } });
  assert.equal(r.status, 400);
  w.ws.close();
});

test('live wall: watched booted devices stream frames through memory; others are never polled', async () => {
  const frameFor = (key: string) => Buffer.from(`JPEG-${key}`);
  const w = await fakeWorker('mac-live', {
    'device.frame': async (f, token) => {
      const r = await fetch(`${base}/api/live/frames`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'x-device-key': f.deviceKey, 'x-platform': f.platform, 'x-image-type': 'jpeg' },
        body: frameFor(f.deviceKey),
      });
      if (!r.ok) throw new Error(`frame upload ${r.status}`);
      return {};
    },
  });
  const mine = ((await api('GET', '/api/devices')).body as any[]).filter((d) => d.worker_id === w.workerId);
  const booted = mine.find((d) => d.device_key === 'AAAA-1111');
  const shutdown = mine.find((d) => d.device_key === 'BBBB-2222');

  assert.equal((await fetch(`${base}/api/live/frames/${encodeURIComponent(booted.id)}`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await api('POST', '/api/live/watch', { deviceIds: [booted.id, shutdown.id] })).status, 200);

  let res: Response | undefined;
  for (let i = 0; i < 40; i++) {
    res = await fetch(`${base}/api/live/frames/${encodeURIComponent(booted.id)}`, { headers: { authorization: `Bearer ${cfg.dashboardToken}` } });
    if (res.status === 200) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(res!.status, 200);
  assert.equal(res!.headers.get('content-type'), 'image/jpeg');
  assert.equal(res!.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await res!.arrayBuffer()), frameFor('AAAA-1111'));
  assert.ok(!w.commands.includes('device.frame:BBBB-2222'), 'shut-down devices are not captured');
  assert.ok(!w.commands.includes('device.frame:Pixel_6'), 'unwatched devices are not captured');

  // Another worker can't publish frames for this worker's devices: the id is derived from its own token.
  const other = await fakeWorker('mac-live-2', {});
  const spoof = await fetch(`${base}/api/live/frames`, {
    method: 'POST',
    headers: { authorization: `Bearer ${other.token}`, 'content-type': 'application/octet-stream', 'x-device-key': 'NOT-MINE', 'x-platform': 'ios', 'x-image-type': 'jpeg' },
    body: Buffer.from('x'),
  });
  assert.equal(spoof.status, 403);

  // Nothing about live frames lands on disk.
  assert.equal(fs.readdirSync(dataDir).includes('live'), false);
  w.ws.close();
  other.ws.close();
});
