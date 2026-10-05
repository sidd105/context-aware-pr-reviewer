import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectContext, DEFAULT_COLLECT_OPTIONS, type CollectedContext } from '../src/context/collect.js';
import { packContext } from '../src/context/pack.js';
import { Git } from '../src/git.js';

// A small payments repo. On the feature branch `toCents` is renamed to
// `toMinorUnits` and its rounding changes, but checkout.ts still calls the old
// name and nobody touches the tests.
let dir: string;
let collected: CollectedContext;

function write(path: string, content: string) {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function git(...args: string[]) {
  execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'prr-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');

  write('src/money.ts', 'export function toCents(amount: number): number {\n  return amount * 100;\n}\n');
  write(
    'src/checkout.ts',
    "import { toCents } from './money.js';\n\nexport function total(prices: number[]) {\n  return prices.map(toCents).reduce((a, b) => a + b, 0);\n}\n",
  );
  write('src/unrelated.ts', 'export const answer = 42;\n');
  write('tests/money.test.ts', "import { toCents } from '../src/money.js';\n// expects toCents(1.1) === 110\n");
  write('CONTRIBUTING.md', '# Contributing\n\nMoney is always stored in integer minor units.\n');
  write('docs/adr/0001-money.md', '# Money\n\nWe use toCents everywhere so amounts are integers.\n');
  write('docs/adr/0002-logging.md', '# Logging\n\nUse structured logs.\n');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');

  write('src/money.ts', 'export function toMinorUnits(amount: number): number {\n  return Math.round(amount * 100);\n}\n');
  git('checkout', '-q', '-b', 'feature');
  git('commit', '-q', '-am', 'Rename toCents and round');

  collected = await collectContext({
    git: new Git(dir),
    base: 'main',
    head: 'feature',
    config: { ...DEFAULT_COLLECT_OPTIONS, rules: ['Money values are integers in minor units.'] },
    prTitle: 'Round cents',
    prBody: 'Fixes float drift.',
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ids = () => collected.items.map((i) => i.id);

describe('collectContext', () => {
  it('always includes the description, commits, rules and diff', () => {
    for (const id of ['pr-description', 'commits', 'rules', 'diff']) expect(ids()).toContain(id);
  });

  it('includes the changed file with a hunk excerpt fallback', () => {
    const changed = collected.items.find((i) => i.id === 'changed:src/money.ts');
    expect(changed?.content).toContain('toMinorUnits');
    expect(changed?.fallback?.content).toContain('Math.round');
  });

  it('finds callers of a removed symbol and flags them', () => {
    const calls = collected.items.find((i) => i.id === 'calls:toCents');
    expect(calls?.score).toBe(95);
    expect(calls?.content).toContain('src/checkout.ts');
    expect(collected.signals.some((s) => s.includes('`toCents` was removed or renamed'))).toBe(true);
  });

  it('includes files that import the changed file', () => {
    expect(ids()).toContain('dependent:src/checkout.ts');
    expect(ids()).not.toContain('dependent:src/unrelated.ts');
  });

  it('includes the existing tests and notes that none changed', () => {
    expect(ids()).toContain('test:tests/money.test.ts');
    expect(collected.signals).toContain('Source files changed but no test files did.');
  });

  it('picks conventions that relate to the change', () => {
    expect(ids()).toContain('convention:CONTRIBUTING.md');
    expect(ids()).toContain('convention:docs/adr/0001-money.md');
    expect(ids()).not.toContain('convention:docs/adr/0002-logging.md');
  });

  it('packs within a budget and lists what it dropped', () => {
    const pack = packContext(collected.items, 20);
    expect(pack.items.some((i) => i.id === 'diff')).toBe(true);
    expect(pack.dropped.length).toBeGreaterThan(0);
  });
});
