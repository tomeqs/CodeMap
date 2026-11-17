/**
 * The text the grammar reads. tree-sitter parses C and C++ without running the preprocessor, which it cannot
 * do without the build's flags; so before parsing, what would trip it up is blanked out with spaces (lines,
 * and columns where possible, stay where they were):
 *
 * - every `#if` / `#ifdef` chain keeps one branch (the first; `#if 0` is skipped, `__cplusplus` is defined for
 *   C++ and not for C, switches that turn a feature off, `#ifdef SQLITE_OMIT_…`, are not defined). Reading every branch leaves unbalanced braces (`#ifdef X` `void f(int a) {` `#else` …).
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
/**
 * Export macros by their usual names, defined by the build (-DSHOP_API=…) so not found in the code. Only where
 * one decorates a declaration, which is before a name (`SHOP_API void f()`, `extern SHOP_API int x`): constants
 * end the same way (`AF_LOCAL`, `RTLD_LOCAL`, an enumerator `VIS_HIDDEN`) and are followed by an operator.
 */
const EXPORT_MACRO = /\b[A-Z][A-Z0-9_]*_(API|EXPORT|EXPORTS|DLL|DLLEXPORT|DECL|EXTERN|PUBLIC|LOCAL|HIDDEN)\b(?=\s+(?!(?:and|or|xor|not|bitand|bitor|and_eq|or_eq|xor_eq|not_eq)\b)[A-Za-z_~])/g;
/** `class SHOP_API Order`: an all-capitals word between the keyword and the name (not `class AABB final`). */
const CLASS_EXPORT_MACRO = /\b(class|struct|union)(\s+)([A-Z][A-Z0-9_]+)(?=\s+(?!final\b)[A-Za-z_]\w*\s*(?:final\s*)?[:{])/g;
/**
 * Words of the languages. A macro named like one (`#define private public` in a test, `#define inline __inline`)
 * is not applied: it would rewrite the keyword in every file read.
 */
const RESERVED = new Set(('alignas alignof and and_eq asm auto bitand bitor bool break case catch char char8_t char16_t char32_t class compl concept const consteval '
  + 'constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false '
  + 'final float for friend goto if inline int long mutable namespace new noexcept not not_eq nullptr operator or or_eq override private protected public '
  + 'register reinterpret_cast requires restrict return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true '
  + 'try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor xor_eq').split(' '));
/** Keywords a decoration macro may stand for; put back when they fit in the macro's place. */
const KEYWORDS = new Set(['static', 'extern', 'inline', 'const', 'volatile', 'constexpr', 'virtual', 'explicit', 'register', 'thread_local', 'override', 'final', 'noexcept']);
const DECORATION = /^(?:\s*(?:__attribute__\s*\(\(.*\)\)|__declspec\s*\([^)]*\)|\[\[.*\]\]|__cdecl|__stdcall|__fastcall|WINAPI|__extension__|__inline|__forceinline|static|extern|inline|const|volatile|constexpr|virtual|explicit|override|final|noexcept|thread_local))*\s*$/;
/** One step of a macro that opens or closes namespaces: `namespace a {`, `inline namespace NAME(TAGS, VERSION) {`, `extern "C" {`, `}`. */
const NAMESPACE_STEP = /^\s*(?:(inline\s+)?namespace(?:\s+([A-Za-z_][\w:]*)(\s*\((?:[^()]|\([^()]*\))*\))?)?\s*\{|(extern\s*"C(?:\+\+)?"\s*\{)|(\}\s*;?))/;

/** The body of a `#define`, with its continuation lines; a backslash may also escape a character ("\n"). */
const BODY = '((?:[^\\n\\\\]|\\\\\\r?\\n|\\\\.)*)';
const OBJECT_DEFINE = new RegExp(`^[ \\t]*#[ \\t]*define[ \\t]+([A-Za-z_]\\w*)(?![\\w(])[ \\t]*${BODY}$`, 'gm');
const FUNCTION_DEFINE = new RegExp(`^[ \\t]*#[ \\t]*define[ \\t]+([A-Za-z_]\\w*)\\([^)\\n]*\\)${BODY}$`, 'gm');
const ANY_DEFINE = new RegExp(`^[ \\t]*#[ \\t]*define[ \\t]+[A-Za-z_]\\w*(?:\\([^)\\n]*\\))?${BODY}$`, 'gm');
/** `#ifndef NAME` (or `#if !defined(NAME)`) on the line before a `#define`. */
const GUARD_BEFORE = /#[ \t]*(?:ifndef[ \t]+(\w+)|if[ \t]+!\s*defined\s*\(?\s*(\w+)\s*\)?)[^\n]*\r?\n\s*$/;

const COMPILER_ATTRIBUTES = ['__attribute__', '__declspec'];
/** The words, one regular expression for all of them. */
const WORDS_RE = new RegExp('\\b(' + WORDS.join('|') + ')\\b', 'g');

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
  const functionLike = new Map();
  // `#define SPDLOG_NAMESPACE spdlog`: a name another macro may open as a namespace.
  const identifiers = new Map();
  const decorate = (name, body) => {
    const words = body.split(/\s+/).filter((w) => KEYWORDS.has(w)).join(' ');
    // Defined differently in different branches (export or import): the safe reading is none of them.
    decorations.set(name, decorations.has(name) && decorations.get(name) !== words ? '' : words);
  };
  for (const text of texts) {
    if (!text.includes('define')) continue;
    const re = OBJECT_DEFINE;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const name = m[1];
      if (RESERVED.has(name)) continue;
      const body = m[2].replace(/\\\r?\n/g, ' ').replace(/\/\*.*?\*\/|\/\/.*$/g, '').trim();
      // An include guard is no decoration: nothing uses its name, and a large repository has one per header.
      if (body === '' && isIncludeGuard(text, m.index, re.lastIndex, name)) continue;
      if (/^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/.test(body)) identifiers.set(name, identifiers.has(name) && identifiers.get(name) !== body ? null : body);
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

    // `#define GUARDED_BY(x) THREAD_ANNOTATION_ATTRIBUTE__(guarded_by(x))`: an attribute, read later.
    const fn = FUNCTION_DEFINE;
    fn.lastIndex = 0;
    while ((m = fn.exec(text))) {
      if (RESERVED.has(m[1])) continue;
      const body = m[2].replace(/\\\r?\n/g, ' ').replace(/\/\*.*?\*\/|\/\/.*$/g, '').trim();
      if (!functionLike.has(m[1])) functionLike.set(m[1], []);
      functionLike.get(m[1]).push(body);
    }

    // `#define JSON_CATCH(e) catch(e)`: the call reads as the keyword. Throw macros stay calls: with exceptions
    // off they do not throw, and the code after them (`FMT_THROW(…); return 0;`) is there for that case.
    const call = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)\([ \t]*([A-Za-z_]\w*)[ \t]*\)[ \t]*catch[ \t]*\([ \t]*([A-Za-z_]\w*)[ \t]*\)[ \t]*$/gm;
    while ((m = call.exec(text))) {
      const [, name, param, arg] = m;
      if (arg === param && !namespaces.has(name) && !RESERVED.has(name)) namespaces.set(name, 'catch'.padEnd(name.length));
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

  // A macro naming a namespace (spdlog: `namespace SPDLOG_NAMESPACE {` behind SPDLOG_NAMESPACE_BEGIN) is that name
  // everywhere, or the code in it and the calls naming it (`spdlog::info`) would not meet.
  const named = new Set();
  const nameOf = (w) => (identifiers.get(w) && !KEYWORDS.has(identifiers.get(w)) ? identifiers.get(w) : null);
  for (const [name, expansion] of namespaces) {
    if (!/\bnamespace\b/.test(expansion)) continue;
    namespaces.set(name, expansion.replace(/\bnamespace\s+([A-Za-z_]\w*)/g, (all, w) => (nameOf(w) ? (named.add(w), `namespace ${nameOf(w)}`) : all)));
  }

  for (const text of texts) for (const m of text.matchAll(/\bnamespace\s+([A-Z_][A-Z0-9_]*)\s*\{/g)) if (nameOf(m[1])) named.add(m[1]);
  for (const name of named) if (!namespaces.has(name)) namespaces.set(name, nameOf(name).padEnd(name.length));

  // A namespace macro is not a decoration, whatever another branch defines it as.
  for (const name of namespaces.keys()) decorations.delete(name);
  return { decorations, namespaces, attributes: attributeMacros(functionLike), words: macroWords(texts) };
}

/**
 * `#ifndef NAME` / `#define NAME` with the header's code after it. The same two lines followed at once by `#endif`
 * give a macro its default instead (`#ifndef SHOP_API` / `#define SHOP_API` / `#endif`): that one decorates.
 */
function isIncludeGuard(text, defineStart, defineEnd, name) {
  const before = GUARD_BEFORE.exec(text.slice(Math.max(0, defineStart - 200), defineStart));
  if (!before || (before[1] ?? before[2]) !== name) return false;
  return !/^\s*#[ \t]*endif\b/.test(text.slice(defineEnd, defineEnd + 200));
}

/**
 * Function-like macros that stand for an attribute in every definition (Clang's thread safety annotations:
 * `void Compact() EXCLUSIVE_LOCKS_REQUIRED(mutex_);`, `int count GUARDED_BY(mu_);`), directly or through another
 * such macro. Left in, the grammar reads them as a method or a field of their own.
 */
function attributeMacros(functionLike) {
  const found = new Set();
  const PIECE = /__attribute__\s*\(\(.*\)\)|__declspec\s*\(.*\)|\[\[.*\]\]/g;
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, bodies] of functionLike) {
      if (found.has(name) || !bodies.some(Boolean)) continue;
      const attribute = bodies.every((body) => !body.replace(PIECE, ' ').replace(/\b([A-Za-z_]\w*)\s*\((?:[^()]|\([^()]*\))*\)/g, (call, callee) => (found.has(callee) ? ' ' : call)).trim());
      if (attribute) {
        found.add(name);
        changed = true;
      }
    }
  }

  return [...found];
}

