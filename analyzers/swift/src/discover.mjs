import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const manifest = JSON.parse(readFileSync(new URL('../codemap-plugin.json', import.meta.url), 'utf8'));
const IGNORED = new Set(manifest.detect.ignoreDirs.filter((d) => !d.includes('*')).map((d) => d.toLowerCase()));
const IGNORED_PATTERNS = manifest.detect.ignoreDirs.filter((d) => d.includes('*')).map((d) => new RegExp('^' + d.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i'));
const IGNORED_MARKERS = manifest.detect.ignoreMarkers ?? [];

export const toPosix = (path) => path.split(sep).join('/');

/** Project files read with the grammar or as text, by name. */
export const isTuistManifest = (name) => name === 'Project.swift';
export const isXcodeGenSpec = (name) => name === 'project.yml' || name === 'project.yaml';
export const isPodspec = (name) => /\.podspec(\.json)?$/.test(name);

/**
 * Manifests and build helpers written in Swift that are not code of the map: Package.swift (and its versions),
 * Tuist's Project.swift, Workspace.swift, Tuist/ and its helpers.
 */
export function isManifestSource(path) {
  const name = basename(path);
  if (/^Package(@swift-[\d.]+)?\.swift$/.test(name) || name === 'Project.swift' || name === 'Workspace.swift') return true;
  return /(^|[/\\])Tuist[/\\]/.test(path);
}

/** Test code by folder or name: Tests/, IntegrationTests/, tests_…/, *Tests.swift, *Test.swift, *Spec.swift. */
export function isTestFile(path) {
  return /(^|\/)(tests?|unittests?|uitests?|specs?)\//i.test(path)
    || /(^|\/)(Integration|Snapshot|UI|Unit|Performance|Acceptance|EndToEnd|E2E|Functional|Smoke|Regression|Compatibility)Tests\//.test(path)
    || /(^|\/)tests?_[^/]*\//.test(path) // swift-nio's tests_04_performance/
    || /(^|\/)[^/]*[a-z0-9](Tests?|Spec|Specs)\.swift$/.test(path);
}

/** Files a tool wrote: by name (*.generated.swift, R.generated.swift) or a mark at the top. */
export function isGenerated(path, text) {
  const name = basename(path);
  if (/\.(generated|gen)\.swift$/i.test(name) || /^R\.generated\.swift$/.test(name)) return true;
  const head = text.slice(0, 1024);
  return /@generated|Generated using (SwiftGen|Sourcery|R\.swift)|automatically generated|DO NOT EDIT/i.test(head);
}

const isBundle = (path, name) => (/\.xcodeproj$/i.test(name) && existsSync(join(path, 'project.pbxproj'))) || (/\.xcworkspace$/i.test(name) && existsSync(join(path, 'contents.xcworkspacedata')));

/**
 * What to analyze for a target: the Swift files and the project files around them.
 *   { target, scanDir, only, files, packages, xcodeprojs, workspaces, tuist, xcodegen, podfiles, podspecs, repository }
 * - a folder: every project file under it, and under the nearest folder above with one when it is inside a project
 *   (Sources/Shop of a package), so the ids are those of the whole project; its own Swift files;
 * - App.xcodeproj, App.xcworkspace, Package.swift, Project.swift, project.yml, a podspec or a Podfile: that project
 *   alone (`only`), with the Swift files of its folder;
 * - a Swift file: that file, in the project that holds it.
 */
export function discover(target) {
  const full = resolve(target);
  const stat = statSync(full);
  const name = basename(full);
  const found = { target: full, scanDir: null, only: null, files: [], packages: [], xcodeprojs: [], workspaces: [], tuist: [], xcodegen: [], podfiles: [], podspecs: [], repository: null };

  let within = null; // the Swift files analyzed are those under it
  if (stat.isDirectory() && isBundle(full, name)) {
    found.scanDir = dirname(full);
    found.only = { kind: /\.xcodeproj$/i.test(name) ? 'xcodeproj' : 'xcworkspace', path: full };
  } else if (stat.isFile() && kindOfFile(name) !== 'file') {
    found.scanDir = dirname(full);
    found.only = { kind: kindOfFile(name), path: full };
  } else if (stat.isFile()) {
    found.scanDir = projectAbove(dirname(full)) ?? dirname(full);
    within = full;
  } else {
    found.scanDir = projectAbove(full) ?? full;
    within = full;
  }

  found.repository = repositoryOf(found.scanDir);
  walk(found.scanDir, found, within);
  return found;
}

function kindOfFile(name) {
  if (/^Package(@swift-[\d.]+)?\.swift$/.test(name)) return 'package';
  if (isTuistManifest(name)) return 'tuist';
  if (isXcodeGenSpec(name)) return 'xcodegen';
  if (isPodspec(name)) return 'podspec';
  if (name === 'Podfile') return 'podfile';
  return 'file';
}

/** The nearest folder above (or at) `dir` with a project file, up to the repository root; not the home folder. */
function projectAbove(dir) {
  const home = homedir();
  for (let current = dir; ; current = dirname(current)) {
    if (current === home) return null;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return null;
    }

    if (entries.some((e) => (e.isFile() && isMarker(e.name)) || (e.isDirectory() && isBundle(join(current, e.name), e.name)))) return current === dir ? null : current;
    if (entries.some((e) => e.name === '.git') || dirname(current) === current) return null;
  }
}

function isMarker(name) {
  return name === 'Package.swift' || isTuistManifest(name) || isXcodeGenSpec(name) || isPodspec(name) || name === 'Podfile';
}

function repositoryOf(dir) {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return current;
    if (dirname(current) === current || current === homedir()) return null;
  }
}

export function isIgnoredDir(name) {
  if (name.startsWith('.')) return true;
  const lower = name.toLowerCase();
  return IGNORED.has(lower) || IGNORED_PATTERNS.some((re) => re.test(name));
}

function walk(root, found, within) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    if (dir !== root && entries.some((e) => IGNORED_MARKERS.includes(e.name))) continue;
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isBundle(path, entry.name)) {
          (/\.xcodeproj$/i.test(entry.name) ? found.xcodeprojs : found.workspaces).push(path);
        } else if (!isIgnoredDir(entry.name)) {
          stack.push(path);
        }

        continue;
      }

      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const name = entry.name;
      if (name === 'Package.swift') found.packages.push(path);
      else if (isTuistManifest(name)) found.tuist.push(path);
      else if (isXcodeGenSpec(name)) found.xcodegen.push(path);
      else if (name === 'Podfile') found.podfiles.push(path);
      else if (isPodspec(name)) found.podspecs.push(path);
      if (extname(name) === '.swift' && !isManifestSource(path) && (!within || isUnder(path, within))) found.files.push(path);
    }
  }

  // In path order, so ids that depend on which of two same-named targets comes first do not depend on the disk.
  for (const key of ['files', 'packages', 'xcodeprojs', 'workspaces', 'tuist', 'xcodegen', 'podfiles', 'podspecs']) found[key].sort();
}

export function isUnder(path, dir) {
  const rel = relative(dir, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function lineCount(text) {
  if (!text) return 0;
  let lines = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lines++;
  return text.endsWith('\n') ? lines - 1 : lines;
}

