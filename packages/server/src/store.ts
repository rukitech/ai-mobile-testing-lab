import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';

/** Reduces an untrusted file name to a safe basename. */
export function safeFileName(name: string, fallback = 'file.bin'): string {
  const base = path.basename(name.replaceAll('\\', '/')).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return base.slice(0, 120) || fallback;
}

export interface StoredFile {
  filePath: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * Local-disk object store. Every path it hands out is resolved under `root`,
 * so a crafted name can never escape it. An S3 implementation can replace it.
 */
export class FileStore {
  constructor(private readonly root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  resolve(...parts: string[]): string {
    const p = path.resolve(this.root, ...parts);
    if (p !== this.root && !p.startsWith(this.root + path.sep)) throw new Error('path escapes store root');
    return p;
  }

  async write(relDir: string, fileName: string, body: Readable, maxBytes: number): Promise<StoredFile> {
    const dir = this.resolve(relDir);
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = this.resolve(relDir, safeFileName(fileName));
    const tmp = this.resolve(relDir, `.upload-${randomUUID()}`);
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) return cb(new Error(`upload exceeds ${maxBytes} bytes`));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(body, meter, fs.createWriteStream(tmp, { flags: 'wx' }));
      if (size === 0) throw new Error('empty upload');
      fs.renameSync(tmp, finalPath);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    return { filePath: finalPath, sizeBytes: size, sha256: hash.digest('hex') };
  }
}
