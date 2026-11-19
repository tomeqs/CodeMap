/**
 * Old-style (OpenStep) property lists, the format of Xcode's project.pbxproj: dictionaries `{ key = value; }`,
 * arrays `( a, b, )`, strings bare or quoted, `/* comments *\/` and `// comments`. Data `<…>` is kept as text.
 * Returns plain objects, arrays and strings; throws on text that is not one.
 */
export function parsePlist(text) {
  const parser = new PlistParser(text);
  const value = parser.value();
  parser.space();
  if (parser.i < text.length) parser.fail('text after the end of the list');
  return value;
}

const BARE = /[A-Za-z0-9_$+/:.\-]/;

class PlistParser {
  constructor(text) {
    this.text = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    this.i = 0;
  }

  fail(what) {
    const line = this.text.slice(0, this.i).split('\n').length;
    throw new Error(`Not a property list: ${what} on line ${line}.`);
  }

  space() {
    const t = this.text;
    for (;;) {
      while (this.i < t.length && /\s/.test(t[this.i])) this.i++;
      if (t.startsWith('//', this.i)) {
        const end = t.indexOf('\n', this.i);
        this.i = end < 0 ? t.length : end + 1;
      } else if (t.startsWith('/*', this.i)) {
        const end = t.indexOf('*/', this.i + 2);
        if (end < 0) this.fail('an unclosed comment');
        this.i = end + 2;
      } else {
        return;
      }
    }
  }

  value() {
    this.space();
    const c = this.text[this.i];
    if (c === '{') return this.dictionary();
    if (c === '(') return this.array();
    if (c === '"' || c === "'") return this.quoted(c);
    if (c === '<') return this.data();
    return this.bare();
  }

  dictionary() {
    this.i++; // {
    const out = {};
    for (;;) {
      this.space();
      if (this.text[this.i] === '}') {
        this.i++;
        return out;
      }

      if (this.i >= this.text.length) this.fail('an unclosed dictionary');
      const key = this.value();
      if (typeof key !== 'string') this.fail('a key that is not a string');
      this.space();
      if (this.text[this.i] !== '=') this.fail(`no '=' after '${key}'`);
      this.i++;
      out[key] = this.value();
      this.space();
      if (this.text[this.i] === ';') this.i++;
      else if (this.text[this.i] !== '}') this.fail(`no ';' after the value of '${key}'`);
    }
  }

  array() {
    this.i++; // (
    const out = [];
    for (;;) {
      this.space();
      if (this.text[this.i] === ')') {
        this.i++;
        return out;
      }

      if (this.i >= this.text.length) this.fail('an unclosed array');
      out.push(this.value());
      this.space();
      if (this.text[this.i] === ',') this.i++;
      else if (this.text[this.i] !== ')') this.fail("no ',' between array items");
    }
  }

  quoted(quote) {
    this.i++;
    let out = '';
    const t = this.text;
    while (this.i < t.length && t[this.i] !== quote) {
      if (t[this.i] === '\\') {
        const next = t[this.i + 1];
        this.i += 2;
        if (next === 'n') out += '\n';
        else if (next === 't') out += '\t';
        else if (next === 'U' || next === 'u') {
          out += String.fromCharCode(parseInt(t.slice(this.i, this.i + 4), 16));
          this.i += 4;
        } else {
          out += next;
        }
      } else {
        out += t[this.i++];
      }
    }

    if (this.i >= t.length) this.fail('an unclosed string');
    this.i++;
    return out;
  }

  data() {
    const end = this.text.indexOf('>', this.i);
    if (end < 0) this.fail('unclosed data');
    const out = this.text.slice(this.i, end + 1);
    this.i = end + 1;
    return out;
  }

  bare() {
    const start = this.i;
    while (this.i < this.text.length && BARE.test(this.text[this.i])) this.i++;
    if (this.i === start) this.fail(`an unexpected '${this.text[this.i] ?? 'end'}'`);
    return this.text.slice(start, this.i);
  }
}