/**
 * Every name a `#define` body uses. Macros are not read as code, so a function only a macro names (redis's config
 * table: `createBoolConfig(…)` expands to `boolConfigGet, boolConfigSet…`) would otherwise look unused.
 */
function macroWords(texts) {
  const words = new Set();
  const re = ANY_DEFINE;
  for (const text of texts) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) for (const w of m[1].match(/\b[A-Za-z_]\w*\b/g) ?? []) words.add(w);
  }

  return words;
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
 * @returns {{ text: string, annotations: {line:number, name:string, args:string}[], sections: {line:number, kind:string, access:string}[], macroArguments: string[] }}
 *   lines are 1-based; macroArguments are the names given to the macros blanked as statements.
 */
export function preprocess(source, { cplusplus = true, macros = null } = {}) {
  let text = flatten(source, cplusplus);
  const annotations = [];
  const sections = [];

  // `__attribute__((fallthrough));` stays: it is what tells a case that runs on from one that forgot its break.
  text = blankCalls(text, COMPILER_ATTRIBUTES, null, (name, args) => /^\(\s*\(\s*_*fallthrough_*\s*\)\s*\)$/.test(args));
  // Qt's string connections: SIGNAL(valueChanged(int)) / SLOT(setValue(int)) read as the name in quotes.
  text = text.replace(/\b(SIGNAL|SLOT|Q_SIGNAL_MACRO)\s*\(\s*(\w+)\s*\(([^()]*)\)\s*\)/g, (all, macro, name) => `"${name}"`.padEnd(all.length, ' '));
  text = blankCalls(text, ANNOTATIONS_WITH_ARGS, annotations);

  text = replaceOutsideDirectives(text, WORDS_RE, (word, offset, all) => {
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
  text = text.replace(CLASS_EXPORT_MACRO, (all, keyword, gap, macro) => keyword + gap + ' '.repeat(macro.length));
  text = replaceOutsideDirectives(text, EXPORT_MACRO, (word) => ' '.repeat(word.length));

  text = blankTypeLists(text);
  if (macros?.attributes?.length) text = blankCalls(text, macros.attributes, null);
  if (macros) text = applyMacros(text, macros);
  const macroArguments = [];
  text = blankStatementMacros(text, macroArguments);
  return { text, annotations: annotations.sort((a, b) => a.line - b.line), sections, macroArguments };
}

/** doctest and Catch2 tests run for each of a list of types. */
const TYPED_TESTS = /\b(?:TEST_CASE_TEMPLATE|TEMPLATE_TEST_CASE|TEMPLATE_PRODUCT_TEST_CASE|TEMPLATE_LIST_TEST_CASE)[ \t]*\(/g;

/**
 * `TEST_CASE_TEMPLATE("name", T, int32_t, uint64_t) { … }`: the types after the title are blanked. Types are not
 * arguments a call can have, so the grammar lost the test's block and the tests after it (nlohmann/json).
 */
function blankTypeLists(text) {
  if (!text.includes('TEST_CASE')) return text;
  TYPED_TESTS.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = TYPED_TESTS.exec(text))) {
    if (inDirective(text, m.index)) continue;
    let depth = 0;
    let end = m.index + m[0].length - 1;
    let afterTitle = -1;
    for (; end < text.length; end++) {
      const c = text[end];
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
      else if (c === '"') {
        end = skipString(text, end);
        if (depth === 1) afterTitle = end + 1;
      }
    }

    if (end >= text.length) break;
    if (afterTitle !== -1 && afterTitle < end) {
      out += text.slice(last, afterTitle) + blank(text.slice(afterTitle, end));
      last = end;
    }

    TYPED_TESTS.lastIndex = end + 1;
  }

  return last === 0 ? text : out + text.slice(last);
}

/**
 * A macro used as a statement or a declaration of its own, without a semicolon (`FMT_PRAGMA_MSVC(…)`,
 * `Q_DECLARE_METATYPE(Order)`, `DECLARE_LOG_CATEGORY(Shop)` on a line of its own): the grammar takes it for a
 * call missing its `;` and loses what follows. A macro that opens a body (`TEST(A, B) {`) is left alone, and so is
 * a call that is part of an expression: one that follows an operator, a comma or an open parenthesis
 * (`foo(a,⏎ MAX(b, c)⏎);`), or that the next line goes on from (`EXPECT_TRUE(ok)⏎ << "why";`).
 */
function blankStatementMacros(text, names) {
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
    const next = tokenAfter(text, end + 1);
    // `[[nodiscard]] int f();` after the macro is a new declaration; `[i]` goes on from the call.
    if (CONTINUES.has(next[0]) && next !== '[[') continue;
    // What is already written is in `out` (as long as the text it stands for: blanking keeps the length).
    const before = tokenBefore(m.index, (i) => (i < last ? out : text).charCodeAt(i), (from, to) => (from < last ? out.slice(from, Math.min(to, last)) : '') + (to > last ? text.slice(Math.max(from, last), to) : ''));
    if (!STATEMENT_START.has(before)) continue;
    out += text.slice(last, m.index + m[1].length) + blank(text.slice(m.index + m[1].length, end + 1));
    // The names it is given are used by the code it expands to (SQLite's IOMETHODS(…, afpClose, …)).
    for (const w of text.slice(open + 1, end).replace(/"(?:\\.|[^"\\])*"/g, '').match(/\b[A-Za-z_]\w*\b/g) ?? []) names.push(w);
    last = end + 1;
    re.lastIndex = end + 1;
  }

  return last === 0 ? text : out + text.slice(last);
}

