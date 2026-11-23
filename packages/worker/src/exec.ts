import { spawn } from 'node:child_process';
import { LabError } from '@lab/shared';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Resolve with the result instead of throwing on a non-zero exit. */
  allowFailure?: boolean;
  maxBuffer?: number;
}

const WINDOWS_SCRIPT = /\.(bat|cmd)$/i;
// Characters cmd.exe treats specially. Arguments reaching a .bat must be free of them.
const CMD_META = /[&|<>^%!"\r\n]/;

/**
 * Runs a tool with an argument array - never a shell string. The one forced
 * exception is a Windows .bat/.cmd (e.g. maestro.bat), which Node can only run
 * through cmd.exe since CVE-2024-27980; there every argument is checked
 * against cmd metacharacters first.
 */
export function run(bin: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const viaShell = process.platform === 'win32' && WINDOWS_SCRIPT.test(bin);
  if (viaShell) {
    for (const a of [bin, ...args]) {
      if (CMD_META.test(a)) return Promise.reject(new LabError('BAD_ARGS', `argument not allowed for a Windows script: ${a}`));
    }
  }
  const maxBuffer = opts.maxBuffer ?? 8 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(viaShell ? `"${bin}"` : bin, viaShell ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args, {
      env: opts.env ?? process.env,
      cwd: opts.cwd,
      shell: viaShell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const pending = { stdout: '', stderr: '' };
    const feed = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      if (stream === 'stdout') stdout = (stdout + s).slice(-maxBuffer);
      else stderr = (stderr + s).slice(-maxBuffer);
      if (!opts.onLine) return;
      const lines = (pending[stream] + s).split(/\r?\n/);
      pending[stream] = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) opts.onLine(l, stream);
    };
    child.stdout.on('data', feed('stdout'));
    child.stderr.on('data', feed('stderr'));
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5000).unref();
        }, opts.timeoutMs)
      : undefined;
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new LabError(e.code === 'ENOENT' ? 'TOOL_MISSING' : 'EXEC_FAILED', `${bin}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      for (const stream of ['stdout', 'stderr'] as const) if (pending[stream].trim()) opts.onLine?.(pending[stream], stream);
      if (timedOut) return reject(new LabError('TIMEOUT', `${bin} ${args[0] ?? ''} timed out after ${opts.timeoutMs} ms`));
      const res = { code: code ?? -1, stdout, stderr };
      if (res.code !== 0 && !opts.allowFailure) {
        return reject(new LabError('EXEC_FAILED', `${bin} ${args.slice(0, 3).join(' ')} exited ${res.code}: ${(stderr || stdout).trim().slice(-800)}`));
      }
      resolve(res);
    });
  });
}

/** Starts a long-lived detached process (the Android emulator) and forgets it. */
export function spawnDetached(bin: string, args: string[]): void {
  const child = spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => undefined);
  child.unref();
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
