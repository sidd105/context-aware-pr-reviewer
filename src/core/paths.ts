import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Root of this package, found by walking up to package.json. Works the same
// from src/ under tsx and from dist/ after a build.
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Could not find the package root');
    dir = parent;
  }
  return dir;
}
