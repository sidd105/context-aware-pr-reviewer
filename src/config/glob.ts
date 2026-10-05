// Minimal glob support: "**" crosses directories, "*" does not, "?" is one
// character. Enough for ignore lists without another dependency.
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        out += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

export function matcher(globs: string[]): (path: string) => boolean {
  const patterns = globs.map(globToRegExp);
  return (path) => patterns.some((p) => p.test(path));
}
