/**
 * Pure parsers for tool output, split out so they are unit-tested against
 * captured real output without needing Xcode or the Android SDK.
 */
import { SAFE, type DeviceState } from '@lab/shared';

// ---------- iOS: `xcrun simctl list devices available -j` ----------

export interface SimDevice {
  udid: string;
  name: string;
  state: DeviceState;
  osVersion: string;
  deviceTypeIdentifier: string;
}

export function parseSimctlDevices(json: string): SimDevice[] {
  const parsed = JSON.parse(json) as {
    devices: Record<string, { udid: string; name: string; state: string; isAvailable?: boolean; deviceTypeIdentifier?: string }[]>;
  };
  const out: SimDevice[] = [];
  for (const [runtime, devices] of Object.entries(parsed.devices ?? {})) {
    // com.apple.CoreSimulator.SimRuntime.iOS-18-1 -> 18.1 ; skip watchOS/tvOS/xrOS.
    const m = /SimRuntime\.iOS-(\d+)-(\d+)(?:-(\d+))?$/.exec(runtime);
    if (!m) continue;
    const osVersion = [m[1], m[2], m[3]].filter(Boolean).join('.');
    for (const d of devices) {
      if (d.isAvailable === false || !SAFE.deviceKey.test(d.udid)) continue;
      out.push({
        udid: d.udid,
        name: d.name,
        state: d.state === 'Booted' ? 'booted' : d.state === 'Shutdown' ? 'shutdown' : d.state === 'Booting' ? 'booting' : 'unknown',
        osVersion,
        deviceTypeIdentifier: d.deviceTypeIdentifier ?? '',
      });
    }
  }
  return out;
}

/** com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro -> "iPhone 16 Pro" */
export function modelFromDeviceType(id: string, fallback: string): string {
  const m = /SimDeviceType\.(.+)$/.exec(id);
  return m?.[1] ? m[1].replaceAll('-', ' ') : fallback;
}

// ---------- Android: `adb devices` ----------

export interface AdbDevice {
  serial: string;
  state: string; // device | offline | unauthorized | ...
  isEmulator: boolean;
}

export function parseAdbDevices(text: string): AdbDevice[] {
  return text
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('*'))
    .map((l) => {
      const [serial = '', state = ''] = l.split(/\s+/);
      return { serial, state, isEmulator: /^emulator-\d+$/.test(serial) };
    })
    .filter((d) => SAFE.serial.test(d.serial));
}

/** `emulator -list-avds` may interleave INFO/WARNING lines; keep only plausible AVD names. */
export function parseAvdList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.includes('|') && !/^(INFO|WARNING|ERROR)\b/.test(l) && SAFE.deviceKey.test(l));
}

/** key=value files: <name>.ini and <name>.avd/config.ini */
export function parseIni(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i <= 0 || line.trimStart().startsWith('#')) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export interface AvdInfo {
  displayName: string;
  model: string;
  apiLevel: string | null;
  width: number | null;
  height: number | null;
  dpi: number | null;
}

export function avdInfoFromConfig(name: string, cfg: Record<string, string>): AvdInfo {
  const num = (k: string) => (cfg[k] && /^\d+$/.test(cfg[k]!) ? Number(cfg[k]) : null);
  const api = /android-(\d+(?:\.\d+)?)/.exec(cfg['image.sysdir.1'] ?? '')?.[1] ?? null;
  return {
    displayName: cfg['avd.ini.displayname'] ?? name.replaceAll('_', ' '),
    model: cfg['hw.device.name'] ?? 'Android Emulator',
    apiLevel: api,
    width: num('hw.lcd.width'),
    height: num('hw.lcd.height'),
    dpi: num('hw.lcd.density'),
  };
}

/** `adb shell wm size` -> override if set, else physical. */
export function parseWmSize(text: string): { width: number; height: number } | null {
  const pick = /Override size:\s*(\d+)x(\d+)/.exec(text) ?? /Physical size:\s*(\d+)x(\d+)/.exec(text);
  return pick ? { width: Number(pick[1]), height: Number(pick[2]) } : null;
}

/** `adb shell wm density` -> override if set, else physical. */
export function parseWmDensity(text: string): number | null {
  const pick = /Override density:\s*(\d+)/.exec(text) ?? /Physical density:\s*(\d+)/.exec(text);
  return pick ? Number(pick[1]) : null;
}

/** Lowest even console port in 5554..5682 not used by a running emulator. */
export function pickEmulatorPort(runningSerials: string[]): number {
  const used = new Set(runningSerials.map((s) => Number(/^emulator-(\d+)$/.exec(s)?.[1])).filter(Boolean));
  for (let p = 5554; p <= 5682; p += 2) if (!used.has(p)) return p;
  throw new Error('no free emulator console port');
}
