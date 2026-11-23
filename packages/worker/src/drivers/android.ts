import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ANDROID_SCREEN_PROFILES, type DeviceReport, LabError, type ScreenInfo, type ScreenProfileName } from '@lab/shared';
import { run, sleep, spawnDetached } from '../exec.ts';
import type { DeviceDriver } from './types.ts';
import { avdInfoFromConfig, parseAdbDevices, parseAvdList, parseIni, parseWmDensity, parseWmSize, pickEmulatorPort } from './parsers.ts';

export function defaultSdkRoot(): string {
  const fromEnv = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (fromEnv) return fromEnv;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Android', 'sdk');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Android', 'Sdk');
  return path.join(os.homedir(), 'Android', 'Sdk');
}

const exe = (p: string) => (process.platform === 'win32' ? `${p}.exe` : p);

/**
 * Android emulators (and, read-only, USB devices) via adb + emulator.
 * Device key = AVD name for emulators (stable), serial for physical devices.
 * Runs on macOS, Windows and Linux.
 */
export class AndroidDriver implements DeviceDriver {
  readonly platform = 'android' as const;
  private readonly adb: string;
  private readonly emulator: string;
  private readonly avdHome: string;

  constructor(private readonly opts: { sdkRoot: string; headless: boolean }) {
    this.adb = exe(path.join(opts.sdkRoot, 'platform-tools', 'adb'));
    this.emulator = exe(path.join(opts.sdkRoot, 'emulator', 'emulator'));
    this.avdHome = process.env.ANDROID_AVD_HOME ?? path.join(os.homedir(), '.android', 'avd');
  }

  async check() {
    if (!fs.existsSync(this.adb)) return { ok: false, reason: `adb not found at ${this.adb} (set ANDROID_HOME)` };
    if (!fs.existsSync(this.emulator)) return { ok: false, reason: `emulator not found at ${this.emulator}` };
    return { ok: true };
  }

  private adbCmd(serial: string, args: string[], timeoutMs = 60_000, allowFailure = false) {
    return run(this.adb, ['-s', serial, ...args], { timeoutMs, allowFailure });
  }

  /** Running emulators mapped serial -> AVD name, plus physical devices. */
  private async running(): Promise<{ serial: string; avd: string | null; state: string }[]> {
    const { stdout } = await run(this.adb, ['devices'], { timeoutMs: 20_000 });
    const devices = parseAdbDevices(stdout);
    return Promise.all(
      devices.map(async (d) => {
        if (!d.isEmulator) return { serial: d.serial, avd: null, state: d.state };
        const res = await this.adbCmd(d.serial, ['emu', 'avd', 'name'], 15_000, true).catch(() => null);
        const avd = res?.stdout.split(/\r?\n/)[0]?.trim() || null;
        return { serial: d.serial, avd, state: d.state };
      }),
    );
  }

  private readAvd(name: string) {
    try {
      const ini = parseIni(fs.readFileSync(path.join(this.avdHome, `${name}.ini`), 'utf8'));
      const dir = ini.path && fs.existsSync(ini.path) ? ini.path : path.join(this.avdHome, `${name}.avd`);
      return avdInfoFromConfig(name, parseIni(fs.readFileSync(path.join(dir, 'config.ini'), 'utf8')));
    } catch {
      return avdInfoFromConfig(name, {});
    }
  }

  private async liveScreen(serial: string): Promise<ScreenInfo | undefined> {
    const [size, dens] = await Promise.all([
      this.adbCmd(serial, ['shell', 'wm', 'size'], 15_000, true),
      this.adbCmd(serial, ['shell', 'wm', 'density'], 15_000, true),
    ]);
    const s = parseWmSize(size.stdout);
    const d = parseWmDensity(dens.stdout);
    return s && d ? { width: s.width, height: s.height, density: d / 160 } : undefined;
  }

