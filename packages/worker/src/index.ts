import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {
  type Capability,
  CommandArgs,
  type CommandFrame,
  type DeviceReport,
  LabError,
  type Platform,
  PROTOCOL_VERSION,
  RegisterResponse,
  ServerToWorker,
} from '@lab/shared';
import { IosSimDriver } from './drivers/ios.ts';
import { AndroidDriver, defaultSdkRoot } from './drivers/android.ts';
import type { DeviceDriver } from './drivers/types.ts';
import { defaultMaestroBin, runMaestro } from './maestro.ts';
import { fetchBuild, uploadArtifact, uploadFrame, type ServerLink } from './transfer.ts';
import { run } from './exec.ts';

const LOW_DISK_MB = 3 * 1024;
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

const cfg = {
  serverUrl: (process.env.LAB_SERVER_URL ?? 'http://127.0.0.1:4300').replace(/\/$/, ''),
  name: process.env.LAB_WORKER_NAME ?? os.hostname().replace(/[^A-Za-z0-9._-]/g, '-'),
  enrollmentSecret: process.env.LAB_WORKER_ENROLLMENT_SECRET ?? '',
  // Relative paths resolve against the repo root, not the package npm happened to start in.
  workDir: path.resolve(REPO_ROOT, process.env.LAB_WORKER_DIR ?? './data/worker'),
  headless: process.env.LAB_HEADLESS === '1',
  maestroBin: defaultMaestroBin(),
};
if (!cfg.enrollmentSecret) {
  console.error('LAB_WORKER_ENROLLMENT_SECRET is not set (copy .env.example to .env)');
  process.exit(1);
}
fs.mkdirSync(cfg.workDir, { recursive: true });
const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

// ---------- capabilities ----------
const drivers: Partial<Record<Platform, DeviceDriver>> = {};
const capabilities: Capability[] = [];
{
  const candidates: DeviceDriver[] = [new AndroidDriver({ sdkRoot: defaultSdkRoot(), headless: cfg.headless })];
  if (process.platform === 'darwin') candidates.unshift(new IosSimDriver({ showSimulatorApp: !cfg.headless }));
  for (const d of candidates) {
    const c = await d.check();
    if (c.ok) {
      drivers[d.platform] = d;
      capabilities.push(d.platform);
    } else log(`${d.platform} driver disabled`, { reason: c.reason });
  }
  try {
    await run(cfg.maestroBin, ['--version'], { timeoutMs: 60_000 });
    capabilities.push('maestro');
  } catch (e) {
    log('maestro not available - flows cannot run on this worker', { bin: cfg.maestroBin, err: (e as Error).message });
  }
}

// ---------- session ----------
let token = '';
let workerId = '';
const link: ServerLink = { serverUrl: cfg.serverUrl, token: () => token };
const buildDownloads = new Map<string, Promise<string>>();

