import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export type Db = DatabaseSync;

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export const nowIso = (ms: number = Date.now()): string => new Date(ms).toISOString();

/** Opens (or creates) the database and applies pending migrations in order. */
export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name),
  );
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    tx(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, nowIso());
    });
  }
  const project = db.prepare('SELECT id FROM projects LIMIT 1').get();
  if (!project) db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(randomUUID(), 'default', nowIso());
}

/** BEGIN IMMEDIATE takes the write lock up front, so check-then-insert is atomic. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function defaultProjectId(db: Db): string {
  return (db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get() as { id: string }).id;
}

export function audit(db: Db, actor: string, action: string, target: string | null, detail?: unknown): void {
  db.prepare('INSERT INTO audit_log (actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?)').run(
    actor,
    action,
    target,
    detail === undefined ? null : JSON.stringify(detail),
    nowIso(),
  );
}
