/**
 * Worker <-> server wire protocol. The single source of truth: both sides
 * parse every frame with these schemas, and ARCHITECTURE.md §3 documents them.
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const Platform = z.enum(['ios', 'android']);
export type Platform = z.infer<typeof Platform>;

export const Capability = z.enum(['ios', 'android', 'maestro']);
export type Capability = z.infer<typeof Capability>;

export const DeviceState = z.enum(['booted', 'shutdown', 'booting', 'unknown']);
export type DeviceState = z.infer<typeof DeviceState>;

/**
 * Allow-lists for anything that ends up as a CLI argument. Every value is
 * passed as an argv element (never a shell string), and these regexes keep
 * the Windows `.bat` path (which needs a shell) safe as well.
 */
export const SAFE = {
  // iOS UDIDs are UUIDs; AVD names are [A-Za-z0-9._-]; serials like emulator-5554.
  // The first character must be alphanumeric so a value can never be read as a flag (`--wipe-data`).
  deviceKey: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
  serial: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/,
  // Reverse-DNS app/bundle id.
  appId: /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_-]+)+$/,
  envKey: /^[A-Z][A-Z0-9_]{0,63}$/,
  // Env values reach Maestro as `-e KEY=VALUE`; keep them shell-inert.
  envValue: /^[A-Za-z0-9 ._:@/+-]{0,256}$/,
};

export const ScreenInfo = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  density: z.number().positive(),
});
export type ScreenInfo = z.infer<typeof ScreenInfo>;

export const DeviceReport = z.object({
  platform: Platform,
  deviceKey: z.string().regex(SAFE.deviceKey),
  serial: z.string().regex(SAFE.serial).optional(),
  name: z.string().max(200),
  model: z.string().max(200),
  osVersion: z.string().max(50),
  state: DeviceState,
  screen: ScreenInfo.optional(),
});
export type DeviceReport = z.infer<typeof DeviceReport>;

export const ScreenProfileName = z.enum(['phone', 'tablet-7', 'tablet-10', 'reset']);
export type ScreenProfileName = z.infer<typeof ScreenProfileName>;

export const CommandName = z.enum([
  'device.discover',
  'device.boot',
  'device.shutdown',
  'device.restart',
  'device.install',
  'device.uninstall',
  'device.launch',
  'device.terminate',
  'device.screenshot',
  'device.logs',
  'device.screenProfile',
  'device.frame',
  'maestro.run',
]);
export type CommandName = z.infer<typeof CommandName>;

export const ErrorCode = z.enum([
  'TIMEOUT',
  'NOT_FOUND',
  'UNSUPPORTED_PLATFORM',
  'TOOL_MISSING',
  'CHECKSUM_MISMATCH',
  'EXEC_FAILED',
  'BAD_ARGS',
  'LOW_DISK',
  'WORKER_LOST',
  'LEASE_EXPIRED',
  'CANCELLED',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

const Env = z.record(z.string().regex(SAFE.envKey), z.string().regex(SAFE.envValue));

/** Per-command argument schemas. The worker validates `args` against these. */
export const CommandArgs = {
  'device.discover': z.object({}),
  'device.boot': z.object({}),
  'device.shutdown': z.object({}),
  'device.restart': z.object({}),
  'device.install': z.object({ buildId: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  'device.uninstall': z.object({ appId: z.string().regex(SAFE.appId) }),
  'device.launch': z.object({ appId: z.string().regex(SAFE.appId) }),
  'device.terminate': z.object({ appId: z.string().regex(SAFE.appId) }),
  'device.screenshot': z.object({ taskId: z.string().uuid().optional(), label: z.string().regex(/^[a-z0-9-]{1,40}$/).optional() }),
  'device.logs': z.object({ lines: z.number().int().min(1).max(5000).default(300) }),
  'device.screenProfile': z.object({ profile: ScreenProfileName }),
  // Live Wall: capture a small JPEG and POST it to /api/live/frames. Never stored on disk.
  'device.frame': z.object({ maxSize: z.number().int().min(200).max(2000).default(900) }),
  'maestro.run': z.object({
    taskId: z.string().uuid(),
    flowYaml: z.string().min(1).max(200_000),
    appId: z.string().regex(SAFE.appId),
    env: Env.default({}),
  }),
} satisfies Record<CommandName, z.ZodTypeAny>;

// ---------- server -> worker ----------

export const CommandFrame = z.object({
  type: z.literal('command'),
  commandId: z.string().uuid(),
  name: CommandName,
  platform: Platform.optional(),
  deviceKey: z.string().regex(SAFE.deviceKey).optional(),
  args: z.unknown(),
  timeoutMs: z.number().int().positive().max(60 * 60 * 1000),
});
export type CommandFrame = z.infer<typeof CommandFrame>;

export const TokenRefreshedFrame = z.object({
  type: z.literal('token.refreshed'),
  token: z.string(),
  expiresAt: z.string(),
});

export const ServerToWorker = z.discriminatedUnion('type', [CommandFrame, TokenRefreshedFrame]);
export type ServerToWorker = z.infer<typeof ServerToWorker>;

// ---------- worker -> server ----------

export const HelloFrame = z.object({
  type: z.literal('hello'),
  workerId: z.string().uuid(),
  version: z.number().int(),
  os: z.enum(['darwin', 'win32', 'linux']),
  capabilities: z.array(Capability),
});

export const HeartbeatFrame = z.object({
  type: z.literal('heartbeat'),
  at: z.string(),
  load: z.object({ cpus: z.number(), freeMemMb: z.number(), freeDiskMb: z.number().optional() }),
});

export const DevicesReportFrame = z.object({
  type: z.literal('devices.report'),
  devices: z.array(DeviceReport).max(500),
});

export const CommandEventFrame = z.object({
  type: z.literal('command.event'),
  commandId: z.string().uuid(),
  level: z.enum(['info', 'warn', 'error']),
  message: z.string().max(4000),
});

export const CommandResultFrame = z.object({
  type: z.literal('command.result'),
  commandId: z.string().uuid(),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: ErrorCode, message: z.string().max(4000) }).optional(),
});
export type CommandResultFrame = z.infer<typeof CommandResultFrame>;

export const TokenRefreshFrame = z.object({ type: z.literal('token.refresh') });

export const WorkerToServer = z.discriminatedUnion('type', [
  HelloFrame,
  HeartbeatFrame,
  DevicesReportFrame,
  CommandEventFrame,
  CommandResultFrame,
  TokenRefreshFrame,
]);
export type WorkerToServer = z.infer<typeof WorkerToServer>;

// ---------- enrollment ----------

export const RegisterRequest = z.object({
  name: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  os: z.enum(['darwin', 'win32', 'linux']),
  enrollmentSecret: z.string().min(1),
  capabilities: z.array(Capability),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const RegisterResponse = z.object({
  workerId: z.string().uuid(),
  token: z.string(),
  expiresAt: z.string(),
});
export type RegisterResponse = z.infer<typeof RegisterResponse>;

/** Typed error both sides throw/serialize. */
export class LabError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LabError';
  }
}
