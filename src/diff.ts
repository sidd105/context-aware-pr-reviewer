export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: string[];
}

export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed';

export interface FileDiff {
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  binary: boolean;
  hunks: Hunk[];
  raw: string;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function stripPrefix(path: string): string | null {
  if (path === '/dev/null') return null;
  return path.replace(/^[ab]\//, '');
}

export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let rawLines: string[] = [];

  const finish = () => {
    if (current) {
      current.raw = rawLines.join('\n');
      files.push(current);
    }
  };

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      finish();
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      current = {
        oldPath: match?.[1] ?? null,
        newPath: match?.[2] ?? null,
        status: 'modified',
        binary: false,
        hunks: [],
        raw: '',
      };
      hunk = null;
      rawLines = [line];
      continue;
    }
    if (!current) continue;
    rawLines.push(line);

    if (hunk) {
      if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line.startsWith('\\')) {
        hunk.lines.push(line);
        continue;
      }
      if (line === '') {
        // git emits a bare empty line for an empty context line in some configs.
        hunk.lines.push(' ');
        continue;
      }
      hunk = null;
    }

    const header = HUNK_HEADER.exec(line);
    if (header) {
      hunk = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        header: (header[5] ?? '').trim(),
        lines: [],
      };
      current.hunks.push(hunk);
    } else if (line.startsWith('new file mode')) {
      current.status = 'added';
      current.oldPath = null;
    } else if (line.startsWith('deleted file mode')) {
      current.status = 'deleted';
      current.newPath = null;
    } else if (line.startsWith('rename from ')) {
      current.status = 'renamed';
      current.oldPath = line.slice('rename from '.length);
    } else if (line.startsWith('rename to ')) {
      current.newPath = line.slice('rename to '.length);
    } else if (line.startsWith('Binary files')) {
      current.binary = true;
    } else if (line.startsWith('--- ')) {
      if (current.status !== 'added') current.oldPath = stripPrefix(line.slice(4));
    } else if (line.startsWith('+++ ')) {
      if (current.status !== 'deleted') current.newPath = stripPrefix(line.slice(4));
    }
  }
  finish();
  // Trailing newline in git output leaves an empty context line on the last hunk.
  for (const file of files) {
    const last = file.hunks.at(-1);
    if (last && last.lines.at(-1) === ' ') last.lines.pop();
  }
  return files;
}

export function filePath(file: FileDiff): string {
  return (file.newPath ?? file.oldPath)!;
}

// Lines added or removed, without the +/- marker.
export function changedLines(file: FileDiff): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added.push(line.slice(1));
      else if (line.startsWith('-')) removed.push(line.slice(1));
    }
  }
  return { added, removed };
}

// Line numbers in the new file that the diff touches. Used to check whether a
// finding the model reports actually points at changed code.
export function addedLineNumbers(file: FileDiff): Set<number> {
  const result = new Set<number>();
  for (const hunk of file.hunks) {
    let n = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        result.add(n);
        n++;
      } else if (line.startsWith(' ')) {
        n++;
      }
    }
  }
  return result;
}
