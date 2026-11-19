import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { evaluate, topLevel } from './evaluate.mjs';
import { packageNameOfUrl } from './swiftpm.mjs';
import { parseYaml } from './yaml.mjs';

/**
 * The project files of Tuist (Project.swift), XcodeGen (project.yml) and CocoaPods (Podfile, *.podspec). Each reader
 * returns its targets as { name, test, executable, sources: [patterns relative to `dir`], excludes, dependencies:
 * [{ target } | { package }], line }, or null when the file is not one it can read.
 */

const TUIST_TESTS = new Set(['unitTests', 'uiTests']);
const TUIST_EXECUTABLES = new Set(['app', 'commandLineTool', 'appExtension', 'watch2App', 'watch2Extension', 'appClip', 'messagesExtension', 'extensionKitExtension', 'xpc', 'systemExtension']);

/** Tuist's Project.swift, read with the Swift grammar: `Project(name:targets:)` and its `.target(…)` / `Target(…)`. */
export function readTuistProject(file, parse) {
  const tree = parse(readFileSync(file, 'utf8'));
  try {
    const { env } = topLevel(tree.rootNode);
    let project = [...env.values()].find((v) => v?.call === 'Project');
    if (!project) {
      const visit = (node) => {
        if (project) return;
        if (node.type === 'call_expression' && node.namedChildren[0]?.text === 'Project') project = evaluate(node, env);
        else for (const child of node.namedChildren) visit(child);
      };
      visit(tree.rootNode);
    }

    if (!project) return null;
    const dir = dirname(file);
    const targets = [];
    for (const target of Array.isArray(project.args.targets) ? project.args.targets : []) {
      if (!target?.call || !['target', 'Target', 'init'].includes(target.call) || typeof target.args.name !== 'string') continue;
      const product = target.args.product?.call ?? null;
      targets.push({
        name: target.args.name,
        test: TUIST_TESTS.has(product),
        executable: TUIST_EXECUTABLES.has(product),
        signature: product ? `.${product}` : undefined,
        sources: tuistSources(target.args.sources),
        excludes: [],
        dependencies: (Array.isArray(target.args.dependencies) ? target.args.dependencies : []).map(tuistDependency).filter(Boolean),
        line: target.line,
      });
    }

    return { file, dir, name: typeof project.args.name === 'string' ? project.args.name : basename(dir), targets };
  } finally {
    tree.delete();
  }
}

/** "Sources/**", ["A/**", "B/**"], .paths([...]), SourceFilesList(globs: [...]), .glob("x", excluding: [...]). */
function tuistSources(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(tuistSources);
  if (value?.call) return [...value.positional, value.args.globs, value.args.paths, value.args.glob].flatMap((v) => (v === undefined ? [] : tuistSources(v)));
  return [];
}

function tuistDependency(value) {
  if (!value?.call) return null;
  const { name, target, product } = value.args;
  if (value.call === 'target' && typeof name === 'string') return { target: name };
  if (value.call === 'project' && typeof target === 'string') return { target, path: value.args.path };
  if ((value.call === 'external' || value.call === 'package') && typeof (name ?? product) === 'string') return { package: name ?? product };
  return null;
}

const XCODEGEN_TESTS = /^bundle\.(unit-test|ui-testing)$/;
const XCODEGEN_EXECUTABLES = /^(application(\..*)?|tool|app-extension|extensionkit-extension|watchkit2-extension)$/;

/** XcodeGen's project.yml: `targets:` with `type`, `sources` and `dependencies`; packages by name. */
export function readXcodeGenProject(file) {
  const text = readFileSync(file, 'utf8');
  let yaml;
  try {
    yaml = parseYaml(text);
  } catch {
    return null;
  }

  if (!yaml || typeof yaml !== 'object' || !yaml.targets || typeof yaml.targets !== 'object') return null;
  const dir = dirname(file);
  const lines = text.split('\n');
  const packages = new Map(Object.entries(yaml.packages ?? {}).map(([name, spec]) => [name, typeof spec?.url === 'string' ? packageNameOfUrl(spec.url) : name]));
  const targets = [];
  for (const [name, spec] of Object.entries(yaml.targets)) {
    if (!spec || typeof spec !== 'object') continue;
    const type = String(spec.type ?? '');
    const sources = [];
    const excludes = [];
    for (const source of [spec.sources ?? []].flat()) {
      if (typeof source === 'string') sources.push(source);
      else if (typeof source?.path === 'string') {
        sources.push(source.path);
        for (const exclude of [source.excludes ?? []].flat()) if (typeof exclude === 'string') excludes.push(`${source.path}/${exclude}`);
      }
    }

    const dependencies = [];
    for (const dependency of [spec.dependencies ?? []].flat()) {
      if (typeof dependency?.target === 'string') dependencies.push({ target: dependency.target.replace(/\/.*$/, '') });
      else if (typeof dependency?.package === 'string') dependencies.push({ package: packages.get(dependency.package) ?? dependency.package });
      else if (typeof dependency?.carthage === 'string') dependencies.push({ package: dependency.carthage });
      else if (typeof dependency?.framework === 'string') dependencies.push({ package: basename(dependency.framework).replace(/\.(xc)?framework$/, '') });
    }

    const at = lines.findIndex((l) => new RegExp(`^\\s+["']?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*:`).test(l));
    targets.push({ name, test: XCODEGEN_TESTS.test(type), executable: XCODEGEN_EXECUTABLES.test(type), signature: type || undefined, sources, excludes, dependencies, line: at + 1 || 1 });
  }

  return { file, dir, name: typeof yaml.name === 'string' ? yaml.name : basename(dir), targets };
}

