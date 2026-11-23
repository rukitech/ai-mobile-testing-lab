/**
 * lab - command-line client for the lab server.
 *
 *   npm run lab -- devices
 *   npm run lab -- action <deviceId|name> boot|shutdown|screenshot|screen-profile tablet-10
 *   npm run lab -- build add <path/to/App.app|app.apk> [--name X] [--app-id com.x]
 *   npm run lab -- build distribute <buildId>
 *   npm run lab -- suite add <name> <flow.yaml>
 *   npm run lab -- run <suiteName> --devices "iPhone 16,Pixel 6" [--ios-build id] [--android-build id] [--app-id-ios x] [--app-id-android y]
 *   npm run lab -- watch <runId>
 *   npm run lab -- artifact <artifactId> [outFile]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const server = (process.env.LAB_SERVER_URL ?? 'http://127.0.0.1:4300').replace(/\/$/, '');
const token = process.env.LAB_DASHBOARD_TOKEN ?? '';

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

async function api<T = unknown>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const isBinary = body instanceof Blob;
  const res = await fetch(server + p, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body && !isBinary ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : isBinary ? body : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) die(`${method} ${p} -> HTTP ${res.status} ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

interface Device {
  id: string;
  name: string;
  platform: string;
  os_version: string;
  state: string;
  connected: number;
  screen_w: number | null;
  screen_h: number | null;
  screen_density: number | null;
  lease_holder: string | null;
  worker_name: string;
}

async function resolveDevices(spec: string): Promise<Device[]> {
  const all = await api<Device[]>('GET', '/api/devices');
  return spec.split(',').map((s) => {
    const want = s.trim();
    const exact = all.filter((d) => d.id === want);
    if (exact.length) return exact[0]!;
    // "iPhone 16@18.5" picks an OS version when the name exists on several runtimes.
    const [name, ver] = want.split('@');
    const hits = all.filter((d) => d.connected && d.name.toLowerCase() === name!.toLowerCase() && (!ver || d.os_version.includes(ver)));
    if (hits.length === 0) die(`no connected device named "${want}" (see: npm run lab -- devices)`);
    // Prefer one that is already booted, then the newest OS.
    hits.sort((a, b) => Number(b.state === 'booted') - Number(a.state === 'booted') || b.os_version.localeCompare(a.os_version, undefined, { numeric: true }));
    return hits[0]!;
  });
}

function zipApp(appPath: string): string {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lab-')), `${path.basename(appPath)}.zip`);
  const r = spawnSync('ditto', ['-c', '-k', '--keepParent', appPath, out], { stdio: 'inherit' });
  if (r.status !== 0) die('ditto failed to zip the .app');
  return out;
}

function detectAppId(p: string): string | undefined {
  if (p.endsWith('.app')) {
    const r = spawnSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', path.join(p, 'Info.plist')], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : undefined;
  }
  // aapt2 lives in build-tools/<version>/; pick the newest.
  const bt = path.join(process.env.ANDROID_HOME ?? path.join(os.homedir(), 'Library', 'Android', 'sdk'), 'build-tools');
  if (!fs.existsSync(bt)) return undefined;
  const latest = fs.readdirSync(bt).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  if (!latest) return undefined;
  const r = spawnSync(path.join(bt, latest, 'aapt2'), ['dump', 'packagename', p], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

const [cmd, ...rest] = process.argv.slice(2);
if (!token && cmd !== 'help') die('LAB_DASHBOARD_TOKEN is not set (.env)');

switch (cmd) {
  case 'devices': {
    const devices = await api<Device[]>('GET', '/api/devices');
    const rows = devices
      .filter((d) => d.connected)
      .map((d) => ({
        name: d.name,
        platform: d.platform,
        os: d.os_version,
        state: d.state + (d.lease_holder ? ' (leased)' : ''),
        screen: d.screen_w ? `${d.screen_w}x${d.screen_h} @${d.screen_density}x` : '',
        worker: d.worker_name,
        id: d.id,
      }));
    console.table(rows);
    break;
  }
  case 'action': {
    const [dev, action, arg] = rest;
    if (!dev || !action) die('usage: action <device> <boot|shutdown|restart|screenshot|logs|launch|terminate|screen-profile> [arg]');
    const [d] = await resolveDevices(dev);
    const args: Record<string, unknown> = {};
    if (action === 'screen-profile') args.profile = arg ?? 'reset';
    if (['launch', 'terminate', 'uninstall'].includes(action)) args.appId = arg;
    if (action === 'install') args.buildId = arg;
    const res = await api<{ data: { artifactId?: string; text?: string } }>('POST', `/api/devices/${encodeURIComponent(d!.id)}/actions/${action}`, { args });
    if (res.data?.artifactId) console.log(`screenshot: ${server}/api/artifacts/${res.data.artifactId}`);
    else if (res.data?.text) console.log(res.data.text);
    else console.log(JSON.stringify(res.data ?? {}, null, 2));
    break;
  }
  case 'build': {
    const [sub, target] = rest;
    if (sub === 'add') {
      if (!target || !fs.existsSync(target)) die('usage: build add <path/to/App.app|app.apk>');
      const abs = path.resolve(target);
      const platform = abs.endsWith('.apk') ? 'android' : abs.endsWith('.app') ? 'ios' : die('expected a .app (iOS simulator) or .apk');
      const appId = flag(rest, 'app-id') ?? detectAppId(abs) ?? die('could not detect the app id; pass --app-id');
      const file = platform === 'ios' ? zipApp(abs) : abs;
      const name = flag(rest, 'name') ?? `${path.basename(abs)} ${new Date().toISOString().slice(0, 16)}`;
      const build = await api<{ id: string }>('POST', '/api/builds', await fs.openAsBlob(file), {
        'content-type': 'application/octet-stream',
        'x-build-name': name,
        'x-platform': platform,
        'x-app-id': appId,
        'x-file-name': path.basename(file),
      });
      if (platform === 'ios') fs.rmSync(path.dirname(file), { recursive: true, force: true });
      console.log(JSON.stringify(build, null, 2));
    } else if (sub === 'distribute') {
      if (!target) die('usage: build distribute <buildId>');
      console.log(JSON.stringify(await api('POST', `/api/builds/${target}/distribute`, {}), null, 2));
    } else {
      console.table(await api('GET', '/api/builds'));
    }
    break;
  }
  case 'suite': {
    const [sub, name, file] = rest;
    if (sub === 'add' && name && file) console.log(await api('POST', '/api/suites', { name, flowYaml: fs.readFileSync(file, 'utf8') }));
    else console.table((await api<{ id: string; name: string }[]>('GET', '/api/suites')).map(({ id, name: n }) => ({ id, name: n })));
    break;
  }
  case 'run': {
    const [suiteName] = rest;
    const devicesSpec = flag(rest, 'devices');
    if (!suiteName || !devicesSpec) die('usage: run <suite> --devices "iPhone 16,Pixel 6" [--ios-build id] [--android-build id]');
    const suites = await api<{ id: string; name: string }[]>('GET', '/api/suites');
    const suite = suites.find((s) => s.name === suiteName) ?? die(`suite ${suiteName} not found`);
    const devices = await resolveDevices(devicesSpec);
    const run = await api<{ id: string }>('POST', '/api/runs', {
      suiteId: suite.id,
      deviceIds: devices.map((d) => d.id),
      builds: { ios: flag(rest, 'ios-build'), android: flag(rest, 'android-build') },
      appIds: { ios: flag(rest, 'app-id-ios'), android: flag(rest, 'app-id-android') },
    });
    console.log(`run ${run.id} on: ${devices.map((d) => `${d.name} (${d.os_version})`).join(', ')}`);
    await watch(run.id);
    break;
  }
  case 'watch':
    await watch(rest[0] ?? die('usage: watch <runId>'));
    break;
  case 'artifact': {
    const [id, out] = rest;
    if (!id || !/^[0-9a-f-]{36}$/.test(id)) die('usage: artifact <artifactId> [outFile]');
    const res = await fetch(`${server}/api/artifacts/${id}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) die(`HTTP ${res.status}`);
    const file = out ?? `${id}.${(res.headers.get('content-type') ?? '').includes('png') ? 'png' : 'txt'}`;
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    console.log(file);
    break;
  }
  default:
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
}

async function watch(runId: string) {
  let last = '';
  for (;;) {
    const r = await api<{ run: { status: string }; tasks: { id: string; device_name: string; os_version: string; status: string; error: string | null; duration_ms: number | null }[]; artifacts: { id: string; task_id: string; kind: string; file_name: string }[] }>('GET', `/api/runs/${runId}`);
    const line = r.tasks.map((t) => `${t.device_name}(${t.os_version}): ${t.status}`).join(' | ');
    if (line !== last) {
      console.log(`[${new Date().toLocaleTimeString()}] ${r.run.status.padEnd(9)} ${line}`);
      last = line;
    }
    if (['passed', 'failed', 'error', 'cancelled'].includes(r.run.status)) {
      for (const t of r.tasks) if (t.error) console.log(`  ${t.device_name}: ${t.error}`);
      console.log(`screenshots:`);
      for (const a of r.artifacts.filter((x) => x.kind === 'screenshot')) {
        const t = r.tasks.find((x) => x.id === a.task_id);
        console.log(`  ${a.id}  ${t ? t.device_name : ''}  ${a.file_name}`);
      }
      return;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
}
