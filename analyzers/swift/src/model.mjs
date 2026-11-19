import { basename, dirname, relative } from 'node:path';
import { isUnder, toPosix } from './discover.mjs';
import { extensionId, holderId, memberId, namespaceId, packageId, projectId, typeId } from './ids.mjs';

const KIND = { class: 'class', actor: 'class', struct: 'struct', enum: 'enum', protocol: 'interface' };
/** Classes of Apple's frameworks a class's first base usually is (the superclass), not a protocol. */
const FRAMEWORK_CLASS = /^(NS|UI|SK|SCN|MK|AV|CA|WK|CL|PH|GK|AR|XC)[A-Z]\w*$/;
const PROTOCOL_LIKE = /(Delegate|DataSource|Protocol|Representable|Convertible|Providing|Coding|Type)$/;

/**
 * The map's nodes from the declarations of every file: targets → folders → types (and a `module` holder per file
 * for free functions, globals and top-level code) → members. An extension of a type the target declares adds its
 * members, conformances and file to that type, as a C# partial class does; an extension of a type from outside is
 * an `extension` node per target and folder.
 */
export function buildModel({ files, projects, root, graph }) {
  const model = new Model(projects, root, graph);
  model.files = files;
  for (const file of files) model.addTypes(file);
  for (const file of files) model.addExtensions(file);
  for (const file of files) model.addFreeDeclarations(file);
  model.emit();
  return model;
}

class Model {
  constructor(projects, root, graph) {
    this.projects = projects;
    this.root = root;
    this.graph = graph;
    this.types = new Map(projects.map((p) => [p.id, new Map()])); // project id → Map(qualified → TypeEntry)
    this.holders = new Map(); // file → holder
  }

  // ---------------------------------------------------------------------------------------------- types

  addTypes(file) {
    for (const decl of file.facts.types) if (decl.kind !== 'extension') this.addType(file, decl, null);
  }

  addType(file, decl, outer) {
    if (!decl.name) return null;
    const table = this.types.get(file.project.id);
    let qualified = outer ? `${outer.nestBase ?? outer.qualified}.${decl.name}` : decl.name;
    let entry = table.get(qualified);
    // Two private types of one name in two files are two types (each `Name@file` but the first); one in both
    // branches of an #if is one. A type of the target that is not private keeps the plain name.
    if (entry && !outer && entry.decls.every((d) => d.file !== file)) {
      if (decl.access === 'private') {
        qualified = `${decl.name}@${file.rel}`;
        entry = table.get(qualified);
      } else if (entry.decls.every((d) => d.decl.access === 'private')) {
        this.rekey(table, entry, `${decl.name}@${entry.decls[0].file.rel}`);
        entry = null;
      }
    }

    if (!entry) {
      entry = { qualified, name: decl.name, display: outer ? `${outer.display}.${decl.name}` : decl.name, project: file.project, outer, kind: decl.kind, decls: [], extensions: [], members: [], nested: [], cases: [], folder: outer ? outer.folder : file.folder };
      table.set(qualified, entry);
      if (outer) outer.nested.push(entry);
    }

    entry.decls.push({ file, decl });
    this.addMembers(entry, file, decl, null);
    for (const nested of decl.nested) this.addType(file, nested, entry);
    return entry;
  }

  /** Moves a type (and the types nested in it) to another key of the target's table. */
  rekey(table, entry, qualified) {
    table.delete(entry.qualified);
    entry.qualified = qualified;
    table.set(qualified, entry);
    for (const nested of entry.nested) this.rekey(table, nested, `${qualified}.${nested.name}`);
  }

  addMembers(entry, file, decl, extension) {
    for (const member of decl.members) this.addMember(entry, file, member, extension);
    for (const c of decl.cases) if (!entry.cases.some((x) => x.name === c.name)) entry.cases.push(c);
  }

  /** A member; the same declaration twice (both branches of an #if) is one member with two places. */
  addMember(entry, file, member, extension) {
    const key = memberKey(member);
    const existing = entry.members.find((m) => m.key === key && sameTypes(m.decl, member));
    const place = { file, member, extension };
    if (existing) {
      existing.places.push(place);
      return existing;
    }

    const created = { key, decl: member, entry, places: [place], extension };
    entry.members.push(created);
    return created;
  }

