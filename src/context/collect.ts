import { posix } from 'node:path';
import { matcher } from '../config/glob.js';
import { changedLines, filePath, parseUnifiedDiff, type FileDiff } from '../diff.js';
import type { Git } from '../git.js';
import { importSpecifiers, isJsLike, isTestFile, resolveImport, testCandidates } from './imports.js';
import { declaredSymbols, enclosingSymbols } from './symbols.js';
import type { ContextItem } from './types.js';

export interface CollectOptions {
  ignore: string[];
  conventionFiles: string[];
  maxCallSitesPerSymbol: number;
  historyCommits: number;
  rules: string[];
}

export const DEFAULT_COLLECT_OPTIONS: CollectOptions = {
  ignore: [],
  conventionFiles: ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', 'docs/adr/**/*.md', 'docs/decisions/**/*.md'],
  maxCallSitesPerSymbol: 8,
  historyCommits: 5,
  rules: [],
};

export interface CollectInput {
  git: Git;
  base: string;
  head: string;
  config: CollectOptions;
  prTitle?: string;
  prBody?: string;
}

export interface CollectedContext {
  files: FileDiff[];
  items: ContextItem[];
  signals: string[];
}

// Above this many hits a name is too generic ("get", "data") for its call
// sites to be useful context.
const MAX_SYMBOL_HITS = 60;
const SNIPPET_RADIUS = 3;
const EXCERPT_RADIUS = 20;

