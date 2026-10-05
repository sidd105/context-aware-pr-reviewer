import { matcher } from '../config/glob.js';
import { importSpecifiers, resolveImport, testCandidates, isTestFile } from '../context/imports.js';
import type { Finding, ResolvedRule, RuleOutcome } from '../core/model.js';
import type { AssessmentContext, Evaluator } from '../core/plugin.js';
import { errorOutcome, excerpt, num, outcome, requireParams, ruleFinding } from './util.js';

// Runs `check` for each rule, turning thrown errors into an "error" outcome
// so one broken rule never takes the whole assessment down.
function perRule(
  id: string,
  check: (rule: ResolvedRule, ctx: AssessmentContext) => Promise<RuleOutcome>,
): Evaluator['evaluate'] {
  return (rules, ctx) =>
    Promise.all(
      rules.map(async (rule) => {
        try {
          return await check(rule, ctx);
        } catch (error) {
          return errorOutcome(rule, 'deterministic', new Error(`${id}: ${error instanceof Error ? error.message : String(error)}`));
        }
      }),
    );
}

// ---------------------------------------------------------------------------
// pattern: forbid or require a regular expression in files
// ---------------------------------------------------------------------------

export const patternEvaluator: Evaluator = {
  id: 'pattern',
  description: 'Forbids (or requires) a regular expression in files in scope',
  evidenceType: 'deterministic',
  validateParams(params) {
    const problems = requireParams(params, { pattern: 'string' });
    if (params.mode !== undefined && params.mode !== 'forbid' && params.mode !== 'require') problems.push('param "mode" must be forbid or require');
    try {
      new RegExp(String(params.pattern), String(params.flags ?? ''));
    } catch (error) {
      problems.push(`param "pattern" is not a valid regular expression: ${(error as Error).message}`);
    }
    return problems;
  },
  evaluate: perRule('pattern', async (rule, ctx) => {
    const flags = String(rule.params.flags ?? '').replace('g', '');
    const re = new RegExp(String(rule.params.pattern), flags);
    const mode = rule.params.mode ?? 'forbid';
    const message = typeof rule.params.message === 'string' ? rule.params.message : rule.title;
    const files = ctx.workspace.filesFor(rule);
    const findings: Finding[] = [];
    for (const file of files) {
      const text = await ctx.workspace.read(file);
      if (text === null) continue;
      if (mode === 'require') {
        if (!re.test(text)) findings.push(ruleFinding(rule, 'pattern', 'deterministic', { file, message: `${message} (required pattern not found)` }));
        continue;
      }
      text.split('\n').forEach((line, i) => {
        if (re.test(line)) {
          findings.push(ruleFinding(rule, 'pattern', 'deterministic', { file, line: i + 1, message, evidence: excerpt(text, i + 1, 0), discriminator: i + 1 }));
        }
      });
    }
    return outcome(rule, 'deterministic', findings, { scope: files.length });
  }),
};

// ---------------------------------------------------------------------------
// files.required / files.forbidden: repository structure
// ---------------------------------------------------------------------------

export const filesRequiredEvaluator: Evaluator = {
  id: 'files.required',
  description: 'Each listed glob must match at least one file in the repository',
  evidenceType: 'deterministic',
  validateParams: (p) => requireParams(p, { paths: 'string[]' }),
  evaluate: perRule('files.required', async (rule, ctx) => {
    const findings = (rule.params.paths as string[])
      .filter((glob) => !ctx.workspace.files.some(matcher([glob])))
      .map((glob) => ruleFinding(rule, 'files.required', 'deterministic', { message: `Required file missing: ${glob}`, discriminator: glob }));
    return outcome(rule, 'deterministic', findings);
  }),
};

export const filesForbiddenEvaluator: Evaluator = {
  id: 'files.forbidden',
  description: 'No file may match the listed globs',
  evidenceType: 'deterministic',
  validateParams: (p) => requireParams(p, { paths: 'string[]' }),
  evaluate: perRule('files.forbidden', async (rule, ctx) => {
    const forbidden = matcher(rule.params.paths as string[]);
    const findings = ctx.workspace.files
      .filter(forbidden)
      .map((file) => ruleFinding(rule, 'files.forbidden', 'deterministic', { file, message: `File should not be committed: ${file}` }));
    return outcome(rule, 'deterministic', findings);
  }),
};

// ---------------------------------------------------------------------------
// metrics.file_length / metrics.line_length
// ---------------------------------------------------------------------------

