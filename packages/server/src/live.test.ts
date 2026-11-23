import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveFrames } from './live.ts';
import { EventBus } from './events.ts';

function setup() {
  let now = 1_000_000;
  const sent: string[] = [];
  const pending: (() => void)[] = [];
  const device = (id: string, state = 'booted') => ({ id, worker_id: 'w', platform: 'ios', device_key: id, connected: 1, state });
  const devices: Record<string, ReturnType<typeof device>> = { a: device('a'), b: device('b'), off: device('off', 'shutdown') };
  const registry = { getDevice: (id: string) => devices[id] } as never;
  const hub = {
    isOnline: () => true,
    send: (_w: string, _n: string, _a: unknown, o: { deviceKey: string }) => {
      sent.push(o.deviceKey);
      return new Promise<void>((r) => pending.push(r)); // resolved by the test
    },
  } as never;
  const live = new LiveFrames(registry, hub, new EventBus(), { intervalMs: 1500, watchTtlMs: 10_000, maxFrameBytes: 1024 }, () => now);
  // Resolve captures, then let their .finally() clear the in-flight flag.
  const settle = async () => {
    pending.splice(0).forEach((r) => r());
    await new Promise((r) => setImmediate(r));
  };
  return { live, sent, settle, advance: (ms: number) => (now += ms) };
}

test('polls only watched, booted devices, at most once per interval', async () => {
  const { live, sent, settle, advance } = setup();
  live.watch(['a', 'off']);
  live.tick();
  assert.deepEqual(sent, ['a']);
  await settle();
  advance(500);
  live.tick();
  assert.deepEqual(sent, ['a'], 'interval not elapsed');
  advance(1100);
  live.tick();
  assert.deepEqual(sent, ['a', 'a']);
});

test('never more than one capture in flight per device', async () => {
  const { live, sent, advance } = setup();
  live.watch(['a']);
  live.tick();
  advance(5000);
  live.tick(); // previous capture still pending
  assert.deepEqual(sent, ['a']);
});

test('an expired watch stops polling and frees the stored frame', async () => {
  const { live, sent, settle, advance } = setup();
  live.watch(['b']);
  live.put('b', { data: Buffer.from('x'), contentType: 'image/jpeg', at: 1 });
  live.tick();
  await settle();
  advance(10_001);
  live.tick();
  assert.equal(live.get('b'), undefined);
  advance(2000);
  live.tick();
  assert.deepEqual(sent, ['b']);
});