  async discover(): Promise<DeviceReport[]> {
    const { stdout } = await run(this.emulator, ['-list-avds'], { timeoutMs: 30_000 });
    const avds = parseAvdList(stdout);
    const live = await this.running();
    const out: DeviceReport[] = [];
    for (const name of avds) {
      const info = this.readAvd(name);
      const r = live.find((l) => l.avd === name);
      const booted = r?.state === 'device' ? await this.isBootCompleted(r.serial) : false;
      let osVersion = info.apiLevel ? `API ${info.apiLevel}` : 'unknown';
      let screen: ScreenInfo | undefined =
        info.width && info.height && info.dpi ? { width: info.width, height: info.height, density: info.dpi / 160 } : undefined;
      if (r && booted) {
        const rel = await this.adbCmd(r.serial, ['shell', 'getprop', 'ro.build.version.release'], 15_000, true);
        if (rel.stdout.trim()) osVersion = `Android ${rel.stdout.trim()}${info.apiLevel ? ` (API ${info.apiLevel})` : ''}`;
        screen = (await this.liveScreen(r.serial)) ?? screen;
      }
      out.push({
        platform: 'android',
        deviceKey: name,
        serial: r?.serial,
        name: info.displayName,
        model: info.model,
        osVersion,
        state: r ? (booted ? 'booted' : 'booting') : 'shutdown',
        screen,
      });
    }
    // Physical devices over USB: reported so they're visible; boot/shutdown don't apply.
    for (const p of live.filter((l) => l.avd === null && l.state === 'device')) {
      const model = (await this.adbCmd(p.serial, ['shell', 'getprop', 'ro.product.model'], 15_000, true)).stdout.trim() || 'Android device';
      const rel = (await this.adbCmd(p.serial, ['shell', 'getprop', 'ro.build.version.release'], 15_000, true)).stdout.trim();
      out.push({ platform: 'android', deviceKey: p.serial, serial: p.serial, name: model, model, osVersion: rel ? `Android ${rel}` : 'unknown', state: 'booted', screen: await this.liveScreen(p.serial) });
    }
    return out;
  }

  private async isBootCompleted(serial: string): Promise<boolean> {
    const res = await this.adbCmd(serial, ['shell', 'getprop', 'sys.boot_completed'], 15_000, true).catch(() => null);
    return res?.stdout.trim() === '1';
  }

  private async serialFor(key: string): Promise<string | null> {
    const live = await this.running();
    return live.find((l) => l.avd === key || (l.avd === null && l.serial === key))?.serial ?? null;
  }

  async boot(avd: string) {
    const existing = await this.serialFor(avd);
    if (existing) {
      await this.waitBooted(existing, 5 * 60_000);
      return { serial: existing };
    }
    if (!parseAvdList((await run(this.emulator, ['-list-avds'], { timeoutMs: 30_000 })).stdout).includes(avd)) {
      throw new LabError('NOT_FOUND', `AVD ${avd} not found`);
    }
    const live = await this.running();
    const port = pickEmulatorPort(live.map((l) => l.serial));
    const serial = `emulator-${port}`;
    // -no-snapshot-load: cold boot (API 36 images hang on snapshot restore often enough to make this the safe default).
    // -no-snapshot-save: otherwise the emulator writes a ~1 GB RAM snapshot when it is killed.
    const args = ['-avd', avd, '-port', String(port), '-no-snapshot-load', '-no-snapshot-save', '-no-boot-anim'];
    if (this.opts.headless) args.push('-no-window');
    spawnDetached(this.emulator, args);
    await run(this.adb, ['-s', serial, 'wait-for-device'], { timeoutMs: 3 * 60_000 });
    await this.waitBooted(serial, 5 * 60_000);
    return { serial };
  }

