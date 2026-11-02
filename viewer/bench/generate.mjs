#!/usr/bin/env node
// Synthetic CodeMap graphs for benchmarks and smoke tests: projects → namespaces → types → members,
// with the shape of real solutions (a few hub types used everywhere, most links local, layered projects,
// some cycles, test projects). Same seed, same graph.
//
//   node bench/generate.mjs --types 20000 [--projects 24] [--members 6] [--degree 5] [--seed 1] [-o file]
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';

const KINDS = [['class', 0.68], ['interface', 0.14], ['record', 0.07], ['enum', 0.05], ['struct', 0.04], ['delegate', 0.02]];
const MEMBER_KINDS = [['method', 0.5], ['property', 0.28], ['field', 0.12], ['constructor', 0.08], ['event', 0.02]];
const TYPE_EDGES = [['holds', 0.34], ['injects', 0.2], ['instantiates', 0.16], ['implements', 0.12], ['inherits', 0.08], ['throws', 0.03], ['uses', 0.07]];
const ROLES = ['service', 'repository', 'controller', 'handler', 'dto', 'validator', 'factory', 'options'];

export function generate({ types = 2000, projects, members = 4, degree = 4, seed = 1, tests = 0.15 } = {}) {
  const random = mulberry32(seed);
  const pick = (weighted) => {
    let r = random();
    for (const [value, w] of weighted) if ((r -= w) <= 0) return value;
    return weighted[0][0];
  };
  const int = (min, max) => min + Math.floor(random() * (max - min + 1));
  const logNormal = (mu, sigma) => Math.exp(mu + sigma * gaussian(random));

  projects ??= Math.max(2, Math.min(80, Math.round(Math.sqrt(types) / 6)));
  const nodes = [];
  const edges = [];
  const projectList = [];
  for (let p = 0; p < projects; p++) {
    const test = p >= projects * (1 - tests) && projects > 3;
    const name = `Bench.${test ? 'Tests' : 'Module'}${String(p).padStart(2, '0')}`;
    const node = { id: `project:${name}`, kind: 'project', name, fullName: `src/${name}/${name}.csproj`, project: `project:${name}`, metrics: {} };
    if (test) node.tags = ['test-project'];
    nodes.push(node);
    projectList.push({ node, name, test, namespaces: [], types: [] });
  }

  // Types per project follow a skewed distribution: a few big projects, many small ones.
  const weights = projectList.map((_, i) => 1 / Math.pow(i + 1, 0.6));
  const total = weights.reduce((a, b) => a + b, 0);
  const allTypes = [];
  projectList.forEach((project, p) => {
    const count = Math.max(1, Math.round((types * weights[p]) / total));
    const nsCount = Math.max(1, Math.round(Math.sqrt(count) / 2));
    for (let n = 0; n < nsCount; n++) {
      const name = `${project.name}.Area${n}`;
      const ns = { id: `namespace:${project.name}/${name}`, kind: 'namespace', name, fullName: name, parent: project.node.id, project: project.node.id, namespace: name, metrics: {} };
      nodes.push(ns);
      project.namespaces.push({ node: ns, types: [] });
    }

    for (let t = 0; t < count; t++) {
      const ns = project.namespaces[Math.min(nsCount - 1, Math.floor(Math.pow(random(), 1.3) * nsCount))];
      const kind = pick(KINDS);
      const name = `${kind === 'interface' ? 'I' : ''}T${allTypes.length}`;
      const fullName = `${ns.node.name}.${name}`;
      const loc = Math.max(3, Math.round(logNormal(3.4, 0.9)));
      const node = {
        id: `T:${fullName}`, kind, name, fullName, parent: ns.node.id, project: project.node.id, namespace: ns.node.name,
        location: { file: `src/${project.name}/Area/${name}.cs`, line: 1, endLine: loc },
        metrics: { loc, complexity: Math.max(1, Math.round(loc / int(4, 12))), dit: int(0, 3) },
      };
      if (random() < 0.3) node.tags = [ROLES[int(0, ROLES.length - 1)]];
      if (project.test) node.tags = ['test'];
      const type = { node, project: p, ns, popularity: Math.pow(random(), 4), members: [] };
      nodes.push(node);
      ns.types.push(type);
      project.types.push(type);
      allTypes.push(type);
    }
  });

  // Members
  for (const type of allTypes) {
    if (type.node.kind === 'enum' || type.node.kind === 'delegate') continue;
    const count = Math.max(0, Math.round(members * (0.4 + random() * 1.2)));
    for (let m = 0; m < count; m++) {
      const kind = pick(MEMBER_KINDS);
      const name = kind === 'constructor' ? '.ctor' : `${kind[0].toUpperCase()}${m}`;
      const id = `${kind === 'method' || kind === 'constructor' ? 'M' : kind === 'property' ? 'P' : kind === 'field' ? 'F' : 'E'}:${type.node.fullName}.${name}${kind === 'method' || kind === 'constructor' ? '()' : ''}${m}`;
      const loc = kind === 'method' ? Math.max(1, Math.round(logNormal(2, 0.8))) : 1;
      const node = { id, kind, name, fullName: `${type.node.fullName}.${name}`, parent: type.node.id, project: type.node.project, metrics: { loc, complexity: kind === 'method' ? int(1, 8) : 1 } };
      nodes.push(node);
      type.members.push(node);
    }

    type.node.metrics.members = type.members.length;
    type.node.metrics.methods = type.members.filter((m) => m.kind === 'method').length;
  }

  // Popular targets: a Zipf-like choice inside a pool (hubs get most of the links).
  const zipf = (pool) => pool[Math.min(pool.length - 1, Math.floor(Math.pow(random(), 2.2) * pool.length))];
  for (const project of projectList) for (const ns of project.namespaces) ns.types.sort((a, b) => b.popularity - a.popularity);
  const byPopularity = (list) => [...list].sort((a, b) => b.popularity - a.popularity);
  const projectPools = projectList.map((p) => byPopularity(p.types));

  const targetFor = (source) => {
    const r = random();
    if (r < 0.62 && source.ns.types.length > 1) return zipf(source.ns.types);
    if (r < 0.88) return zipf(projectPools[source.project]);
    // Mostly downward between projects (lower index = lower layer), sometimes upward: cycles to find.
    const up = random() < 0.06;
    const other = up ? int(source.project, projectList.length - 1) : int(0, Math.max(0, source.project - 1));
    const pool = projectPools[projectList[other].test ? 0 : other];
    return pool.length ? zipf(pool) : null;
  };

  for (const source of allTypes) {
    const count = Math.max(0, Math.round(degree * (0.3 + random() * 1.4)));
    for (let k = 0; k < count; k++) {
      const target = targetFor(source);
      if (!target || target === source) continue;
      let kind = pick(TYPE_EDGES);
      if ((kind === 'implements') !== (target.node.kind === 'interface')) kind = target.node.kind === 'interface' ? 'implements' : 'holds';
      if (kind === 'inherits' && source.node.kind !== 'class') kind = 'holds';
      edges.push({ source: source.node.id, target: target.node.id, kind, weight: 1 });
      // Calls between their members ride along with most type links.
      if (source.members.length && target.members.length && random() < 0.7) {
        const caller = source.members[int(0, source.members.length - 1)];
        const callee = target.members[int(0, target.members.length - 1)];
        edges.push({ source: caller.id, target: callee.id, kind: 'calls', weight: int(1, 3), line: 1 });
      }
    }
  }

  // Projects reference the projects their types point at.
  const projectRefs = new Set();
  for (const e of edges) {
    const s = e.source.slice(e.source.indexOf(':') + 1).split('.').slice(0, 2).join('.');
    const t = e.target.slice(e.target.indexOf(':') + 1).split('.').slice(0, 2).join('.');
    if (s !== t) projectRefs.add(`project:${s}\u0000project:${t}`);
  }

  for (const key of projectRefs) {
    const [source, target] = key.split('\u0000');
    edges.push({ source, target, kind: 'projectReference', weight: 1 });
  }

  for (const project of projectList) project.node.metrics.types = project.types.length;
  const stats = { projects: projectList.length, namespaces: projectList.reduce((a, p) => a + p.namespaces.length, 0), types: allTypes.length, members: allTypes.reduce((a, t) => a + t.members.length, 0), edges: edges.length };
  return {
    format: 'codemap',
    version: '1.0',
    generator: { name: 'codemap-bench', version: '1' },
    generatedAt: new Date(0).toISOString(),
    source: { path: `bench-${types}.sln`, root: '/bench', kind: 'solution', name: `Bench ${types} types` },
    stats,
    nodes,
    edges,
  };
}

