import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { matcher } from '../config/glob.js';
import { Git } from '../git.js';
import type { ResolvedRule } from './model.js';

const LANGUAGES: Record<string, string> = {
  '.py': 'python',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.cs': 'csharp',
  '.php': 'php',
  '.tf': 'terraform',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
  '.md': 'markdown',
  '.sh': 'shell',
  '.sql': 'sql',
};

export function languageOf(path: string): string | undefined {
  if (/(?:^|\/)Dockerfile$/.test(path)) return 'dockerfile';
  return LANGUAGES[extname(path).toLowerCase()];
}

export interface DiffScope {
  base: string;
  head: string;
  changedFiles: string[];
}

// Read-only view of the repository under assessment. Evaluators get files
// through here so exclusions apply everywhere and reads are cached.
export class Workspace {
  private cache = new Map<string, Promise<string | null>>();
  readonly git: Git;

  private constructor(
    readonly root: string,
    readonly files: string[],
    readonly commit: string | null,
    readonly diff: DiffScope | null,
  ) {
    this.git = new Git(root);
  }

  static async open(root: string, options: { exclude: string[]; diff?: { base: string; head: string } }): Promise<Workspace> {
    const git = new Git(root);
    const excluded = matcher(options.exclude);
    let files: string[];
    let commit: string | null = null;
    try {
      // Tracked plus untracked-but-not-ignored, so local runs see new files.
      const out = await git.run(['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
      files = [...new Set(out.split('\0').filter(Boolean))];
      commit = (await git.tryRun(['rev-parse', 'HEAD'])).trim() || null;
    } catch {
      throw new Error(`${root} is not a git repository. Assessments run against a git working tree.`);
    }
    files = files.filter((f) => !excluded(f)).sort();
    let diff: DiffScope | null = null;
    if (options.diff) {
      const changed = await git.run(['diff', '--name-only', `${options.diff.base}...${options.diff.head}`]);
      diff = { ...options.diff, changedFiles: changed.split('\n').filter((f) => f && !excluded(f)) };
    }
    return new Workspace(root, files, commit, diff);
  }

  read(path: string): Promise<string | null> {
    let hit = this.cache.get(path);
    if (!hit) {
      hit = readFile(join(this.root, path), 'utf8')
        .then((s) => (s.includes('\0') ? null : s))
        .catch(() => null);
      this.cache.set(path, hit);
    }
    return hit;
  }

  // Files a rule applies to. In diff mode only changed files are in scope for
  // file-level rules; repository-level rules decide for themselves.
  filesFor(rule: Pick<ResolvedRule, 'applies_to'>, options: { diffOnly?: boolean } = {}): string[] {
    const include = matcher(rule.applies_to.paths);
    const exclude = matcher(rule.applies_to.exclude);
    const langs = rule.applies_to.languages;
    const pool = options.diffOnly !== false && this.diff ? this.diff.changedFiles.filter((f) => this.files.includes(f)) : this.files;
    return pool.filter((f) => include(f) && !exclude(f) && (langs.length === 0 || langs.includes(languageOf(f) ?? '')));
  }
}
