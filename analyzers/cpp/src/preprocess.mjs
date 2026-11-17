/**
 * The text the grammar reads. tree-sitter parses C and C++ without running the preprocessor, which it cannot
 * do without the build's flags; so before parsing, what would trip it up is blanked out with spaces (lines,
 * and columns where possible, stay where they were):
 *
 * - every `#if` / `#ifdef` chain keeps one branch (the first; `#if 0` is skipped, `__cplusplus` is defined for
 *   C++ and not for C). Reading every branch leaves unbalanced braces (`#ifdef X` `void f(int a) {` `#else` …).
 * - `#define` and `#undef`, with their continuation lines: the grammar ends a macro's body at a comment inside
 *   it, and reads the lines after as code (nlohmann/json's enum macros became functions of the file).
 * - macros that only decorate a declaration: export macros (`class SHOP_API Order`, `SHOP_EXPORT void f()`),
 *   `__declspec(…)`, `__attribute__((…))`, and the project's own `#define`s that expand to nothing or to
 *   keywords (`#define SQLITE_PRIVATE static`: the keyword is put back when it fits);
 * - namespace macros (`#define FMT_BEGIN_NAMESPACE namespace fmt {`) and template headers
 *   (`#define NLOHMANN_BASIC_JSON_TPL_DECLARATION template<…>`) are expanded (on their own line);
 * - Qt and Unreal Engine annotations (`Q_OBJECT`, `signals:`, `UCLASS(…)`, `UPROPERTY(…)` …): blanked, and
 *   returned as annotations of the next declaration, with the `signals:` / `slots:` sections.
 */

const DIRECTIVE = /^\s*#\s*(if|ifdef|ifndef|elif|elifdef|elifndef|else|endif|define|undef)\b(.*)$/;

