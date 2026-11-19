import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { isUnder, toPosix } from '../discover.mjs';
import { globMatcher } from './glob.mjs';
import { readPodfile, readPodspec, readTuistProject, readXcodeGenProject } from './others.mjs';
import { readPackage } from './swiftpm.mjs';
import { readWorkspace, readXcodeProject } from './xcode.mjs';

/**
 * The projects of the map (SwiftPM targets, Xcode targets, Tuist and XcodeGen targets, podspecs, else folders) and
 * the project of every Swift file. A file goes to the first kind that claims it, in that order: a folder with both a
 * Package.swift and an .xcodeproj of the same files (Alamofire) is mapped by its package; several Xcode targets of
 * the same files (one per platform) are one project, the first. Projects with no Swift file are left out.
 *
 *   { projects: [Project], fileProject: Map(path → Project), warnings }
 *   Project = { id, name, kind, dir, test, executable, signature, marker: { file, line }, references: [Project],
 *               packages: [names], files: [paths] }
 */
export function buildProjects(found, parse) {
  const warnings = [];
  const read = (reader, file) => {
    try {
      return reader(file);
    } catch (error) {
      warnings.push(`${toPosix(relative(found.scanDir, file))} could not be read (${String(error?.message ?? error).split('\n')[0]}).`);
      return null;
    }
  };

  // What was asked for: one project file alone, or everything found.
  const only = found.only;
  const pick = (kind, list) => (!only ? list : only.kind === kind ? [only.path] : []);
  let xcodeprojs = pick('xcodeproj', found.xcodeprojs);
  const packageDirs = [];
  if (only?.kind === 'xcworkspace') {
    const workspace = read(readWorkspace, only.path);
    xcodeprojs = (workspace?.projects ?? []).filter((p) => existsSync(join(p, 'project.pbxproj')));
    for (const folder of workspace?.folders ?? []) if (existsSync(join(folder, 'Package.swift'))) packageDirs.push(join(folder, 'Package.swift'));
  }

  if (only?.kind === 'podfile') xcodeprojs = found.xcodeprojs.filter((p) => dirname(p) === dirname(only.path));
  const packages = [...pick('package', found.packages), ...packageDirs].map((f) => read((file) => readPackage(file, parse), f)).filter(Boolean);
  const xcode = xcodeprojs.map((b) => read(readXcodeProject, b)).filter(Boolean);
  const tuist = pick('tuist', found.tuist).map((f) => read((file) => readTuistProject(file, parse), f)).filter(Boolean);
  const xcodegen = pick('xcodegen', found.xcodegen).map((f) => read(readXcodeGenProject, f)).filter(Boolean);
  const podspecs = pick('podspec', found.podspecs).map((f) => read(readPodspec, f)).filter(Boolean);
  const podfiles = (only && only.kind !== 'podfile' && only.kind !== 'xcodeproj' && only.kind !== 'xcworkspace' ? [] : found.podfiles).map((f) => read(readPodfile, f)).filter(Boolean);

  const projects = [];
  const claims = new Claims();
  const add = (project) => {
    projects.push(project);
    return project;
  };

  // SwiftPM: a target's folder (or the paths it lists), less what it excludes; the deepest folder wins.
  for (const pkg of packages) {
    for (const target of pkg.targets) {
      if (target.kind === 'plugin' && !target.sources) continue;
      const project = add(newProject(target.name, 'swiftpm', target.dir, {
        test: target.kind === 'test',
        executable: target.kind === 'executable',
        signature: `.${target.kind === 'library' ? 'target' : target.kind === 'test' ? 'testTarget' : target.kind === 'executable' ? 'executableTarget' : target.kind}`,
        marker: { file: pkg.file, line: target.line },
        container: pkg.name,
      }));
      project.source = { pkg, target };
      const roots = target.sources ?? [target.dir];
      for (const root of roots) claims.dir(root, project, (path) => !target.exclude.some((e) => isUnder(path, e)));
    }
  }

  // Xcode: the files of a target's sources build phase, and its synchronized folders.
  for (const proj of xcode) {
    for (const target of proj.targets) {
      const project = add(newProject(target.name, 'xcode', commonDir(target.files, target.folders.map((f) => f.dir)) ?? proj.dir, {
        test: target.test,
        executable: target.executable,
        signature: target.productType.replace(/^com\.apple\.product-type\./, ''),
        marker: { file: proj.file, line: target.line },
        container: proj.name,
      }));
      project.source = { xcode: proj, target };
      for (const file of target.files) claims.file(file, project);
      for (const folder of target.folders) claims.dir(folder.dir, project, (path) => !folder.excluded.has(path), 1);
    }
  }

  // Tuist and XcodeGen: their targets' source patterns.
  for (const spec of [...tuist.map((t) => ({ ...t, kind: 'tuist' })), ...xcodegen.map((x) => ({ ...x, kind: 'xcodegen' }))]) {
    for (const target of spec.targets) {
      const matcher = globMatcher(spec.dir, target.sources);
      const excluded = globMatcher(spec.dir, target.excludes);
      const project = add(newProject(target.name, spec.kind, commonDir([], matcher.roots) ?? spec.dir, {
        test: target.test,
        executable: target.executable,
        signature: target.signature,
        marker: { file: spec.file, line: target.line },
        container: spec.name,
      }));
      project.source = { spec, target };
      for (const root of matcher.roots) claims.dir(root, project, (path) => matcher.matches(path) && !excluded.matches(path), 2);
    }
  }

  // A podspec's source files, when nothing else holds them.
  for (const spec of podspecs) {
    for (const [patterns, test] of [[spec.sources, false], [spec.testSources, true]]) {
      if (!patterns.length) continue;
      const matcher = globMatcher(spec.dir, patterns);
      const project = add(newProject(test ? `${spec.name}Tests` : spec.name, 'podspec', commonDir([], matcher.roots) ?? spec.dir, {
        test,
        signature: 'podspec',
        marker: { file: spec.file, line: spec.line },
        container: spec.name,
      }));
      project.source = { podspec: spec };
      for (const root of matcher.roots) claims.dir(root, project, (path) => matcher.matches(path), 3);
    }
  }

  // Each file to its project; what nothing claims to a folder project (the folder with a project file above it,
  // or the folder analyzed), unless one project file alone was asked for.
  const fileProject = new Map();
  const folders = new Map();
  for (const path of found.files) {
    let project = claims.owner(path);
    if (!project) {
      if (only && only.kind !== 'file') continue;
      const dir = folderOf(path, found);
      project = folders.get(dir);
      if (!project) {
        project = add(newProject(basename(dir), 'folder', dir, { signature: 'folder', container: basename(dirname(dir)) }));
        folders.set(dir, project);
      }
    }

    project.files.push(path);
    fileProject.set(path, project);
  }

  const kept = projects.filter((p) => p.files.length);
  assignIds(kept);
  link(kept, { packages, podfiles, all: projects, fileProject });
  return { projects: kept, fileProject, warnings };
}

