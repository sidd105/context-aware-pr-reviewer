import { posix } from 'node:path';

const JS_IMPORT = [
  /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];
const PY_FROM = /^\s*from\s+(\.*[\w.]*)\s+import\b/gm;
const PY_IMPORT = /^\s*import\s+([\w.]+)/gm;

const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

export function isJsLike(path: string): boolean {
  return JS_EXTENSIONS.some((ext) => path.endsWith(ext));
}

export function importSpecifiers(path: string, source: string): string[] {
  const specs = new Set<string>();
  if (isJsLike(path)) {
    for (const pattern of JS_IMPORT) {
      for (const match of source.matchAll(pattern)) specs.add(match[1]!);
    }
  } else if (path.endsWith('.py')) {
    for (const match of source.matchAll(PY_FROM)) specs.add(match[1]!);
    for (const match of source.matchAll(PY_IMPORT)) specs.add(match[1]!);
  }
  return [...specs];
}

// Resolve an import specifier from `fromPath` to a file in the repository.
// Only local imports resolve; packages from node_modules or site-packages
// return null, which is what we want.
export function resolveImport(fromPath: string, spec: string, files: Set<string>): string | null {
  if (isJsLike(fromPath)) {
    if (!spec.startsWith('.')) return null;
    const base = posix.normalize(posix.join(posix.dirname(fromPath), spec));
    // TS ESM code imports "./x.js" for a file that is really "./x.ts".
    const stem = base.replace(/\.(?:js|mjs|cjs|jsx)$/, '');
    const candidates = [
      base,
      ...JS_EXTENSIONS.map((ext) => stem + ext),
      ...JS_EXTENSIONS.map((ext) => `${base}/index${ext}`),
    ];
    return candidates.find((c) => files.has(c)) ?? null;
  }
  if (fromPath.endsWith('.py')) {
    let dir: string;
    let rest: string;
    const dots = /^\.+/.exec(spec)?.[0].length ?? 0;
    if (dots > 0) {
      dir = posix.dirname(fromPath);
      for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
      rest = spec.slice(dots);
    } else {
      dir = '';
      rest = spec;
    }
    const rel = rest.split('.').filter(Boolean).join('/');
    const base = rel ? posix.join(dir, rel) : dir;
    const candidates = [`${base}.py`, `${base}/__init__.py`].map((c) => c.replace(/^\.\//, ''));
    return candidates.find((c) => files.has(c)) ?? null;
  }
  return null;
}

// Likely test files for a source file, by the common naming conventions.
export function testCandidates(path: string): string[] {
  const dir = posix.dirname(path);
  const ext = posix.extname(path);
  const name = posix.basename(path, ext);
  const out: string[] = [];
  if (isJsLike(path)) {
    for (const kind of ['test', 'spec']) {
      out.push(posix.join(dir, `${name}.${kind}${ext}`));
      out.push(posix.join(dir, '__tests__', `${name}.${kind}${ext}`));
      out.push(posix.join(dir, '__tests__', `${name}${ext}`));
      out.push(posix.join('test', `${name}.${kind}${ext}`));
      out.push(posix.join('tests', `${name}.${kind}${ext}`));
    }
    // src/a/b.ts -> tests/a/b.test.ts
    if (dir.startsWith('src/') || dir === 'src') {
      const sub = dir.replace(/^src\/?/, '');
      for (const root of ['test', 'tests']) {
        out.push(posix.join(root, sub, `${name}.test${ext}`));
        out.push(posix.join(root, sub, `${name}.spec${ext}`));
      }
    }
  } else if (ext === '.py') {
    out.push(posix.join(dir, `test_${name}.py`));
    out.push(posix.join(dir, `${name}_test.py`));
    out.push(posix.join('tests', `test_${name}.py`));
    out.push(posix.join(dir, 'tests', `test_${name}.py`));
  } else if (ext === '.go') {
    out.push(posix.join(dir, `${name}_test.go`));
  }
  return [...new Set(out.map((p) => posix.normalize(p)))];
}

export function isTestFile(path: string): boolean {
  return /(?:^|\/)(?:__tests__|tests?)\//.test(path) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /(?:^|\/)test_[^/]+\.py$/.test(path) ||
    /_test\.(?:py|go)$/.test(path);
}
