import path from 'node:path';

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  serverSecret: string;
  dashboardToken: string;
  enrollmentSecret: string;
  maxParallelTasks: number;
  leaseSeconds: number;
  workerTokenTtlSeconds: number;
}

const PLACEHOLDER = /^change-me/;
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const required = (key: string): string => {
    const v = env[key];
    if (!v) throw new Error(`${key} is not set (copy .env.example to .env)`);
    if (PLACEHOLDER.test(v)) throw new Error(`${key} still has the placeholder value from .env.example`);
    return v;
  };
  const serverSecret = required('LAB_SERVER_SECRET');
  if (serverSecret.length < 32) throw new Error('LAB_SERVER_SECRET must be at least 32 characters');
  return {
    host: env.LAB_HOST ?? '127.0.0.1',
    port: Number(env.LAB_PORT ?? 4300),
    // Relative to the repo root, whichever package directory npm started us in.
    dataDir: path.resolve(REPO_ROOT, env.LAB_DATA_DIR ?? './data'),
    serverSecret,
    dashboardToken: required('LAB_DASHBOARD_TOKEN'),
    enrollmentSecret: required('LAB_WORKER_ENROLLMENT_SECRET'),
    maxParallelTasks: Math.max(1, Number(env.LAB_MAX_PARALLEL_TASKS ?? 4)),
    leaseSeconds: Math.max(30, Number(env.LAB_LEASE_SECONDS ?? 120)),
    workerTokenTtlSeconds: 15 * 60,
  };
}
