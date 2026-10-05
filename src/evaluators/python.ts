import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { packageRoot } from '../core/paths.js';
import type { Finding, ResolvedRule } from '../core/model.js';
import type { Evaluator } from '../core/plugin.js';
import { errorOutcome, outcome, ruleFinding, skipped } from './util.js';

interface FunctionMetrics {
  name: string;
  line: number;
  end_line: number;
  length: number;
  complexity: number;
  params: number;
  nesting: number;
  has_docstring: boolean;
  is_public: boolean;
}

interface FileMetrics {
  file: string;
  syntax_error?: { line: number; message: string };
  read_error?: string;
  module_docstring?: boolean;
  functions?: FunctionMetrics[];
  bare_excepts?: number[];
  silent_excepts?: number[];
  mutable_defaults?: Array<{ function: string; line: number }>;
  wildcard_imports?: Array<{ line: number; module: string }>;
  global_statements?: Array<{ line: number; names: string[] }>;
}

const CHECKS = [
  'function_length',
  'complexity',
  'max_params',
  'nesting_depth',
  'bare_except',
  'silent_except',
  'mutable_default',
  'wildcard_import',
  'missing_docstring',
  'global_statement',
  'syntax_error',
] as const;
type Check = (typeof CHECKS)[number];
const THRESHOLD_CHECKS = new Set<Check>(['function_length', 'complexity', 'max_params', 'nesting_depth']);

const SCRIPT = join(packageRoot(), 'scripts', 'python_ast_metrics.py');

export function runPythonMetrics(root: string, files: string[], python = 'python3'): Promise<{ python: string; files: FileMetrics[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [SCRIPT], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (e) => reject(new Error(`could not start ${python}: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`python AST script exited ${code}: ${err.trim()}`));
      try {
        resolve(JSON.parse(out) as { python: string; files: FileMetrics[] });
      } catch {
        reject(new Error('python AST script returned invalid JSON'));
      }
    });
    child.stdin.end(JSON.stringify({ root, files }));
  });
}

function check(rule: ResolvedRule, metrics: FileMetrics, evaluatorId: string): Finding[] {
  const kind = rule.params.check as Check;
  const max = typeof rule.params.max === 'number' ? rule.params.max : 0;
  const file = metrics.file;
  const f = (line: number, message: string, discriminator: string | number = line) =>
    ruleFinding(rule, evaluatorId, 'deterministic', { file, line, message, discriminator });
  const fns = metrics.functions ?? [];
  const publicOnly = rule.params.public_only !== false;

  switch (kind) {
    case 'syntax_error':
      return metrics.syntax_error ? [f(metrics.syntax_error.line, `Syntax error: ${metrics.syntax_error.message}`)] : [];
    case 'function_length':
      return fns.filter((x) => x.length > max).map((x) => f(x.line, `${x.name}() is ${x.length} lines (limit ${max})`, x.name));
    case 'complexity':
      return fns.filter((x) => x.complexity > max).map((x) => f(x.line, `${x.name}() has cyclomatic complexity ${x.complexity} (limit ${max})`, x.name));
    case 'max_params':
      return fns.filter((x) => x.params > max).map((x) => f(x.line, `${x.name}() takes ${x.params} parameters (limit ${max})`, x.name));
    case 'nesting_depth':
      return fns.filter((x) => x.nesting > max).map((x) => f(x.line, `${x.name}() nests ${x.nesting} levels deep (limit ${max})`, x.name));
    case 'bare_except':
      return (metrics.bare_excepts ?? []).map((l) => f(l, 'Bare `except:` catches everything, including KeyboardInterrupt and SystemExit'));
    case 'silent_except':
      return (metrics.silent_excepts ?? []).map((l) => f(l, 'Exception is caught and silently ignored'));
    case 'mutable_default':
      return (metrics.mutable_defaults ?? []).map((m) => f(m.line, `${m.function}() uses a mutable default argument`));
    case 'wildcard_import':
      return (metrics.wildcard_imports ?? []).map((w) => f(w.line, `Wildcard import from ${w.module}`));
    case 'global_statement':
      return (metrics.global_statements ?? []).map((g) => f(g.line, `global statement modifies ${g.names.join(', ')}`));
    case 'missing_docstring':
      return fns
        .filter((x) => !x.has_docstring && (!publicOnly || x.is_public) && x.length > (typeof rule.params.min_length === 'number' ? rule.params.min_length : 0))
        .map((x) => f(x.line, `Public function ${x.name}() has no docstring`, x.name));
  }
}

export const pythonAstEvaluator: Evaluator = {
  id: 'python.ast',
  description: `Deterministic Python checks from the standard library AST. check: ${CHECKS.join(', ')}`,
  evidenceType: 'deterministic',
  validateParams(params) {
    const problems: string[] = [];
    if (!CHECKS.includes(params.check as Check)) problems.push(`param "check" must be one of ${CHECKS.join(', ')}`);
    if (THRESHOLD_CHECKS.has(params.check as Check) && typeof params.max !== 'number') problems.push(`check ${String(params.check)} needs a numeric "max"`);
    return problems;
  },
  async evaluate(rules, ctx) {
    const scopes = new Map(rules.map((r) => [r.id, ctx.workspace.filesFor({ ...r, applies_to: { ...r.applies_to, languages: ['python'] } })]));
    const union = [...new Set([...scopes.values()].flat())];
    if (union.length === 0) return rules.map((r) => outcome(r, 'deterministic', [], { scope: 0 }));

    let metrics: Map<string, FileMetrics>;
    try {
      const python = (ctx.config.evaluators['python.ast']?.python as string | undefined) ?? 'python3';
      const result = await runPythonMetrics(ctx.workspace.root, union, python);
      metrics = new Map(result.files.map((m) => [m.file, m]));
      ctx.logger.debug(`python.ast analysed ${union.length} files with Python ${result.python}`);
    } catch (error) {
      // No interpreter is an environment problem, not a rule failure.
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('could not start')) return rules.map((r) => skipped(r, 'deterministic', message));
      return rules.map((r) => errorOutcome(r, 'deterministic', error));
    }

    return rules.map((rule) => {
      const files = scopes.get(rule.id) ?? [];
      const findings = files.flatMap((file) => {
        const m = metrics.get(file);
        if (!m || m.read_error) return [];
        // A file that doesn't parse can't be checked; only syntax_error rules report it.
        if (m.syntax_error && rule.params.check !== 'syntax_error') return [];
        return check(rule, m, 'python.ast');
      });
      return outcome(rule, 'deterministic', findings, { scope: files.length });
    });
  },
};
