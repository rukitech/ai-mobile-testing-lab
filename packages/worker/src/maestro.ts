import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './exec.ts';

export function defaultMaestroBin(): string {
  if (process.env.LAB_MAESTRO_BIN) return process.env.LAB_MAESTRO_BIN;
  const home = path.join(os.homedir(), '.maestro', 'bin', process.platform === 'win32' ? 'maestro.bat' : 'maestro');
  return fs.existsSync(home) ? home : 'maestro';
}

export interface MaestroRunInput {
  bin: string;
  deviceId: string; // UDID (iOS) or serial (Android)
  flowYaml: string;
  env: Record<string, string>;
  workDir: string;
  timeoutMs: number;
  onLine: (line: string) => void;
}

export interface MaestroRunOutput {
  exitCode: number;
  durationMs: number;
  junitFile: string | null;
  logFile: string;
  screenshots: string[];
  /** Maestro's own detailed logs from --test-output-dir; its stdout alone often just says "Unknown error". */
  diagnostics: string[];
}

export function maestroArgs(i: { deviceId: string; flowFile: string; junitFile: string; outDir: string; env: Record<string, string> }): string[] {
  return [
    'test',
    '--device', i.deviceId,
    '--no-ansi',
    '--format', 'JUNIT',
    '--output', i.junitFile,
    '--test-output-dir', i.outDir,
    ...Object.entries(i.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    i.flowFile,
  ];
}

/** One Maestro process per device and task, each with its own output dir. */
export async function runMaestro(input: MaestroRunInput): Promise<MaestroRunOutput> {
  fs.mkdirSync(input.workDir, { recursive: true });
  const flowFile = path.join(input.workDir, 'flow.yaml');
  const junitFile = path.join(input.workDir, 'report.xml');
  const outDir = path.join(input.workDir, 'out');
  const logFile = path.join(input.workDir, 'maestro.log');
  fs.writeFileSync(flowFile, input.flowYaml);
  const log = fs.createWriteStream(logFile);
  const started = Date.now();
  const res = await run(input.bin, maestroArgs({ deviceId: input.deviceId, flowFile, junitFile, outDir, env: input.env }), {
    cwd: input.workDir,
    timeoutMs: input.timeoutMs,
    allowFailure: true,
    env: { ...process.env, MAESTRO_CLI_NO_ANALYTICS: '1', MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true' },
    onLine: (line) => {
      log.write(line + '\n');
      input.onLine(line);
    },
  });
  await new Promise((r) => log.end(r));
  return {
    exitCode: res.code,
    durationMs: Date.now() - started,
    junitFile: fs.existsSync(junitFile) ? junitFile : null,
    logFile,
    screenshots: findFiles(outDir, /\.png$/i),
    diagnostics: findFiles(outDir, /\.(log|json)$/i).filter((f) => fs.statSync(f).size < 20 * 1024 * 1024),
  };
}

function findFiles(dir: string, pattern: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findFiles(p, pattern));
    else if (pattern.test(e.name)) out.push(p);
  }
  return out.sort();
}
