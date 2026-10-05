import { describe, expect, it } from 'vitest';
import { globToRegExp } from '../src/config/glob.js';
import { importSpecifiers, isTestFile, resolveImport, testCandidates } from '../src/context/imports.js';
import { estimateTokens, packContext } from '../src/context/pack.js';
import { declaredSymbols } from '../src/context/symbols.js';
import type { ContextItem } from '../src/context/types.js';
import { addedLineNumbers, changedLines, parseUnifiedDiff } from '../src/diff.js';

const DIFF = `diff --git a/src/money.ts b/src/money.ts
index 1111111..2222222 100644
--- a/src/money.ts
+++ b/src/money.ts
@@ -1,4 +1,5 @@ export function toCents(amount: number) {
 export function toCents(amount: number) {
-  return amount * 100;
+  // round to avoid 0.1 + 0.2 drift
+  return Math.round(amount * 100);
 }

diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 3333333..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const legacy = () => 1;
diff --git a/src/a.ts b/src/b.ts
similarity index 90%
rename from src/a.ts
rename to src/b.ts
`;

describe('parseUnifiedDiff', () => {
  const files = parseUnifiedDiff(DIFF);

  it('reads modified, deleted and renamed files', () => {
    expect(files.map((f) => [f.status, f.oldPath, f.newPath])).toEqual([
      ['modified', 'src/money.ts', 'src/money.ts'],
      ['deleted', 'src/old.ts', null],
      ['renamed', 'src/a.ts', 'src/b.ts'],
    ]);
  });

  it('tracks hunk headers and changed lines', () => {
    const money = files[0]!;
    expect(money.hunks[0]!.header).toBe('export function toCents(amount: number) {');
    expect(changedLines(money).removed).toEqual(['  return amount * 100;']);
    expect(addedLineNumbers(money)).toEqual(new Set([2, 3]));
  });
});

describe('declaredSymbols', () => {
  it('finds declarations across languages', () => {
    expect(
      declaredSymbols([
        'export async function chargeCard(id: string) {',
        'export const refund = async (id) => {',
        'export interface Payment {',
        'class Ledger:',
        'def settle_batch(batch):',
        'func (s *Server) HandleCharge(w http.ResponseWriter) {',
        '  private applyFee(amount: number): number {',
        '  if (x) {',
      ]),
    ).toEqual(['chargeCard', 'refund', 'Payment', 'Ledger', 'settle_batch', 'HandleCharge', 'applyFee']);
  });
});

describe('imports', () => {
  const files = new Set(['src/money.ts', 'src/lib/index.ts', 'pkg/util.py', 'pkg/__init__.py', 'pkg/sub/mod.py']);

  it('extracts JS and Python specifiers', () => {
    expect(importSpecifiers('a.ts', `import { x } from './money.js';\nexport * from "./lib";\nconst y = require('fs');`)).toEqual([
      './money.js',
      './lib',
      'fs',
    ]);
    expect(importSpecifiers('a.py', 'from .util import f\nimport pkg.sub.mod\n')).toEqual(['.util', 'pkg.sub.mod']);
  });

  it('resolves local imports, including .js specifiers for .ts files', () => {
    expect(resolveImport('src/cli.ts', './money.js', files)).toBe('src/money.ts');
    expect(resolveImport('src/cli.ts', './lib', files)).toBe('src/lib/index.ts');
    expect(resolveImport('src/cli.ts', 'zod', files)).toBeNull();
    expect(resolveImport('pkg/sub/mod.py', '..util', files)).toBe('pkg/util.py');
    expect(resolveImport('main.py', 'pkg.sub.mod', files)).toBe('pkg/sub/mod.py');
  });

  it('guesses test file locations', () => {
    expect(testCandidates('src/billing/money.ts')).toContain('tests/billing/money.test.ts');
    expect(testCandidates('src/billing/money.ts')).toContain('src/billing/money.test.ts');
    expect(testCandidates('pkg/util.py')).toContain('pkg/test_util.py');
    expect(isTestFile('tests/billing/money.test.ts')).toBe(true);
    expect(isTestFile('src/billing/money.ts')).toBe(false);
  });
});

describe('globToRegExp', () => {
  it('matches like a gitignore-style glob', () => {
    expect(globToRegExp('**/package-lock.json').test('package-lock.json')).toBe(true);
    expect(globToRegExp('**/package-lock.json').test('a/b/package-lock.json')).toBe(true);
    expect(globToRegExp('dist/**').test('dist/x/y.js')).toBe(true);
    expect(globToRegExp('docs/adr/*.md').test('docs/adr/x/y.md')).toBe(false);
  });
});

describe('packContext', () => {
  const item = (id: string, size: number, score: number, extra: Partial<ContextItem> = {}): ContextItem => ({
    id,
    kind: 'dependency',
    title: id,
    content: 'x'.repeat(size * 4),
    score,
    reasons: [],
    ...extra,
  });

  it('always keeps required items and fills the rest by score, filling gaps with smaller items', () => {
    const pack = packContext(
      [item('diff', 500, 100, { required: true }), item('low', 40, 10), item('high', 60, 90), item('mid', 50, 50)],
      100,
    );
    // high (60) goes in, mid (50) doesn't fit, low (40) fills what's left.
    expect(pack.items.map((i) => i.id)).toEqual(['diff', 'high', 'low']);
    expect(pack.dropped.map((d) => d.id)).toEqual(['mid']);
    expect(pack.used).toBe(100);
  });

  it('uses the fallback when the full item does not fit', () => {
    const pack = packContext([item('big', 500, 90, { fallback: { content: 'y'.repeat(80), note: 'excerpt' } })], 100);
    expect(pack.items[0]!.usedFallback).toBe(true);
    expect(pack.items[0]!.title).toBe('big [excerpt]');
    expect(pack.used).toBe(estimateTokens('y'.repeat(80)));
  });
});
