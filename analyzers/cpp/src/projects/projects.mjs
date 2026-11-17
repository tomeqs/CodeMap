import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, normalize, relative, sep } from 'node:path';
import { isHeaderFile, isTestFile, toPosix } from '../discover.mjs';
import { readCMake } from './cmake.mjs';
import { readVcxproj, solutionProjects } from './msbuild.mjs';
import { readBuildCs } from './unreal.mjs';

/** Libraries every program links that say nothing about the design. */
const SYSTEM_LIBRARIES = new Set(['m', 'dl', 'rt', 'pthread', 'c', 'stdc++', 'stdc++fs', 'c++fs', 'atomic', 'Threads::Threads', 'ws2_32', 'kernel32', 'user32']);
const FOLDER_KINDS = {
  'meson.build': 'Meson', Makefile: 'Makefile', GNUmakefile: 'Makefile', makefile: 'Makefile', BUILD: 'Bazel', 'BUILD.bazel': 'Bazel',
  'MODULE.bazel': 'Bazel', WORKSPACE: 'Bazel', 'configure.ac': 'Autotools', 'premake5.lua': 'Premake', 'xmake.lua': 'xmake',
  'vcpkg.json': 'vcpkg', 'conanfile.txt': 'Conan', 'conanfile.py': 'Conan',
};

/**
 * The projects of the code and the project of every file:
 * - CMake targets (add_library / add_executable), with the files they list;
 * - Visual Studio projects (.vcxproj), with theirs (only a solution's own when a .sln is analyzed);
 * - Unreal Engine modules (the folder of Name.Build.cs);
 * - a project per folder with another build file (meson.build, a Makefile, Bazel's BUILD…);
 * - and, for what none of these holds, a project named after the folder analyzed.
 * Files not listed by any project belong to the nearest project folder above them; headers to the project whose
 * include directories hold them.
 */
