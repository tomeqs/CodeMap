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