/** What may follow a macro standing as a statement: not what goes on with the expression it would be part of. */
const CONTINUES = new Set(['{', ':', ',', '.', '-', '+', '=', '<', '>', '&', '|', '?', '*', '/', '%', '^', '!', '[', ')', ']', ';', '"']);
/** What a statement or a declaration comes after ('' is the start of the file; `>` ends `template <…>`). */
const STATEMENT_START = new Set(['', ';', '{', '}', ':', '>']);

/** The first two characters of the code after an offset, past spaces and comments ('' at the end). */
function tokenAfter(text, from) {
  let i = from;
  const limit = Math.min(text.length, from + 4000);
  while (i < limit) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++;
    else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else return text.slice(i, i + 2);
  }

  return '';
}

/**
 * The last character of the code before `lineStart`, past blank lines (blanked macros and directives are long runs
 * of them), comments and preprocessor lines: '' at the start of the file. `codeAt` and `slice` read the text as it
 * stands after the blanking done so far.
 */
function tokenBefore(lineStart, codeAt, slice) {
  let end = lineStart;
  let inComment = false; // `end` is inside a comment that began before it
  for (let round = 0; round < 64; round++) {
    if (!inComment) {
      for (let c = codeAt(end - 1); end > 0 && (c === 32 || c === 9 || c === 10 || c === 13); c = codeAt(end - 1)) end--;
    }

    if (end <= 0) return '';
    let from = Math.max(0, end - 8000);
    let code = slice(from, end);
    // Whole lines only: half a comment or half a directive would read as code.
    const firstLine = from > 0 ? code.indexOf('\n') : -1;
    if (firstLine !== -1) {
      code = code.slice(firstLine + 1);
      from += firstLine + 1;
    }

    if (inComment) {
      const open = code.lastIndexOf('/*');
      if (open === -1) {
        end = from;
        continue;
      }

      code = code.slice(0, open);
      inComment = false;
    }

    // The window may open inside a comment that began before it.
    const close = code.indexOf('*/');
    const open = code.indexOf('/*');
    const cut = from > 0 && close !== -1 && (open === -1 || close < open);
    if (cut) code = code.slice(close + 2);
    code = code
      .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/.*$/gm, '')
      .replace(/^[ \t]*#.*$/gm, '')
      .trimEnd();
    if (code) return code[code.length - 1];
    if (from === 0) return '';
    end = from;
    inComment = cut;
  }

  return ' ';
}

