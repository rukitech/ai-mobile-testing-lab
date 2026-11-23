import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  avdInfoFromConfig,
  modelFromDeviceType,
  parseAdbDevices,
  parseAvdList,
  parseIni,
  parseSimctlDevices,
  parseWmDensity,
  parseWmSize,
  pickEmulatorPort,
} from './drivers/parsers.ts';
import { maestroArgs } from './maestro.ts';
import { smallestWidthDp, ANDROID_SCREEN_PROFILES } from '@lab/shared';

test('simctl JSON: iOS runtimes only, versions parsed, unavailable skipped', () => {
  const json = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [
        { udid: 'A1B2', name: 'iPhone 16', state: 'Booted', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16' },
        { udid: 'C3D4', name: 'iPad Air', state: 'Shutdown', isAvailable: false },
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-17-0-1': [{ udid: 'E5', name: 'iPhone SE', state: 'Shutdown', isAvailable: true }],
      'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [{ udid: 'W1', name: 'Watch', state: 'Shutdown', isAvailable: true }],
    },
  });
  const out = parseSimctlDevices(json);
  assert.deepEqual(
    out.map((d) => [d.udid, d.state, d.osVersion]),
    [
      ['A1B2', 'booted', '18.5'],
      ['E5', 'shutdown', '17.0.1'],
    ],
  );
  assert.equal(modelFromDeviceType('com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro', 'x'), 'iPhone 16 Pro');
});

test('adb devices: emulators vs physical, header and daemon lines ignored', () => {
  const text = `* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\nemulator-5554\tdevice\nR58M12ABCDE\tunauthorized\n\n`;
  // The first real line is the header only once the daemon lines are gone; parse after the header.
  const fromHeader = text.slice(text.indexOf('List of devices'));
  assert.deepEqual(parseAdbDevices(fromHeader), [
    { serial: 'emulator-5554', state: 'device', isEmulator: true },
    { serial: 'R58M12ABCDE', state: 'unauthorized', isEmulator: false },
  ]);
});

test('emulator -list-avds: INFO noise filtered out', () => {
  assert.deepEqual(parseAvdList('INFO    | Storing crashdata in: /tmp/x\nMedium_Phone_API_36.0\nPixel_6\n'), ['Medium_Phone_API_36.0', 'Pixel_6']);
});

test('AVD config.ini -> screen and API level', () => {
  const cfg = parseIni('hw.lcd.width=1080\nhw.lcd.height = 2400\nhw.lcd.density=420\nimage.sysdir.1=system-images/android-36/google_apis_playstore/arm64-v8a/\nhw.device.name=pixel_6\n# c=d');
  const info = avdInfoFromConfig('Pixel_6', cfg);
  assert.deepEqual(info, { displayName: 'Pixel 6', model: 'pixel_6', apiLevel: '36', width: 1080, height: 2400, dpi: 420 });
});

test('wm size / density prefer the override', () => {
  assert.deepEqual(parseWmSize('Physical size: 1080x2400\nOverride size: 1600x2560'), { width: 1600, height: 2560 });
  assert.deepEqual(parseWmSize('Physical size: 1080x2400'), { width: 1080, height: 2400 });
  assert.equal(parseWmDensity('Physical density: 420\nOverride density: 320'), 320);
  assert.equal(parseWmSize('garbage'), null);
});

test('emulator port: lowest free even port', () => {
  assert.equal(pickEmulatorPort([]), 5554);
  assert.equal(pickEmulatorPort(['emulator-5554', 'emulator-5558', 'R58M']), 5556);
});

test('screen profiles land in the intended smallestWidth buckets', () => {
  const sw = (k: keyof typeof ANDROID_SCREEN_PROFILES) => {
    const p = ANDROID_SCREEN_PROFILES[k];
    return smallestWidthDp(p.width, p.height, p.density);
  };
  assert.ok(sw('phone') < 600);
  assert.ok(sw('tablet-7') >= 600 && sw('tablet-7') < 720);
  assert.ok(sw('tablet-10') >= 720);
});

test('maestro args: explicit device, per-run output, env as separate argv items', () => {
  const args = maestroArgs({ deviceId: 'emulator-5554', flowFile: '/w/flow.yaml', junitFile: '/w/r.xml', outDir: '/w/out', env: { APP_ID: 'com.x.y', USER: 'a b' } });
  assert.deepEqual(args.slice(0, 3), ['test', '--device', 'emulator-5554']);
  assert.ok(args.includes('--test-output-dir'));
  assert.deepEqual(args.slice(-5), ['-e', 'APP_ID=com.x.y', '-e', 'USER=a b', '/w/flow.yaml']);
});
