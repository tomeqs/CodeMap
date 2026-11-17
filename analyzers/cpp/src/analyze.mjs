import { statSync } from 'node:fs';
import { basename, dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { discover, grammarOf, includesOf, isGenerated, isHeaderFile, isTestFile, lineCount, readText, toPosix } from './discover.mjs';
import { extractFile } from './extract/declarations.mjs';
import { Graph } from './graph.mjs';
import { buildModel } from './model.mjs';
import { collectMacros, preprocess } from './preprocess.mjs';
import { buildProjects, isUnder } from './projects/projects.mjs';
import { resolveReferences } from './resolve.mjs';

/** Files above this size are left out (generated tables, amalgamations of amalgamations); SQLite's 8 MB parses in about a second. */
const MAX_BYTES = 16 * 1024 * 1024;
const LEVEL_RANK = { project: 0, namespace: 1, type: 2, member: 3 };
/** Bookkeeping fields of nodes, not written. */
const PRIVATE_FIELDS = new Set(['bases', 'declaredType', 'returnType', 'paramTypes']);

/**
 * The raw graph of the C and C++ code under `request.target`: projects (CMake targets, Visual Studio projects,
 * Unreal modules, folders with a build file), namespaces, types, free functions in a holder per header/source
 * pair, and members; see docs/plugins.md for the protocol and model.mjs for the shape.
 */
export function analyze(parser, request, log = () => {}) {
  const options = request.options ?? {};
  const includeTests = options.includeTests !== false;
  const includeGenerated = options.includeGenerated === true;
  const root = resolve(request.root ?? (statSync(request.target).isFile() ? dirname(request.target) : request.target));
  const timing = new Timing(process.env.CODEMAP_CPP_STATS ? log : null);
  const found = discover(request.target);
  timing.mark('discover');
  const { projects, fileProject, explicit } = buildProjects(found, found.files);
  timing.mark('projects');
  const warnings = [];
  const counts = { generated: 0, tests: 0, large: 0, failed: [], unreadable: [] };

  // Pass 0: what each file includes and defines, which files are left out.
  const files = [];
  const texts = [];
  for (const path of found.files) {
    if (!fileProject.has(path)) continue;
    const text = readText(path);
    if (text === null) continue;
    if (text.length > MAX_BYTES) {
      counts.large++;
      continue;
    }

    const rel = toPosix(relative(root, path));
    const project = fileProject.get(path);
    const test = project.test || isTestFile(toPosix(relative(project.dir, path))) || isTestFile(rel);
    if (!includeGenerated && isGenerated(path, text)) {
      counts.generated++;
      continue;
    }

    if (!includeTests && test) {
      counts.tests++;
      continue;
    }

    const qtest = [...text.matchAll(/\bQTEST_(?:GUILESS_|APPLESS_)?MAIN\s*\(\s*(\w+)\s*\)/g)].map((m) => m[1]);
    files.push({ path, rel, project, test, header: isHeaderFile(path), lang: grammarOf(path), includes: includesOf(text), lines: lineCount(text), qtest });
    if (text.includes('define')) texts.push(text);
  }

  addContextHeaders(files, found, root, texts);
  const macros = collectMacros(texts);
  texts.length = 0;
  resolveIncludes(files, projects);
  headersToTheirIncluders(files, explicit);
  chooseHeaderGrammars(files);
  assignComponents(files);
  timing.mark('includes and macros');

  // Pass 1: parse each file, keep its declarations, free the tree.
  let started = Date.now();
  let errorBytes = 0;
  let totalBytes = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const text = readText(file.path) ?? '';
    try {
      const pre = preprocess(text, { cplusplus: file.lang === 'cpp', macros });
      const tree = parser.parse(pre.text, file.lang);
      try {
        const errors = errorShare(tree);
        errorBytes += errors;
        totalBytes += pre.text.length;
        if (pre.text.length > 2000 && errors > pre.text.length / 2) counts.unreadable.push(file.rel);
        file.facts = extractFile(tree, { annotations: pre.annotations, sections: pre.sections });
      } finally {
        tree.delete();
      }
    } catch (error) {
      counts.failed.push(`${file.rel} (${String(error?.message ?? error).split('\n')[0]})`);
      file.facts = emptyFacts();
    }

    if (Date.now() - started > 5000) {
      log(`[${i + 1}/${files.length}] ${file.rel}`);
      started = Date.now();
    }
  }

  timing.mark('parse');
  log(`${files.filter((f) => !f.context).length} file(s) in ${projects.length} project(s)`);
  const graph = new Graph();
  const stats = { errorBytes, totalBytes };
  const model = buildModel({ files, projects, root, graph, stats });
  timing.mark('model');
  resolveReferences(model, graph, { log, stats: Boolean(process.env.CODEMAP_CPP_STATS), unresolvedFile: process.env.CODEMAP_CPP_UNRESOLVED || null });
  timing.mark('references');

  if (counts.generated) warnings.push(`${counts.generated} generated file(s) were skipped.`);
  if (counts.tests) warnings.push(`${counts.tests} test file(s) were left out.`);
  if (counts.large) warnings.push(`${counts.large} file(s) larger than ${MAX_BYTES / 1024 / 1024} MB were skipped.`);
  if (counts.failed.length) warnings.push(`${counts.failed.length} file(s) could not be read: ${counts.failed.slice(0, 5).join(', ')}${counts.failed.length > 5 ? ', …' : ''}`);
  if (counts.unreadable.length) {
    warnings.push(`${counts.unreadable.length} file(s) are mostly code the parser could not follow (macros it cannot expand), so their declarations may be missing: ${counts.unreadable.slice(0, 5).join(', ')}${counts.unreadable.length > 5 ? ', …' : ''}`);
  }

  if (process.env.CODEMAP_CPP_STATS) {
    log(`parse errors: ${totalBytes ? ((100 * errorBytes) / totalBytes).toFixed(2) : '0.00'}% of the code; ${model.unplaced} definition(s) of members of classes not on the map`);
  }

  const nodes = [...graph.nodes.values()].map(clean).sort((a, b) => rank(a) - rank(b) || cmp(a.id, b.id));
  const edges = graph.connectedEdges().sort((a, b) => cmp(a.source, b.source) || cmp(a.kind, b.kind) || cmp(a.target, b.target));
  const target = resolve(request.target);
  return {
    source: {
      path: target,
      root,
      kind: statSync(target).isFile() ? (/\.(sln|slnx)$/i.test(target) ? 'solution' : /\.vcxproj$|CMakeLists\.txt$/i.test(target) ? 'project' : 'file') : 'directory',
      name: basename(target).replace(/\.(sln|slnx|vcxproj)$/i, ''),
    },
    nodes,
    edges,
    analysis: { warnings },
  };
}