export async function collectContext(input: CollectInput): Promise<CollectedContext> {
  const { git, base, head, config } = input;
  const ignored = matcher(config.ignore);
  const mergeBase = await git.mergeBase(base, head);
  const files = parseUnifiedDiff(await git.diff(base, head)).filter((f) => !ignored(filePath(f)));
  const headFiles = new Set((await git.listFiles(head)).filter((p) => !ignored(p)));
  const changedPaths = new Set(files.map(filePath));

  const items: ContextItem[] = [];
  const signals: string[] = [];
  const headSource = cachedReader(git, head);

  // ---- What the author says the change is -------------------------------
  if (input.prTitle || input.prBody) {
    items.push({
      id: 'pr-description',
      kind: 'pr-description',
      title: 'Pull request description',
      content: [input.prTitle && `# ${input.prTitle}`, input.prBody].filter(Boolean).join('\n\n'),
      score: 100,
      required: true,
      reasons: ['States the intent the change should be reviewed against'],
    });
  }
  const commits = (await git.log(mergeBase, head)).trim();
  if (commits) {
    items.push({
      id: 'commits',
      kind: 'commits',
      title: 'Commits in this change',
      content: commits,
      score: 100,
      required: true,
      reasons: ['Commit messages often explain intent the description leaves out'],
    });
  }
  if (config.rules.length > 0) {
    items.push({
      id: 'rules',
      kind: 'rules',
      title: 'Team review rules',
      content: config.rules.map((r, i) => `${i + 1}. ${r}`).join('\n'),
      score: 100,
      required: true,
      reasons: ['Configured in .prreview.json; every change is checked against them'],
    });
  }
  items.push({
    id: 'diff',
    kind: 'diff',
    title: 'Diff',
    content: files.map((f) => f.raw).join('\n'),
    score: 100,
    required: true,
    reasons: ['The change under review'],
  });

  // ---- The changed files in full ----------------------------------------
  for (const file of files) {
    if (file.binary || file.status === 'deleted' || !file.newPath) continue;
    const source = await headSource(file.newPath);
    if (source === null) continue;
    items.push({
      id: `changed:${file.newPath}`,
      kind: 'changed-file',
      title: `${file.newPath} (after the change)`,
      path: file.newPath,
      content: source,
      score: 90,
      reasons: ['Changed in this PR; the full file shows code around the hunks'],
      fallback: { content: excerptAroundHunks(source, file), note: `±${EXCERPT_RADIUS} lines around each hunk` },
    });
  }

  // ---- Who calls what changed -------------------------------------------
  // Test files declare helpers, not API, so their symbols aren't followed.
  const symbolsByFile = new Map<string, { added: string[]; removed: string[] }>();
  for (const file of files) {
    if (isTestFile(filePath(file))) continue;
    const { added, removed } = changedLines(file);
    const headers = file.hunks.map((h) => h.header);
    const addedSymbols = new Set([...declaredSymbols(added), ...enclosingSymbols(headers)]);
    const removedSymbols = declaredSymbols(removed).filter((s) => !addedSymbols.has(s));
    symbolsByFile.set(filePath(file), { added: [...addedSymbols], removed: removedSymbols });
  }

  // One entry per symbol, even when several changed files mention it (a type
  // and the barrel file that re-exports it, say).
  const symbols = new Map<string, { paths: string[]; removed: boolean }>();
  for (const [path, { added, removed }] of symbolsByFile) {
    for (const symbol of [...removed, ...added]) {
      const entry = symbols.get(symbol) ?? { paths: [], removed: false };
      entry.paths.push(path);
      entry.removed ||= removed.includes(symbol);
      symbols.set(symbol, entry);
    }
  }

  for (const [symbol, { paths, removed: isRemoved }] of symbols) {
    const where = paths.join(', ');
    const hits = (await git.grepWord(head, symbol))
      .map(parseGrepRow)
      .filter((h): h is GrepHit => h !== null && !paths.includes(h.path) && !ignored(h.path) && headFiles.has(h.path));
    if (hits.length === 0) continue;
    if (hits.length > MAX_SYMBOL_HITS) {
      signals.push(`\`${symbol}\` (changed in ${where}) is referenced in ${hits.length} places; too many to include.`);
      continue;
    }
    if (isRemoved) {
      const users = [...new Set(hits.map((h) => h.path))].slice(0, 5).join(', ');
      signals.push(`\`${symbol}\` was removed or renamed in ${where} but is still referenced in: ${users}.`);
    }
    const snippets: string[] = [];
    const byFile = groupBy(hits.slice(0, config.maxCallSitesPerSymbol), (h) => h.path);
    for (const [hitPath, fileHits] of byFile) {
      const source = await headSource(hitPath);
      if (source === null) continue;
      snippets.push(snippetBlock(hitPath, source, fileHits.map((h) => h.line)));
    }
    const extra = hits.length - Math.min(hits.length, config.maxCallSitesPerSymbol);
    items.push({
      id: `calls:${symbol}`,
      kind: 'call-sites',
      title: `Uses of \`${symbol}\` outside ${where}`,
      content: snippets.join('\n\n') + (extra > 0 ? `\n\n…and ${extra} more` : ''),
      score: isRemoved ? 95 : 80,
      reasons: [
        isRemoved
          ? `\`${symbol}\` was removed or renamed but other files still use it`
          : `\`${symbol}\` changed; these callers may depend on the old behaviour`,
      ],
    });
  }

  // ---- Imports in both directions ---------------------------------------
  const dependencies = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  for (const file of files) {
    if (!file.newPath || file.status === 'deleted') continue;
    const source = await headSource(file.newPath);
    if (source === null) continue;
    for (const spec of importSpecifiers(file.newPath, source)) {
      const target = resolveImport(file.newPath, spec, headFiles);
      if (target && !changedPaths.has(target)) push(dependencies, target, file.newPath);
    }
  }
  for (const file of files) {
    const path = filePath(file);
    const stem = posix.basename(path).replace(/\.[^.]+$/, '');
    if (stem.length < 3 || stem === 'index' || stem === '__init__') continue;
    const candidates = new Set((await git.grepWord(head, stem)).map(parseGrepRow).flatMap((h) => (h ? [h.path] : [])));
    for (const candidate of candidates) {
      if (candidate === path || changedPaths.has(candidate) || !headFiles.has(candidate)) continue;
      if (isJsLike(candidate) !== isJsLike(path)) continue;
      const source = await headSource(candidate);
      if (source === null) continue;
      const imports = importSpecifiers(candidate, source).map((s) => resolveImport(candidate, s, headFiles));
      // A deleted file is gone from the head tree, so resolve it by name.
      const target = file.status === 'deleted' ? path : file.newPath;
      if (imports.includes(target) || (file.status === 'deleted' && importsByName(candidate, source, path))) {
        push(dependents, candidate, path);
      }
    }
  }

  // A file can be both imported by and importing changed code; it gets one
  // item that says both.
  for (const path of new Set([...dependencies.keys(), ...dependents.keys()])) {
    const source = await headSource(path);
    if (source === null) continue;
    const importers = dependencies.get(path) ?? [];
    const targets = dependents.get(path) ?? [];
    const deleted = targets.filter((t) => !headFiles.has(t));
    if (deleted.length > 0) signals.push(`${path} imports ${deleted.join(', ')}, which this PR deletes.`);
    const reasons: string[] = [];
    if (targets.length > 0) reasons.push(`Imports ${targets.join(', ')}; may break if their behaviour changed`);
    if (importers.length > 0) reasons.push(`Imported by ${importers.join(', ')}; shows the contracts the change relies on`);
    const isDependent = targets.length > 0;
    items.push({
      id: `${isDependent ? 'dependent' : 'dep'}:${path}`,
      kind: isDependent ? 'dependent' : 'dependency',
      title: `${path} (${isDependent ? 'imports changed code' : 'imported by changed code'})`,
      path,
      content: source,
      score: deleted.length > 0 ? 92 : isDependent ? 55 + Math.min(targets.length, 5) * 2 : 50 + Math.min(importers.length, 5) * 2,
      reasons,
      fallback: isDependent
        ? { content: importLines(path, source), note: 'import lines only' }
        : { content: exportedSurface(source), note: 'declarations only' },
    });
  }

  // ---- Tests --------------------------------------------------------------
  const changedSources = files.filter((f) => !isTestFile(filePath(f)) && f.status !== 'deleted');
  const changedTests = files.filter((f) => isTestFile(filePath(f)));
  for (const file of changedSources) {
    for (const candidate of testCandidates(filePath(file))) {
      if (!headFiles.has(candidate) || changedPaths.has(candidate)) continue;
      const source = await headSource(candidate);
      if (source === null) continue;
      items.push({
        id: `test:${candidate}`,
        kind: 'test',
        title: `${candidate} (existing tests, not changed)`,
        path: candidate,
        content: source,
        score: 70,
        reasons: [`Tests for ${filePath(file)}; shows what behaviour is pinned down and what isn't`],
      });
    }
  }
  const codeChanged = changedSources.some((f) => f.hunks.length > 0 && looksLikeCode(filePath(f)));
  if (codeChanged && changedTests.length === 0) {
    signals.push('Source files changed but no test files did.');
  }

  // ---- How the team works -------------------------------------------------
  const isConvention = matcher(config.conventionFiles);
  const keywords = changeKeywords(files, symbolsByFile);
  for (const path of headFiles) {
    if (!isConvention(path) || changedPaths.has(path)) continue;
    const source = await headSource(path);
    if (source === null) continue;
    const overlap = keywordOverlap(source, keywords);
    const general = /(?:^|\/)(?:CLAUDE|AGENTS|CONTRIBUTING)\.md$/.test(path);
    if (!general && overlap.length === 0) continue;
    items.push({
      id: `convention:${path}`,
      kind: 'convention',
      title: path,
      path,
      content: source,
      score: (general ? 60 : 35) + Math.min(overlap.length, 10) * 3,
      reasons: [
        general ? 'Project-wide guidance for contributors' : 'Design document for this area',
        ...(overlap.length > 0 ? [`Mentions ${overlap.slice(0, 5).join(', ')}`] : []),
      ],
    });
  }

  // ---- Recent history of the touched files --------------------------------
  const history: string[] = [];
  for (const file of files) {
    const path = file.oldPath ?? filePath(file);
    const log = (await git.fileHistory(mergeBase, path, config.historyCommits)).trim();
    if (!log) continue;
    history.push(`${path}\n${indent(log)}`);
    const risky = log.split('\n').filter((l) => /\b(?:revert|hotfix|fix|bug|regression|incident)\b/i.test(l));
    if (risky.length >= 2) {
      signals.push(`${path} has ${risky.length} recent fix/revert commits; it may be fragile.`);
    }
  }
  if (history.length > 0) {
    items.push({
      id: 'history',
      kind: 'history',
      title: 'Recent commits touching these files',
      content: history.join('\n\n'),
      score: 30,
      reasons: ['Recent fixes and reverts point at fragile areas'],
    });
  }

  if (signals.length > 0) {
    items.push({
      id: 'signals',
      kind: 'signals',
      title: 'Things noticed while gathering context',
      content: signals.map((s) => `- ${s}`).join('\n'),
      score: 100,
      required: true,
      reasons: ['Mechanical checks worth confirming during review'],
    });
  }

  return { files, items, signals };
}

