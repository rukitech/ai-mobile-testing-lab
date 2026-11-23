import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LabError, type Platform } from '@lab/shared';
import { run } from './exec.ts';

export interface ServerLink {
  serverUrl: string;
  token: () => string;
}

/**
 * Downloads a build once per worker, verifies its sha256, and for iOS unzips
 * the .app. Returns the path the driver installs from.
 */
export async function fetchBuild(link: ServerLink, cacheDir: string, buildId: string, sha256: string, platform: Platform): Promise<string> {
  const dir = path.join(cacheDir, 'builds', buildId);
  const marker = path.join(dir, '.ready');
  if (fs.existsSync(marker)) return fs.readFileSync(marker, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const res = await fetch(`${link.serverUrl}/api/builds/${buildId}/file`, { headers: { authorization: `Bearer ${link.token()}` } });
  if (!res.ok || !res.body) throw new LabError('EXEC_FAILED', `build download failed: HTTP ${res.status}`);
  const file = path.join(dir, platform === 'ios' ? 'build.zip' : 'build.apk');
  const hash = createHash('sha256');
  await pipeline(
    Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
    new Transform({ transform(c: Buffer, _e, cb) { hash.update(c); cb(null, c); } }),
    fs.createWriteStream(file),
  );
  if (hash.digest('hex') !== sha256) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new LabError('CHECKSUM_MISMATCH', 'downloaded build does not match its sha256');
  }

  let installPath = file;
  if (platform === 'ios') {
    const out = path.join(dir, 'unzipped');
    await run('ditto', ['-x', '-k', file, out], { timeoutMs: 5 * 60_000 });
    const app = fs.readdirSync(out).find((n) => n.endsWith('.app'));
    if (!app) throw new LabError('BAD_ARGS', 'zip does not contain a .app at its top level');
    installPath = path.join(out, app);
    fs.rmSync(file); // keep only the unzipped bundle - disk is precious on simulator hosts
  }
  fs.writeFileSync(marker, installPath);
  return installPath;
}

export async function uploadArtifact(
  link: ServerLink,
  file: string,
  meta: { kind: 'screenshot' | 'junit' | 'log' | 'maestro-output'; taskId?: string; deviceKey?: string; platform?: Platform; fileName?: string },
): Promise<string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${link.token()}`,
    'content-type': 'application/octet-stream',
    'x-kind': meta.kind,
    'x-file-name': meta.fileName ?? path.basename(file),
  };
  if (meta.taskId) headers['x-task-id'] = meta.taskId;
  if (meta.deviceKey) headers['x-device-key'] = meta.deviceKey;
  if (meta.platform) headers['x-platform'] = meta.platform;
  const res = await fetch(`${link.serverUrl}/api/artifacts`, { method: 'POST', headers, body: await fs.openAsBlob(file) });
  if (!res.ok) throw new LabError('EXEC_FAILED', `artifact upload failed: HTTP ${res.status} ${await res.text()}`);
  return ((await res.json()) as { artifactId: string }).artifactId;
}

/** Live Wall frame: kept in server memory only, latest frame per device. */
export async function uploadFrame(link: ServerLink, file: string, meta: { deviceKey: string; platform: Platform; imageType: 'jpeg' | 'png' }): Promise<void> {
  const res = await fetch(`${link.serverUrl}/api/live/frames`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${link.token()}`,
      'content-type': 'application/octet-stream',
      'x-device-key': meta.deviceKey,
      'x-platform': meta.platform,
      'x-image-type': meta.imageType,
    },
    body: await fs.openAsBlob(file),
  });
  if (!res.ok) throw new LabError('EXEC_FAILED', `frame upload failed: HTTP ${res.status}`);
}
