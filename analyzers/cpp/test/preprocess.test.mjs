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
