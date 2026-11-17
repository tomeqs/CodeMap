import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import test from 'node:test';
import { commands, readCMake } from '../src/projects/cmake.mjs';
import { readVcxproj, solutionProjects } from '../src/projects/msbuild.mjs';
import { readBuildCs } from '../src/projects/unreal.mjs';
import { fixtures, scratch } from './helpers.mjs';

test('CMake commands: quoted, bracket and unquoted arguments, comments, generator expressions, lines', () => {
  const list = commands('# comment\nadd_library(core STATIC a.cpp "b c.cpp" #[[ skipped ]] [=[d.cpp]=])\n\ntarget_include_directories(core PUBLIC $<BUILD_INTERFACE:${X}/include> $<INSTALL_INTERFACE:include>)\n');
  assert.deepEqual(list.map((c) => [c.name, c.line, c.args.map((a) => a.value)]), [
    ['add_library', 2, ['core', 'STATIC', 'a.cpp', 'b c.cpp', 'd.cpp']],
    ['target_include_directories', 4, ['core', 'PUBLIC', '$<BUILD_INTERFACE:${X}/include>', '$<INSTALL_INTERFACE:include>']],
  ]);
});

test('CMake targets: sources through variables, globs and subdirectories; include directories; links; tests', () => {
  const { dir, dispose } = scratch({
    'CMakeLists.txt': 'project(app)\nset(SRC main.cpp)\nadd_executable(app ${SRC})\ntarget_link_libraries(app PRIVATE core::core Qt6::Widgets)\nadd_subdirectory(core)\nadd_subdirectory(tests)\n',
    'main.cpp': '',
    'core/CMakeLists.txt': 'file(GLOB CORE_SOURCES CONFIGURE_DEPENDS src/*.cpp)\nadd_library(core ${CORE_SOURCES})\nadd_library(core::core ALIAS core)\ntarget_include_directories(core PUBLIC $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>)\nif(WIN32)\n  target_sources(core PRIVATE src/win/win.cpp)\nendif()\n',
    'core/src/a.cpp': '',
    'core/src/b.cpp': '',
    'core/src/win/win.cpp': '',
    'tests/CMakeLists.txt': 'add_executable(core_tests t.cpp)\ntarget_link_libraries(core_tests core)\ngtest_discover_tests(core_tests)\nadd_executable(bench bench.cpp)\n',
  });
  try {
    const { targets, projectName } = readCMake(dir);
    const byName = Object.fromEntries(targets.map((t) => [t.name, t]));
    assert.equal(projectName, 'app');
    assert.deepEqual(Object.keys(byName).sort(), ['app', 'bench', 'core', 'core_tests']);
    assert.deepEqual(byName.app.sources, [join(dir, 'main.cpp')]);
    assert.deepEqual(byName.core.sources.map((s) => s.slice(dir.length + 1).split(sep).join('/')).sort(), ['core/src/a.cpp', 'core/src/b.cpp', 'core/src/win/win.cpp']);
    assert.ok(byName.core.includeDirs.includes(join(dir, 'core', 'include')));
    assert.deepEqual(byName.app.links, ['core', 'Qt6::Widgets']); // the alias is the target it names
    assert.equal(byName.app.kind, 'executable');
    assert.equal(byName.core_tests.test, true);
    assert.equal(byName.bench.test, false);
  } finally {
    dispose();
  }
});

test('Visual Studio projects and solutions', () => {
  const game = readVcxproj(join(fixtures, 'msbuild', 'Game', 'Game.vcxproj'), join(fixtures, 'msbuild'));
  assert.equal(game.name, 'Game');
  assert.equal(game.executable, true);
  assert.deepEqual(game.sources, [join(fixtures, 'msbuild', 'Game', 'main.cpp')]);
  assert.deepEqual(game.references, [join(fixtures, 'msbuild', 'Engine', 'Engine.vcxproj')]);
  assert.deepEqual(game.includeDirs, [join(fixtures, 'msbuild', 'Engine')]); // $(VCInstallDir) and %(…) are dropped
  assert.deepEqual(solutionProjects(join(fixtures, 'msbuild', 'Game.sln')).map((p) => p.slice(join(fixtures, 'msbuild').length + 1).split(sep).join('/')).sort(), ['Engine/Engine.vcxproj', 'Game/Game.vcxproj']);
});

test('Unreal modules name their dependencies', () => {
  const module = readBuildCs(join(fixtures, 'unreal', 'Source', 'ShopGame', 'ShopGame.Build.cs'));
  assert.equal(module.name, 'ShopGame');
  assert.deepEqual(module.dependencies, ['Core', 'CoreUObject', 'Engine', 'ShopCore', 'Slate']);
});

test('CMake: a foreach is read for each of its items; a target named by something unknown is no target', () => {
  // `add_executable(${t}_test …)` in a loop, or in a function, made a project named by the mark of the unknown.
  const { dir, dispose } = scratch({
    'CMakeLists.txt': [
      'add_library(core core.cpp)',
      'set(NAMES order money)',
      'foreach(t ${NAMES})',
      '  add_executable(${t}_test ${t}_test.cpp)',
      '  target_link_libraries(${t}_test core)',
      'endforeach()',
      'foreach(tool IN ITEMS dump load)',
      '  foreach(kind IN LISTS NAMES)',
      '    add_executable(${tool}_${kind} tools/${tool}.cpp)',
      '  endforeach()',
      'endforeach()',
      'foreach(n RANGE 3)',
      '  add_executable(bench_${n} bench.cpp)',
      'endforeach()',
      'function(add_plugin name)',
      '  add_library(${name} MODULE ${name}.cpp)',
      '  add_library(always_the_same MODULE x.cpp)',
      'endfunction()',
      'macro(add_sample name)',
      '  add_executable(sample_${name} ${name}.cpp)',
      'endmacro()',
      'add_plugin(png)',
      'add_executable(${NOT_SET} x.cpp)',
      'add_executable(last last.cpp)',
    ].join('\n'),
  });
  try {
    const { targets } = readCMake(dir);
    // add_plugin is read where it is called (png); add_sample is never called; bench_${n} and ${NOT_SET} are not known.
    assert.deepEqual(targets.map((t) => t.name).sort(), ['always_the_same', 'core', 'dump_money', 'dump_order', 'last', 'load_money', 'load_order', 'money_test', 'order_test', 'png']);
    const money = targets.find((t) => t.name === 'money_test');
    assert.deepEqual(money.sources, [join(dir, 'money_test.cpp')]);
    assert.deepEqual(money.links, ['core']);
    assert.deepEqual(targets.find((t) => t.name === 'load_order').sources, [join(dir, 'tools', 'load.cpp')]);
  } finally {
    dispose();
  }
});