/** Keeps one branch of each `#if` chain, blanks the directives and the rest; lines stay. */
export function flatten(source, cplusplus) {
  if (!source.includes('#')) return source;
  const lines = source.split('\n');
  const stack = [];
  let inComment = false;
  // A comment that began on a directive's line (blanked) and runs on: its tail goes too, or it is read as code.
  let tail = false;
  const active = () => stack.every((f) => f.active);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (tail) {
      const close = line.indexOf('*/');
      if (close === -1) {
        lines[i] = blank(line);
        continue;
      }

      line = lines[i] = blank(line.slice(0, close + 2)) + line.slice(close + 2);
      tail = false;
    }

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
      const condition = rest.replace(/\/\*.*?\*\/|\/\/.*$|\/\*.*$/g, '').replace(/\\/g, ' ').trim();
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

      for (let k = i; k <= j; k++) {
        tail = commentState(lines[k], tail);
        lines[k] = blank(lines[k]);
      }

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
  // A switch that turns a feature off (`#ifdef SQLITE_OMIT_FLOATING_POINT`): its first branch is the stub, so the
  // code a normal build has is in the #else.
  const name = keyword === 'ifdef' ? condition : keyword === 'if' ? /^defined\s*\(?\s*(\w+)\s*\)?$/.exec(condition)?.[1] : null;
  if (name && /(?:^|_)(?:OMIT|DISABLE|DISABLED|NO|WITHOUT|EXCLUDE)(?:_|$)/.test(name)) return false;
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

const CALLS = new WeakMap();

/**
 * Blanks `NAME(…)` (balanced, over lines) for the given names; records them as annotations when asked. `keep`
 * may leave a call in the text, by its name and its arguments with their parentheses.
 */
function blankCalls(text, names, annotations, keep = null) {
  // One regular expression per list of names, not per file.
  let re = CALLS.get(names);
  if (!re) CALLS.set(names, re = new RegExp('\\b(' + names.join('|') + ')\\s*\\(', 'g'));
  re.lastIndex = 0;
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
    if (keep?.(name, text.slice(m.index + m[0].length - 1, end + 1))) {
      re.lastIndex = end + 1;
      continue;
    }

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

/**
 * The project's decoration macros blanked (or their keyword put back), namespace and template macros expanded on
 * their line. The regular expression of all the names and the table of what each becomes are made once for the
 * analysis: compiling the expression for every file cost far more than running it.
 */
export function applyMacros(text, macros) {
  const table = macros.table ??= replacements(macros);
  if (!table.size) return text;
  const re = macros.pattern ??= new RegExp('\\b(?:' + [...table.keys()].sort((x, y) => y.length - x.length).join('|') + ')\\b', 'g');
  return text.replace(re, (name, offset, all) => (inDirective(all, offset) ? name : table.get(name)));
}

function replacements({ decorations, namespaces }) {
  const table = new Map();
  for (const [name, keyword] of decorations) table.set(name, keyword && keyword.length <= name.length ? keyword.padEnd(name.length, ' ') : ' '.repeat(name.length));
  for (const [name, expansion] of namespaces) table.set(name, expansion);
  return table;
}

function lineAt(text, offset) {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line++;
  return line;
}