function newProject(name, kind, dir, extra) {
  return { id: null, name, kind, dir, test: false, executable: false, references: [], packages: [], files: [], ...extra };
}

/**
 * Who claims a file: explicit files first, then folders, deepest first, by rank (SwiftPM 0, Xcode folders 1,
 * Tuist and XcodeGen 2, podspecs 3) and then the order they were added.
 */
class Claims {
  constructor() {
    this.files = new Map();
    this.dirs = new Map(); // dir → [{ project, accepts, rank, order }]
    this.order = 0;
  }

  file(path, project) {
    if (!this.files.has(path)) this.files.set(path, project);
  }

  dir(dir, project, accepts, rank = 0) {
    if (!this.dirs.has(dir)) this.dirs.set(dir, []);
    this.dirs.get(dir).push({ project, accepts, rank, order: this.order++ });
  }

  owner(path) {
    // From the file itself (a target that lists single files) up: the deepest claim wins, unless one higher up has
    // a lower rank (SwiftPM targets come before Xcode's, a package before its .xcodeproj of the same files).
    let best = null;
    for (let dir = path; ; dir = dirname(dir)) {
      let here = null;
      for (const claim of this.dirs.get(dir) ?? []) {
        if (!claim.accepts(path)) continue;
        if (!here || claim.rank < here.rank || (claim.rank === here.rank && claim.order < here.order)) here = claim;
      }

      if (here && (!best || here.rank < best.rank)) best = here;
      if (best?.rank === 0 || dirname(dir) === dir) break;
    }

    const explicit = this.files.get(path);
    if (explicit && (!best || best.rank > 0)) return explicit;
    return best?.project ?? null;
  }
}

/** The deepest folder that holds all of these files and folders. */
function commonDir(files, dirs) {
  const all = [...files.map((f) => dirname(f)), ...dirs];
  if (!all.length) return null;
  let common = all[0];
  for (const dir of all.slice(1)) while (!isUnder(dir, common) && dirname(common) !== common) common = dirname(common);
  return common;
}

/** A file nothing claims: the nearest folder above it with a project file, else the folder analyzed. */
function folderOf(path, found) {
  const markers = new Set([...found.packages, ...found.tuist, ...found.xcodegen, ...found.podspecs, ...found.podfiles].map((f) => dirname(f)).concat(found.xcodeprojs.map((p) => dirname(p))));
  for (let dir = dirname(path); isUnder(dir, found.scanDir); dir = dirname(dir)) {
    if (markers.has(dir)) return dir;
    if (dir === found.scanDir || dirname(dir) === dir) break;
  }

  return found.scanDir;
}

/** Unique ids: the target's name; when two share it, the second and later add their package or project. */
function assignIds(projects) {
  const used = new Set();
  for (const project of projects) {
    let id = project.name;
    if (used.has(id) && project.container && project.container !== project.name) id = `${project.name} (${project.container})`;
    for (let i = 2; used.has(id); i++) id = `${project.name}~${i}`;
    used.add(id);
    project.id = id;
  }
}