test('CMake: a function or macro of the project is read where it is called, with the arguments of the call', () => {
  // googletest makes its libraries with cxx_library(gtest …): read as written, the body gave one target named by
  // the parameter; skipped, it gave none.
  const { dir, dispose } = scratch({
    'CMakeLists.txt': 'include(cmake/utils.cmake)\ncxx_library(gtest "${cxx_strict}" src/gtest-all.cc)\ncxx_library(gtest_main "${cxx_strict}" src/gtest_main.cc)\ncxx_test(sample1_unittest gtest_main)\n',
    'cmake/utils.cmake': [
      'function(cxx_library_with_type name type flags)',
      '  add_library(${name} ${type} ${ARGN})',
      'endfunction()',
      'function(cxx_library name flags)',
      '  cxx_library_with_type(${name} "" "${flags}" ${ARGN})',
      'endfunction()',
      'macro(cxx_test name libs)',
      '  add_executable(${name} test/${name}.cc)',
      '  target_link_libraries(${name} ${libs})',
      '  add_test(NAME ${name} COMMAND ${name})',
      'endmacro()',
      'function(recursive name)',
      '  recursive(${name}_again)',
      'endfunction()',
      'recursive(loop)',
    ].join('\n'),
  });
  try {
    const { targets } = readCMake(dir);
    assert.deepEqual(targets.map((t) => [t.name, t.kind, t.line, t.sources.map((s) => s.slice(dir.length + 1).split(sep).join('/'))]), [
      ['gtest', 'library', 2, ['src/gtest-all.cc']],
      ['gtest_main', 'library', 3, ['src/gtest_main.cc']],
      ['sample1_unittest', 'executable', 4, ['test/sample1_unittest.cc']],
    ]);
    const sample = targets.find((t) => t.name === 'sample1_unittest');
    assert.deepEqual([sample.links, sample.test], [['gtest_main'], true]);
  } finally {
    dispose();
  }
});

test('CMake: white space of any kind between arguments does not stop the reader', () => {
  // A no-break space or a form feed inside the parentheses kept it on the spot until memory ran out.
  const list = commands('add_library(core a.cpp\fb.cpp c.cpp)\nadd_executable(app main.cpp)\n');
  assert.deepEqual(list.map((c) => [c.name, c.args.map((a) => a.value)]), [
    ['add_library', ['core', 'a.cpp', 'b.cpp', 'c.cpp']],
    ['add_executable', ['app', 'main.cpp']],
  ]);
});

test('CMake: an included file has its own CMAKE_CURRENT_LIST_DIR, and gives it back', () => {
  const { dir, dispose } = scratch({
    'CMakeLists.txt': 'include(cmake/sources.cmake)\nadd_library(core ${CORE_SOURCES})\nadd_library(more ${CMAKE_CURRENT_LIST_DIR}/b.cpp)\n',
    'cmake/sources.cmake': 'set(CORE_SOURCES ${CMAKE_CURRENT_LIST_DIR}/../src/a.cpp)\n',
    'src/a.cpp': '',
    'b.cpp': '',
  });
  try {
    const { targets } = readCMake(dir);
    assert.deepEqual(targets.find((t) => t.name === 'core').sources, [join(dir, 'src', 'a.cpp')]);
    assert.deepEqual(targets.find((t) => t.name === 'more').sources, [join(dir, 'b.cpp')]);
  } finally {
    dispose();
  }
});

test('Unreal modules: dependencies in comments are not dependencies', () => {
  // The engine's template for Build.cs: "Uncomment if you are using Slate UI".
  const { dir, dispose } = scratch({
    'Source/Game/Game.Build.cs': [
      'public class Game : ModuleRules {',
      '  public Game(ReadOnlyTargetRules Target) : base(Target) {',
      '    PublicDependencyModuleNames.AddRange(new string[] { "Core", "Engine" });',
      '    // Uncomment if you are using Slate UI',
      '    // PrivateDependencyModuleNames.AddRange(new string[] { "Slate", "SlateCore" });',
      '    /* PrivateDependencyModuleNames.Add("OnlineSubsystem"); */',
      '    PrivateDependencyModuleNames.Add("UMG"); // widgets',
      '  }',
      '}',
    ].join('\n'),
  });
  try {
    assert.deepEqual(readBuildCs(join(dir, 'Source', 'Game', 'Game.Build.cs')).dependencies, ['Core', 'Engine', 'UMG']);
  } finally {
    dispose();
  }
});

test('the manifest names every file the plugin reads as a target', () => {
  const manifest = JSON.parse(readFileSync(new URL('../codemap-plugin.json', import.meta.url), 'utf8'));
  for (const input of ['CMakeLists.txt', '*.sln', '*.slnx', '*.vcxproj', '*.uproject']) assert.ok(manifest.detect.inputs.includes(input), input);
});