async function register(): Promise<void> {
  const res = await fetch(`${cfg.serverUrl}/api/workers/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: cfg.name, os: process.platform, enrollmentSecret: cfg.enrollmentSecret, capabilities }),
  });
  if (!res.ok) throw new Error(`register failed: HTTP ${res.status} ${await res.text()}`);
  const body = RegisterResponse.parse(await res.json());
  token = body.token;
  workerId = body.workerId;
}

async function discoverAll(): Promise<DeviceReport[]> {
  const lists = await Promise.all(
    Object.values(drivers).map((d) =>
      d.discover().catch((e) => {
        log(`${d.platform} discovery failed`, { err: (e as Error).message });
        return [] as DeviceReport[];
      }),
    ),
  );
  return lists.flat();
}

function freeDiskMb(dir: string): number {
  const s = fs.statfsSync(dir);
  return Math.round((s.bavail * s.bsize) / 1024 / 1024);
}

/**
 * Boots run one at a time per worker, each after a fresh disk check. Parallel
 * boots all passed the check at once and then filled the disk together
 * (seen on a real run: 6 GB -> 0.2 GB with four devices).
 */
let bootChain: Promise<unknown> = Promise.resolve();
function guardedBoot(driver: DeviceDriver, key: string, event: (l: 'info' | 'warn' | 'error', m: string) => unknown) {
  const next = bootChain.then(async () => {
    const free = freeDiskMb(cfg.workDir);
    if (free < LOW_DISK_MB) throw new LabError('LOW_DISK', `only ${free} MB disk free on the worker; a boot needs at least ${LOW_DISK_MB} MB`);
    event('info', `booting (${free} MB disk free)`);
    return driver.boot(key);
  });
  bootChain = next.catch(() => undefined);
  return next;
}

// ---------- command execution ----------
async function execute(frame: CommandFrame, socket: WebSocket): Promise<unknown> {
  const event = (level: 'info' | 'warn' | 'error', message: string) =>
    socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'command.event', commandId: frame.commandId, level, message: message.slice(0, 4000) }));

  if (frame.name === 'device.discover') return { devices: await discoverAll() };

  const driver = frame.platform ? drivers[frame.platform] : undefined;
  if (!driver) throw new LabError('UNSUPPORTED_PLATFORM', `this worker has no ${frame.platform ?? '?'} driver`);
  const key = frame.deviceKey;
  if (!key) throw new LabError('BAD_ARGS', 'deviceKey missing');

  switch (frame.name) {
    case 'device.boot':
      return guardedBoot(driver, key, event);
    case 'device.shutdown':
      return driver.shutdown(key);
    case 'device.restart':
      await driver.shutdown(key);
      return guardedBoot(driver, key, event);
    case 'device.install': {
      const a = CommandArgs['device.install'].parse(frame.args);
      // One download per build even when several devices install it at once.
      let p = buildDownloads.get(a.buildId);
      if (!p) {
        p = fetchBuild(link, cfg.workDir, a.buildId, a.sha256, driver.platform);
        buildDownloads.set(a.buildId, p);
        p.catch(() => buildDownloads.delete(a.buildId));
      }
      await driver.install(key, await p);
      return {};
    }
    case 'device.uninstall':
      return driver.uninstall(key, CommandArgs['device.uninstall'].parse(frame.args).appId);
    case 'device.launch':
      return driver.launch(key, CommandArgs['device.launch'].parse(frame.args).appId);
    case 'device.terminate':
      return driver.terminate(key, CommandArgs['device.terminate'].parse(frame.args).appId);
    case 'device.screenshot': {
      const a = CommandArgs['device.screenshot'].parse(frame.args);
      const file = path.join(cfg.workDir, 'shots', `${frame.commandId}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        await driver.screenshot(key, file);
        const artifactId = await uploadArtifact(link, file, {
          kind: 'screenshot',
          taskId: a.taskId,
          deviceKey: key,
          platform: driver.platform,
          fileName: `${a.label ?? 'screenshot'}.png`,
        });
        return { artifactId };
      } finally {
        fs.rmSync(file, { force: true });
      }
    }
    case 'device.frame': {
      const { maxSize } = CommandArgs['device.frame'].parse(frame.args);
      const dir = path.join(cfg.workDir, 'frames');
      fs.mkdirSync(dir, { recursive: true });
      const png = path.join(dir, `${frame.commandId}.png`);
      const jpg = path.join(dir, `${frame.commandId}.jpg`);
      try {
        await driver.screenshot(key, png);
        // macOS ships `sips`: downscale + JPEG turns a 2-5 MB PNG into ~100 KB. Elsewhere send the PNG as is.
        let file = png;
        let imageType: 'jpeg' | 'png' = 'png';
        if (process.platform === 'darwin') {
          await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', '-Z', String(maxSize), png, '--out', jpg], { timeoutMs: 15_000 });
          file = jpg;
          imageType = 'jpeg';
        }
        await uploadFrame(link, file, { deviceKey: key, platform: driver.platform, imageType });
        return {};
      } finally {
        fs.rmSync(png, { force: true });
        fs.rmSync(jpg, { force: true });
      }
    }
    case 'device.logs':
      return { text: await driver.logs(key, CommandArgs['device.logs'].parse(frame.args).lines) };
    case 'device.screenProfile': {
      if (!driver.screenProfile) throw new LabError('UNSUPPORTED_PLATFORM', 'screen profiles are Android-only');
      return driver.screenProfile(key, CommandArgs['device.screenProfile'].parse(frame.args).profile);
    }
    case 'maestro.run': {
      if (!capabilities.includes('maestro')) throw new LabError('TOOL_MISSING', 'Maestro CLI is not installed on this worker');
      const a = CommandArgs['maestro.run'].parse(frame.args);
      const deviceId = await driver.maestroDeviceId(key);
      const workDir = path.join(cfg.workDir, 'tasks', a.taskId);
      try {
        const out = await runMaestro({
          bin: cfg.maestroBin,
          deviceId,
          flowYaml: a.flowYaml,
          env: a.env,
          workDir,
          timeoutMs: frame.timeoutMs,
          onLine: (line) => event('info', line),
        });
        const artifactIds: string[] = [];
        const up = async (file: string, kind: 'screenshot' | 'junit' | 'log', fileName?: string) => {
          try {
            artifactIds.push(await uploadArtifact(link, file, { kind, taskId: a.taskId, fileName }));
          } catch (e) {
            event('warn', `upload of ${path.basename(file)} failed: ${(e as Error).message}`);
          }
        };
        for (const s of out.screenshots) await up(s, 'screenshot');
        for (const f of out.diagnostics) await up(f, 'log', `maestro-${path.basename(f)}`);
        if (out.junitFile) await up(out.junitFile, 'junit');
        await up(out.logFile, 'log');
        return { exitCode: out.exitCode, durationMs: out.durationMs, artifactIds };
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true }); // everything is uploaded; free the disk
      }
    }
    default:
      throw new LabError('BAD_ARGS', `unknown command ${frame.name}`);
  }
}