export function buildProjects(found, files) {
  const projects = [];
  const explicit = new Map();
  const add = (project) => {
    projects.push(project);
    for (const file of project.listed) if (!explicit.has(file)) explicit.set(file, project);
    return project;
  };

  // CMake: the topmost CMakeLists.txt above (it reaches this folder), then roots of their own inside.
  const cmakeRoots = [];
  if (found.above.cmake.length) cmakeRoots.push(found.above.cmake[found.above.cmake.length - 1]);
  else if (found.markers.cmake.length) cmakeRoots.push(dirname(shallowest(found.markers.cmake)));
  const visited = new Set();
  const cmakeTargets = [];
  const readRoot = (root) => {
    const result = readCMake(root);
    for (const file of result.visited) visited.add(file);
    cmakeTargets.push(...result.targets);
  };
  for (const root of cmakeRoots) readRoot(root);
  for (const file of [...found.markers.cmake].sort((a, b) => depth(a) - depth(b))) {
    if (!visited.has(file) && !found.markers.cmake.some((other) => other !== file && !visited.has(other) && isUnder(dirname(file), dirname(other)) && dirname(file) !== dirname(other))) readRoot(dirname(file));
  }

  for (const target of cmakeTargets) {
    const iface = target.interface && !target.sources.some((s) => !isHeaderFile(s));
    add({
      name: target.name,
      dir: target.dir,
      kind: 'cmake',
      marker: { file: target.file, line: target.line },
      signature: `CMake · ${target.test ? 'test' : iface ? 'header-only library' : target.kind}`,
      executable: target.kind === 'executable',
      test: target.test,
      listed: target.sources,
      includeDirs: [...new Set([...target.includeDirs, target.dir])],
      linkNames: target.links,
      interface: iface,
    });
  }

  // Visual Studio.
  const vcxprojFiles = found.solution ? solutionProjects(found.solution) : [...found.markers.vcxproj, ...found.above.vcxproj];
  const solutionDir = found.solution ? dirname(found.solution) : null;
  for (const file of [...new Set(vcxprojFiles)]) {
    const project = readVcxproj(file, solutionDir);
    if (!project) continue;
    add({
      name: project.name,
      dir: project.dir,
      kind: 'msbuild',
      marker: { file, line: 1 },
      signature: `Visual Studio · ${project.configurationType ?? 'project'}`,
      executable: project.executable,
      test: /tests?$/i.test(project.name),
      listed: project.sources,
      includeDirs: [...new Set([...project.includeDirs, project.dir])],
      referenceFiles: project.references,
      linkNames: [],
    });
  }

  // Unreal Engine modules.
  const modules = [...new Set([...found.markers.buildCs, ...found.above.buildCs])].map(readBuildCs).filter(Boolean);
  const moduleNames = new Set(modules.map((m) => m.name));
  for (const module of modules) {
    add({
      name: module.name,
      dir: module.dir,
      kind: 'unreal',
      marker: { file: module.file, line: 1 },
      signature: 'Unreal Engine module',
      executable: false,
      test: /tests?$/i.test(module.name),
      listed: [],
      includeDirs: ['', 'Public', 'Private', 'Classes'].map((d) => join(module.dir, d)),
      linkNames: module.dependencies,
      unrealModules: moduleNames,
      contains: true,
    });
  }

  // A project per folder with another build file, the topmost of each tree.
  const folderMarkers = [...found.markers.folder];
  if (found.above.folder) {
    const marker = Object.keys(FOLDER_KINDS).map((n) => join(found.above.folder, n)).find((f) => existsSync(f));
    if (marker) folderMarkers.push(marker);
  }

  const folderDirs = [...new Set(folderMarkers.map(dirname))].sort((a, b) => depth(a) - depth(b));
  const topFolders = [];
  const top = new Set();
  for (const dir of folderDirs) {
    if (ancestors(dirname(dir)).some((above) => top.has(keyOf(above)))) continue;
    top.add(keyOf(dir));
    topFolders.push(dir);
  }
  for (const dir of topFolders) {
    if (projects.some((p) => p.kind !== 'cmake' && p.dir === dir)) continue;
    const marker = folderMarkers.filter((f) => dirname(f) === dir).sort()[0];
    add({
      name: mesonName(dir) ?? basename(dir),
      dir,
      kind: 'folder',
      marker: { file: marker, line: 1 },
      signature: FOLDER_KINDS[basename(marker)] ?? 'folder',
      executable: false,
      test: false,
      listed: [],
      includeDirs: [dir, join(dir, 'include'), join(dir, 'src')],
      linkNames: [],
    });
  }

  // Every file to its project. The projects are looked up by the folders above the file (a repository of
  // hundreds of targets and tens of thousands of files compared every pair before).
  const index = folderIndex(projects);
  const fileProject = new Map();
  let fallback = null;
  for (const file of files) {
    const above = ancestors(dirname(file));
    let project = explicit.get(file) ?? null;
    if (!project) project = containingModule(index, above);
    if (!project && isHeaderFile(file)) project = byIncludeDirectory(index, above);
    if (!project) project = nearestFolder(index, above);
    if (!project && found.solution) continue; // a solution maps its own projects only
    if (!project) {
      fallback ??= add({
        name: basename(found.scanDir),
        dir: found.scanDir,
        kind: 'loose',
        marker: null,
        signature: 'no build file',
        executable: false,
        test: false,
        listed: [],
        includeDirs: [found.scanDir, join(found.scanDir, 'include'), join(found.scanDir, 'src')],
        linkNames: [],
      });
      project = fallback;
    }

    fileProject.set(file, project);
  }

  // The projects that hold files, named uniquely, with their references.
  const filesOf = new Map();
  for (const file of files) {
    const project = fileProject.get(file);
    if (!project) continue;
    if (!filesOf.has(project)) filesOf.set(project, []);
    filesOf.get(project).push(file);
  }

  const used = projects.filter((p) => filesOf.has(p));
  const usedSet = new Set(used);
  const names = new Set();
  for (const project of used) {
    let name = project.name;
    for (let i = 2; names.has(name); i++) name = `${project.name}~${i}`;
    names.add(name);
    project.id = name;
    project.files = filesOf.get(project);
    project.test ||= project.files.every((f) => isTestFile(toPosix(relative(found.scanDir, f))));
  }

  const byName = new Map(projects.map((p) => [p.name, p]));
  const byFile = new Map(projects.filter((p) => p.kind === 'msbuild').map((p) => [normalize(p.marker.file), p]));
  for (const project of used) {
    const references = new Set();
    const libraries = new Set();
    for (const name of project.linkNames) {
      const other = byName.get(name) ?? byName.get(name.replace(/^.*::/, ''));
      if (other && other !== project && (project.kind !== 'unreal' || other.kind === 'unreal')) references.add(other);
      else if (!other && !SYSTEM_LIBRARIES.has(name) && !/^-|\.(a|lib|so|dylib)$|[/\\]/.test(name)) libraries.add(name);
    }

    for (const file of project.referenceFiles ?? []) {
      const other = byFile.get(normalize(file));
      if (other && other !== project) references.add(other);
    }

    project.references = [...references].filter((p) => usedSet.has(p));
    project.libraries = [...libraries].sort();
  }

  return { projects: used, fileProject, explicit: new Set([...explicit.keys()].filter((f) => fileProject.has(f))), outside: outsideFiles(found, projects, files) };
}

