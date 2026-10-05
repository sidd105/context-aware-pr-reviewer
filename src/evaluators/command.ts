import { matcher } from '../config/glob.js';
import { parseJson, repoPath, runCommand } from '../connectors/common.js';
import { parseSarif } from '../connectors/sarif.js';
import type { Finding } from '../core/model.js';
import type { Evaluator } from '../core/plugin.js';
import { errorOutcome, outcome, ruleFinding, skipped } from './util.js';

// Runs an existing linter as the evaluator for an organization rule:
//
//   - id: ORG-PY-LINT
//     evaluator: command
//     params:
//       run: [ruff, check, --output-format=json, --select, "E,F,B", "."]
//       format: ruff
//       select: ["B*"]          # optional: only these tool rule codes count
//
// The org rule owns severity and enforcement; the linter supplies evidence.

interface ToolHit {
  file?: string;
  line?: number;
  code: string;
  message: string;
}

function parseRuff(text: string, root: string): ToolHit[] {
  const rows = parseJson<Array<{ code: string | null; message: string; filename: string; location?: { row: number } }>>(text, 'ruff output');
  return rows.map((r) => ({ file: repoPath(r.filename, `${root}/`), line: r.location?.row, code: r.code ?? 'syntax', message: r.message }));
}

function parseEslint(text: string, root: string): ToolHit[] {
  const files = parseJson<Array<{ filePath: string; messages: Array<{ ruleId: string | null; message: string; line?: number }> }>>(text, 'eslint output');
  return files.flatMap((f) => f.messages.map((m) => ({ file: repoPath(f.filePath, `${root}/`), line: m.line, code: m.ruleId ?? 'parse', message: m.message })));
}

function parseSarifHits(text: string, root: string): ToolHit[] {
  return parseSarif(text, { root, connector: 'command' }).findings.map((f) => ({
    file: f.location.file,
    line: f.location.start_line,
    code: f.rule_id.replace(/^[^:]+:/, ''),
    message: f.message,
  }));
}

const FORMATS = { ruff: parseRuff, eslint: parseEslint, sarif: parseSarifHits } as const;

export const commandEvaluator: Evaluator = {
  id: 'command',
  description: 'Runs a linter or scanner (formats: ruff, eslint, sarif). Needs execution.allow_commands',
  evidenceType: 'deterministic',
  validateParams(p) {
    const problems: string[] = [];
    if (!Array.isArray(p.run) || p.run.length === 0 || !p.run.every((x) => typeof x === 'string')) problems.push('param "run" must be a non-empty argv array');
    if (!(String(p.format) in FORMATS)) problems.push(`param "format" must be one of ${Object.keys(FORMATS).join(', ')}`);
    return problems;
  },
  async evaluate(rules, ctx) {
    // Rules sharing the same command run it once.
    const runs = new Map<string, Promise<string>>();
    return Promise.all(
      rules.map(async (rule) => {
        if (!ctx.config.execution.allow_commands) {
          return skipped(rule, 'deterministic', 'execution.allow_commands is false; command evaluators are disabled');
        }
        try {
          const argv = rule.params.run as string[];
          const key = JSON.stringify(argv);
          if (!runs.has(key)) {
            runs.set(
              key,
              runCommand(argv, { cwd: ctx.workspace.root, timeoutMs: ctx.config.execution.timeout_seconds * 1000, signal: ctx.signal, okExitCodes: [0, 1] }).then((r) => r.stdout),
            );
          }
          const stdout = await runs.get(key)!;
          const hits = FORMATS[rule.params.format as keyof typeof FORMATS](stdout || '[]', ctx.workspace.root);
          const select = matcher((rule.params.select as string[] | undefined) ?? ['*']);
          const inScope = new Set(ctx.workspace.filesFor(rule));
          const findings: Finding[] = hits
            .filter((h) => select(h.code) && (!h.file || inScope.has(h.file)))
            .map((h) =>
              ruleFinding(rule, 'command', 'deterministic', {
                file: h.file,
                line: h.line,
                message: `${h.code}: ${h.message}`,
                discriminator: `${h.line}:${h.code}`,
                extra: { tags: [...rule.tags, `tool-rule:${h.code}`], tool: { name: argv[0]! } },
              }),
            );
          return outcome(rule, 'deterministic', findings, { scope: inScope.size });
        } catch (error) {
          return errorOutcome(rule, 'deterministic', error);
        }
      }),
    );
  },
};
