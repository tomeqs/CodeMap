import { basename, dirname, join, relative, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { Graph } from './graph.mjs';
import { discover, isGenerated, isTestFile, lineCount, toPosix } from './discover.mjs';
import { Resolver, compilerOptions, createHost } from './program.mjs';
import { folderId, moduleId, packageId, projectId } from './ids.mjs';
import { declareModule } from './extract/declarations.mjs';
import { collectReferences } from './extract/references.mjs';
import { collectImports } from './extract/imports.mjs';
import { applyFrameworks, finishDi, finishRoutes } from './frameworks/index.mjs';

const LEVEL_RANK = { project: 0, namespace: 1, type: 2, member: 3 };

/**
 * The raw graph of a folder, package or file (CodeMap's plugin protocol, version 1): packages, folders, files,
 * declarations and the edges between them. One compiler program per package; files are parsed once for all.
 */
export function analyze(ts, request, log = () => {}) {
  const target = resolve(request.target);
  const isFile = statSync(target).isFile();
  const root = resolve(request.root ?? (isFile ? dirname(target) : target));
  const options = request.options ?? {};
  const { projects, packages, skippedTests } = discover(target, root, { includeTests: options.includeTests !== false });

  const graph = new Graph();
  const files = new Map(); // file name as the compiler writes it → where it sits on the map
  const stats = { unresolved: 0, generated: 0 };
  const warnings = [];
  const projectsByName = new Map(projects.map((p) => [p.name, p]));
  const ensurePackage = (name, version) => {
    if (!graph.has(packageId(name))) graph.addNode({ id: packageId(name), kind: 'package', name, fullName: name, signature: version || undefined, external: true });
  };

  for (const project of projects) {
    const id = projectId(project.name);
    const analyzed = [];
    let lines = 0;
    for (const file of project.files) {
      const text = ts.sys.readFile(file) ?? '';
      if (!options.includeGenerated && isGenerated(file, text)) {
        stats.generated++;
        continue;
      }

      const path = toPosix(relative(project.dir, file));
      const folder = folderOf(path);
      const count = lineCount(text);
      lines += count;
      analyzed.push(file);
      files.set(toPosix(file), {
        projectId: id,
        moduleId: moduleId(project.name, path),
        path,
        rel: toPosix(relative(root, file)),
        name: basename(file),
        folder,
        folderId: folderId(project.name, folder),
        lines: count,
        isTest: isTestFile(path),
      });
      if (!graph.has(folderId(project.name, folder))) {
        graph.addNode({ id: folderId(project.name, folder), kind: 'namespace', name: folder, fullName: `${project.name}/${folder}`, parent: id, project: id, namespace: folder });
      }
    }

    project.analyzedFiles = analyzed;
    const json = project.json;
    const manifestFile = join(project.dir, 'package.json');
    // A folder inside a package: its package.json is above the root, where the map has no files.
    const manifestRel = toPosix(relative(root, manifestFile));
    const manifestInside = !manifestRel.startsWith('../') && manifestRel !== '..';
    const allTests = analyzed.length > 0 && analyzed.every((f) => files.get(toPosix(f)).isTest);
    const tags = [...(allTests ? ['test-project'] : []), ...(json.bin ? ['entrypoint'] : [])];
    graph.addNode({
      id,
      kind: 'project',
      name: project.name,
      fullName: project.hasPackageJson ? (manifestInside ? manifestRel : project.name) : toPosix(relative(root, project.dir)) || '.',
      project: id,
      signature: [json.version, json.type === 'module' ? 'ESM' : json.type === 'commonjs' ? 'CommonJS' : null, project.hasPackageJson ? null : 'no package.json'].filter(Boolean).join(' · ') || undefined,
      location: project.hasPackageJson && manifestInside && existsSync(manifestFile) ? { file: manifestRel, line: 1, endLine: 1 } : undefined,
      tags: tags.length ? tags : undefined,
      metrics: { files: analyzed.length, lines },
    });

    for (const [name, version] of Object.entries({ ...json.peerDependencies, ...json.optionalDependencies, ...json.devDependencies, ...json.dependencies })) {
      const sibling = projectsByName.get(name);
      if (sibling) {
        graph.addEdge(id, projectId(sibling.name), 'projectReference');
      } else {
        ensurePackage(name, version);
        graph.addEdge(id, packageId(name), 'packageReference');
      }
    }
  }

  const sourceCache = new Map();
  const resolver = new Resolver(ts, packages, (file) => files.has(toPosix(file)));
  const shared = { di: { registrations: [], dependencies: [] }, claimed: new Map(), nestScopes: new Map(), express: { routers: new Map(), mounts: new Map(), routes: [] } };
  projects.forEach((project, i) => {
    if (!project.analyzedFiles.length) return;
    log(`[${i + 1}/${projects.length}] ${project.name}: ${project.analyzedFiles.length} file(s)`);
    const compilerOpts = compilerOptions(ts, project.dir, root);
    const host = createHost(ts, compilerOpts, sourceCache, resolver);
    const program = ts.createProgram({ rootNames: project.analyzedFiles, options: compilerOpts, host });
    const ctx = { ts, program, checker: program.getTypeChecker(), graph, files, options: compilerOpts, resolver, stats, projectsByName, ensurePackage, ...shared };
    const declared = [];
    for (const file of project.analyzedFiles) {
      const sf = program.getSourceFile(file);
      const info = files.get(toPosix(file));
      if (sf && info) declared.push([sf, info, declareModule(ctx, sf, info)]);
    }

    for (const [sf, info, owners] of declared) owners.push(...applyFrameworks(ctx, sf, info, owners));
    for (const [sf, info, owners] of declared) {
      collectReferences(ctx, sf, owners);
      collectImports(ctx, sf, info);
    }
  });

  markEntryPoints(graph, projects, resolver, files);
  finishRoutes({ ...shared, graph });
  const di = finishDi(shared);

  if (stats.unresolved) warnings.push(`${stats.unresolved} relative import(s) could not be resolved (paths only a bundler knows, or missing files).`);
  if (stats.generated) warnings.push(`${stats.generated} generated file(s) were skipped.`);
  if (skippedTests) warnings.push(`${skippedTests} test file(s) were left out.`);

  const nodes = [...graph.nodes.values()].map(clean);
  nodes.sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const edges = graph.connectedEdges();
  edges.sort((a, b) => cmp(a.source, b.source) || cmp(a.kind, b.kind) || cmp(a.target, b.target));

  const manifest = isFile && basename(target) === 'package.json';
  return {
    source: {
      path: target,
      root,
      kind: isFile ? (manifest ? 'project' : 'file') : 'directory',
      name: manifest ? projects[0]?.name ?? basename(dirname(target)) : basename(isFile ? target : target),
    },
    nodes,
    edges,
    analysis: di ? { warnings, di } : { warnings },
  };
}

/**
 * Entry points: what package.json starts (main, bin), and files that run code at the top and that nothing
 * imports (scripts, server.ts, main.ts). They are where flows start, and never unused.
 */
function markEntryPoints(graph, projects, resolver, files) {
  const tag = (node) => {
    if (!node) return;
    node.tags ??= [];
    if (!node.tags.includes('entrypoint')) node.tags.push('entrypoint');
  };
  const imported = new Set([...graph.edges.values()].filter((e) => e.kind === 'imports' || e.kind === 'uses').map((e) => e.target));
  for (const node of graph.nodes.values()) {
    if (node.kind !== 'module' || node.tags?.includes('test')) continue;
    const topLevel = graph.nodes.get(`${node.id}#(top-level)`);
    if (topLevel && !imported.has(node.id)) {
      tag(node);
      tag(topLevel);
    }
  }

  for (const project of projects) {
    const json = project.json;
    const starts = [json.main, ...(typeof json.bin === 'string' ? [json.bin] : Object.values(json.bin ?? {}))].filter((v) => typeof v === 'string');
    for (const start of starts) {
      const file = resolver.sourceFor(project.dir, start);
      const info = file && files.get(toPosix(file));
      if (info) tag(graph.nodes.get(info.moduleId));
    }
  }
}

/** Folder of a file within its package, without the conventional src/: src/orders/x.ts → orders. */
function folderOf(path) {
  const dir = dirname(path);
  if (dir === '.' || dir === 'src') return '(root)';
  return dir.startsWith('src/') ? dir.slice(4) : dir;
}

function rank(node) {
  if (node.kind === 'package') return 4;
  return LEVEL_RANK[node.level ?? (node.kind === 'project' ? 'project' : node.kind === 'namespace' ? 'namespace' : 'type')] ?? 5;
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The node as written: no bookkeeping fields, no empty ones. */
function clean(node) {
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'hasCode' || value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }

  return out;
}
