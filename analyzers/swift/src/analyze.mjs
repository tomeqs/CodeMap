import { statSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { runChecks } from './checks.mjs';
import { discover, isGenerated, isTestFile, lineCount, readText, toPosix } from './discover.mjs';
import { extractFile } from './extract/declarations.mjs';
import { Graph } from './graph.mjs';
import { buildModel, placeOf } from './model.mjs';
import { buildProjects } from './projects/projects.mjs';
import { applyFrameworks } from './frameworks.mjs';
import { resolveReferences } from './resolve.mjs';

/** Files longer than this (in characters) are left out: generated tables. 4 MB of Swift parses in about a second. */
const MAX_LENGTH = 8 * 1024 * 1024;
const LEVEL_RANK = { project: 0, namespace: 1, type: 2, member: 3 };
/** Bookkeeping fields of nodes, not written. */
const PRIVATE_FIELDS = new Set(['bases', 'declaredType', 'returnType', 'paramTypes']);

/**
 * The raw graph of the Swift code under `request.target`: targets (SwiftPM, Xcode, Tuist, XcodeGen, podspecs, else
 * folders), their folders, types with their extensions, a holder per file for free code, and members; see
 * docs/plugins.md for the protocol and model.mjs for the shape.
 */
export function analyze(parser, request, log = () => {}) {
  const options = request.options ?? {};
  const includeTests = options.includeTests !== false;
  const includeGenerated = options.includeGenerated === true;
  const target = resolve(request.target);
  const root = resolve(request.root ?? (statSync(target).isFile() ? dirname(target) : target));
  const timing = new Timing(process.env.CODEMAP_SWIFT_STATS ? log : null);
  const found = discover(target);
  timing.mark('discover');
  const { projects, fileProject, warnings } = buildProjects(found, (text) => parser.parse(text));
  timing.mark('projects');
  const counts = { generated: 0, tests: 0, large: 0, failed: [], unreadable: [], unchecked: [] };

  const files = [];
  const diagnostics = [];
  let errorBytes = 0;
  let totalBytes = 0;
  let started = Date.now();
  for (const path of found.files) {
    const project = fileProject.get(path);
    if (!project) continue;
    const text = readText(path);
    if (text === null) continue;
    if (text.length > MAX_LENGTH) {
      counts.large++;
      continue;
    }

    const rel = toPosix(relative(root, path));
    const test = project.test || isTestFile(toPosix(relative(project.dir, path))) || isTestFile(rel);
    if (!includeGenerated && isGenerated(path, text)) {
      counts.generated++;
      continue;
    }

    if (!includeTests && test) {
      counts.tests++;
      continue;
    }

    const file = { path, rel, project, test, lines: lineCount(text) };
    Object.assign(file, placeOf(file));
    try {
      const tree = parser.parse(text);
      try {
        const errors = errorShare(tree);
        errorBytes += errors;
        totalBytes += text.length;
        if (text.length > 2000 && errors > text.length / 2) counts.unreadable.push(rel);
        file.facts = extractFile(tree);
        // Problems inside the code (--checks), not in tests; a check that fails leaves the file's map as it is.
        if (options.checks && !test) {
          try {
            diagnostics.push(...runChecks(tree, file));
          } catch (error) {
            counts.unchecked.push(`${rel} (${String(error?.message ?? error).split('\n')[0]})`);
          }
        }
      } finally {
        tree.delete();
      }
    } catch (error) {
      counts.failed.push(`${rel} (${String(error?.message ?? error).split('\n')[0]})`);
      file.facts = { imports: [], types: [], functions: [], variables: [], aliases: [], topLevel: null };
    }

    files.push(file);
    if (Date.now() - started > 5000) {
      log(`[${files.length}/${found.files.length}] ${rel}`);
      started = Date.now();
    }
  }

  timing.mark('parse');
  const kept = projects.filter((p) => files.some((f) => f.project === p));
  for (const project of kept) project.references = project.references.filter((r) => kept.includes(r));
  log(`${files.length} file(s) in ${kept.length} target(s)`);
  const graph = new Graph();
  const model = buildModel({ files, projects: kept, root, graph });
  timing.mark('model');
  const resolver = resolveReferences(model, graph, { log, stats: Boolean(process.env.CODEMAP_SWIFT_STATS), unresolvedFile: process.env.CODEMAP_SWIFT_UNRESOLVED || null });
  timing.mark('references');
  applyFrameworks(model, resolver, graph);
  timing.mark('frameworks');

  if (counts.generated) warnings.push(`${counts.generated} generated file(s) were skipped.`);
  if (counts.tests) warnings.push(`${counts.tests} test file(s) were left out.`);
  if (counts.large) warnings.push(`${counts.large} file(s) longer than ${MAX_LENGTH / 1024 / 1024} M characters were skipped.`);
  if (counts.unchecked.length) warnings.push(`${counts.unchecked.length} file(s) could not be checked: ${counts.unchecked.slice(0, 5).join(', ')}${counts.unchecked.length > 5 ? ', …' : ''}`);
  if (counts.failed.length) warnings.push(`${counts.failed.length} file(s) could not be read: ${counts.failed.slice(0, 5).join(', ')}${counts.failed.length > 5 ? ', …' : ''}`);
  if (counts.unreadable.length) warnings.push(`${counts.unreadable.length} file(s) are mostly code the parser could not follow, so their declarations may be missing: ${counts.unreadable.slice(0, 5).join(', ')}${counts.unreadable.length > 5 ? ', …' : ''}`);
  if (process.env.CODEMAP_SWIFT_STATS) log(`parse errors: ${totalBytes ? ((100 * errorBytes) / totalBytes).toFixed(2) : '0.00'}% of the code`);

  const nodes = [...graph.nodes.values()].map(clean).sort((a, b) => rank(a) - rank(b) || cmp(a.id, b.id));
  const edges = graph.connectedEdges().sort((a, b) => cmp(a.source, b.source) || cmp(a.kind, b.kind) || cmp(a.target, b.target));
  const isFile = statSync(target).isFile();
  return {
    source: {
      path: target,
      root,
      kind: found.only && found.only.kind !== 'file' ? (found.only.kind === 'xcworkspace' ? 'solution' : 'project') : isFile ? 'file' : 'directory',
      name: nameOf(target, found.only),
    },
    nodes,
    edges,
    analysis: options.checks ? { warnings, diagnostics: sortDiagnostics(diagnostics) } : { warnings },
  };
}

/** The map's name: a project file's folder (Package.swift, Project.swift, project.yml, Podfile), else the target's name. */
function nameOf(target, only) {
  if (only && ['package', 'tuist', 'xcodegen', 'podfile'].includes(only.kind)) return basename(dirname(target));
  return basename(target).replace(/\.(xcodeproj|xcworkspace|podspec\.json|podspec|swift)$/i, '');
}

/** One report per rule and place, in file order. */
function sortDiagnostics(list) {
  const seen = new Set();
  return list
    .filter((d) => {
      const key = `${d.rule}|${d.location.file}|${d.location.line}|${d.column}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => cmp(a.location.file, b.location.file) || a.location.line - b.location.line || a.column - b.column || cmp(a.rule, b.rule));
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
