import fs from 'node:fs';
import path from 'node:path';
import { type DeviceReport, LabError, type ScreenInfo } from '@lab/shared';
import { run } from '../exec.ts';
import type { DeviceDriver } from './types.ts';
import { modelFromDeviceType, parseSimctlDevices } from './parsers.ts';

/** iOS Simulator via `xcrun simctl`. macOS only - refuses to run anywhere else. */
export class IosSimDriver implements DeviceDriver {
  readonly platform = 'ios' as const;
  private screenCache = new Map<string, ScreenInfo | null>();

  constructor(private readonly opts: { showSimulatorApp: boolean }) {}

  async check() {
    if (process.platform !== 'darwin') return { ok: false, reason: 'iOS Simulator only runs on macOS' };
    try {
      await run('xcrun', ['simctl', 'help'], { timeoutMs: 20_000 });
      return { ok: true };
    } catch {
      return { ok: false, reason: 'xcrun simctl not available (install Xcode and run xcode-select)' };
    }
  }

  async discover(): Promise<DeviceReport[]> {
    const { stdout } = await run('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { timeoutMs: 30_000 });
    const sims = parseSimctlDevices(stdout);
    const types = await this.deviceTypeBundles();
    return Promise.all(
      sims.map(async (s) => ({
        platform: 'ios' as const,
        deviceKey: s.udid,
        name: s.name,
        model: modelFromDeviceType(s.deviceTypeIdentifier, s.name),
        osVersion: s.osVersion,
        state: s.state,
        screen: (await this.screenFor(s.deviceTypeIdentifier, types)) ?? undefined,
      })),
    );
  }

  /** Screen size lives in the device type bundle's profile.plist, not in `simctl list`. */
  private async deviceTypeBundles(): Promise<Map<string, string>> {
    try {
      const { stdout } = await run('xcrun', ['simctl', 'list', 'devicetypes', '-j'], { timeoutMs: 30_000 });
      const parsed = JSON.parse(stdout) as { devicetypes: { identifier: string; bundlePath?: string }[] };
      return new Map(parsed.devicetypes.filter((t) => t.bundlePath).map((t) => [t.identifier, t.bundlePath!]));
    } catch {
      return new Map();
    }
  }

  private async screenFor(typeId: string, bundles: Map<string, string>): Promise<ScreenInfo | null> {
    if (this.screenCache.has(typeId)) return this.screenCache.get(typeId)!;
    let info: ScreenInfo | null = null;
    const bundle = bundles.get(typeId);
    const plist = bundle ? path.join(bundle, 'Contents', 'Resources', 'profile.plist') : null;
    if (plist && fs.existsSync(plist)) {
      try {
        const { stdout } = await run('plutil', ['-convert', 'json', '-o', '-', plist], { timeoutMs: 10_000 });
        const p = JSON.parse(stdout) as { mainScreenWidth?: number; mainScreenHeight?: number; mainScreenScale?: number };
        if (p.mainScreenWidth && p.mainScreenHeight && p.mainScreenScale) {
          info = { width: p.mainScreenWidth, height: p.mainScreenHeight, density: p.mainScreenScale };
        }
      } catch {
        /* screen info is best-effort */
      }
    }
    this.screenCache.set(typeId, info);
    return info;
  }

  async boot(udid: string) {
    const res = await run('xcrun', ['simctl', 'boot', udid], { timeoutMs: 120_000, allowFailure: true });
    // Exit 149 = "Unable to boot device in current state: Booted" -> already up, fine.
    if (res.code !== 0 && !/current state: Booted/i.test(res.stderr)) {
      throw new LabError('EXEC_FAILED', `simctl boot failed: ${res.stderr.trim().slice(-500)}`);
    }
    await run('xcrun', ['simctl', 'bootstatus', udid, '-b'], { timeoutMs: 5 * 60_000 });
    if (this.opts.showSimulatorApp) await run('open', ['-a', 'Simulator'], { timeoutMs: 20_000, allowFailure: true });
    return {};
  }

  async shutdown(udid: string) {
    const res = await run('xcrun', ['simctl', 'shutdown', udid], { timeoutMs: 120_000, allowFailure: true });
    if (res.code !== 0 && !/current state: Shutdown/i.test(res.stderr)) {
      throw new LabError('EXEC_FAILED', `simctl shutdown failed: ${res.stderr.trim().slice(-500)}`);
    }
  }

  async install(udid: string, appPath: string) {
    if (!appPath.endsWith('.app')) throw new LabError('BAD_ARGS', 'iOS simulator installs need a .app bundle');
    await run('xcrun', ['simctl', 'install', udid, appPath], { timeoutMs: 5 * 60_000 });
  }

  async uninstall(udid: string, appId: string) {
    await run('xcrun', ['simctl', 'uninstall', udid, appId], { timeoutMs: 120_000 });
  }

  async launch(udid: string, appId: string) {
    await run('xcrun', ['simctl', 'launch', udid, appId], { timeoutMs: 60_000 });
  }

  async terminate(udid: string, appId: string) {
    // Non-zero when the app isn't running - that's the desired end state anyway.
    await run('xcrun', ['simctl', 'terminate', udid, appId], { timeoutMs: 60_000, allowFailure: true });
  }

  async screenshot(udid: string, outFile: string) {
    await run('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=png', outFile], { timeoutMs: 60_000 });
  }

  async logs(udid: string, lines: number) {
    const { stdout } = await run('xcrun', ['simctl', 'spawn', udid, 'log', 'show', '--last', '2m', '--style', 'compact'], {
      timeoutMs: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.split('\n').slice(-lines).join('\n');
  }

  async maestroDeviceId(udid: string) {
    const devices = await this.discover();
    const d = devices.find((x) => x.deviceKey === udid);
    if (!d) throw new LabError('NOT_FOUND', `simulator ${udid} not found`);
    if (d.state !== 'booted') throw new LabError('BAD_ARGS', `simulator ${d.name} is not booted`);
    return udid;
  }
}