  private async waitBooted(serial: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isBootCompleted(serial)) return;
      await sleep(2000);
    }
    throw new LabError('TIMEOUT', `${serial} did not finish booting`);
  }

  private async requireSerial(key: string): Promise<string> {
    const s = await this.serialFor(key);
    if (!s) throw new LabError('BAD_ARGS', `${key} is not running - boot it first`);
    return s;
  }

  async shutdown(key: string) {
    const serial = await this.serialFor(key);
    if (!serial) return;
    if (!serial.startsWith('emulator-')) throw new LabError('UNSUPPORTED_PLATFORM', 'cannot shut down a physical device');
    await this.adbCmd(serial, ['emu', 'kill'], 30_000, true);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && (await this.serialFor(key))) await sleep(1000);
  }

  async install(key: string, apk: string) {
    if (!apk.endsWith('.apk')) throw new LabError('BAD_ARGS', 'Android installs need an .apk');
    const res = await this.adbCmd(await this.requireSerial(key), ['install', '-r', '-g', apk], 5 * 60_000, true);
    if (res.code === 0) return;
    const out = res.stdout + res.stderr;
    const down = /INSTALL_FAILED_VERSION_DOWNGRADE.*?(\d+) is older than current (\d+)/.exec(out);
    if (down) {
      throw new LabError('EXEC_FAILED', `device already has a newer build (versionCode ${down[2]}) than this one (${down[1]}). Uninstall the app on the device first (this deletes its data), or upload a newer build.`);
    }
    if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(out)) {
      throw new LabError('EXEC_FAILED', 'the installed app is signed with a different key (e.g. debug vs release). Uninstall it on the device first (this deletes its data).');
    }
    if (/INSUFFICIENT_STORAGE/.test(out)) throw new LabError('LOW_DISK', 'the emulator has no space left for this APK');
    throw new LabError('EXEC_FAILED', `adb install failed: ${out.trim().slice(-600)}`);
  }

  async uninstall(key: string, appId: string) {
    await this.adbCmd(await this.requireSerial(key), ['uninstall', appId], 120_000);
  }

  async launch(key: string, appId: string) {
    const res = await this.adbCmd(await this.requireSerial(key), ['shell', 'monkey', '-p', appId, '-c', 'android.intent.category.LAUNCHER', '1'], 60_000, true);
    if (/No activities found|monkey aborted/i.test(res.stdout + res.stderr)) throw new LabError('NOT_FOUND', `${appId} has no launchable activity (not installed?)`);
  }

  async terminate(key: string, appId: string) {
    await this.adbCmd(await this.requireSerial(key), ['shell', 'am', 'force-stop', appId], 60_000);
  }

  async screenshot(key: string, outFile: string) {
    const serial = await this.requireSerial(key);
    // exec-out would stream binary through stdout; pulling a file keeps the exec layer text-only.
    const remote = '/sdcard/lab-screenshot.png';
    await this.adbCmd(serial, ['shell', 'screencap', '-p', remote], 60_000);
    await this.adbCmd(serial, ['pull', remote, outFile], 60_000);
    await this.adbCmd(serial, ['shell', 'rm', '-f', remote], 15_000, true);
  }

  async logs(key: string, lines: number) {
    const { stdout } = await this.adbCmd(await this.requireSerial(key), ['logcat', '-d', '-t', String(lines)], 60_000);
    return stdout;
  }

  async maestroDeviceId(key: string) {
    const serial = await this.requireSerial(key);
    if (!(await this.isBootCompleted(serial))) throw new LabError('BAD_ARGS', `${key} is still booting`);
    return serial;
  }

  async screenProfile(key: string, profile: ScreenProfileName): Promise<ScreenInfo> {
    const serial = await this.requireSerial(key);
    if (profile === 'reset') {
      await this.adbCmd(serial, ['shell', 'wm', 'size', 'reset']);
      await this.adbCmd(serial, ['shell', 'wm', 'density', 'reset']);
    } else {
      const p = ANDROID_SCREEN_PROFILES[profile];
      await this.adbCmd(serial, ['shell', 'wm', 'size', `${p.width}x${p.height}`]);
      await this.adbCmd(serial, ['shell', 'wm', 'density', String(p.density)]);
    }
    const screen = await this.liveScreen(serial);
    if (!screen) throw new LabError('EXEC_FAILED', 'could not read the screen size back');
    return screen;
  }
}