/**
 * Headers outside the folder analyzed that its files include from their projects' include directories (a
 * src/ folder analyzed alone, its headers in ../include): read as context, so a definition finds its class and
 * a source its header, and the ids are those of the whole project. They add nothing of their own to the map.
 */
function addContextHeaders(files, found, root, texts) {
  const known = new Set(files.map((f) => normalize(f.path)));
  const limit = found.repository ?? dirname(found.scanDir);
  const queue = [...files];
  let added = 0;
  while (queue.length && added < 5000) {
    const file = queue.shift();
    const dirs = [...file.project.includeDirs, ...file.project.references.flatMap((p) => p.includeDirs)];
    for (const include of file.includes) {
      const wanted = include.path.replace(/\\/g, '/');
      if (!isHeaderFile(wanted)) continue;
      const candidates = [...(include.quoted ? [dirname(file.path)] : []), ...dirs].map((d) => normalize(join(d, wanted)));
      for (const path of candidates) {
        if (known.has(path)) break;
        if (isUnder(path, found.scanDir) || !isUnder(path, limit) || !isFile(path)) continue;
        const text = readText(path);
        if (text === null) continue;
        const context = { path, rel: toPosix(relative(root, path)), project: file.project, test: false, header: true, lang: grammarOf(path), includes: includesOf(text), lines: lineCount(text), context: true };
        files.push(context);
        known.add(path);
        queue.push(context);
        if (text.includes('define')) texts.push(text);
        added++;
        break;
      }
    }
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Each include to the file it names: next to the file (quoted), then the include directories, then by path suffix. */
function resolveIncludes(files, projects) {
  const byPath = new Map(files.map((f) => [normalize(f.path), f]));
  const bySuffix = new Map();
  for (const f of files) {
    const name = basename(f.path).toLowerCase();
    if (!bySuffix.has(name)) bySuffix.set(name, []);
    bySuffix.get(name).push(f);
  }

  for (const file of files) {
    const dirs = [...file.project.includeDirs, ...file.project.references.flatMap((p) => p.includeDirs)];
    file.included = [];
    for (const include of file.includes) {
      const wanted = include.path.replace(/\\/g, '/');
      let target = null;
      if (include.quoted) target = byPath.get(normalize(join(dirname(file.path), wanted))) ?? null;
      for (let i = 0; !target && i < dirs.length; i++) target = byPath.get(normalize(join(dirs[i], wanted))) ?? null;
      if (!target) {
        const candidates = (bySuffix.get(basename(wanted).toLowerCase()) ?? []).filter((f) => toPosix(f.path).endsWith('/' + wanted));
        if (candidates.length === 1) target = candidates[0];
        else if (candidates.length > 1) target = candidates.find((c) => c.project === file.project) ?? null;
      }

      if (target && target !== file) file.included.push(target);
    }
  }
}

/**
 * A header no build file lists, included only by the sources of one other project (a test target's fixture header
 * next to the library's folder), belongs to that project.
 */
function headersToTheirIncluders(files, explicit) {
  const includers = new Map();
  for (const file of files) {
    if (file.header) continue;
    for (const target of file.included) {
      if (!includers.has(target)) includers.set(target, new Set());
      includers.get(target).add(file.project);
    }
  }

  for (const file of files) {
    if (!file.header || file.context || explicit.has(file.path) || file.project.kind === 'unreal') continue;
    const projects = includers.get(file);
    if (projects?.size === 1) {
      const [project] = projects;
      if (project !== file.project) {
        file.project = project;
        file.test ||= project.test;
      }
    }
  }
}

/**
 * A .h is read as C++ when C++ code includes it or it reads as C++ (class, namespace, template); as C when only C
 * includes it; otherwise as its project's majority.
 */
function chooseHeaderGrammars(files) {
  const includers = new Map();
  for (const file of files) for (const target of file.included) {
    if (!includers.has(target)) includers.set(target, []);
    includers.get(target).push(file);
  }

  const majority = new Map();
  for (const file of files) {
    if (file.header) continue;
    const m = majority.get(file.project) ?? { c: 0, cpp: 0 };
    m[file.lang]++;
    majority.set(file.project, m);
  }

  const pending = files.filter((f) => f.lang === null);
  for (let round = 0; round < 3; round++) {
    for (const file of pending) {
      if (file.lang) continue;
      const by = (includers.get(file) ?? []).map((f) => f.lang).filter(Boolean);
      if (by.includes('cpp')) file.lang = 'cpp';
      else if (round === 2 || by.length) file.lang = by.includes('c') ? 'c' : null;
    }
  }

  for (const file of pending) {
    if (file.lang) continue;
    const text = readText(file.path) ?? '';
    if (/\b(namespace|template\s*<|class\s+\w+\s*[:{]|public:|private:|virtual\b)/.test(text)) file.lang = 'cpp';
    else {
      const m = majority.get(file.project) ?? { c: 0, cpp: 0 };
      file.lang = m.c > m.cpp ? 'c' : 'cpp';
    }
  }

  // A header that reads as C++ is C++ whoever includes it (C++ headers included by a C++ file of a C project).
  for (const file of files) {
    if (file.header && file.lang === 'c') {
      const text = readText(file.path) ?? '';
      if (/\b(namespace\s+\w+\s*\{|template\s*<|class\s+\w+\s*[:{])/.test(text)) file.lang = 'cpp';
    }
  }
}

/** A header and the source that includes it with the same name (orders.h + orders.cpp) are one component. */
function assignComponents(files) {
  const stem = (f) => basename(f.path, extname(f.path)).toLowerCase();
  const componentOf = (f) => f.rel.replace(/\.[^./]+$/, '');
  for (const file of files) file.component = componentOf(file);
  for (const file of files) {
    if (file.header) continue;
    const pair = file.included.find((h) => h.header && stem(h) === stem(file) && h.project === file.project);
    if (pair) file.component = pair.component;
  }
}

function errorShare(tree) {
  const rootNode = tree.rootNode;
  if (!rootNode.hasError) return 0;
  let bytes = 0;
  const cursor = rootNode.walk();
  try {
    let more = true;
    while (more) {
      if (cursor.nodeType === 'ERROR') bytes += cursor.endIndex - cursor.startIndex;
      else if (cursor.currentNode.hasError && cursor.gotoFirstChild()) continue;
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) {
          more = false;
          break;
        }
      }
    }
  } finally {
    cursor.delete();
  }

  return bytes;
}

class Timing {
  constructor(log) {
    this.log = log;
    this.last = Date.now();
  }

  mark(phase) {
    if (!this.log) return;
    const now = Date.now();
    this.log(`${phase}: ${((now - this.last) / 1000).toFixed(2)}s`);
    this.last = now;
  }
}

function emptyFacts() {
  return { namespaces: [], types: [], functions: [], variables: [], aliases: [], usingNamespaces: [], usingNames: [], namespaceAliases: [] };
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
    if (PRIVATE_FIELDS.has(key) || value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    out[key] = value;
  }

  return out;
}

export { isUnder };
