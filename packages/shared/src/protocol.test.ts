import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandArgs, DeviceReport, WorkerToServer } from './protocol.ts';

test('device keys that could smuggle arguments are rejected', () => {
  const base = { platform: 'android', name: 'x', model: 'x', osVersion: '1', state: 'booted' };
  assert.ok(DeviceReport.safeParse({ ...base, deviceKey: 'Pixel_6' }).success);
  assert.equal(DeviceReport.safeParse({ ...base, deviceKey: '--wipe-data' }).success, false, 'would be read as a flag');
  assert.equal(DeviceReport.safeParse({ ...base, deviceKey: 'a b' }).success, false);
  assert.equal(DeviceReport.safeParse({ ...base, deviceKey: 'a;rm -rf' }).success, false);
  assert.equal(DeviceReport.safeParse({ ...base, deviceKey: 'a&b' }).success, false);
});

test('maestro env values are limited to shell-inert characters', () => {
  const ok = CommandArgs['maestro.run'].safeParse({ taskId: crypto.randomUUID(), flowYaml: 'x', appId: 'com.a.b', env: { USER: 'qa@example.com' } });
  assert.ok(ok.success);
  const bad = CommandArgs['maestro.run'].safeParse({ taskId: crypto.randomUUID(), flowYaml: 'x', appId: 'com.a.b', env: { USER: 'a"&calc' } });
  assert.equal(bad.success, false);
  assert.equal(CommandArgs['device.launch'].safeParse({ appId: 'com.a.b; reboot' }).success, false);
});

test('unknown worker frame types are rejected', () => {
  assert.equal(WorkerToServer.safeParse({ type: 'shell', cmd: 'ls' }).success, false);
});
