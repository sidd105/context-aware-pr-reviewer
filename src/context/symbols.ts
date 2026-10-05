// Pulls the names of functions, classes, types and constants that a diff
// declares or changes. Regex-based on purpose: it works across languages with
// no parser dependencies, and a missed symbol only costs a little context.
const DECLARATIONS: RegExp[] = [
  // TS / JS
  /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /\b(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|function|[A-Za-z_$][\w$]*\s*=>)/,
  // class methods: "  async name(" / "  private name(" — but not control flow
  /^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+|override\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/,
  // Python
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^\s*class\s+([A-Za-z_]\w*)/,
  // Go
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  // Java / Kotlin / C#
  /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?(?:final\s+)?[\w<>[\],\s]+\s+([A-Za-z_]\w*)\s*\(/,
];

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor',
  'else', 'do', 'try', 'new', 'typeof', 'await', 'super', 'this', 'main', 'init',
]);

// Names so common that searching for them finds mostly unrelated code.
const GENERIC = new Set([
  'get', 'set', 'has', 'add', 'call', 'run', 'start', 'stop', 'close', 'open', 'read', 'write',
  'load', 'save', 'parse', 'render', 'apply', 'update', 'create', 'delete', 'remove', 'handle',
  'handler', 'connect', 'send', 'emit', 'next', 'done', 'text', 'data', 'value', 'error', 'result',
  'name', 'type', 'list', 'item', 'items', 'config', 'options', 'props', 'state', 'setup', 'reset',
  'test', 'check', 'build', 'process', 'execute', 'fetch', 'format', 'toString', 'toJSON', 'equals',
]);

export function declaredSymbols(lines: string[]): string[] {
  const found = new Set<string>();
  for (const line of lines) {
    for (const pattern of DECLARATIONS) {
      const name = pattern.exec(line)?.[1];
      if (name && name.length >= 3 && !KEYWORDS.has(name) && !GENERIC.has(name)) found.add(name);
    }
  }
  return [...found];
}

// Names that appear in a hunk's "@@ ... @@ function foo()" header. git puts
// the enclosing function there, so a change in the middle of a function still
// tells us which function changed.
export function enclosingSymbols(headers: string[]): string[] {
  return declaredSymbols(headers);
}
