import assert from 'node:assert/strict';
import test from 'node:test';
import { collectMacros, flatten, preprocess } from '../src/preprocess.mjs';

test('each #if chain keeps its first branch, so braces stay balanced; lines stay where they were', () => {
  const source = '#ifdef _WIN32\nvoid f(int a) {\n#else\nvoid f(int a, int b) {\n#endif\n  return;\n}\n';
  const text = flatten(source, true);
  assert.equal(text.split('\n').length, source.split('\n').length);
  assert.match(text, /void f\(int a\) \{/);
  assert.doesNotMatch(text, /int b/);
  assert.doesNotMatch(text, /#/);
});

test('directives are read in files with Windows line ends', () => {
  const guard = '#ifdef __cplusplus\r\nextern "C" {\r\n#endif\r\nint f(void);\r\n#ifdef __cplusplus\r\n}\r\n#endif\r\n';
  const c = flatten(guard, false);
  assert.doesNotMatch(c, /extern|\}|#/);
  assert.equal(c.split('\n').length, guard.split('\n').length);
});

test('#if 0 is skipped (its #else is read), and __cplusplus is defined for C++ only', () => {
  assert.match(flatten('#if 0\nold();\n#else\nnew_();\n#endif\n', true), /new_\(\)/);
  assert.doesNotMatch(flatten('#if 0\nold();\n#else\nnew_();\n#endif\n', true), /old/);
  const guard = '#ifdef __cplusplus\nextern "C" {\n#endif\nint f(void);\n#ifdef __cplusplus\n}\n#endif\n';
  assert.match(flatten(guard, true), /extern "C" \{[\s\S]*\}/);
  assert.doesNotMatch(flatten(guard, false), /extern|\}/);
  assert.match(flatten('#if !defined(__cplusplus)\nc_only();\n#endif\n', false), /c_only/);
  assert.doesNotMatch(flatten('#if !defined(__cplusplus)\nc_only();\n#endif\n', true), /c_only/);
});

test('a switch that turns a feature off is not defined: its #else, the code a normal build has, is read', () => {
  // SQLite: #ifdef SQLITE_OMIT_FLOATING_POINT kept the stub, and the printf code calling et_getdigit was dropped.
  const omit = '#ifdef SQLITE_OMIT_FLOATING_POINT\nstub();\n#else\nfloats();\n#endif\n';
  assert.match(flatten(omit, false), /floats\(\)/);
  assert.doesNotMatch(flatten(omit, false), /stub/);
  assert.doesNotMatch(flatten('#if defined(FMT_NO_LOCALE)\nnone();\n#endif\n', true), /none/);
  assert.match(flatten('#ifdef SQLITE_ENABLE_FTS5\nfts5();\n#endif\n', false), /fts5/);
  assert.match(flatten('#ifdef NOMINMAX\nkept();\n#endif\n', true), /kept/);
});

test('decoration macros of the project are blanked, a keyword they stand for is put back', () => {
  const macros = collectMacros(['#define SQLITE_API\n#define SQLITE_PRIVATE static\n#define FMT_BEGIN_NAMESPACE namespace fmt { inline namespace v10 {\n#define FMT_END_NAMESPACE } }\n#define VERSION "3"\n']);
  assert.deepEqual([...macros.decorations.keys()].sort(), ['SQLITE_API', 'SQLITE_PRIVATE']);
  const { text } = preprocess('SQLITE_API int open(void);\nSQLITE_PRIVATE int helper(void);\nFMT_BEGIN_NAMESPACE\nint x;\nFMT_END_NAMESPACE\n', { macros });
  const lines = text.split('\n');
  assert.equal(lines[0].trim(), 'int open(void);');
  assert.match(lines[1], /^static\s+int helper/);
  assert.equal(lines[2].trim(), 'namespace fmt { inline namespace v10 {');
  assert.equal(lines[4].trim(), '} }');
});

test('a namespace macro naming its inline namespace with another macro, or opening extern "C", still opens it', () => {
  // nlohmann/json: without the opening macro, the closing one left an extra brace and the file fell apart.
  const macros = collectMacros([
    '#define NLOHMANN_JSON_NAMESPACE_BEGIN namespace nlohmann { \\\n  inline namespace NLOHMANN_JSON_NAMESPACE_CONCAT( \\\n    NLOHMANN_JSON_ABI_TAGS, NLOHMANN_JSON_NAMESPACE_VERSION) \\\n  {\n#define NLOHMANN_JSON_NAMESPACE_END } } // namespace nlohmann\n',
    '#if defined(__cplusplus)\n#define BEGIN_C_DECLS extern "C" {\n#define END_C_DECLS }\n#else\n#define BEGIN_C_DECLS\n#define END_C_DECLS\n#endif\n#define COMPUTED namespace NAME(x) {\n',
  ]);
  assert.equal(macros.namespaces.get('NLOHMANN_JSON_NAMESPACE_BEGIN'), 'namespace nlohmann { inline namespace NLOHMANN_JSON_NAMESPACE_CONCAT {');
  assert.equal(macros.namespaces.get('NLOHMANN_JSON_NAMESPACE_END'), '} }');
  assert.equal(macros.namespaces.get('BEGIN_C_DECLS'), 'extern "C" {');
  assert.equal(macros.namespaces.get('END_C_DECLS'), '}');
  assert.ok(!macros.namespaces.has('COMPUTED') && !macros.decorations.has('BEGIN_C_DECLS'));
});

test('a macro naming a namespace is that name everywhere: in the namespace macro and in qualified names', () => {
  // spdlog: `#define SPDLOG_NAMESPACE_BEGIN namespace SPDLOG_NAMESPACE {`; calls say spdlog::info.
  const macros = collectMacros(['#ifndef SPDLOG_NAMESPACE\n#define SPDLOG_NAMESPACE spdlog\n#endif\n#define SPDLOG_NAMESPACE_BEGIN namespace SPDLOG_NAMESPACE {\n#define SPDLOG_NAMESPACE_END }\n#define LEVEL 3\n']);
  assert.equal(macros.namespaces.get('SPDLOG_NAMESPACE_BEGIN'), 'namespace spdlog {');
  assert.equal(macros.namespaces.get('SPDLOG_NAMESPACE'), 'spdlog'.padEnd(16));
  assert.ok(!macros.namespaces.has('LEVEL'));
  const { text } = preprocess('SPDLOG_NAMESPACE_BEGIN\nvoid f() { SPDLOG_NAMESPACE::info(); }\nSPDLOG_NAMESPACE_END\n', { macros });
  assert.equal(text.split('\n')[1], 'void f() { spdlog          ::info(); }');
});

test('a macro standing for a template header is expanded, so the class after it stays a class', () => {
  // nlohmann/json: basic_json, the library's main class, was missing from the map.
  const macros = collectMacros(['#define TPL_DECLARATION \\\n  template<template<typename, typename...> class ObjectType, \\\n           class StringType>\n#define TPL_WITH_REST template<class T> int\n']);
  assert.equal(macros.namespaces.get('TPL_DECLARATION'), 'template<template<typename, typename...> class ObjectType, class StringType>');
  assert.ok(!macros.namespaces.has('TPL_WITH_REST'));
  const { text } = preprocess('namespace n {\nTPL_DECLARATION\nclass basic_json {\n};\n}\n', { macros });
  assert.equal(text.split('\n')[1].trim(), 'template<template<typename, typename...> class ObjectType, class StringType>');
});

test('try and catch macros read as the keywords, so a class using them stays whole; throw macros stay calls', () => {
  // nlohmann/json, fmt, spdlog and Catch2 all spell try / catch with macros; the first branch (exceptions on) wins.
  const macros = collectMacros([
    '#if EXCEPTIONS\n#define JSON_TRY try\n#define JSON_CATCH(exception) catch(exception)\n#define JSON_THROW(exception) throw exception\n#define CATCH_ALL catch (...)\n#else\n#define JSON_TRY if(true)\n#define JSON_CATCH(exception) if(false)\n#endif\n#define NOT_A_CATCH(x) catch(y)\n',
  ]);
  assert.equal(macros.namespaces.get('JSON_TRY'), 'try     ');
  assert.equal(macros.namespaces.get('JSON_CATCH'), 'catch     ');
  assert.ok(!macros.namespaces.has('JSON_THROW'));
  assert.equal(macros.namespaces.get('CATCH_ALL'), 'catch (...)');
  assert.ok(!macros.namespaces.has('NOT_A_CATCH'));
  assert.equal(collectMacros(['#define JSON_PRIVATE_UNLESS_TESTED public\n']).namespaces.get('JSON_PRIVATE_UNLESS_TESTED'), 'public'.padEnd(26));
  const { text } = preprocess('void f() {\n  JSON_TRY { g(); }\n  JSON_CATCH(std::exception& e) { JSON_THROW(e); }\n}\n', { macros });
  assert.equal(text.split('\n')[1], '  try      { g(); }');
  assert.equal(text.split('\n')[2], '  catch     (std::exception& e) { JSON_THROW(e); }');
});

test('function-like macros that only stand for attributes are blanked where they are used', () => {
  // leveldb: `void Compact() EXCLUSIVE_LOCKS_REQUIRED(mutex_);` became a method named EXCLUSIVE_LOCKS_REQUIRED.
  const macros = collectMacros([
    '#if defined(__clang__)\n#define THREAD_ANNOTATION_ATTRIBUTE__(x) __attribute__((x))\n#else\n#define THREAD_ANNOTATION_ATTRIBUTE__(x)  // no-op\n#endif\n#define GUARDED_BY(x) THREAD_ANNOTATION_ATTRIBUTE__(guarded_by(x))\n#define EXCLUSIVE_LOCKS_REQUIRED(...) THREAD_ANNOTATION_ATTRIBUTE__(exclusive_locks_required(__VA_ARGS__))\n#define DCHECK(x)\n#define MAX(a, b) ((a) > (b) ? (a) : (b))\n',
  ]);
  assert.deepEqual(macros.attributes.sort(), ['EXCLUSIVE_LOCKS_REQUIRED', 'GUARDED_BY', 'THREAD_ANNOTATION_ATTRIBUTE__']);
  const { text } = preprocess('class Db {\n  void Compact() EXCLUSIVE_LOCKS_REQUIRED(mutex_);\n  int count_ GUARDED_BY(mutex_);\n};\n', { macros });
  assert.match(text.split('\n')[1], /^  void Compact\(\)\s+;$/);
  assert.match(text.split('\n')[2], /^  int count_\s+;$/);
});

test('a macro made of other decoration macros is a decoration; one made of code is not', () => {
  const macros = collectMacros([
    '#define HEDLEY_INLINE inline\n#define HEDLEY_ALWAYS_INLINE __attribute__((__always_inline__)) HEDLEY_INLINE\n#define OUTER HEDLEY_ALWAYS_INLINE\n#define JSON_TRY try\n#define JSON_THROW throw\n',
  ]);
  assert.equal(macros.decorations.get('HEDLEY_ALWAYS_INLINE'), 'inline');
  assert.equal(macros.decorations.get('OUTER'), 'inline');
  assert.ok(!macros.decorations.has('JSON_TRY') && !macros.decorations.has('JSON_THROW'));
});

test('a multi-line #define is blanked, a comment inside it included', () => {
  // The grammar ends the macro at the comment and read the rest as code: the class around it fell apart.
  const source = '#define ENUM_MACRO(T)  \\\n    /* comment */  \\\n    inline void to_json(T& j) { j = 1; }\nint after;\n';
  const lines = flatten(source, true).split('\n');
  assert.deepEqual(lines.slice(0, 3).map((l) => l.trim()), ['', '', '']);
  assert.equal(lines[3], 'int after;');
});

test('a macro defined two ways (export or import) is blanked', () => {
  const macros = collectMacros(['#ifdef BUILDING\n#define LIB_EXPORT __declspec(dllexport)\n#else\n#define LIB_EXPORT __declspec(dllimport)\n#endif\n']);
  assert.equal(macros.decorations.get('LIB_EXPORT'), '');
});

test('export macros, __declspec and __attribute__ are blanked; Qt and Unreal annotations become annotations', () => {
  const source = [
    'class SHOP_API Order : public Base {',
    '    Q_OBJECT',
    '    Q_PROPERTY(int count READ count NOTIFY countChanged)',
    'public:',
    '    Q_INVOKABLE void refresh();',
    'signals:',
    '    void countChanged(int);',
    'public slots:',
    '    void reload() { emit countChanged(1); }',
    '};',
    'UCLASS(Blueprintable)',
    'class GAME_API AShop : public AActor {',
    '    GENERATED_BODY()',
    '    UPROPERTY(EditAnywhere, meta = (ClampMin = "0"))',
    '    int32 Stock;',
    '};',
    '__declspec(dllexport) int f() __attribute__((noinline));',
  ].join('\n');
  const { text, annotations, sections } = preprocess(source);
  assert.equal(text.split('\n').length, source.split('\n').length);
  for (const gone of ['SHOP_API', 'GAME_API', 'Q_OBJECT', 'Q_PROPERTY', 'Q_INVOKABLE', 'signals', 'slots', 'emit', 'UCLASS', 'GENERATED_BODY', 'UPROPERTY', '__declspec', '__attribute__']) {
    assert.ok(!text.includes(gone), `${gone} left in:\n${text}`);
  }

  assert.match(text, /^public\s*:/m);
  assert.match(text, /countChanged\(1\)/);
  assert.deepEqual(annotations.map((a) => `${a.line} ${a.name}`), ['3 Q_PROPERTY', '5 Q_INVOKABLE', '11 UCLASS', '14 UPROPERTY']);
  assert.equal(annotations.find((a) => a.name === 'UPROPERTY').args, 'EditAnywhere, meta = (ClampMin = "0")');
  assert.deepEqual(sections, [{ line: 6, kind: 'signals', access: 'public' }, { line: 8, kind: 'slots', access: 'public' }]);
});

test('a struct named in capitals is not taken for an export macro', () => {
  const { text } = preprocess('struct SOCKADDR addr;\nclass SHOP_API Order {};\n');
  assert.match(text, /struct SOCKADDR addr/);
  assert.match(text, /class\s+Order/);
});

test('export macros are blanked where they decorate a declaration, not where a constant ends the same way', () => {
  // socket(AF_LOCAL, …) became socket(        , …), and enumerators named *_PUBLIC / *_HIDDEN vanished.
  const { text } = preprocess('int s = socket(AF_LOCAL, 1, 0);\nenum Vis { VIS_PUBLIC, VIS_HIDDEN };\nif (v == STV_HIDDEN) f(RTLD_NOW | RTLD_LOCAL);\nint y = A_PUBLIC or B_LOCAL;\nSHOP_EXPORT void f();\nextern SHOP_API int x;\nstruct S { LIB_API ~S(); };\n');
  const lines = text.split('\n');
  assert.equal(lines[0], 'int s = socket(AF_LOCAL, 1, 0);');
  assert.equal(lines[1], 'enum Vis { VIS_PUBLIC, VIS_HIDDEN };');
  assert.equal(lines[2], 'if (v == STV_HIDDEN) f(RTLD_NOW | RTLD_LOCAL);');
  assert.equal(lines[3], 'int y = A_PUBLIC or B_LOCAL;');
  assert.equal(lines[4].trim(), 'void f();');
  assert.match(lines[5], /^extern\s+int x;$/);
  assert.match(lines[6], /^struct S \{\s+~S\(\); \};$/);
});

test('a class named in capitals and marked final keeps its name', () => {
  // `class AABB final {` read AABB as an export macro: the class had no name and dropped off the map.
  const { text } = preprocess('class AABB final { int x; };\nstruct URL final : Base {};\nclass SHOP_API Order final : public Base {};\n');
  const lines = text.split('\n');
  assert.equal(lines[0], 'class AABB final { int x; };');
  assert.equal(lines[1], 'struct URL final : Base {};');
  assert.match(lines[2], /^class\s+Order final : public Base \{\};$/);
});

test('a macro named like a keyword is not applied', () => {
  // One test file with `#define private public` made every private member of the repository public.
  const macros = collectMacros(['#define private public\n#define protected public\n#define inline\n#define const\n#define SHOP_INLINE inline\n']);
  assert.deepEqual([...macros.namespaces.keys()], []);
  assert.deepEqual([...macros.decorations.keys()], ['SHOP_INLINE']);
  const source = 'class A : private B { private: int x; protected: SHOP_INLINE const int* f(); };';
  assert.equal(preprocess(source, { macros }).text, 'class A : private B { private: int x; protected: inline      const int* f(); };');
});

test('a macro call inside an expression is not blanked as a statement', () => {
  const kept = [
    'foo(a,\n    MAX(b, c)\n);', // an argument: foo(a, ) had one argument less
    'EXPECT_TRUE(ok)\n    << "why" << detail();', // the next line goes on from it
    'x = y &&\n    IS_SET(f)\n    && other;', // an operand
    'T table[] = {\n  ENTRY(a, b),\n  ENTRY(c, d)\n};', // the last entry of a table
    'int n = a >\n    LIMIT(b)\n    ? 1 : 2;',
    'value =\n    COMPUTE(x)\n;',
  ];
  for (const source of kept) assert.equal(preprocess(source).text, source, source);
});

test('a macro standing as a statement or a declaration is still blanked', () => {
  const blanked = (source, macro) => assert.ok(!preprocess(source).text.includes(macro), source);
  blanked('DECLARE_LOG_CATEGORY(Shop)\nint after;', 'DECLARE_LOG');
  blanked('#include "a.h"\nDECLARE_LOG_CATEGORY(Shop)\nint after;', 'DECLARE_LOG'); // after a preprocessor line
  blanked('int before;\n// what it is for\n/* and\n   more */\nDECLARE_THING(a)\nint after;', 'DECLARE_THING'); // after comments
  blanked('struct S {\n  DECLARE_FIELDS(S)\n};', 'DECLARE_FIELDS');
  blanked('class W {\npublic:\n  DECLARE_EVENTS(W)\n  void f();\n};', 'DECLARE_EVENTS');
  blanked('BEGIN_MAP(A, B)\n  ON_PAINT()\n  ON_COMMAND(ID_X, OnX)\nEND_MAP()\nint after;', 'ON_COMMAND'); // each after the one blanked before it
  blanked('template <class T>\nREQUIRES_NUMBER(T)\nvoid f(T t);', 'REQUIRES_NUMBER');
  blanked('DECLARE_CATEGORY(lc)\n[[nodiscard]] int f();', 'DECLARE_CATEGORY'); // [[…]] starts a declaration
  // Catch2's decomposer: the macros come after the long #define they call (blanked: thousands of spaces).
  blanked('int before;\n#define LONG(op) \\\n' + '    line(op); \\\n'.repeat(700) + '    end(op)\n\nDEFINE_OPERATOR( lt, < )\nDEFINE_OPERATOR( gt, > )\nint after;', 'DEFINE_OPERATOR');
  blanked('int before;\n/*' + ' many words\n'.repeat(1500) + '*/\nDECLARE_AFTER_COMMENT(a)\nint after;', 'DECLARE_AFTER_COMMENT');
  // The names it is given are still recorded.
  assert.deepEqual(preprocess('IOMETHODS(\n  afpIoFinder,\n  afpClose\n)\nint after;').macroArguments, ['afpIoFinder', 'afpClose']);
});

test('a #define whose body escapes a character is read: the names it uses are recorded', () => {
  // `#define LOG(fmt) log_write(fmt "\n")` matched no pattern, so log_write looked unused.
  const macros = collectMacros(['#define LOG(fmt) log_write(fmt "\\n")\n#define SEP \'\\\\\' + separator()\n#define MULTI(x) \\\n  first(x "\\t"); \\\n  second(x)\n']);
  for (const name of ['log_write', 'separator', 'first', 'second']) assert.ok(macros.words.has(name), name);
});

test('a comment that begins on a directive line and runs on is blanked to its end', () => {
  // GNU-style headers: the tail was read as code (a syntax error and a variable named `for`).
  const lines = flatten('#define FLAG_A 0x01 /* first flag,\n                       used for X */\nint y;\n#define FLAG_B 2 /* one line */\nint w;\n#endif /* GUARD\n  ends here */ int z;\n', true).split('\n');
  assert.deepEqual(lines.slice(0, 2).map((l) => l.trim()), ['', '']);
  assert.equal(lines[2], 'int y;');
  assert.equal(lines[4], 'int w;');
  assert.equal(lines[6].trim(), 'int z;');
});

test('__attribute__((fallthrough)) stays in the text; other attributes are blanked', () => {
  const { text } = preprocess('switch (x) { case 1: f(); __attribute__((fallthrough));\ncase 2: g(); __attribute__ ((__fallthrough__));\ndefault: break; }\nint h() __attribute__((noreturn));\n');
  const lines = text.split('\n');
  assert.match(lines[0], /__attribute__\(\(fallthrough\)\);$/);
  assert.match(lines[1], /__attribute__ \(\(__fallthrough__\)\);$/);
  assert.match(lines[3], /^int h\(\)\s+;$/);
});

test('an include guard is not a decoration macro; a macro given its default the same way is', () => {
  // Every header's guard was in the table of macros: 20,000 headers made a regular expression of 20,000 names.
  const macros = collectMacros([
    '#ifndef SHOP_ORDER_H\n#define SHOP_ORDER_H\nclass Order {};\n#endif\n',
    '#if !defined(SHOP_MONEY_H_)\n#  define SHOP_MONEY_H_ // guard\n\nint x;\n#endif\n',
    '#ifndef SHOP_API\n#  define SHOP_API\n#endif\n',
  ]);
  assert.deepEqual([...macros.decorations.keys()], ['SHOP_API']);
  assert.match(preprocess('class SHOP_API Order {};\nSHOP_API void f();', { macros }).text, /^class\s+Order \{\};\n\s+void f\(\);$/);
  // The table and the regular expression of the names are made once and kept for the next file.
  const pattern = macros.pattern;
  preprocess('SHOP_API void g();', { macros });
  assert.ok(pattern && macros.pattern === pattern);
});

test('a test over a list of types keeps its title; the types are blanked', () => {
  // nlohmann/json: TEST_CASE_TEMPLATE("…", T, int32_t, …) is no call the grammar can read; the test and the
  // tests after it were lost (or the whole macro was blanked, when a comment ended its line).
  const { text } = preprocess('TEST_CASE_TEMPLATE("extreme values", T, int32_t, uint64_t) // NOLINT\n{\n  T x;\n}\nTEMPLATE_TEST_CASE("sizes", "[vector]", int, (std::tuple<int, float>))\n{\n}\nTEST_CASE("plain") {}\n');
  const lines = text.split('\n');
  assert.match(lines[0], /^TEST_CASE_TEMPLATE\("extreme values"\s+\) \/\/ NOLINT$/);
  assert.match(lines[4], /^TEMPLATE_TEST_CASE\("sizes", "\[vector\]"\s+\)$/);
  assert.equal(lines[7], 'TEST_CASE("plain") {}');
});
