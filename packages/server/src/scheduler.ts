import { randomUUID } from 'node:crypto';
import { LabError, type Platform } from '@lab/shared';
import { type Db, audit, defaultProjectId, nowIso, tx } from './db.ts';
import type { Registry, DeviceRow } from './registry.ts';
import type { LeaseManager } from './leases.ts';
import type { WorkerHub } from './workerHub.ts';
import type { EventBus } from './events.ts';
import { type TaskStatus, TERMINAL, canTransition, deriveRunStatus } from './taskState.ts';

export interface CreateRunInput {
  suiteId: string;
  deviceIds: string[];
  builds?: Partial<Record<Platform, string>>;
  appIds?: Partial<Record<Platform, string>>;
  env?: Record<string, string>;
  actor: string;
}

interface TaskRow {
  id: string;
  run_id: string;
  device_id: string;
  build_id: string | null;
  status: TaskStatus;
}

interface BuildRow {
  id: string;
  platform: Platform;
  app_id: string;
  sha256: string;
}

const BOOT_TIMEOUT = 6 * 60_000;
const INSTALL_TIMEOUT = 5 * 60_000;
const MAESTRO_TIMEOUT = 20 * 60_000;

/**
 * Shared-test mode (spec Mode A): one task per device, at most
 * `maxParallel` tasks holding a device lease at once. Durable state lives in
 * test_tasks; this class only holds the in-flight bookkeeping.
 */
export class Scheduler {
  private readonly active = new Map<string, { renewTimer: NodeJS.Timeout }>();
  private readonly cancelledRuns = new Set<string>();
  private sweepTimer?: NodeJS.Timeout;
  private pumping = false;

  constructor(
    private readonly db: Db,
    private readonly registry: Registry,
    private readonly leases: LeaseManager,
    private readonly hub: WorkerHub,
    private readonly bus: EventBus,
    private readonly opts: { maxParallel: number; leaseSeconds: number },
    private readonly log: { error: (o: object, m?: string) => void },
  ) {}

  start(): void {
    // Tasks that were in flight when the server died can't be resumed: the
    // command correlation is gone. Fail them so their run settles.
    const orphaned = this.db
      .prepare("SELECT id, run_id, device_id, build_id, status FROM test_tasks WHERE status IN ('leasing','preparing','running')")
      .all() as unknown as TaskRow[];
    for (const t of orphaned) this.finish(t.id, 'error', 'server restarted while the task was running');
    this.db.prepare("DELETE FROM device_leases WHERE holder LIKE 'task:%'").run();
    this.sweepTimer = setInterval(() => this.sweep(), 10_000);
    this.pump();
  }

  stop(): void {
    clearInterval(this.sweepTimer);
    for (const a of this.active.values()) clearInterval(a.renewTimer);
  }

