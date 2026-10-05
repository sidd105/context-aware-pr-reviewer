import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Thin wrapper over the git CLI. Everything the reviewer knows about the
// repository comes through here, which keeps the collectors easy to test
// against a throwaway repo.
export class Git {
  constructor(readonly cwd: string) {}

  async run(args: string[]): Promise<string> {
    const { stdout } = await exec('git', args, {
      cwd: this.cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  }

  // Like run(), but treats a non-zero exit as "no output". git grep exits 1
  // when nothing matches and git show fails for paths missing at a ref.
  async tryRun(args: string[]): Promise<string> {
    try {
      return await this.run(args);
    } catch {
      return '';
    }
  }

  async mergeBase(base: string, head: string): Promise<string> {
    return (await this.run(['merge-base', base, head])).trim();
  }

  async diff(base: string, head: string): Promise<string> {
    return this.run(['diff', '--no-color', '--unified=3', '--find-renames', `${base}...${head}`]);
  }

  async show(ref: string, path: string): Promise<string | null> {
    try {
      return await this.run(['show', `${ref}:${path}`]);
    } catch {
      return null;
    }
  }

  async listFiles(ref: string): Promise<string[]> {
    const out = await this.run(['ls-tree', '-r', '--name-only', ref]);
    return out.split('\n').filter(Boolean);
  }

  async log(base: string, head: string): Promise<string> {
    return this.tryRun(['log', '--no-color', '--format=%h %s%n%b', `${base}..${head}`]);
  }

  // Recent history of a file before this change, so the reviewer can see
  // whether the area has been fixed or reverted recently.
  async fileHistory(ref: string, path: string, limit: number): Promise<string> {
    return this.tryRun([
      'log',
      '--no-color',
      `-n${limit}`,
      '--format=%h %ad %s',
      '--date=short',
      ref,
      '--',
      path,
    ]);
  }

  // Whole-word search at a ref. Returns "path:line:text" rows.
  async grepWord(ref: string, word: string): Promise<string[]> {
    const out = await this.tryRun(['grep', '-n', '-w', '-I', '-F', '-e', word, ref, '--']);
    // git grep prefixes each row with "<ref>:" when searching a tree.
    const prefix = `${ref}:`;
    return out
      .split('\n')
      .filter(Boolean)
      .map((row) => (row.startsWith(prefix) ? row.slice(prefix.length) : row));
  }
}
