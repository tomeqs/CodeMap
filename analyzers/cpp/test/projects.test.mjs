import assert from 'node:assert/strict';
import { join } from 'node:path';
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
    assert.deepEqual(byName.core.sources.map((s) => s.slice(dir.length + 1)).sort(), ['core/src/a.cpp', 'core/src/b.cpp', 'core/src/win/win.cpp']);
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
  assert.deepEqual(solutionProjects(join(fixtures, 'msbuild', 'Game.sln')).map((p) => p.slice(join(fixtures, 'msbuild').length + 1)).sort(), ['Engine/Engine.vcxproj', 'Game/Game.vcxproj']);
});

test('Unreal modules name their dependencies', () => {
  const module = readBuildCs(join(fixtures, 'unreal', 'Source', 'ShopGame', 'ShopGame.Build.cs'));
  assert.equal(module.name, 'ShopGame');
  assert.deepEqual(module.dependencies, ['Core', 'CoreUObject', 'Engine', 'ShopCore', 'Slate']);
});
