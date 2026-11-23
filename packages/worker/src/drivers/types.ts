import type { DeviceReport, Platform, ScreenProfileName, ScreenInfo } from '@lab/shared';

export interface DeviceDriver {
  readonly platform: Platform;
  /** Whether the host can run this driver at all; `reason` is shown to the user when not. */
  check(): Promise<{ ok: boolean; reason?: string }>;
  discover(): Promise<DeviceReport[]>;
  boot(key: string): Promise<{ serial?: string }>;
  shutdown(key: string): Promise<void>;
  /** iOS: path to a .app directory. Android: path to an .apk. */
  install(key: string, appPath: string): Promise<void>;
  uninstall(key: string, appId: string): Promise<void>;
  launch(key: string, appId: string): Promise<void>;
  terminate(key: string, appId: string): Promise<void>;
  screenshot(key: string, outFile: string): Promise<void>;
  logs(key: string, lines: number): Promise<string>;
  /** The id Maestro's --device expects (UDID on iOS, serial on Android). Throws if not booted. */
  maestroDeviceId(key: string): Promise<string>;
  screenProfile?(key: string, profile: ScreenProfileName): Promise<ScreenInfo>;
}