/**
 * A Podfile's pods by target: `target 'App' do … pod 'Alamofire' … end`. Pods of an enclosing (abstract) target and
 * of the file's top level belong to every target inside; a subspec is its pod (Firebase/Analytics → Firebase).
 *   { file, dir, project: the .xcodeproj it names or null, targets: Map(name → [pods]) }
 */
export function readPodfile(file) {
  const dir = dirname(file);
  const targets = new Map();
  const stack = []; // { target: name or null, pods: [] }
  const top = [];
  let project = null;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const projectMatch = /^(?:xcodeproj|project)\s+['"]([^'"]+)['"]/.exec(line);
    if (projectMatch) project = resolve(dir, projectMatch[1].endsWith('.xcodeproj') ? projectMatch[1] : `${projectMatch[1]}.xcodeproj`);
    const target = /^(abstract_)?target\s+['":]?([^'"\s]+)['"]?\s+do\b/.exec(line);
    if (target) {
      stack.push({ target: target[1] ? null : target[2], abstract: Boolean(target[1]), pods: [] });
      if (!target[1] && !targets.has(target[2])) targets.set(target[2], []);
      continue;
    }

    const pod = /^pod\s+['"]([^'"/]+)/.exec(line);
    if (pod) {
      const frame = stack[stack.length - 1];
      if (!frame) top.push(pod[1]);
      else frame.pods.push(pod[1]);
      if (frame?.target) targets.get(frame.target).push(pod[1]);
      continue;
    }

    if (/^end\b/.test(line)) {
      const frame = stack.pop();
      // Pods of an enclosing abstract target belong to the targets inside it, those already closed included.
      if (frame?.abstract) for (const inner of frame.inner ?? []) targets.get(inner).push(...frame.pods);
      if (frame?.target) for (const outer of stack) (outer.inner ??= []).push(frame.target);
      continue;
    }

    if (/\bdo\b(\s*\|[^|]*\|)?\s*$/.test(line) || /^(if|unless|case|def|begin|while|until|for)\b/.test(line)) stack.push({ target: null, pods: [] });
  }

  for (const pods of targets.values()) pods.push(...top);
  for (const [name, pods] of targets) targets.set(name, [...new Set(pods)]);
  return { file, dir, project, targets };
}

/**
 * A podspec (Ruby): its name, its source files (subspecs included; test specs apart), its dependencies.
 *   { file, dir, name, sources, testSources, dependencies, line }
 */
export function readPodspec(file) {
  const text = readFileSync(file, 'utf8');
  const dir = dirname(file);
  if (file.endsWith('.json')) {
    try {
      const spec = JSON.parse(text);
      const sources = [spec.source_files ?? [], ...(spec.subspecs ?? []).map((s) => s.source_files ?? [])].flat();
      return { file, dir, name: spec.name ?? basename(file, '.podspec.json'), sources, testSources: [], dependencies: Object.keys(spec.dependencies ?? {}).map((d) => d.split('/')[0]), line: 1 };
    } catch {
      return null;
    }
  }

  const name = /\.name\s*=\s*['"]([^'"]+)['"]/.exec(text)?.[1] ?? basename(file, '.podspec');
  const sources = [];
  const testSources = [];
  const dependencies = [];
  let testDepth = 0;
  let depth = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (/\.(test_spec|app_spec)\b.*\bdo\b/.test(line)) {
      depth++;
      testDepth = testDepth || depth;
      continue;
    }

    if (/\bdo\b(\s*\|[^|]*\|)?\s*$/.test(line) || /^(if|unless|case|def|begin)\b/.test(line)) depth++;
    else if (/^end\b/.test(line)) {
      if (testDepth === depth) testDepth = 0;
      depth--;
    }

    const files = /\.source_files\s*=\s*(.+)$/.exec(line);
    if (files) (testDepth ? testSources : sources).push(...rubyStrings(files[1]));
    const dependency = /\.dependency\s+['"]([^'"/]+)/.exec(line);
    if (dependency && !testDepth) dependencies.push(dependency[1]);
  }

  const at = text.split('\n').findIndex((l) => /\.source_files\s*=/.test(l));
  return { file, dir, name, sources, testSources, dependencies: [...new Set(dependencies)], line: at + 1 || 1 };
}

/** 'a', ['a', "b"], %w[a b] */
function rubyStrings(text) {
  const words = /%w[[(]([^\])]*)[\])]/.exec(text);
  if (words) return words[1].split(/\s+/).filter(Boolean);
  return [...text.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}
