import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { silentLogger } from '../src/core/logger.js';
import type { ResolvedRule } from '../src/core/model.js';
import type { AssessmentContext, Evaluator } from '../src/core/plugin.js';
import { Workspace } from '../src/core/workspace.js';
import { filesRequiredEvaluator, importsForbiddenEvaluator, patternEvaluator, testsRequiredEvaluator } from '../src/evaluators/deterministic.js';
import { pythonAstEvaluator } from '../src/evaluators/python.js';
import { findSecrets, secretsEvaluator } from '../src/evaluators/secrets.js';
import { StaticMcpPool } from '../src/mcp/client.js';
import { makeFinding } from '../src/core/finding.js';
import { outcome, ruleFinding, skipped } from '../src/evaluators/util.js';

let ctx: AssessmentContext;

const hasPython = (() => {
  try {
    execFileSync('python3', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cqr-eval-'));
  const write = (p: string, c: string) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  };
  write('app/domain/order.py', 'import requests\nfrom app.infra import db\n\ndef total(items, discounts=[]):\n    try:\n        return sum(items)\n    except:\n        pass\n');
  write('app/domain/clean.py', '"""Clean module."""\n\ndef add(a, b):\n    """Add."""\n    return a + b\n');
  write('app/infra/db.py', 'PASSWORD = "changeme"\nTOKEN = "ghp_' + 'A1b2C3d4'.repeat(5) + '"\n');
  write('app/infra/__init__.py', '');
  write('tests/test_clean.py', 'def test_add():\n    assert True\n');
  write('broken.py', 'def oops(:\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  ctx = {
    workspace: await Workspace.open(dir, { exclude: [] }),
    config: ConfigSchema.parse({}),
    logger: silentLogger(),
    ai: null,
    toolFindings: [],
    connectorStatus: new Map(),
    environment: undefined,
    mcp: new StaticMcpPool(),
    signal: new AbortController().signal,
    sdk: { ruleFinding, outcome, skipped, makeFinding },
  };
});

const rule = (evaluator: Evaluator, params: Record<string, unknown>, over: Partial<ResolvedRule> = {}): ResolvedRule => ({
  id: 'T-1',
  title: 'test rule',
  description: '',
  rationale: '',
  category: 'code-quality',
  severity: 'high',
  enforcement: 'scored',
  evaluator: evaluator.id,
  params,
  applies_to: { languages: [], paths: ['**'], exclude: [] },
  remediation: '',
  references: [],
  tags: [],
  enabled: true,
  ruleset: 'test',
  ruleset_version: '1.0.0',
  source: 'organization',
  ...over,
});

async function evaluate(evaluator: Evaluator, params: Record<string, unknown>, over: Partial<ResolvedRule> = {}) {
  const [outcome] = await evaluator.evaluate([rule(evaluator, params, over)], ctx);
  return outcome!;
}

describe('secrets.scan', () => {
  it('finds real tokens, ignores low-entropy placeholders, and never echoes the secret', async () => {
    const o = await evaluate(secretsEvaluator, {});
    expect(o.status).toBe('failed');
    expect(o.findings).toHaveLength(1);
    expect(o.findings[0]!.location.file).toBe('app/infra/db.py');
    expect(o.findings[0]!.evidence).not.toContain('A1b2C3d4A1b2');
    expect(o.findings[0]!.tags).toContain('secret');
    expect(findSecrets('password = "changeme"')).toHaveLength(0);
    expect(findSecrets('DB_PASSWORD = "Xk9#mP2vL8qR4tW7zN3"')).toHaveLength(1);
  });
});

describe('pattern', () => {
  it('reports each matching line', async () => {
    const o = await evaluate(patternEvaluator, { pattern: '^\\s*pass$' }, { applies_to: { languages: ['python'], paths: ['app/**'], exclude: [] } });
    expect(o.findings.map((f) => `${f.location.file}:${f.location.start_line}`)).toEqual(['app/domain/order.py:8']);
  });
  it('is not applicable when no files are in scope', async () => {
    const o = await evaluate(patternEvaluator, { pattern: 'x' }, { applies_to: { languages: ['go'], paths: ['**'], exclude: [] } });
    expect(o.status).toBe('not_applicable');
  });
});

describe('imports.forbidden', () => {
  it('catches forbidden packages and layer violations', async () => {
    const o = await evaluate(importsForbiddenEvaluator, { modules: ['requests'], to: ['app/infra/**'] }, { applies_to: { languages: [], paths: ['app/domain/**'], exclude: [] } });
    expect(o.findings.map((f) => f.location.start_line)).toEqual([1, 2]);
  });
});

describe('tests.required and files.required', () => {
  it('flags source files without tests', async () => {
    const o = await evaluate(testsRequiredEvaluator, {}, { applies_to: { languages: ['python'], paths: ['app/domain/**'], exclude: [] } });
    expect(o.findings.map((f) => f.location.file)).toEqual(['app/domain/order.py']);
  });
  it('flags missing repository files', async () => {
    const o = await evaluate(filesRequiredEvaluator, { paths: ['README.md', 'tests/**'] });
    expect(o.findings.map((f) => f.message)).toEqual(['Required file missing: README.md']);
  });
});

describe.skipIf(!hasPython)('python.ast', () => {
  const py = { languages: ['python'], paths: ['**'], exclude: [] };
  it('detects mutable defaults, bare and silent excepts', async () => {
    for (const [check, line] of [['mutable_default', 4], ['bare_except', 7], ['silent_except', 7]] as const) {
      const o = await evaluate(pythonAstEvaluator, { check }, { applies_to: py });
      expect(o.findings.map((f) => `${f.location.file}:${f.location.start_line}`), check).toEqual([`app/domain/order.py:${line}`]);
    }
  });
  it('reports syntax errors only through the syntax_error check', async () => {
    const o = await evaluate(pythonAstEvaluator, { check: 'syntax_error' }, { applies_to: py });
    expect(o.findings.map((f) => f.location.file)).toEqual(['broken.py']);
    const other = await evaluate(pythonAstEvaluator, { check: 'complexity', max: 0 }, { applies_to: py });
    expect(other.findings.some((f) => f.location.file === 'broken.py')).toBe(false);
  });
  it('validates params', () => {
    expect(pythonAstEvaluator.validateParams!({ check: 'complexity' }, rule(pythonAstEvaluator, {}))).toEqual(['check complexity needs a numeric "max"']);
  });
});