  /** Extensions: into the type when the target declares it, else into the target's extension node of the folder. */
  addExtensions(file) {
    for (const decl of file.facts.types) {
      if (decl.kind !== 'extension' || !decl.name) continue;
      const table = this.types.get(file.project.id);
      // The file's own private type first: another file's private type of the name is not the one it extends.
      let entry = table.get(`${decl.name}@${file.rel}`) ?? table.get(decl.name);
      if (!entry) {
        const key = `extension|${file.folder}|${decl.name}`;
        entry = table.get(key);
        if (!entry) {
          // Types nested in it are named after its node: swift:T:extension:Folder/String.Inner.
          const nestBase = `extension:${file.folder ? `${file.folder}/` : ''}${decl.name}`;
          entry = { qualified: key, nestBase, name: decl.name, display: decl.name, project: file.project, outer: null, kind: 'extension', decls: [], extensions: [], members: [], nested: [], cases: [], folder: file.folder, external: true };
          table.set(key, entry);
        }
      }

      entry.extensions.push({ file, decl });
      this.addMembers(entry, file, decl, decl);
      for (const nested of decl.nested) this.addType(file, nested, entry);
    }
  }

  // ---------------------------------------------------------------------------------------- free code

  addFreeDeclarations(file) {
    const { functions, variables, aliases, topLevel } = file.facts;
    if (!functions.length && !variables.length && !aliases.length && !topLevel) return;
    const holder = { id: holderId(file.project.id, file.component), file, members: [] };
    this.holders.set(file, holder);
    for (const member of [...functions, ...variables, ...aliases]) {
      const key = memberKey(member);
      const existing = holder.members.find((m) => m.key === key && sameTypes(m.decl, member));
      if (existing) existing.places.push({ file, member });
      else holder.members.push({ key, decl: member, places: [{ file, member }] });
    }

    if (topLevel) {
      const main = { kind: 'method', name: 'main', labels: null, params: [], returns: null, access: 'private', modifiers: [], attributes: [], signature: 'top-level code', line: topLevel.line, endLine: topLevel.endLine, complexity: topLevel.complexity, topLevel: true, refs: topLevel.refs, locals: topLevel.locals };
      holder.members.push({ key: 'top-level', decl: main, places: [{ file, member: main }] });
    }
  }

  // --------------------------------------------------------------------------------------------- nodes

  emit() {
    for (const project of this.projects) this.emitProject(project);
    const folders = new Set();
    const folderNode = (project, key) => {
      const id = namespaceId(project.id, key);
      if (!folders.has(id)) {
        folders.add(id);
        const name = key || basename(project.dir);
        this.graph.addNode({ id, kind: 'namespace', name, fullName: key ? `${project.id}/${key}` : project.id, parent: projectId(project.id), project: projectId(project.id) });
      }

      return id;
    };

    for (const table of this.types.values()) {
      for (const entry of table.values()) {
        if (entry.outer) continue;
        this.emitType(entry, folderNode(entry.project, entry.folder));
      }
    }

    for (const holder of this.holders.values()) this.emitHolder(holder, folderNode(holder.file.project, holder.file.folder));
    this.emitProjectEdges();
  }

  emitProject(project) {
    const own = this.files.filter((f) => f.project === project);
    const tags = [];
    if (project.test) tags.push('test-project');
    if (project.executable && !project.test) tags.push('entrypoint');
    const marker = project.marker && isUnder(project.marker.file, this.root) ? { file: this.rel(project.marker.file), line: project.marker.line, endLine: project.marker.line } : undefined;
    this.graph.addNode({
      id: projectId(project.id),
      kind: 'project',
      name: project.id,
      fullName: toPosix(relative(this.root, project.dir)) || '.',
      signature: project.signature,
      location: marker,
      tags,
      metrics: { files: own.length, lines: own.reduce((sum, f) => sum + (f.lines ?? 0), 0) },
    });
  }

  emitProjectEdges() {
    for (const project of this.projects) {
      for (const other of project.references) this.graph.addEdge(projectId(project.id), projectId(other.id), 'projectReference');
      for (const name of project.packages) {
        const id = packageId(name);
        this.graph.addNode({ id, kind: 'package', name, external: true });
        this.graph.addEdge(projectId(project.id), id, 'packageReference');
      }
    }
  }

