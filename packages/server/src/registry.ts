import { randomUUID } from 'node:crypto';
import type { Capability, DeviceReport, Platform } from '@lab/shared';
import { type Db, nowIso, tx } from './db.ts';

export interface WorkerRow {
  id: string;
  name: string;
  os: string;
  capabilities: string;
  status: 'online' | 'offline';
  load: string | null;
  last_heartbeat_at: string | null;
  created_at: string;
}

export interface DeviceRow {
  id: string;
  worker_id: string;
  platform: Platform;
  device_key: string;
  serial: string | null;
  name: string;
  model: string;
  os_version: string;
  screen_w: number | null;
  screen_h: number | null;
  screen_density: number | null;
  state: string;
  connected: number;
  last_seen_at: string;
}

export const deviceId = (workerId: string, platform: Platform, key: string) => `${workerId}:${platform}:${key}`;

/** Workers and their devices. Only the server writes here; workers report facts. */
export class Registry {
  constructor(private readonly db: Db) {}

  upsertWorker(name: string, os: string, capabilities: Capability[]): WorkerRow {
    const existing = this.db.prepare('SELECT * FROM workers WHERE name = ?').get(name) as WorkerRow | undefined;
    if (existing) {
      this.db.prepare('UPDATE workers SET os = ?, capabilities = ? WHERE id = ?').run(os, JSON.stringify(capabilities), existing.id);
      return this.getWorker(existing.id)!;
    }
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO workers (id, name, os, capabilities, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name, os, JSON.stringify(capabilities), 'offline', nowIso());
    return this.getWorker(id)!;
  }

  getWorker(id: string): WorkerRow | undefined {
    return this.db.prepare('SELECT * FROM workers WHERE id = ?').get(id) as WorkerRow | undefined;
  }

  listWorkers(): WorkerRow[] {
    return this.db.prepare('SELECT * FROM workers ORDER BY name').all() as unknown as WorkerRow[];
  }

  setWorkerStatus(id: string, status: 'online' | 'offline'): void {
    tx(this.db, () => {
      this.db.prepare('UPDATE workers SET status = ? WHERE id = ?').run(status, id);
      if (status === 'offline') this.db.prepare('UPDATE devices SET connected = 0 WHERE worker_id = ?').run(id);
    });
  }

  heartbeat(id: string, load: unknown): void {
    this.db.prepare("UPDATE workers SET last_heartbeat_at = ?, load = ?, status = 'online' WHERE id = ?").run(nowIso(), JSON.stringify(load), id);
  }

  /**
   * Replaces the worker's device list: upserts every reported device and marks
   * the rest disconnected (kept, not deleted, so run history keeps its FK).
   */
  syncDevices(workerId: string, reports: DeviceReport[]): void {
    const now = nowIso();
    tx(this.db, () => {
      this.db.prepare('UPDATE devices SET connected = 0 WHERE worker_id = ?').run(workerId);
      const upsert = this.db.prepare(`
        INSERT INTO devices (id, worker_id, platform, device_key, serial, name, model, os_version, screen_w, screen_h, screen_density, state, connected, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(id) DO UPDATE SET serial = excluded.serial, name = excluded.name, model = excluded.model,
          os_version = excluded.os_version,
          screen_w = COALESCE(excluded.screen_w, devices.screen_w),
          screen_h = COALESCE(excluded.screen_h, devices.screen_h),
          screen_density = COALESCE(excluded.screen_density, devices.screen_density),
          state = excluded.state, connected = 1, last_seen_at = excluded.last_seen_at`);
      for (const d of reports) {
        upsert.run(
          deviceId(workerId, d.platform, d.deviceKey),
          workerId,
          d.platform,
          d.deviceKey,
          d.serial ?? null,
          d.name,
          d.model,
          d.osVersion,
          d.screen?.width ?? null,
          d.screen?.height ?? null,
          d.screen?.density ?? null,
          d.state,
          now,
        );
      }
    });
  }

  getDevice(id: string): DeviceRow | undefined {
    return this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined;
  }

  listDevices(filter: { platform?: string; state?: string } = {}): (DeviceRow & { lease_holder: string | null; lease_expires_at: string | null; worker_name: string; worker_status: string })[] {
    const where: string[] = [];
    const args: string[] = [nowIso()];
    if (filter.platform) {
      where.push('d.platform = ?');
      args.push(filter.platform);
    }
    if (filter.state) {
      where.push('d.state = ?');
      args.push(filter.state);
    }
    const sql = `SELECT d.*, l.holder AS lease_holder, l.expires_at AS lease_expires_at, w.name AS worker_name, w.status AS worker_status
      FROM devices d JOIN workers w ON w.id = d.worker_id
      LEFT JOIN device_leases l ON l.device_id = d.id AND l.expires_at > ?
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY d.connected DESC, d.platform, d.name, d.os_version`;
    return this.db.prepare(sql).all(...args) as never;
  }
}
