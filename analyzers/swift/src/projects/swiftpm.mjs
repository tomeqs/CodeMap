import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { evaluate, topLevel } from './evaluate.mjs';

const KINDS = { target: 'library', executableTarget: 'executable', testTarget: 'test', macro: 'macro', plugin: 'plugin' };
/** Where SwiftPM looks for a target's sources when the manifest gives no path. */
const SOURCE_DIRS = ['Sources', 'Source', 'src', 'srcs'];

/**
 * A Swift package from its Package.swift, read with the Swift grammar (not run):
 *   { file, dir, name, targets: [{ name, kind, dir, sources, exclude, dependencies, line }], products, packages }
 * A target's dependencies are { target }, { product, package } or { byName }; `packages` are the package
 * dependencies: { name, url } or { name, path } for a local one. What the manifest computes is left out.
 */
export function readPackage(file, parse) {
  const text = readFileSync(file, 'utf8');
  const tree = parse(text);
  try {
    const { env, changes } = topLevel(tree.rootNode);
    const variable = [...env.entries()].find(([, value]) => value?.call === 'Package');
    const manifest = variable?.[1] ?? findPackageCall(tree.rootNode, env);
    if (!manifest) return null;
    const own = variable?.[0] ?? 'package';
    const targets = list(manifest.args.targets);
    const products = list(manifest.args.products);
    const dependencies = list(manifest.args.dependencies);
    for (const change of changes) {
      if (change.operator !== '+=' && change.operator !== '=') continue;
      const into = change.target === `${own}.targets` ? targets : change.target === `${own}.products` ? products : change.target === `${own}.dependencies` ? dependencies : null;
      if (!into) continue;
      if (change.operator === '=') into.length = 0;
      into.push(...list(change.value));
    }

    const dir = dirname(file);
    return {
      file,
      dir,
      name: typeof manifest.args.name === 'string' ? manifest.args.name : basename(dir),
      line: manifest.line,
      targets: targets.map((t) => readTarget(t, dir)).filter(Boolean),
      products: products.filter((p) => p?.call && typeof p.args.name === 'string').map((p) => ({ name: p.args.name, targets: strings(p.args.targets) })),
      packages: dependencies.map((d) => readDependency(d, dir)).filter(Boolean),
    };
  } finally {
    tree.delete();
  }
}

function list(value) {
  return Array.isArray(value) ? value.filter((v) => v !== null && v !== undefined) : [];
}

function strings(value) {
  return list(value).filter((v) => typeof v === 'string');
}

/** `Package(…)` written without a `let` (passed straight to a function of the manifest). */
function findPackageCall(root, env) {
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (node.type === 'call_expression' && node.namedChildren[0]?.type === 'simple_identifier' && node.namedChildren[0].text === 'Package') {
      found = evaluate(node, env);
      return;
    }

    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return found;
}

function readTarget(call, dir) {
  const kind = KINDS[call?.call];
  if (!kind || typeof call.args.name !== 'string') return null;
  const name = call.args.name;
  const path = typeof call.args.path === 'string' ? call.args.path : null;
  const targetDir = path !== null ? resolve(dir, path) : defaultDir(dir, name, kind);
  return {
    name,
    kind,
    dir: targetDir,
    sources: call.args.sources === undefined || call.args.sources === null ? null : strings(call.args.sources).map((s) => resolve(targetDir, s)),
    exclude: strings(call.args.exclude).map((s) => resolve(targetDir, s)),
    dependencies: list(call.args.dependencies).map(readTargetDependency).filter(Boolean),
    line: call.line,
  };
}

function defaultDir(dir, name, kind) {
  const roots = kind === 'test' ? ['Tests'] : kind === 'plugin' ? ['Plugins'] : SOURCE_DIRS;
  for (const root of roots) {
    const candidate = join(dir, root, name);
    if (isDirectory(candidate)) return candidate;
  }

  return join(dir, roots[0], name);
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readTargetDependency(value) {
  if (typeof value === 'string') return { byName: value };
  if (!value?.call) return null;
  const name = typeof value.args.name === 'string' ? value.args.name : null;
  if (!name) return null;
  if (value.call === 'target') return { target: name };
  if (value.call === 'product') return { product: name, package: typeof value.args.package === 'string' ? value.args.package : null };
  if (value.call === 'byName') return { byName: name };
  return null;
}

/** `.package(url:…)`, `.package(name:url:…)`, `.package(path:)`, `.package(id: "scope.name")`. */
function readDependency(value, dir) {
  if (value?.call !== 'package') return null;
  const { url, path, id, name } = value.args;
  if (typeof path === 'string') {
    const full = resolve(dir, path);
    return { name: typeof name === 'string' ? name : basename(full), path: full };
  }

  if (typeof url === 'string') return { name: typeof name === 'string' ? name : packageNameOfUrl(url), url };
  if (typeof id === 'string') return { name: id.split('.').pop(), url: id };
  return null;
}

/** The package a repository URL names: its last path part without .git (https://github.com/apple/swift-nio.git → swift-nio). */
export function packageNameOfUrl(url) {
  return url.replace(/\/+$/, '').replace(/\.git$/i, '').split(/[/:]/).pop();
}

export const isPackageManifest = (path) => /^Package(@swift-[\d.]+)?\.swift$/.test(basename(path));