/** Writes the document piece by piece: a big graph never becomes one giant string. */
export async function writeDoc(doc, file) {
  const out = createWriteStream(file);
  const write = async (text) => {
    if (!out.write(text)) await once(out, 'drain');
  };
  const { nodes, edges, ...head } = doc;
  await write(JSON.stringify(head).slice(0, -1) + ',"nodes":[');
  for (let i = 0; i < nodes.length; i++) await write((i ? ',' : '') + JSON.stringify(nodes[i]));
  await write('],"edges":[');
  for (let i = 0; i < edges.length; i++) await write((i ? ',' : '') + JSON.stringify(edges[i]));
  await write(']}');
  out.end();
  await once(out, 'finish');
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random) {
  const u = Math.max(1e-9, random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

export function parseSize(text) {
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/i.exec(String(text).trim());
  if (!m) throw new Error(`Not a size: ${text}`);
  return Math.round(Number(m[1]) * (m[2]?.toLowerCase() === 'k' ? 1000 : m[2]?.toLowerCase() === 'm' ? 1e6 : 1));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const i = args.findIndex((a) => a === `--${name}` || (name === 'out' && a === '-o'));
    return i >= 0 ? args[i + 1] : fallback;
  };
  const types = parseSize(option('types', '2000'));
  const doc = generate({
    types,
    projects: option('projects') ? Number(option('projects')) : undefined,
    members: Number(option('members', '4')),
    degree: Number(option('degree', '4')),
    seed: Number(option('seed', '1')),
  });
  const file = option('out', `bench-${types}.codemap.json`);
  await writeDoc(doc, file);
  console.log(`${file}: ${JSON.stringify(doc.stats)}`);
}