/** Dependencies between projects (projectReference) and on packages outside the map (packageReference). */
function link(projects, { packages, podfiles, all = projects, fileProject = new Map() }) {
  const byName = new Map();
  for (const project of projects) if (!byName.has(project.name)) byName.set(project.name, project);
  const sameContainer = (project, name) => projects.find((p) => p.name === name && p.container === project.container && p.kind === project.kind) ?? null;
  // An Xcode target left with no files because a package holds them (Kingfisher.xcodeproj's Kingfisher framework):
  // what depends on it depends on the projects that hold its files.
  const holdersOf = (dropped) => {
    const target = dropped?.source?.target;
    if (!target) return [];
    const owners = new Set();
    for (const file of target.files ?? []) if (fileProject.get(file)) owners.add(fileProject.get(file));
    for (const folder of target.folders ?? []) for (const [file, owner] of fileProject) if (isUnder(file, folder.dir)) owners.add(owner);
    return [...owners].filter((p) => !p.test);
  };
  const xcodeTarget = (project, name) => {
    const kept = sameContainer(project, name);
    if (kept) return [kept];
    return holdersOf(all.find((p) => p.name === name && p.container === project.container && p.kind === 'xcode' && !p.files.length));
  };
  // A framework another project of the map builds (a workspace's Kingfisher.framework); system frameworks are not.
  const framework = (project, name) => {
    const built = projects.filter((p) => p.name === name && !p.test);
    return built.length ? built : holdersOf(all.find((p) => p.name === name && p.kind === 'xcode' && !p.files.length));
  };
  // Products of the packages read: name → targets, and the package each product is in.
  const products = new Map();
  for (const pkg of packages) for (const product of pkg.products) products.set(`${pkg.name}|${product.name}`, product.targets);
  const productTargets = (packageName, product) => {
    const pkg = packages.find((p) => p.name === packageName || basename(p.dir) === packageName || (packageName === null && p.products.some((x) => x.name === product)));
    if (!pkg) return null;
    const names = products.get(`${pkg.name}|${product}`) ?? (pkg.targets.some((t) => t.name === product) ? [product] : null);
    return names?.map((n) => projects.find((p) => p.name === n && p.source?.pkg === pkg)).filter(Boolean) ?? null;
  };

  const refer = (project, other) => {
    if (other && other !== project && !project.references.includes(other)) project.references.push(other);
  };
  const external = (project, name) => {
    if (name && !project.packages.includes(name)) project.packages.push(name);
  };

  for (const project of projects) {
    const source = project.source ?? {};
    if (source.target && source.pkg) {
      for (const dependency of source.target.dependencies) {
        // A target of the package with no Swift in it (a C target of swift-nio) is not on the map, nor a package.
        if (dependency.target || source.pkg.targets.some((t) => t.name === dependency.byName)) refer(project, sameContainer(project, dependency.target ?? dependency.byName));
        else if (dependency.byName) {
          const local = sameContainer(project, dependency.byName);
          const elsewhere = local ? null : productTargets(null, dependency.byName);
          if (local) refer(project, local);
          else if (elsewhere?.length) for (const other of elsewhere) refer(project, other);
          else external(project, dependency.byName);
        } else if (dependency.product) {
          const local = productTargets(dependency.package, dependency.product);
          if (local?.length) for (const other of local) refer(project, other);
          else external(project, dependency.package ?? dependency.product);
        }
      }
    } else if (source.xcode) {
      for (const name of source.target.dependencies) for (const other of xcodeTarget(project, name)) refer(project, other);
      for (const name of source.target.frameworks ?? []) for (const other of framework(project, name)) refer(project, other);
      for (const product of source.target.products) {
        const local = productTargets(product.path ? packages.find((p) => p.dir === product.path)?.name ?? null : product.package, product.product);
        if (local?.length) for (const other of local) refer(project, other);
        else external(project, product.package ?? product.product);
      }
    } else if (source.spec) {
      for (const dependency of source.target.dependencies) {
        if (dependency.target) refer(project, sameContainer(project, dependency.target) ?? (dependency.path ? byName.get(dependency.target) : null));
        else external(project, dependency.package);
      }
    } else if (source.podspec) {
      if (project.test) refer(project, projects.find((p) => p.source?.podspec === source.podspec && !p.test));
      for (const name of source.podspec.dependencies) external(project, name);
    }
  }

  // A Podfile's pods are packages of the Xcode targets of its folder with those names.
  for (const podfile of podfiles) {
    for (const [name, pods] of podfile.targets) {
      for (const project of projects) {
        if (project.kind !== 'xcode' || project.name !== name) continue;
        if (podfile.project ? project.source.xcode.bundle !== podfile.project : dirname(project.source.xcode.bundle) !== podfile.dir) continue;
        for (const pod of pods) external(project, pod);
      }
    }
  }

  for (const project of projects) project.references.sort((a, b) => (a.id < b.id ? -1 : 1));
}

export { resolve, isUnder };