/**
 * The files a solution's or a project file's projects list outside the folder analyzed (a solution kept apart from
 * the code: contrib/vs/zlib.sln naming ..\..\src\*.c). They are not read: CodeMap shows no place outside the
 * folder analyzed, so the caller says which folder holds them.
 */
function outsideFiles(found, projects, files) {
  if (!found.solution && !found.targetProject) return [];
  const read = new Set(files);
  const out = [];
  for (const project of projects) {
    if (project.kind !== 'msbuild') continue;
    for (const file of project.listed) if (!read.has(file) && !isUnder(file, found.scanDir) && existsSync(file)) out.push(file);
  }

  return out;
}

/** A folder as a key: its path without a separator at the end, and without case where the file system has none. */
const keyOf = process.platform === 'win32' ? (dir) => normalize(dir).replace(/[\\/]+$/, '').toLowerCase() : (dir) => (dir.length > 1 ? dir.replace(/\/+$/, '') : dir);

/** A folder and the folders above it, nearest first. */
function ancestors(dir) {
  const out = [];
  for (let d = dir, parent = dirname(d); ; d = parent, parent = dirname(d)) {
    out.push(d);
    if (parent === d) return out;
  }
}

/** The projects by their folder and by their include directories, in the order they were made. */
function folderIndex(projects) {
  const byDir = new Map();
  const byInclude = new Map();
  const put = (map, dir, entry) => {
    if (!dir) return;
    const key = keyOf(dir);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(entry);
  };
  let order = 0;
  for (const project of projects) {
    put(byDir, project.dir, project);
    for (const dir of project.includeDirs) put(byInclude, dir, { project, dir, order: order++ });
  }

  return { byDir, byInclude };
}

/** The Unreal module whose folder is the nearest above the file. */
function containingModule(index, above) {
  for (const dir of above) {
    const module = index.byDir.get(keyOf(dir))?.find((p) => p.contains);
    if (module) return module;
  }

  return null;
}

/** A header not listed anywhere: the project whose include directory holds it (the deepest one). */
function byIncludeDirectory(index, above) {
  const candidates = above.flatMap((dir) => index.byInclude.get(keyOf(dir)) ?? []).sort((a, b) => a.order - b.order);
  let best = null;
  let bestLength = -1;
  for (const { project: p, dir } of candidates) {
    if (dir.length > bestLength && (p.kind !== 'cmake' || !p.interface || !best)) {
      best = p;
      bestLength = dir.length;
    } else if (dir.length === bestLength && best && rank(p) < rank(best)) {
      best = p;
    }
  }

  return best;
}

/** The project whose folder is the nearest above the file; of several in one folder, a library before a program or test. */
function nearestFolder(index, above) {
  for (const dir of above) {
    const here = index.byDir.get(keyOf(dir));
    if (here) return here.reduce((best, p) => (rank(p) < rank(best) ? p : best));
  }

  return null;
}

function rank(project) {
  return (project.test ? 4 : 0) + (project.executable ? 2 : 0) + (project.interface ? 1 : 0);
}

function mesonName(dir) {
  try {
    const text = readFileSync(join(dir, 'meson.build'), 'utf8');
    return /\bproject\s*\(\s*'([^']+)'/.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function isUnder(path, dir) {
  if (!dir) return false;
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

function depth(path) {
  return path.split(sep).length;
}

function shallowest(paths) {
  return [...paths].sort((a, b) => depth(a) - depth(b))[0];
}