/** Annotations kept as the next declaration's attributes (Unreal reflection, Qt meta-object). */
const ANNOTATIONS_WITH_ARGS = [
  'UCLASS', 'USTRUCT', 'UENUM', 'UINTERFACE', 'UPROPERTY', 'UFUNCTION', 'UDELEGATE', 'UMETA', 'UPARAM',
  'Q_PROPERTY', 'Q_ENUM', 'Q_FLAG', 'Q_ENUMS', 'Q_FLAGS', 'Q_ENUM_NS', 'Q_FLAG_NS', 'Q_CLASSINFO', 'Q_INTERFACES', 'Q_PLUGIN_METADATA',
  'Q_DECLARE_PRIVATE', 'Q_DECLARE_PUBLIC', 'Q_DECLARE_PRIVATE_D', 'Q_DISABLE_COPY', 'Q_DISABLE_COPY_MOVE', 'Q_DISABLE_MOVE',
  'Q_DECLARE_METATYPE', 'Q_DECLARE_FLAGS', 'Q_DECLARE_OPERATORS_FOR_FLAGS', 'Q_DECLARE_INTERFACE', 'Q_DECLARE_TYPEINFO',
  'GENERATED_BODY', 'GENERATED_UCLASS_BODY', 'GENERATED_USTRUCT_BODY', 'GENERATED_UINTERFACE_BODY', 'GENERATED_IINTERFACE_BODY',
  'UE_DEPRECATED', 'DEPRECATED',
];
/** The ones that describe the declaration after them (the rest are blanked only). */
const KEPT = new Set(['UCLASS', 'USTRUCT', 'UENUM', 'UINTERFACE', 'UPROPERTY', 'UFUNCTION', 'UDELEGATE', 'Q_PROPERTY', 'Q_INVOKABLE', 'Q_SLOT', 'Q_SIGNAL', 'Q_SCRIPTABLE']);
/** Words with no arguments that decorate or stand for nothing the grammar knows. */
const WORDS = [
  'Q_OBJECT', 'Q_GADGET', 'Q_NAMESPACE', 'Q_INVOKABLE', 'Q_SLOT', 'Q_SIGNAL', 'Q_SCRIPTABLE', 'Q_REQUIRED_RESULT', 'Q_ALWAYS_INLINE',
  'Q_NEVER_INLINE', 'Q_NORETURN', 'Q_DECL_EXPORT', 'Q_DECL_IMPORT', 'Q_DECL_HIDDEN', 'Q_DECL_CONSTEXPR', 'Q_DECL_RELAXED_CONSTEXPR',
  'Q_DECL_NOTHROW', 'Q_DECL_NOEXCEPT', 'Q_DECL_UNUSED', 'Q_DECL_DEPRECATED', 'Q_CORE_EXPORT', 'Q_GUI_EXPORT', 'Q_WIDGETS_EXPORT',
  'QT_BEGIN_NAMESPACE', 'QT_END_NAMESPACE', 'QT_BEGIN_MOC_NAMESPACE', 'QT_END_MOC_NAMESPACE',
  'FORCEINLINE', 'FORCENOINLINE', 'FORCEINLINE_DEBUGGABLE', 'UE_NODISCARD', 'UE_NORETURN',
  'WINAPI', 'APIENTRY', 'CALLBACK', 'STDMETHODCALLTYPE', '__cdecl', '__stdcall', '__fastcall', '__thiscall', '__vectorcall', '__forceinline',
  '__declspec', '_In_', '_Out_', '_Inout_', '_In_opt_', '_Out_opt_', '_Inout_opt_', '_Ret_maybenull_', '_Check_return_', '_Success_',
];
/** Export macros by their usual names, defined by the build (-DSHOP_API=…) so not found in the code. */
const EXPORT_MACRO = /\b[A-Z][A-Z0-9_]*_(API|EXPORT|EXPORTS|DLL|DLLEXPORT|DECL|EXTERN|PUBLIC|LOCAL|HIDDEN)\b/g;
/** Keywords a decoration macro may stand for; put back when they fit in the macro's place. */
const KEYWORDS = new Set(['static', 'extern', 'inline', 'const', 'volatile', 'constexpr', 'virtual', 'explicit', 'register', 'thread_local', 'override', 'final', 'noexcept']);
const DECORATION = /^(?:\s*(?:__attribute__\s*\(\(.*\)\)|__declspec\s*\([^)]*\)|\[\[.*\]\]|__cdecl|__stdcall|__fastcall|WINAPI|__extension__|__inline|__forceinline|static|extern|inline|const|volatile|constexpr|virtual|explicit|override|final|noexcept|thread_local))*\s*$/;
/** One step of a macro that opens or closes namespaces: `namespace a {`, `inline namespace NAME(TAGS, VERSION) {`, `extern "C" {`, `}`. */
const NAMESPACE_STEP = /^\s*(?:(inline\s+)?namespace(?:\s+([A-Za-z_][\w:]*)(\s*\((?:[^()]|\([^()]*\))*\))?)?\s*\{|(extern\s*"C(?:\+\+)?"\s*\{)|(\}\s*;?))/;

const blank = (s) => s.replace(/[^\n\r]/g, ' ');

/**
 * Object-like macros of the project that decorate declarations (`decorations`), or open and close namespaces or
 * stand for a template header (`namespaces`, expanded in place), from its headers' `#define`s (`#define SQLITE_API`,
 * `#define FMT_BEGIN_NAMESPACE namespace fmt { inline namespace v10 {`, `#define TPL_DECLARATION template<…>`).
 */
export function collectMacros(texts) {
  const decorations = new Map();
  const namespaces = new Map();
  // Bodies made of decorations and other macros (`#define JSON_HEDLEY_ALWAYS_INLINE __attribute__((…)) JSON_HEDLEY_INLINE`):
  // decorations too once those macros are.
  const composed = new Map();
  const decorate = (name, body) => {
    const words = body.split(/\s+/).filter((w) => KEYWORDS.has(w)).join(' ');
    // Defined differently in different branches (export or import): the safe reading is none of them.
    decorations.set(name, decorations.has(name) && decorations.get(name) !== words ? '' : words);
  };
  for (const text of texts) {
    if (!text.includes('define')) continue;
    const re = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)(?![\w(])[ \t]*((?:[^\n\\]|\\\r?\n)*)$/gm;
    let m;
    while ((m = re.exec(text))) {
      const name = m[1];
      const body = m[2].replace(/\\\r?\n/g, ' ').replace(/\/\*.*?\*\/|\/\/.*$/g, '').trim();
      const expansion = body && (namespaceExpansion(body) ?? templateHeader(body) ?? keywordMacro(body, name));
      if (expansion) {
        if (!namespaces.has(name)) namespaces.set(name, expansion);
      } else if (/fall[\s_]*thr(ough|u)/i.test(name + ' ' + body)) {
        continue;
      } else if (body === '' || DECORATION.test(body)) {
        decorate(name, body);
      } else if (!body.replace(/__attribute__\s*\(\(.*\)\)|__declspec\s*\([^)]*\)|\[\[.*\]\]|\b[A-Za-z_]\w*\b/g, ' ').trim()) {
        if (!composed.has(name)) composed.set(name, body);
      }
    }

    // `#define JSON_CATCH(e) catch(e)`: the call reads as the keyword. Throw macros stay calls: with exceptions
    // off they do not throw, and the code after them (`FMT_THROW(…); return 0;`) is there for that case.
    const call = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)\([ \t]*([A-Za-z_]\w*)[ \t]*\)[ \t]*catch[ \t]*\([ \t]*([A-Za-z_]\w*)[ \t]*\)[ \t]*$/gm;
    while ((m = call.exec(text))) {
      const [, name, param, arg] = m;
      if (arg === param && !namespaces.has(name)) namespaces.set(name, 'catch'.padEnd(name.length));
    }
  }

  for (let changed = true; changed;) {
    changed = false;
    for (const [name, body] of composed) {
      if (decorations.has(name)) continue;
      const words = [];
      const rest = body.replace(/\b[A-Za-z_]\w*\b/g, (word) => {
        if (!decorations.has(word)) return word;
        words.push(decorations.get(word));
        return '';
      });
      if (DECORATION.test(rest)) {
        decorate(name, [rest, ...words].join(' '));
        changed = true;
      }
    }
  }

  // A namespace macro is not a decoration, whatever another branch defines it as.
  for (const name of namespaces.keys()) decorations.delete(name);
  return { decorations, namespaces };
}