  emitType(entry, parent) {
    const id = entry.external ? extensionId(entry.project.id, entry.folder, entry.name) : typeId(entry.project.id, entry.qualified);
    entry.id = id;
    const decls = [...entry.decls].sort((a, b) => a.file.rel.localeCompare(b.file.rel) || a.decl.line - b.decl.line);
    const main = decls[0] ?? entry.extensions[0];
    const decl = main.decl;
    const places = [...decls.slice(1), ...entry.extensions.filter((e) => e !== main)];
    const modifiers = new Set(entry.external ? ['extension'] : decl.modifiers);
    if (entry.kind === 'actor') modifiers.add('actor');
    const conformances = [...decls, ...entry.extensions].flatMap((d) => d.decl.bases);
    const loc = [...decls, ...entry.extensions].reduce((sum, d) => sum + (d.decl.endLine - d.decl.line + 1), 0);
    const metrics = { loc };
    if (entry.kind === 'enum') metrics.enumMembers = entry.cases.length;
    if (decl.generics) metrics.typeParameters = decl.generics.split(',').length;
    const node = this.graph.addNode({
      id,
      kind: entry.external ? 'extension' : KIND[entry.kind] ?? 'class',
      level: entry.external ? 'type' : undefined,
      name: entry.name,
      fullName: entry.external ? `extension ${entry.name}` : entry.display,
      parent: entry.outer?.id ?? parent,
      project: projectId(entry.project.id),
      namespace: entry.folder || undefined,
      accessibility: accessOf(decl.access, entry.outer ? null : null),
      modifiers: [...modifiers].sort(),
      signature: decl.signature,
      baseType: entry.kind === 'class' || entry.kind === 'actor' ? this.baseClassOf(entry, decl) : undefined,
      location: this.location(main.file, decl.line, decl.endLine),
      extraLocations: places.map((p) => this.location(p.file, p.decl.line, p.decl.endLine)).filter(Boolean),
      attributes: [...new Set([...decls, ...entry.extensions].flatMap((d) => d.decl.attributes))],
      doc: [...decls, ...entry.extensions].map((d) => d.decl.doc).find(Boolean),
      tags: tagsOf([...decls, ...entry.extensions].every((d) => d.file.test) ? ['test'] : []),
      metrics,
    });
    node.bases = conformances; // for the resolver, not written

    this.assignMemberIds(entry);
    for (const member of entry.members) this.emitMember(member, node, entry);
    for (const nested of entry.nested) this.emitType(nested, id);
  }

  /** A class's superclass: its first base when that is a class of the code, or of Apple's frameworks by its name. */
  baseClassOf(entry, decl) {
    const first = decl.bases[0];
    if (!first) return undefined;
    const known = this.findType(entry.project, first.name);
    if (known) return known.kind === 'class' ? first.text : undefined;
    return FRAMEWORK_CLASS.test(first.name) && !PROTOCOL_LIKE.test(first.name) ? first.text : undefined;
  }

  /** A type of the target or of the targets it uses, by its name (Order, Order.Line). */
  findType(project, name) {
    for (const p of [project, ...project.references]) {
      const hit = this.types.get(p.id)?.get(name);
      if (hit && !hit.external) return hit;
    }

    return null;
  }

  assignMemberIds(entry) {
    assignIds(entry.id, entry.members);
  }

  emitMember(member, owner, entry) {
    const decl = member.decl;
    const definition = member.places.find((p) => !p.member.requirement) ?? member.places[0];
    const others = member.places.filter((p) => p !== definition);
    const d = definition.member;
    const own = decl.access ?? member.places.map((p) => p.member.access).find(Boolean);
    const inherited = member.extension?.access ?? (entry.kind === 'protocol' ? entry.decls[0]?.decl.access : null);
    const node = this.graph.addNode({
      id: member.id,
      kind: decl.kind,
      level: 'member',
      name: decl.name,
      fullName: `${owner.fullName}.${decl.name}${decl.labels && decl.kind !== 'property' ? `(${decl.labels.map((l) => `${l}:`).join('')})` : decl.labels ? `[${decl.labels.map((l) => `${l}:`).join('')}]` : ''}`,
      parent: owner.id,
      project: projectId(entry.project.id),
      namespace: entry.folder || undefined,
      accessibility: accessOf(own ?? inherited),
      modifiers: [...new Set(member.places.flatMap((p) => p.member.modifiers))].sort(),
      signature: d.signature,
      location: this.location(definition.file, d.line, d.endLine),
      extraLocations: others.map((p) => this.location(p.file, p.member.line, p.member.endLine)).filter(Boolean),
      attributes: [...new Set(member.places.flatMap((p) => p.member.attributes))],
      doc: member.places.map((p) => p.member.doc).find(Boolean),
      tags: tagsOf(member.places.every((p) => p.file.test) ? ['test'] : []),
      metrics: memberMetrics(d),
    });
    this.keepTypes(node, decl);
    return node;
  }