// ---------- connection loop ----------
let backoff = 1000;
let timers: NodeJS.Timeout[] = [];

async function connect(): Promise<void> {
  try {
    if (!token) await register();
  } catch (e) {
    log('registration failed, retrying', { err: (e as Error).message, inMs: backoff });
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
    return;
  }
  const wsUrl = cfg.serverUrl.replace(/^http/, 'ws') + '/ws/worker';
  const socket = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` }, maxPayload: 1024 * 1024 });
  const send = (o: object) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(o));
  const reportDevices = async () => send({ type: 'devices.report', devices: await discoverAll() });

  socket.on('open', async () => {
    backoff = 1000;
    log('connected', { workerId, capabilities });
    send({ type: 'hello', workerId, version: PROTOCOL_VERSION, os: process.platform, capabilities });
    await reportDevices();
    timers = [
      setInterval(() => send({ type: 'heartbeat', at: new Date().toISOString(), load: { cpus: os.loadavg()[0] ?? 0, freeMemMb: Math.round(os.freemem() / 1048576), freeDiskMb: freeDiskMb(cfg.workDir) } }), 10_000),
      setInterval(() => void reportDevices(), 30_000),
      setInterval(() => send({ type: 'token.refresh' }), 10 * 60_000),
    ];
  });

  socket.on('message', async (raw) => {
    let frame;
    try {
      frame = ServerToWorker.parse(JSON.parse(String(raw)));
    } catch (e) {
      log('ignored invalid server frame', { err: String(e) });
      return;
    }
    if (frame.type === 'token.refreshed') {
      token = frame.token;
      return;
    }
    const started = Date.now();
    const quiet = frame.name === 'device.frame'; // Live Wall polls every ~1.5 s per device
    if (!quiet) log('command', { name: frame.name, deviceKey: frame.deviceKey });
    let timer: NodeJS.Timeout | undefined;
    try {
      const data = await Promise.race([
        execute(frame, socket),
        new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new LabError('TIMEOUT', `${frame.name} exceeded ${frame.timeoutMs} ms`)), frame.timeoutMs))),
      ]);
      send({ type: 'command.result', commandId: frame.commandId, ok: true, data: data ?? {} });
      if (!quiet) log('command ok', { name: frame.name, ms: Date.now() - started });
    } catch (e) {
      const err = e instanceof LabError ? e : new LabError('EXEC_FAILED', (e as Error)?.message ?? String(e));
      send({ type: 'command.result', commandId: frame.commandId, ok: false, error: { code: err.code, message: err.message } });
      log('command failed', { name: frame.name, code: err.code, err: err.message });
    } finally {
      clearTimeout(timer);
    }
    if (['device.boot', 'device.shutdown', 'device.restart', 'device.screenProfile'].includes(frame.name)) void reportDevices();
  });

  socket.on('close', (code, reason) => {
    timers.forEach(clearInterval);
    timers = [];
    if (code === 4001 || code === 4003) token = ''; // expired/invalid session -> enroll again
    log('disconnected, reconnecting', { code, reason: String(reason), inMs: backoff });
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  });
  socket.on('error', (e) => log('socket error', { err: e.message }));
}

log('worker starting', { name: cfg.name, server: cfg.serverUrl, capabilities, maestro: cfg.maestroBin });
void connect();