// ---- helpers ---------------------------------------------------------------

interface GrepHit {
  path: string;
  line: number;
}

function parseGrepRow(row: string): GrepHit | null {
  const match = /^(.+?):(\d+):/.exec(row);
  return match ? { path: match[1]!, line: Number(match[2]) } : null;
}

function cachedReader(git: Git, ref: string) {
  const cache = new Map<string, Promise<string | null>>();
  return (path: string) => {
    let hit = cache.get(path);
    if (!hit) {
      hit = git.show(ref, path).then((s) => (s !== null && s.includes('\0') ? null : s));
      cache.set(path, hit);
    }
    return hit;
  };
}

function groupBy<T>(values: T[], key: (v: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const v of values) push(out, key(v), v);
  return out;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) {
    if (!list.includes(value)) list.push(value);
  } else {
    map.set(key, [value]);
  }
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
}

// Numbered lines from `source` covering each wanted line ± radius, with
// "…" between gaps.
export function numberedWindows(source: string, wanted: number[], radius: number): string {
  const lines = source.split('\n');
  const keep = new Set<number>();
  for (const n of wanted) {
    for (let i = Math.max(1, n - radius); i <= Math.min(lines.length, n + radius); i++) keep.add(i);
  }
  const sorted = [...keep].sort((a, b) => a - b);
  const out: string[] = [];
  let prev = 0;
  for (const n of sorted) {
    if (prev && n !== prev + 1) out.push('    …');
    out.push(`${String(n).padStart(5)}  ${lines[n - 1]}`);
    prev = n;
  }
  return out.join('\n');
}