  emitHolder(holder, parent) {
    const file = holder.file;
    const node = this.graph.addNode({
      id: holder.id,
      kind: 'module',
      level: 'type',
      name: basename(file.rel).replace(/\.swift$/, ''),
      fullName: file.component,
      parent,
      project: projectId(file.project.id),
      namespace: file.folder || undefined,
      accessibility: holder.members.every((m) => accessOf(m.decl.access) === 'private') ? 'private' : 'public',
      signature: basename(file.rel),
      location: this.location(file, 1, file.lines),
      tags: tagsOf(file.test ? ['test'] : []),
      metrics: { loc: 0 },
    });
    assignIds(holder.id, holder.members);
    for (const member of holder.members) {
      const decl = member.decl;
      const id = member.id;
      const others = member.places.slice(1);
      const child = this.graph.addNode({
        id,
        kind: decl.kind,
        level: 'member',
        name: decl.name,
        fullName: decl.topLevel ? `${file.component} (top-level code)` : `${decl.name}${decl.kind === 'function' ? `(${decl.labels.map((l) => `${l}:`).join('')})` : ''}`,
        parent: holder.id,
        project: projectId(file.project.id),
        namespace: file.folder || undefined,
        accessibility: accessOf(decl.access),
        modifiers: [...new Set(member.places.flatMap((p) => p.member.modifiers))].sort(),
        signature: decl.signature,
        location: this.location(file, decl.line, decl.endLine),
        extraLocations: others.map((p) => this.location(p.file, p.member.line, p.member.endLine)).filter(Boolean),
        attributes: [...new Set(member.places.flatMap((p) => p.member.attributes))],
        doc: decl.doc,
        tags: tagsOf(file.test ? ['test'] : [], decl.topLevel && basename(file.path) === 'main.swift' ? ['entrypoint'] : []),
        metrics: memberMetrics(decl),
      });
      if (decl.topLevel && basename(file.path) === 'main.swift') node.tags = tagsOf(node.tags ?? [], ['entrypoint']);
      node.metrics.loc += decl.endLine - decl.line + 1;
      this.keepTypes(child, decl);
    }
  }

  /** What the resolver needs, removed before writing. */
  keepTypes(node, decl) {
    node.declaredType = decl.type ?? undefined;
    node.returnType = decl.returns ?? undefined;
    node.paramTypes = decl.params?.map((p) => p.type);
  }

  location(file, line, endLine) {
    if (!file || !isUnder(file.path, this.root)) return undefined;
    return { file: file.rel, line, endLine: Math.max(line, endLine ?? line) };
  }

  rel(path) {
    return toPosix(relative(this.root, path));
  }
}

// --------------------------------------------------------------------------------------------- helpers

/** Where a file goes: its folder relative to its target (the namespace key) and its path without .swift. */
export function placeOf(file) {
  const project = file.project;
  let rel = toPosix(relative(project.dir, file.path));
  if (rel.startsWith('..')) rel = toPosix(relative(dirname(project.dir), file.path));
  const folder = dirname(rel) === '.' ? '' : dirname(rel);
  return { folder, component: rel.replace(/\.swift$/, '') };
}

/** What makes two declarations one member: a stored and a computed property of one name (#if branches) are one. */
function memberKey(member) {
  const labels = idLabels(member);
  const kind = member.kind === 'field' || member.kind === 'property' || member.kind === 'variable' ? 'var' : member.kind;
  const scope = member.modifiers?.includes('static') ? 'static|' : '';
  return `${scope}${kind}|${member.name}|${labels ? labels.join(':') : ''}`;
}

/** Ids from the argument labels; with the parameter types too when two members share them. */
function assignIds(ownerId, members) {
  const byLabels = new Map();
  for (const member of members) {
    const base = memberId(ownerId, member.decl.name, idLabels(member.decl));
    if (!byLabels.has(base)) byLabels.set(base, []);
    byLabels.get(base).push(member);
  }

  const seen = new Set();
  for (const [base, group] of byLabels) {
    // An instance member keeps the plain id; a static one of the same name and labels gets #static.
    group.sort((a, b) => Number(a.decl.modifiers.includes('static')) - Number(b.decl.modifiers.includes('static')));
    for (const member of group) {
      const decl = member.decl;
      let id = group.length > 1 && decl.params?.length ? memberId(ownerId, decl.name, idLabels(decl), decl.params.map((p) => compactType(p.type))) : base;
      if (seen.has(id) && decl.modifiers.includes('static')) id = `${id}#static`;
      for (let i = 2; seen.has(id); i++) id = `${base}~${i}`;
      seen.add(id);
      member.id = id;
    }
  }
}

/** The labels of an id: a function's, an initializer's and a subscript's; none for properties and fields. */
function idLabels(decl) {
  return decl.labels && (decl.kind !== 'property' || decl.name === 'subscript') ? decl.labels : null;
}

function sameTypes(a, b) {
  if (!a.params || !b.params) return true;
  return a.params.map((p) => compactType(p.type)).join(',') === b.params.map((p) => compactType(p.type)).join(',');
}

function compactType(type) {
  return (type ?? '').replace(/\s+/g, '');
}

function accessOf(access) {
  return access ?? 'internal';
}

function tagsOf(...lists) {
  const tags = [...new Set(lists.flat())].sort();
  return tags.length ? tags : undefined;
}

function memberMetrics(d) {
  const metrics = { loc: d.endLine - d.line + 1 };
  if (d.complexity !== null && d.complexity !== undefined) metrics.complexity = 1 + d.complexity;
  if (d.kind === 'method' || d.kind === 'constructor' || d.kind === 'function') metrics.parameters = d.params?.length ?? 0;
  return metrics;
}
