export type TaskStatus = 'queued' | 'leasing' | 'preparing' | 'running' | 'passed' | 'failed' | 'error' | 'cancelled';
export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'cancelled';

export const TERMINAL: ReadonlySet<TaskStatus> = new Set(['passed', 'failed', 'error', 'cancelled']);

const ALLOWED: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['leasing', 'cancelled', 'error'],
  leasing: ['preparing', 'queued', 'cancelled', 'error'],
  preparing: ['running', 'cancelled', 'error'],
  running: ['passed', 'failed', 'cancelled', 'error'],
  passed: [],
  failed: [],
  error: [],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new Error(`illegal task transition ${from} -> ${to}`);
}

/** A run's status is derived from its tasks, never set independently. */
export function deriveRunStatus(tasks: readonly TaskStatus[], cancelled = false): RunStatus {
  if (tasks.length === 0) return cancelled ? 'cancelled' : 'queued';
  if (tasks.some((t) => !TERMINAL.has(t))) {
    return tasks.every((t) => t === 'queued') ? 'queued' : 'running';
  }
  if (cancelled || tasks.every((t) => t === 'cancelled')) return 'cancelled';
  if (tasks.some((t) => t === 'error')) return 'error';
  if (tasks.some((t) => t === 'failed')) return 'failed';
  return 'passed';
}