function snippetBlock(path: string, source: string, lines: number[]): string {
  return `${path}\n${numberedWindows(source, lines, SNIPPET_RADIUS)}`;
}

function excerptAroundHunks(source: string, file: FileDiff): string {
  const wanted: number[] = [];
  for (const h of file.hunks) {
    for (let n = h.newStart; n < h.newStart + Math.max(h.newLines, 1); n++) wanted.push(n);
  }
  return numberedWindows(source, wanted, EXCERPT_RADIUS);
}

function exportedSurface(source: string): string {
  const lines = source.split('\n');
  const keep: number[] = [];
  lines.forEach((line, i) => {
    if (declaredSymbols([line]).length > 0 || /^\s*export\b/.test(line)) keep.push(i + 1);
  });
  return numberedWindows(source, keep, 0);
}

function importLines(path: string, source: string): string {
  const lines = source.split('\n');
  const keep: number[] = [];
  lines.forEach((line, i) => {
    if (importSpecifiers(path, line).length > 0) keep.push(i + 1);
  });
  return numberedWindows(source, keep, 0);
}

function importsByName(path: string, source: string, deletedPath: string): boolean {
  const stem = deletedPath.replace(/\.[^.]+$/, '');
  return importSpecifiers(path, source).some((spec) => {
    if (!spec.startsWith('.')) return false;
    const resolved = posix.normalize(posix.join(posix.dirname(path), spec)).replace(/\.[^./]+$/, '');
    return resolved === stem;
  });
}

function looksLikeCode(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?|py|go|rb|java|kt|cs|php|rs|swift|scala)$/.test(path);
}

const STOPWORDS = new Set(['src', 'lib', 'index', 'test', 'tests', 'main', 'app', 'utils', 'util', 'types']);

function changeKeywords(files: FileDiff[], symbols: Map<string, { added: string[]; removed: string[] }>): string[] {
  const words = new Set<string>();
  for (const file of files) {
    for (const part of filePath(file).split(/[/._-]/)) {
      if (part.length >= 4 && !STOPWORDS.has(part.toLowerCase())) words.add(part.toLowerCase());
    }
  }
  for (const { added, removed } of symbols.values()) {
    for (const s of [...added, ...removed]) words.add(s.toLowerCase());
  }
  return [...words];
}

function keywordOverlap(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase();
  return keywords.filter((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower));
}