export const fileLengthEvaluator: Evaluator = {
  id: 'metrics.file_length',
  description: 'Files must not exceed max_lines',
  evidenceType: 'deterministic',
  validateParams: (p) => requireParams(p, { max_lines: 'number' }),
  evaluate: perRule('metrics.file_length', async (rule, ctx) => {
    const max = num(rule.params, 'max_lines')!;
    const files = ctx.workspace.filesFor(rule);
    const findings: Finding[] = [];
    for (const file of files) {
      const text = await ctx.workspace.read(file);
      if (text === null) continue;
      const lines = text.split('\n').length;
      if (lines > max) findings.push(ruleFinding(rule, 'metrics.file_length', 'deterministic', { file, message: `${file} has ${lines} lines (limit ${max})` }));
    }
    return outcome(rule, 'deterministic', findings, { scope: files.length });
  }),
};

export const lineLengthEvaluator: Evaluator = {
  id: 'metrics.line_length',
  description: 'Lines must not exceed max characters; one finding per file',
  evidenceType: 'deterministic',
  validateParams: (p) => requireParams(p, { max: 'number' }),
  evaluate: perRule('metrics.line_length', async (rule, ctx) => {
    const max = num(rule.params, 'max')!;
    const files = ctx.workspace.filesFor(rule);
    const findings: Finding[] = [];
    for (const file of files) {
      const text = await ctx.workspace.read(file);
      if (text === null) continue;
      const long = text.split('\n').flatMap((l, i) => (l.length > max ? [i + 1] : []));
      if (long.length > 0) {
        findings.push(
          ruleFinding(rule, 'metrics.line_length', 'deterministic', {
            file,
            line: long[0],
            message: `${long.length} line(s) longer than ${max} characters`,
            evidence: `First at line ${long[0]}; lines ${long.slice(0, 10).join(', ')}${long.length > 10 ? ', …' : ''}`,
          }),
        );
      }
    }
    return outcome(rule, 'deterministic', findings, { scope: files.length });
  }),
};

// ---------------------------------------------------------------------------
// tests.required: source files need a matching test file
// ---------------------------------------------------------------------------

export const testsRequiredEvaluator: Evaluator = {
  id: 'tests.required',
  description: 'Each source file in scope must have a test file by naming convention',
  evidenceType: 'deterministic',
  evaluate: perRule('tests.required', async (rule, ctx) => {
    const all = new Set(ctx.workspace.files);
    const files = ctx.workspace.filesFor(rule).filter((f) => !isTestFile(f) && !/(?:^|\/)__init__\.py$/.test(f));
    const findings = files
      .filter((f) => !testCandidates(f).some((t) => all.has(t)))
      .map((file) =>
        ruleFinding(rule, 'tests.required', 'deterministic', {
          file,
          message: `No test file found for ${file}`,
          evidence: `Looked for: ${testCandidates(file).slice(0, 4).join(', ')}`,
        }),
      );
    return outcome(rule, 'deterministic', findings, { scope: files.length });
  }),
};

// ---------------------------------------------------------------------------
// imports.forbidden: architecture boundaries
// ---------------------------------------------------------------------------

export const importsForbiddenEvaluator: Evaluator = {
  id: 'imports.forbidden',
  description: 'Files in scope must not import files matching `to` or packages listed in `modules`',
  evidenceType: 'deterministic',
  validateParams(p) {
    if (!Array.isArray(p.to) && !Array.isArray(p.modules)) return ['set "to" (file globs) and/or "modules" (package names)'];
    return [];
  },
  evaluate: perRule('imports.forbidden', async (rule, ctx) => {
    const toFile = matcher((rule.params.to as string[] | undefined) ?? []);
    const modules = (rule.params.modules as string[] | undefined) ?? [];
    const all = new Set(ctx.workspace.files);
    const files = ctx.workspace.filesFor(rule);
    const findings: Finding[] = [];
    for (const file of files) {
      const text = await ctx.workspace.read(file);
      if (text === null) continue;
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        for (const spec of importSpecifiers(file, line)) {
          const target = resolveImport(file, spec, all);
          const badModule = modules.find((m) => spec === m || spec.startsWith(`${m}.`) || spec.startsWith(`${m}/`));
          if ((target && toFile(target)) || badModule) {
            findings.push(
              ruleFinding(rule, 'imports.forbidden', 'deterministic', {
                file,
                line: i + 1,
                message: `${file} imports ${target ?? spec}, which this boundary forbids`,
                evidence: excerpt(text, i + 1, 0),
                discriminator: `${i + 1}:${spec}`,
              }),
            );
          }
        }
      });
    }
    return outcome(rule, 'deterministic', findings, { scope: files.length });
  }),
};
