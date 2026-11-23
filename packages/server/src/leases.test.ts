import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, nowIso } from './db.ts';
import { LeaseManager } from './leases.ts';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO workers (id, name, os, created_at) VALUES ('w', 'w', 'darwin', ?)").run(nowIso());
  for (const id of ['d1', 'd2']) {
    db.prepare(
      "INSERT INTO devices (id, worker_id, platform, device_key, name, model, os_version, state, last_seen_at) VALUES (?, 'w', 'ios', ?, 'n', 'm', '18', 'booted', ?)",
    ).run(id, id, nowIso());
  }
  let now = Date.parse('2026-01-01T00:00:00Z');
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  return { db, clock, leases: new LeaseManager(db, 60, clock.now) };
}

test('a device has at most one holder', () => {
  const { leases } = setup();
  assert.ok(leases.acquire('d1', 'task:a'));
  assert.equal(leases.acquire('d1', 'task:b'), null);
  assert.ok(leases.acquire('d2', 'task:b'), 'other devices are unaffected');
});

test('the same holder re-acquiring renews instead of failing', () => {
  const { leases, clock } = setup();
  const first = leases.acquire('d1', 'task:a')!;
  clock.advance(30_000);
  const again = leases.acquire('d1', 'task:a')!;
  assert.ok(again.expires_at > first.expires_at);
});

test('an expired lease can be taken over, and the old holder cannot renew it', () => {
  const { leases, clock } = setup();
  leases.acquire('d1', 'task:a');
  clock.advance(61_000);
  assert.ok(leases.acquire('d1', 'task:b'));
  assert.equal(leases.renew('d1', 'task:a'), null);
});

test('renew keeps a live lease alive past its original expiry', () => {
  const { leases, clock } = setup();
  leases.acquire('d1', 'task:a');
  clock.advance(40_000);
  assert.ok(leases.renew('d1', 'task:a'));
  clock.advance(40_000); // 80 s after acquire, 40 s after renew
  assert.equal(leases.acquire('d1', 'task:b'), null);
});

test('sweepExpired returns and removes only expired leases', () => {
  const { leases, clock } = setup();
  leases.acquire('d1', 'task:a', null);
  clock.advance(30_000);
  leases.acquire('d2', 'task:b', null);
  clock.advance(31_000); // d1 expired, d2 not
  const swept = leases.sweepExpired();
  assert.deepEqual(swept.map((l) => l.device_id), ['d1']);
  assert.equal(leases.get('d1'), null);
  assert.ok(leases.get('d2'));
});

test('release only works for the holder', () => {
  const { leases } = setup();
  leases.acquire('d1', 'task:a');
  assert.equal(leases.release('d1', 'task:b'), false);
  assert.equal(leases.release('d1', 'task:a'), true);
  assert.ok(leases.acquire('d1', 'task:b'));
});
