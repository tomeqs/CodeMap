/**
 * The YAML that XcodeGen's project.yml files use: block mappings and sequences by indentation, flow sequences and
 * mappings (`[a, b]`, `{ path: x }`), plain and quoted scalars, comments. Anchors, aliases, tags and multi-line
 * scalars are not read (their values come back as text or are skipped). Returns plain objects, arrays and strings.
 */
export function parseYaml(text) {
  const lines = [];
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line.trim() || line.trim() === '---' || line.trim() === '...') continue;
    lines.push({ indent: line.length - line.trimStart().length, text: line.trim() });
  }

  const state = { lines, i: 0 };
  return lines.length ? block(state, lines[0].indent) : null;
}

/** A line without its comment: `#` at the start or after a space, outside quotes. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd();
    }
  }

  return line.trimEnd();
}

/** The mapping or sequence whose lines start at `indent`. */
function block(state, indent) {
  const first = state.lines[state.i];
  if (!first) return null;
  return first.text.startsWith('- ') || first.text === '-' ? sequence(state, indent) : mapping(state, indent);
}

function sequence(state, indent) {
  const out = [];
  while (state.i < state.lines.length) {
    const line = state.lines[state.i];
    if (line.indent < indent || !(line.text.startsWith('- ') || line.text === '-')) break;
    if (line.indent > indent) {
      state.i++;
      continue;
    }

    const rest = line.text === '-' ? '' : line.text.slice(2).trim();
    state.i++;
    if (!rest) {
      const next = state.lines[state.i];
      out.push(next && next.indent > indent ? block(state, next.indent) : null);
    } else if (keyOf(rest) !== null) {
      // `- path: x` and the keys under it: a mapping that starts on the dash's line.
      const inner = indent + 2;
      state.lines.splice(state.i, 0, { indent: inner, text: rest });
      out.push(mapping(state, inner));
    } else {
      out.push(scalar(rest));
    }
  }

  return out;
}

function mapping(state, indent) {
  const out = {};
  while (state.i < state.lines.length) {
    const line = state.lines[state.i];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      state.i++;
      continue;
    }

    const key = keyOf(line.text);
    if (key === null) break;
    const rest = line.text.slice(key.length).replace(/^\s*:/, '').trim();
    state.i++;
    const name = unquote(key.trim());
    if (rest && !rest.startsWith('&') && !rest.startsWith('|') && !rest.startsWith('>')) {
      out[name] = scalar(rest);
    } else {
      const next = state.lines[state.i];
      // A sequence may sit at the key's own indentation.
      if (next && (next.indent > indent || (next.indent === indent && next.text.startsWith('- ')))) out[name] = block(state, next.indent);
      else out[name] = null;
    }
  }

  return out;
}

/** The key of `key: value` or `key:`, or null when the line is not one. */
function keyOf(text) {
  if (text.startsWith('"') || text.startsWith("'")) {
    const end = text.indexOf(text[0], 1);
    if (end > 0 && /^\s*:(\s|$)/.test(text.slice(end + 1))) return text.slice(0, end + 1);
    return null;
  }

  if (text.startsWith('[') || text.startsWith('{')) return null;
  const match = /^([^:]+?):(\s|$)/.exec(text);
  return match ? match[1] : null;
}

function scalar(text) {
  if (text.startsWith('[')) return flow(text, 0).value;
  if (text.startsWith('{')) return flow(text, 0).value;
  return unquote(text.replace(/^&\S+\s*/, ''));
}

function unquote(text) {
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text.endsWith(text[0])) return text.slice(1, -1);
  return text;
}

/** A flow collection from `start`: its value and where it ends. */
function flow(text, start) {
  const open = text[start];
  const close = open === '[' ? ']' : '}';
  const items = [];
  const map = {};
  let i = start + 1;
  let token = '';
  let key = null;
  const flush = () => {
    const value = token.trim();
    if (open === '[') {
      if (value) items.push(unquote(value));
    } else if (key !== null) {
      map[unquote(key.trim())] = typeof value === 'string' ? unquote(value) : value;
    }

    token = '';
    key = null;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      token += text.slice(i, end < 0 ? text.length : end + 1);
      i = end < 0 ? text.length : end + 1;
      continue;
    }

    if (c === '[' || c === '{') {
      const inner = flow(text, i);
      if (open === '[') items.push(inner.value);
      else if (key !== null) map[unquote(key.trim())] = inner.value;
      token = '';
      key = open === '[' ? null : key;
      if (open === '{') key = null;
      i = inner.end;
      continue;
    }

    if (c === close) {
      flush();
      return { value: open === '[' ? items : map, end: i + 1 };
    }

    if (c === ',') {
      flush();
    } else if (c === ':' && open === '{' && key === null) {
      key = token;
      token = '';
    } else {
      token += c;
    }

    i++;
  }

  flush();
  return { value: open === '[' ? items : map, end: i };
}