  createRun(input: CreateRunInput): { id: string } {
    const suite = this.db.prepare('SELECT id FROM test_suites WHERE id = ?').get(input.suiteId);
    if (!suite) throw new LabError('NOT_FOUND', 'suite not found');
    if (input.deviceIds.length === 0) throw new LabError('BAD_ARGS', 'pick at least one device');
    const devices = input.deviceIds.map((id) => {
      const d = this.registry.getDevice(id);
      if (!d) throw new LabError('NOT_FOUND', `device ${id} not found`);
      return d;
    });
    const builds: Partial<Record<Platform, BuildRow>> = {};
    for (const p of ['ios', 'android'] as const) {
      const id = input.builds?.[p];
      if (!id) continue;
      const b = this.db.prepare('SELECT id, platform, app_id, sha256 FROM builds WHERE id = ?').get(id) as BuildRow | undefined;
      if (!b || b.platform !== p) throw new LabError('BAD_ARGS', `build ${id} is not a ${p} build`);
      builds[p] = b;
    }
    for (const d of devices) {
      if (!builds[d.platform] && !input.appIds?.[d.platform]) {
        throw new LabError('BAD_ARGS', `no ${d.platform} build or appId given, but ${d.name} is ${d.platform}`);
      }
    }
    const runId = randomUUID();
    const now = nowIso();
    tx(this.db, () => {
      this.db
        .prepare('INSERT INTO test_runs (id, project_id, suite_id, mode, status, env, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(runId, defaultProjectId(this.db), input.suiteId, 'shared', 'queued', JSON.stringify({ env: input.env ?? {}, appIds: input.appIds ?? {} }), input.actor, now);
      const ins = this.db.prepare(
        'INSERT INTO test_tasks (id, run_id, device_id, build_id, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const d of devices) ins.run(randomUUID(), runId, d.id, builds[d.platform]?.id ?? null, 'queued', now);
    });
    audit(this.db, input.actor, 'run.create', runId, { suiteId: input.suiteId, devices: input.deviceIds, builds: input.builds });
    this.bus.emit({ type: 'run.updated', runId });
    this.pump();
    return { id: runId };
  }

  cancelRun(runId: string, actor: string): void {
    this.cancelledRuns.add(runId);
    const queued = this.db.prepare("SELECT id FROM test_tasks WHERE run_id = ? AND status = 'queued'").all(runId) as { id: string }[];
    for (const t of queued) this.finish(t.id, 'cancelled', 'cancelled by user');
    audit(this.db, actor, 'run.cancel', runId);
    this.refreshRun(runId);
  }

  /** Starts queued tasks while capacity and free devices allow. Re-entrant safe. */
  pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const queued = this.db
        .prepare(
          `SELECT t.id, t.run_id, t.device_id, t.build_id, t.status FROM test_tasks t JOIN test_runs r ON r.id = t.run_id
           WHERE t.status = 'queued' ORDER BY r.created_at, t.rowid`,
        )
        .all() as unknown as TaskRow[];
      for (const task of queued) {
        if (this.active.size >= this.opts.maxParallel) break;
        const device = this.registry.getDevice(task.device_id);
        if (!device || !device.connected || !this.hub.isOnline(device.worker_id)) {
          this.finish(task.id, 'error', 'device is not connected (worker offline or device gone)');
          continue;
        }
        if (!this.setStatus(task.id, 'leasing')) continue;
        const lease = this.leases.acquire(device.id, `task:${task.id}`, task.id);
        if (!lease) {
          // Device busy (another run or a manual action) - try again on the next pump.
          this.setStatus(task.id, 'queued');
          continue;
        }
        const renewTimer = setInterval(() => {
          if (!this.leases.renew(device.id, `task:${task.id}`)) clearInterval(renewTimer);
        }, (this.opts.leaseSeconds * 1000) / 3);
        this.active.set(task.id, { renewTimer });
        void this.runTask(task, device).finally(() => {
          clearInterval(renewTimer);
          this.active.delete(task.id);
          this.leases.release(device.id, `task:${task.id}`);
          this.bus.emit({ type: 'device.updated', deviceId: device.id });
          this.pump();
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  private async runTask(task: TaskRow, device: DeviceRow): Promise<void> {
    const started = Date.now();
    const runId = task.run_id;
    const logLine = (level: string, message: string) => this.bus.emit({ type: 'task.log', runId, taskId: task.id, level, message });
    const ctx = { platform: device.platform, deviceKey: device.device_key };
    const checkpoint = () => {
      if (this.cancelledRuns.has(runId)) throw new LabError('CANCELLED', 'cancelled by user');
      if (TERMINAL.has(this.status(task.id))) throw new LabError('LEASE_EXPIRED', 'task was failed by the lease sweeper');
    };
    try {
      this.db.prepare('UPDATE test_tasks SET started_at = ? WHERE id = ?').run(nowIso(started), task.id);
      if (!this.setStatus(task.id, 'preparing')) return;

      if (device.state !== 'booted') {
        logLine('info', `booting ${device.name}`);
        await this.hub.send(device.worker_id, 'device.boot', {}, { ...ctx, timeoutMs: BOOT_TIMEOUT });
      }
      checkpoint();

      const run = this.db.prepare('SELECT env FROM test_runs WHERE id = ?').get(runId) as { env: string };
      const { env, appIds } = JSON.parse(run.env) as { env: Record<string, string>; appIds: Partial<Record<Platform, string>> };
      let appId = appIds[device.platform];
      if (task.build_id) {
        const build = this.db.prepare('SELECT id, platform, app_id, sha256 FROM builds WHERE id = ?').get(task.build_id) as unknown as BuildRow;
        appId = build.app_id;
        logLine('info', `installing build ${build.id.slice(0, 8)} (${build.app_id})`);
        this.trackInstall(build.id, device.id, 'installing');
        try {
          await this.hub.send(device.worker_id, 'device.install', { buildId: build.id, sha256: build.sha256 }, { ...ctx, timeoutMs: INSTALL_TIMEOUT });
          this.trackInstall(build.id, device.id, 'installed');
        } catch (e) {
          this.trackInstall(build.id, device.id, 'failed', String((e as Error).message));
          throw e;
        }
      }
      checkpoint();
      if (!appId) throw new LabError('BAD_ARGS', 'no appId for this platform');

      const suite = this.db
        .prepare('SELECT s.flow_yaml FROM test_runs r JOIN test_suites s ON s.id = r.suite_id WHERE r.id = ?')
        .get(runId) as { flow_yaml: string };
      if (!this.setStatus(task.id, 'running')) return;
      logLine('info', 'running Maestro flow');
      let exitCode = 1;
      try {
        const res = (await this.hub.send(
          device.worker_id,
          'maestro.run',
          { taskId: task.id, flowYaml: suite.flow_yaml, appId, env: { ...env, APP_ID: appId } },
          { ...ctx, timeoutMs: MAESTRO_TIMEOUT, onEvent: logLine },
        )) as { exitCode: number };
        exitCode = res.exitCode;
      } finally {
        // Always grab a final frame so every device has a comparable image, pass or fail.
        await this.hub
          .send(device.worker_id, 'device.screenshot', { taskId: task.id, label: 'final' }, { ...ctx, timeoutMs: 60_000 })
          .catch((e) => logLine('warn', `final screenshot failed: ${(e as Error).message}`));
      }
      checkpoint();
      this.finish(task.id, exitCode === 0 ? 'passed' : 'failed', exitCode === 0 ? null : `Maestro exited with ${exitCode}`, Date.now() - started);
    } catch (e) {
      const err = e instanceof LabError ? e : new LabError('EXEC_FAILED', String((e as Error)?.message ?? e));
      this.finish(task.id, err.code === 'CANCELLED' ? 'cancelled' : 'error', `${err.code}: ${err.message}`, Date.now() - started);
      if (err.code !== 'CANCELLED') this.log.error({ taskId: task.id, err: err.message }, 'task failed');
    }
  }

  private trackInstall(buildId: string, deviceId: string, status: string, error: string | null = null): void {
    this.db
      .prepare(
        `INSERT INTO build_installs (id, build_id, device_id, status, error, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(build_id, device_id) DO UPDATE SET status = excluded.status, error = excluded.error, updated_at = excluded.updated_at`,
      )
      .run(randomUUID(), buildId, deviceId, status, error, nowIso());
  }

  private status(taskId: string): TaskStatus {
    return (this.db.prepare('SELECT status FROM test_tasks WHERE id = ?').get(taskId) as { status: TaskStatus }).status;
  }

  /** Guarded transition. Returns false (and changes nothing) when it is not allowed, e.g. the task is already terminal. */
  private setStatus(taskId: string, to: TaskStatus): boolean {
    const from = this.status(taskId);
    if (!canTransition(from, to)) return false;
    const res = this.db.prepare('UPDATE test_tasks SET status = ?, updated_at = ? WHERE id = ? AND status = ?').run(to, nowIso(), taskId, from);
    if (Number(res.changes) === 0) return false;
    const { run_id } = this.db.prepare('SELECT run_id FROM test_tasks WHERE id = ?').get(taskId) as { run_id: string };
    this.bus.emit({ type: 'task.updated', runId: run_id, taskId, status: to });
    this.refreshRun(run_id);
    return true;
  }

  private finish(taskId: string, to: TaskStatus, error: string | null, durationMs?: number): void {
    if (!this.setStatus(taskId, to)) return;
    this.db
      .prepare('UPDATE test_tasks SET error = ?, finished_at = ?, duration_ms = COALESCE(?, duration_ms) WHERE id = ?')
      .run(error, nowIso(), durationMs ?? null, taskId);
  }

  private refreshRun(runId: string): void {
    const tasks = (this.db.prepare('SELECT status FROM test_tasks WHERE run_id = ?').all(runId) as { status: TaskStatus }[]).map((t) => t.status);
    const status = deriveRunStatus(tasks, this.cancelledRuns.has(runId));
    const done = TERMINAL.has(status as TaskStatus);
    this.db.prepare('UPDATE test_runs SET status = ?, finished_at = ? WHERE id = ?').run(status, done ? nowIso() : null, runId);
    this.bus.emit({ type: 'run.updated', runId });
  }

  private sweep(): void {
    for (const lease of this.leases.sweepExpired()) {
      if (lease.task_id) this.finish(lease.task_id, 'error', 'LEASE_EXPIRED: device lease ran out (worker or server stalled)');
    }
    this.pump();
  }
}