/**
 * A macro that stands for `try`, `catch (...)` or an access specifier (`#define JSON_TRY try`,
 * `#define JSON_PRIVATE_UNLESS_TESTED public`), padded to the macro's length, else null. Left as a name,
 * `JSON_TRY { … }` is not a statement and the class around it falls apart.
 */
function keywordMacro(body, name) {
  return /^(?:try|public|protected|private)$/.test(body) || /^catch\s*\(\s*\.\.\.\s*\)$/.test(body) ? body.padEnd(name.length) : null;
}

/**
 * A macro that stands for a template header (`template<…>` with its brackets balanced and nothing after it), else
 * null. Left unexpanded, the class after it is read as something else and drops off the map (nlohmann's
 * `basic_json`).
 */
function templateHeader(body) {
  const m = /^template\s*</.exec(body);
  if (!m) return null;
  let depth = 0;
  for (let i = m[0].length - 1; i < body.length; i++) {
    if (body[i] === '<') depth++;
    else if (body[i] === '>' && --depth === 0) return body.slice(i + 1).trim() ? null : body.replace(/\s+/g, ' ');
  }

  return null;
}

/**
 * The body of a macro that only opens and closes namespaces, in a form the parser reads, else null. An inline
 * namespace named by another macro (nlohmann's `inline namespace NLOHMANN_JSON_NAMESPACE_CONCAT(…) {`) keeps that
 * macro's name: inline namespaces are not part of the ids anyway. Taking the closing macro without its opening one
 * would leave the braces unbalanced, so both kinds are read the same way.
 */
function namespaceExpansion(body) {
  const parts = [];
  let rest = body;
  while (rest.trim()) {
    const m = NAMESPACE_STEP.exec(rest);
    if (!m) return null;
    const [whole, inline, name, call, externC] = m;
    if (call && !inline) return null; // a namespace whose name is computed is not one ids could use
    if (externC) parts.push('extern "C" {');
    else if (whole.trim().startsWith('}')) parts.push('}');
    else parts.push(`${inline ? 'inline ' : ''}namespace${name ? ' ' + name : ''} {`);
    rest = rest.slice(whole.length);
  }

  return parts.join(' ');
}

/**
 * @returns {{ text: string, annotations: {line:number, name:string, args:string}[], sections: {line:number, kind:string, access:string}[] }}
 *   lines are 1-based.
 */
