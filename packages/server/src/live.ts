import type { Registry } from './registry.ts';
import type { WorkerHub } from './workerHub.ts';
import type { EventBus } from './events.ts';

export interface Frame {
  data: Buffer;
  contentType: 'image/jpeg' | 'image/png';
  at: number;
}

/**
 * Live Wall: the latest frame per device, in memory only. Devices are polled
 * only while some dashboard is watching them (a watch expires after
 * `watchTtlMs` unless renewed), and never more than one capture in flight per
 * device. Nothing here touches the disk - simulator hosts are tight on space.
 */
export class LiveFrames {
  private readonly frames = new Map<string, Frame>();
  private readonly watched = new Map<string, number>(); // deviceId -> watch expiry (epoch ms)
  private readonly inFlight = new Set<string>();
  private readonly lastRequest = new Map<string, number>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly registry: Registry,
    private readonly hub: WorkerHub,
    private readonly bus: EventBus,
    readonly opts: { intervalMs: number; watchTtlMs: number; maxFrameBytes: number } = { intervalMs: 1500, watchTtlMs: 10_000, maxFrameBytes: 15 * 1024 * 1024 },
    private readonly clock: () => number = Date.now,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), 250);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  watch(deviceIds: string[]): void {
    const until = this.clock() + this.opts.watchTtlMs;
    for (const id of deviceIds) this.watched.set(id, until);
  }

  get(deviceId: string): Frame | undefined {
    return this.frames.get(deviceId);
  }

  put(deviceId: string, frame: Frame): void {
    this.frames.set(deviceId, frame);
    this.bus.emit({ type: 'live.frame', deviceId, at: frame.at });
  }

  /** One scheduling pass. Public for tests. */
  tick(): void {
    const now = this.clock();
    for (const [deviceId, until] of this.watched) {
      if (until <= now) {
        this.watched.delete(deviceId);
        this.frames.delete(deviceId); // nobody is looking: free the memory
        continue;
      }
      if (this.inFlight.has(deviceId)) continue;
      if (now - (this.lastRequest.get(deviceId) ?? 0) < this.opts.intervalMs) continue;
      const d = this.registry.getDevice(deviceId);
      if (!d || !d.connected || d.state !== 'booted' || !this.hub.isOnline(d.worker_id)) continue;
      this.inFlight.add(deviceId);
      this.lastRequest.set(deviceId, now);
      this.hub
        .send(d.worker_id, 'device.frame', { maxSize: 900 }, { platform: d.platform, deviceKey: d.device_key, timeoutMs: 20_000 })
        .catch(() => undefined) // a missed frame is fine; the next tick retries
        .finally(() => this.inFlight.delete(deviceId));
    }
  }
}
