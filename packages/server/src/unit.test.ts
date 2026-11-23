import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signWorkerToken, verifyWorkerToken, bearer } from './auth.ts';
import { canTransition, deriveRunStatus } from './taskState.ts';
import { safeFileName, FileStore } from './store.ts';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Readable } from 'node:stream';

const SECRET = 'x'.repeat(32);

test('worker token round-trips and carries the worker id', () => {
  const { token } = signWorkerToken(SECRET, 'w1', 900);
  assert.equal(verifyWorkerToken(SECRET, token)?.workerId, 'w1');
});

test('worker token is rejected when expired, tampered or signed with another key', () => {
  const now = Date.now();
  const { token } = signWorkerToken(SECRET, 'w1', 900, now);
  assert.equal(verifyWorkerToken(SECRET, token, now + 901_000), null);
  assert.equal(verifyWorkerToken('y'.repeat(32), token), null);
  const [body, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ workerId: 'w2', exp: 9e9 })).toString('base64url');
  assert.equal(verifyWorkerToken(SECRET, `${forged}.${sig}`), null);
  assert.equal(verifyWorkerToken(SECRET, `${body}.${sig}.extra`), null);
});

test('bearer parsing', () => {
  assert.equal(bearer('Bearer abc'), 'abc');
  assert.equal(bearer('Basic abc'), null);
  assert.equal(bearer(undefined), null);
});

test('task transitions: terminal states are final, running cannot go back', () => {
  assert.ok(canTransition('queued', 'leasing'));
  assert.ok(canTransition('leasing', 'queued'), 'device busy -> back to queue');
  assert.ok(canTransition('running', 'failed'));
  assert.equal(canTransition('running', 'queued'), false);
  assert.equal(canTransition('passed', 'error'), false);
  assert.equal(canTransition('error', 'passed'), false);
});

test('run status is derived from task statuses', () => {
  assert.equal(deriveRunStatus(['queued', 'queued']), 'queued');
  assert.equal(deriveRunStatus(['passed', 'running']), 'running');
  assert.equal(deriveRunStatus(['passed', 'passed']), 'passed');
  assert.equal(deriveRunStatus(['passed', 'failed']), 'failed');
  assert.equal(deriveRunStatus(['failed', 'error']), 'error');
  assert.equal(deriveRunStatus(['passed', 'cancelled'], true), 'cancelled');
});

test('safeFileName strips traversal and odd characters', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('..\\..\\win.ini'), 'win.ini');
  assert.equal(safeFileName('my shot (1).png'), 'my_shot__1_.png');
  assert.equal(safeFileName('...'), 'file.bin');
});

test('FileStore refuses paths outside its root and enforces size limits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-store-'));
  const store = new FileStore(root);
  assert.throws(() => store.resolve('..', 'x'));
  const ok = await store.write('a', 'f.txt', Readable.from([Buffer.from('hello')]), 100);
  assert.equal(ok.sizeBytes, 5);
  assert.equal(ok.sha256, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  await assert.rejects(store.write('a', 'big.txt', Readable.from([Buffer.alloc(200)]), 100), /exceeds/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'a')), ['f.txt'], 'failed upload leaves no temp file');
  fs.rmSync(root, { recursive: true, force: true });
});
