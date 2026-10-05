import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { ConnectorConfig } from '../config/schema.js';
import type { Severity } from '../core/model.js';
import type { AssessmentContext } from '../core/plugin.js';

export function runCommand(
  argv: string[],
  options: { cwd: string; timeoutMs: number; signal: AbortSignal; okExitCodes?: number[]; env?: Record<string, string> },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const [cmd, ...args] = argv;
  if (!cmd) return Promise.reject(new Error('empty command'));
  return new Promise((resolve, reject) => {
    // No shell: arguments are passed as-is, so config values can't inject commands.
    const child = spawn(cmd, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, signal: options.signal, timeout: options.timeoutMs });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) => reject(new Error(`${cmd}: ${e.message}`)));
    child.on('close', (code) => {
      const ok = options.okExitCodes ?? [0, 1];
      if (code === null || !ok.includes(code)) return reject(new Error(`${cmd} exited ${code ?? 'by signal'}: ${stderr.trim().slice(0, 500)}`));
      resolve({ stdout, stderr, code });
    });
  });
}

// A connector reads an existing report (`report: path`) or, when command
// execution is allowed, runs the tool (`run: [argv]`).
export async function readReport(name: string, config: ConnectorConfig, ctx: AssessmentContext): Promise<string> {
  if (config.report) return readFile(config.report, 'utf8');
  const run = config.run as string[] | undefined;
  if (Array.isArray(run)) {
    if (!ctx.config.execution.allow_commands) {
      throw new Error(`connector ${name} wants to run "${run.join(' ')}" but execution.allow_commands is false`);
    }
    const { stdout } = await runCommand(run, { cwd: ctx.workspace.root, timeoutMs: ctx.config.execution.timeout_seconds * 1000, signal: ctx.signal });
    return stdout;
  }
  throw new Error(`connector ${name} needs "report" (a file) or "run" (a command)`);
}

export function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${what} is not valid JSON: ${(error as Error).message}`);
  }
}

export function severityFromCvss(score: number): Severity {
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  if (score > 0) return 'low';
  return 'info';
}

export function normaliseSeverity(value: unknown, fallback: Severity = 'medium'): Severity {
  const v = String(value ?? '').toLowerCase();
  if (['critical', 'blocker'].includes(v)) return 'critical';
  if (['high', 'error', 'major_high'].includes(v)) return 'high';
  if (['medium', 'moderate', 'warning', 'major'].includes(v)) return 'medium';
  if (['low', 'minor', 'note'].includes(v)) return 'low';
  if (['info', 'informational', 'none', 'info_'].includes(v)) return 'info';
  return fallback;
}

// Relative POSIX path within the repo, from an absolute path or file:// URI.
export function repoPath(uri: string | undefined, root: string): string | undefined {
  if (!uri) return undefined;
  let p = uri.replace(/^file:\/\//, '');
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep as-is
  }
  if (p.startsWith(root)) p = p.slice(root.length);
  return p.replace(/^\.?\/+/, '');
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
