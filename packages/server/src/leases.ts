import { type Db, nowIso, tx } from './db.ts';

export interface Lease {
  device_id: string;
  holder: string;
  task_id: string | null;
  acquired_at: string;
  expires_at: string;
}

/**
 * Exclusive device reservations. `device_leases.device_id` is the primary key,
 * so the database itself guarantees one holder per device; acquire runs in a
 * write transaction so "expired? then take it" is atomic.
 */
export class LeaseManager {
  constructor(
    private readonly db: Db,
    private readonly leaseSeconds: number,
    private readonly clock: () => number = Date.now,
  ) {}

  acquire(deviceId: string, holder: string, taskId: string | null = null): Lease | null {
    return tx(this.db, () => {
      const now = this.clock();
      this.db.prepare('DELETE FROM device_leases WHERE device_id = ? AND expires_at <= ?').run(deviceId, nowIso(now));
      const existing = this.db.prepare('SELECT * FROM device_leases WHERE device_id = ?').get(deviceId) as Lease | undefined;
      if (existing) return existing.holder === holder ? this.renewInTx(deviceId, holder, now) : null;
      const lease: Lease = {
        device_id: deviceId,
        holder,
        task_id: taskId,
        acquired_at: nowIso(now),
        expires_at: nowIso(now + this.leaseSeconds * 1000),
      };
      this.db
        .prepare('INSERT INTO device_leases (device_id, holder, task_id, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(lease.device_id, lease.holder, lease.task_id, lease.acquired_at, lease.expires_at);
      return lease;
    });
  }

  /** Extends a lease the caller still holds. Returns null if it was lost (expired and taken, or released). */
  renew(deviceId: string, holder: string): Lease | null {
    return tx(this.db, () => this.renewInTx(deviceId, holder, this.clock()));
  }

  private renewInTx(deviceId: string, holder: string, now: number): Lease | null {
    const res = this.db
      .prepare('UPDATE device_leases SET expires_at = ? WHERE device_id = ? AND holder = ? AND expires_at > ?')
      .run(nowIso(now + this.leaseSeconds * 1000), deviceId, holder, nowIso(now));
    if (Number(res.changes) === 0) return null;
    return this.db.prepare('SELECT * FROM device_leases WHERE device_id = ?').get(deviceId) as unknown as Lease;
  }

  release(deviceId: string, holder: string): boolean {
    const res = this.db.prepare('DELETE FROM device_leases WHERE device_id = ? AND holder = ?').run(deviceId, holder);
    return Number(res.changes) > 0;
  }

  get(deviceId: string): Lease | null {
    const l = this.db.prepare('SELECT * FROM device_leases WHERE device_id = ? AND expires_at > ?').get(deviceId, nowIso(this.clock())) as
      | Lease
      | undefined;
    return l ?? null;
  }

  /** Removes expired leases and returns them so the caller can fail their tasks. */
  sweepExpired(): Lease[] {
    return tx(this.db, () => {
      const now = nowIso(this.clock());
      const expired = this.db.prepare('SELECT * FROM device_leases WHERE expires_at <= ?').all(now) as unknown as Lease[];
      if (expired.length) this.db.prepare('DELETE FROM device_leases WHERE expires_at <= ?').run(now);
      return expired;
    });
  }
}