export function preprocess(source, { cplusplus = true, macros = null } = {}) {
  let text = flatten(source, cplusplus);
  const annotations = [];
  const sections = [];

  text = blankCalls(text, ['__attribute__', '__declspec'], null);
  // Qt's string connections: SIGNAL(valueChanged(int)) / SLOT(setValue(int)) read as the name in quotes.
  text = text.replace(/\b(SIGNAL|SLOT|Q_SIGNAL_MACRO)\s*\(\s*(\w+)\s*\(([^()]*)\)\s*\)/g, (all, macro, name) => `"${name}"`.padEnd(all.length, ' '));
  text = blankCalls(text, ANNOTATIONS_WITH_ARGS, annotations);

  // Words, one regular expression for all of them.
  const words = new RegExp('\\b(' + WORDS.join('|') + ')\\b', 'g');
  text = replaceOutsideDirectives(text, words, (word, offset, all) => {
    if (KEPT.has(word)) annotations.push({ line: lineAt(all, offset), name: word, args: '' });
    return ' '.repeat(word.length);
  });

  // Qt sections: `signals:` is `public:` to the grammar; `public slots:` is `public:`.
  text = text.replace(/^([ \t]*)(?:(public|protected|private)([ \t]+))?(signals|Q_SIGNALS|slots|Q_SLOTS)([ \t]*):/gm, (all, indent, access, gap, word, space, offset) => {
    const kind = /signal/i.test(word) ? 'signals' : 'slots';
    sections.push({ line: lineAt(text, offset), kind, access: access ?? (kind === 'signals' ? 'public' : 'private') });
    if (access) return indent + access + ' '.repeat(gap.length + word.length) + space + ':';
    // A bare `signals:` is public (Qt defines it so); a bare `slots:` is not valid Qt, read as private.
    const keyword = kind === 'signals' ? 'public' : 'private';
    return indent + keyword.padEnd(word.length, ' ') + space + ':';
  });

  // `emit sig(…)` / `Q_EMIT sig(…)`: the call is what is left.
  text = text.replace(/\b(emit|Q_EMIT)(?=\s+[A-Za-z_][\w:.>-]*\s*\()/g, (w) => ' '.repeat(w.length));

  // Export macros: `class SHOP_API Order`, and by their usual names anywhere outside directives.
  text = text.replace(/\b(class|struct|union)(\s+)([A-Z][A-Z0-9_]+)(?=\s+[A-Za-z_]\w*\s*(?:final\s*)?[:{])/g, (all, keyword, gap, macro) => keyword + gap + ' '.repeat(macro.length));
  text = replaceOutsideDirectives(text, EXPORT_MACRO, (word) => ' '.repeat(word.length));

  if (macros) text = applyMacros(text, macros);
  text = blankStatementMacros(text);
  return { text, annotations: annotations.sort((a, b) => a.line - b.line), sections };
}

/**
 * A macro used as a statement or a declaration of its own, without a semicolon (`FMT_PRAGMA_MSVC(…)`,
 * `Q_DECLARE_METATYPE(Order)`, `DECLARE_LOG_CATEGORY(Shop)` on a line of its own): the grammar takes it for a
 * call missing its `;` and loses what follows. A macro that opens a body (`TEST(A, B) {`) is left alone.
 */
function blankStatementMacros(text) {
  const re = /^([ \t]*)([A-Z][A-Z0-9_]{2,})[ \t]*\(/gm;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = open;
    for (; end < text.length; end++) {
      const c = text[end];
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
      else if (c === '"') end = skipString(text, end);
      else if (c === ';' || c === '{' || c === '}') break;
    }

    if (end >= text.length || text[end] !== ')') continue;
    const after = /^[ \t]*(\/\/[^\n]*)?(\r?\n|$)/.exec(text.slice(end + 1, end + 400));
    if (!after) continue; // `;`, `{` or more code follows on the line
    const next = /^\s*(\S)/.exec(text.slice(end + 1, end + 400));
    if (next && (next[1] === '{' || next[1] === ':' || next[1] === ',' || next[1] === '.' || next[1] === '-' || next[1] === '+' || next[1] === '=')) continue;
    out += text.slice(last, m.index + m[1].length) + blank(text.slice(m.index + m[1].length, end + 1));
    last = end + 1;
    re.lastIndex = end + 1;
  }

  return last === 0 ? text : out + text.slice(last);
}

/** Keeps one branch of each `#if` chain, blanks the directives and the rest; lines stay. */
export function flatten(source, cplusplus) {
  if (!source.includes('#')) return source;
  const lines = source.split('\n');
  const stack = [];
  let inComment = false;
  const active = () => stack.every((f) => f.active);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // `.` does not match \r: a file with Windows line ends is matched without it.
    const m = !inComment && line.includes('#') ? DIRECTIVE.exec(line.replace(/\r$/, '')) : null;
    if (m) {
      let j = i;
      let rest = m[2];
      while (lines[j].replace(/\r$/, '').endsWith('\\') && j + 1 < lines.length) {
        j++;
        rest += ' ' + lines[j];
      }

      const keyword = m[1];
      const condition = rest.replace(/\/\*.*?\*\/|\/\/.*$/g, '').replace(/\\/g, ' ').trim();
      if (keyword === 'if' || keyword === 'ifdef' || keyword === 'ifndef') {
        const want = wanted(keyword, condition, cplusplus);
        stack.push({ taken: want, active: want });
      } else if (keyword.startsWith('elif')) {
        const frame = stack[stack.length - 1];
        if (frame) {
          frame.active = !frame.taken && wanted(keyword === 'elif' ? 'if' : keyword.slice(2), condition, cplusplus);
          if (frame.active) frame.taken = true;
        }
      } else if (keyword === 'else') {
        const frame = stack[stack.length - 1];
        if (frame) {
          frame.active = !frame.taken;
          frame.taken = true;
        }
      } else if (keyword === 'endif') {
        stack.pop();
      }

      for (let k = i; k <= j; k++) lines[k] = blank(lines[k]);
      i = j;
      continue;
    }

    if (!active()) lines[i] = blank(line);
    inComment = commentState(line, inComment);
  }

  return lines.join('\n');
}

/** Whether a branch is read: all are (the first that comes), except `#if 0` and C++-only code in C (and back). */
function wanted(keyword, condition, cplusplus) {
  if (/\b__cplusplus\b/.test(condition)) {
    if (keyword === 'ifdef') return cplusplus;
    if (keyword === 'ifndef') return !cplusplus;
    if (/^!\s*defined\s*\(?\s*__cplusplus/.test(condition)) return !cplusplus;
    if (/^defined\s*\(?\s*__cplusplus\s*\)?\s*$/.test(condition) || /^__cplusplus\b/.test(condition)) return cplusplus;
  }

  if (keyword === 'if' && /^(0|false)\b/.test(condition)) return false;
  return true;
}

function commentState(line, inComment) {
  if (!line.includes('/*') && !inComment) return false;
  const s = line.replace(/"(?:\\.|[^"\\])*"/g, '""');
  for (let k = 0; k < s.length; k++) {
    if (!inComment && s[k] === '/' && s[k + 1] === '*') {
      inComment = true;
      k++;
    } else if (inComment && s[k] === '*' && s[k + 1] === '/') {
      inComment = false;
      k++;
    } else if (!inComment && s[k] === '/' && s[k + 1] === '/') {
      break;
    }
  }

  return inComment;
}

/** Blanks `NAME(…)` (balanced, over lines) for the given names; records them as annotations when asked. */
function blankCalls(text, names, annotations) {
  const re = new RegExp('\\b(' + names.join('|') + ')\\s*\\(', 'g');
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (inDirective(text, m.index)) continue;
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < text.length; end++) {
      const c = text[end];
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
      else if (c === '"') end = skipString(text, end);
    }

    if (end >= text.length) break;
    const name = m[1];
    if (annotations && KEPT.has(name)) {
      const args = text.slice(m.index + m[0].length, end).replace(/\s+/g, ' ').trim();
      annotations.push({ line: lineAt(text, m.index), name, args });
    }

    out += text.slice(last, m.index) + blank(text.slice(m.index, end + 1));
    last = end + 1;
    re.lastIndex = end + 1;
  }

  return last === 0 ? text : out + text.slice(last);
}

