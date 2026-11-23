import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { buildApp } from './app.ts';

const cfg = loadConfig();
const db = openDb(path.join(cfg.dataDir, 'lab.sqlite'));
const { fastify, scheduler, hub, live } = await buildApp(cfg, db);

// Seed the example suites from /flows on first start so a fresh lab has something to run.
const flowsDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../flows');
if (fs.existsSync(flowsDir) && !(db.prepare('SELECT 1 FROM test_suites LIMIT 1').get())) {
  const { defaultProjectId, nowIso } = await import('./db.ts');
  const { randomUUID } = await import('node:crypto');
  for (const f of fs.readdirSync(flowsDir).filter((n) => n.endsWith('.yaml'))) {
    db.prepare('INSERT INTO test_suites (id, project_id, name, flow_yaml, created_at) VALUES (?, ?, ?, ?, ?)').run(
      randomUUID(),
      defaultProjectId(db),
      f.replace(/\.yaml$/, ''),
      fs.readFileSync(path.join(flowsDir, f), 'utf8'),
      nowIso(),
    );
  }
}

scheduler.start();
live.start();
await fastify.listen({ host: cfg.host, port: cfg.port });
if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost') {
  fastify.log.warn('Listening beyond localhost without TLS. Put a TLS reverse proxy in front before remote workers connect (SECURITY.md).');
}

const shutdown = async () => {
  scheduler.stop();
  live.stop();
  hub.closeAll();
  await fastify.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
