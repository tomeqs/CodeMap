import { resolve, sep } from 'node:path';

/**
 * File patterns of Tuist, XcodeGen and CocoaPods (`Sources/**`, `App/**\/*.swift`, `Classes/*.{h,m,swift}`) as
 * matchers of full paths: `**` any folders, `*` and `?` within a name, `{a,b}` alternatives. A pattern without a
 * wildcard names a file or everything in a folder. `base` is the folder the patterns are relative to.
 *   { roots: [folders the patterns start in], matches(path) }
 */
export function globMatcher(base, patterns) {
  const compiled = patterns.filter((p) => typeof p === 'string' && p.trim()).map((pattern) => {
    const full = toPosix(resolve(base, pattern.trim()));
    const wild = full.search(/[*?{[]/);
    if (wild < 0) return { root: full, re: new RegExp(`^${escape(full)}(/.*)?$`) };
    const root = full.slice(0, full.lastIndexOf('/', wild)) || '/';
    return { root, re: new RegExp(`^${translate(full)}$`) };
  });
  return {
    roots: compiled.map((c) => c.root),
    matches: (path) => {
      const posix = toPosix(path);
      return compiled.some((c) => c.re.test(posix));
    },
  };
}

function translate(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const slash = pattern[i + 2] === '/';
        out += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end < 0) {
        out += '\\{';
        continue;
      }

      out += `(?:${pattern.slice(i + 1, end).split(',').map(escape).join('|')})`;
      i = end;
    } else {
      out += escape(c);
    }
  }

  return out;
}

function escape(text) {
  return text.replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
}

function toPosix(path) {
  return path.split(sep).join('/');
}