function skipString(text, start) {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"' || text[i] === '\n') return i;
  }

  return text.length;
}

/** Whether an offset is on a preprocessor line (`#define X UCLASS()` is left alone). */
function inDirective(text, offset) {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  return /^\s*#/.test(text.slice(start, offset + 1));
}

function replaceOutsideDirectives(text, re, replace) {
  return text.replace(re, (match, ...rest) => {
    const offset = rest[rest.length - 2];
    const all = rest[rest.length - 1];
    if (inDirective(all, offset)) return match;
    return replace(match, offset, all);
  });
}

/** The project's decoration macros blanked (or their keyword put back), namespace and template macros expanded on their line. */
export function applyMacros(text, { decorations, namespaces }) {
  const names = [...decorations.keys(), ...namespaces.keys()];
  if (!names.length) return text;
  const re = new RegExp('\\b(' + names.sort((a, b) => b.length - a.length).join('|') + ')\\b', 'g');
  return text.replace(re, (name, _group, offset, all) => {
    if (inDirective(all, offset)) return name;
    const expansion = namespaces.get(name);
    if (expansion !== undefined) return expansion;
    const keyword = decorations.get(name);
    return keyword && keyword.length <= name.length ? keyword.padEnd(name.length, ' ') : ' '.repeat(name.length);
  });
}

function lineAt(text, offset) {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line++;
  return line;
}
