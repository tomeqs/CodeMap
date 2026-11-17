import { basename, dirname, extname, relative } from 'node:path';
import { toPosix } from './discover.mjs';
import { Frameworks } from './frameworks.mjs';
import { holderId, libraryId, memberId, namespaceId, projectId, typeId } from './ids.mjs';
import { normalizeType } from './extract/declarations.mjs';
import { isUnder } from './projects/projects.mjs';

/**
 * The map's nodes from the declarations of every file: projects → namespaces → types (and the `module` holders
 * of free functions, one per namespace and header/source pair) → members. A declaration and its definition
 * (in another file) are one node; a class keeps its out-of-line definitions' files as extra locations.
 */
export function buildModel({ files, projects, root, graph, stats }) {
  const model = new Model(projects, root, graph, stats);
  model.files = files;
  for (const project of projects) project.base = baseOf(project, files.filter((f) => f.project === project));
  for (const file of files) model.addTypes(file);
  for (const file of files) model.addFunctions(file);
  model.moveFileLocalHelpers(files);
  model.frameworks = new Frameworks(model, files);
  model.emit();
  return model;
}

class Model {
  constructor(projects, root, graph, stats) {
    this.projects = projects;
    this.root = root;
    this.graph = graph;
    this.stats = stats;
    this.types = new Map(); // project id → Map(qualified name → TypeEntry)
    this.namespaces = new Map(); // project id → Set(namespace key)
    this.functions = []; // FunctionEntry (free functions and variables)
    this.functionKeys = new Map(); // `${project}|${ns}|${name}` → [FunctionEntry]
    this.unplaced = 0;
    for (const project of projects) {
      this.types.set(project.id, new Map());
      this.namespaces.set(project.id, new Set());
      project.base = null;
    }
  }

  // ------------------------------------------------------------------------------------------- types

  addTypes(file) {
    for (const ns of file.facts.namespaces) this.namespaces.get(file.project.id).add(ns.path.join('::'));
    for (const type of file.facts.types) this.addType(file, type, null);
  }

  addType(file, decl, outer) {
    if (!decl.name) return; // an anonymous struct used only for a variable
    const project = file.project;
    const scopeKey = decl.scope.join('::');
    const local = decl.internal || (!file.header && !outer && !decl.qualifiers.length);
    const qualified = outer
      ? `${outer.qualified}::${decl.name}`
      : [scopeKey, ...decl.qualifiers, decl.name].filter(Boolean).join('::') + (decl.internal ? `@${file.rel}` : '');
    const table = this.types.get(project.id);
    let entry = table.get(qualified);
    if (!entry) {
      entry = {
        qualified,
        name: decl.name,
        project,
        outer,
        namespace: outer ? outer.namespace : scopeKey,
        folderNamespace: !outer && !scopeKey ? this.folderNamespace(project, file) : null,
        decls: [],
        members: [],
        definitionFiles: new Map(),
        local,
        nested: [],
      };
      table.set(qualified, entry);
      if (outer) outer.nested.push(entry);
    }

    entry.decls.push({ file, decl });
    entry.local &&= local;
    for (const member of decl.members) this.addMember(entry, file, member, member.hasBody, true);
    for (const nested of decl.nested) this.addType(file, nested, entry);
  }

  /** A member declared (or defined) in the class body. */
  addMember(entry, file, member, defined, strict = false) {
    const existing = member.kind === 'field' || member.kind === 'property'
      ? entry.members.find((m) => m.kind === member.kind && m.name === member.name)
      : this.matchMember(entry, member, file, strict);
    if (existing) {
      existing.places.push({ file, member, defined });
      return existing;
    }

    const created = { kind: member.kind, name: member.name, entry, places: [{ file, member, defined }], declaration: member };
    entry.members.push(created);
    return created;
  }

  /** The member a definition (or another declaration) of the same function is: by name and arity, then types. */
  matchMember(entry, member, file, strict) {
    const candidates = entry.members.filter((m) => m.kind !== 'field' && m.kind !== 'property' && m.name === member.name && !m.places.some((p) => p.file === file && p.member.line === member.line));
    if (!candidates.length) return null;
    // Declarations in a class body (or a second definition of the class): overloads unless the parameters are the same.
    if (strict) {
      const key = paramsKey(member.params, true);
      return candidates.find((m) => paramsKey(m.declaration.params, true) === key && isConst(m.declaration) === isConst(member)) ?? null;
    }

    const arity = member.params ? member.params.length : 0;
    const fits = candidates.filter((m) => fitsArity(m.declaration.params, arity, member.params));
    if (fits.length === 1) return fits[0];
    const pool = fits.length ? fits : candidates;
    const key = paramsKey(member.params, true);
    const same = pool.filter((m) => paramsKey(m.declaration.params, true) === key && isConst(m.declaration) === isConst(member));
    if (same.length >= 1) return same[0];
    const sameTypes = pool.filter((m) => paramsKey(m.declaration.params, true) === key);
    return sameTypes.length === 1 ? sameTypes[0] : null;
  }

  /** Classes of the project (and the projects it uses) by qualified name, looked up from a namespace outward. */
  findType(project, scope, qualifiers, usings = []) {
    const name = qualifiers.join('::');
    const tables = [this.types.get(project.id), ...project.references.map((p) => this.types.get(p.id)).filter(Boolean)];
    for (let i = scope.length; i >= 0; i--) {
      const key = [...scope.slice(0, i), name].filter(Boolean).join('::');
      for (const table of tables) if (table.has(key)) return table.get(key);
    }

    for (const using of usings) {
      const key = `${using}::${name}`;
      for (const table of tables) if (table.has(key)) return table.get(key);
    }

    // A class of another project the build files do not link (a test target's fixture header).
    if (!this.searchedAll) {
      const others = [...this.types.entries()].filter(([id]) => id !== project.id && !project.references.some((p) => p.id === id)).map(([, t]) => t);
      for (let i = scope.length; i >= 0; i--) {
        const key = [...scope.slice(0, i), name].filter(Boolean).join('::');
        for (const table of others) if (table.has(key)) return table.get(key);
      }
    }

    return null;
  }

  isNamespace(project, key) {
    if (this.namespaces.get(project.id).has(key)) return true;
    return project.references.some((p) => this.namespaces.get(p.id)?.has(key));
  }

  // ------------------------------------------------------------------------------- free functions

  addFunctions(file) {
    const usings = file.facts.usingNamespaces.map((u) => u.target);
    for (const fn of file.facts.functions) {
      if (fn.qualifiers.length) {
        const owner = this.findType(file.project, fn.scope, fn.qualifiers, usings);
        if (owner) {
          // Unreal: the body of a BlueprintNativeEvent or an RPC is Name_Implementation, declared as Name.
          const native = /_Implementation$/.exec(fn.name);
          const name = native && !owner.members.some((m) => m.name === fn.name) && owner.members.some((m) => m.name === fn.name.slice(0, native.index)) ? fn.name.slice(0, native.index) : fn.name;
          const member = { ...fn, name, kind: memberKind({ ...fn, name }, owner), access: null, hasBody: fn.definition && !fn.noBody };
          const placed = this.addMember(owner, file, member, member.hasBody);
          if (member.hasBody) owner.definitionFiles.set(file, [...(owner.definitionFiles.get(file) ?? []), fn]);
          placed.outOfLine = true;
          continue;
        }

        const namespace = this.namespaceOf(file.project, fn.scope, fn.qualifiers, usings);
        if (namespace === null) {
          this.unplaced++;
          continue;
        }

        this.addFunction(file, { ...fn, scope: namespace.split('::').filter(Boolean), qualifiers: [] });
        continue;
      }

      this.addFunction(file, fn);
    }

    for (const variable of file.facts.variables) {
      if (variable.extern) continue; // a declaration of a global defined elsewhere
      if (variable.qualifiers.length) {
        // A static member defined out of the class: `int Order::count = 0;`
        const owner = this.findType(file.project, variable.scope, variable.qualifiers, usings);
        if (owner) {
          const field = owner.members.find((m) => m.kind === 'field' && m.name === variable.name);
          if (field) field.places.push({ file, member: { ...variable, kind: 'field' }, defined: true });
          continue;
        }
      }

      this.addFunction(file, { ...variable, kind: 'variable' });
    }

    for (const alias of file.facts.aliases) {
      if (!alias.name) continue;
      this.addFunction(file, { ...alias, kind: 'typeAlias', qualifiers: [], internal: alias.internal });
    }
  }

  /** `void shop::helper()`: the namespace the qualifiers name, from the enclosing one outward. */
  namespaceOf(project, scope, qualifiers, usings) {
    const name = qualifiers.join('::');
    for (let i = scope.length; i >= 0; i--) {
      const key = [...scope.slice(0, i), name].filter(Boolean).join('::');
      if (this.isNamespace(project, key)) return key;
    }

    for (const using of usings) if (this.isNamespace(project, `${using}::${name}`)) return `${using}::${name}`;
    return null;
  }

  addFunction(file, fn) {
    const kind = fn.kind ?? 'function';
    const namespace = fn.scope.join('::');
    const lang = file.lang;
    const key = `${file.project.id}|${namespace}|${kind === 'function' ? '' : kind}|${fn.name}${fn.internal ? `|${file.rel}` : ''}`;
    const list = this.functionKeys.get(key) ?? [];
    let entry = null;
    if (kind === 'function') {
      const arity = fn.params.length;
      const candidates = list.filter((e) => !e.places.some((p) => p.file === file && p.member.line === fn.line));
      // C has no overloads: one function per name. C++ by arity, then by parameter types.
      if (lang === 'c' || candidates.every((c) => c.lang === 'c')) entry = candidates[0] ?? null;
      else {
        const fits = candidates.filter((e) => fitsArity(e.declaration.params, arity, fn.params));
        if (fits.length === 1) entry = fits[0];
        else {
          const key2 = paramsKey(fn.params, true);
          entry = (fits.length ? fits : candidates).find((e) => paramsKey(e.declaration.params, true) === key2) ?? null;
        }
      }
    } else if (kind === 'variable' || kind === 'typeAlias') {
      entry = list[0] ?? null;
    }

    const defined = kind !== 'function' || (fn.definition && !fn.noBody);
    if (entry) {
      entry.places.push({ file, member: fn, defined });
      if (!entry.declaration.params && fn.params) entry.declaration = fn;
      return entry;
    }

    entry = { kind, name: fn.name, project: file.project, namespace, places: [{ file, member: fn, defined }], declaration: fn, lang, internal: fn.internal };
    list.push(entry);
    this.functionKeys.set(key, list);
    this.functions.push(entry);
    return entry;
  }

  /**
   * A file-local function or variable (static, anonymous namespace) in a source file that defines members of
   * exactly one class is that class's implementation detail: a private static member of it, so the class and
   * its helpers are not a cycle of two types. Not when the file also defines functions of its own: they use the
   * helpers too (qBittorrent's parseCommandLine and DAEMON_OPTION), and could not reach a class's private member.
   */
  moveFileLocalHelpers(files) {
    const withFunctions = new Set();
    for (const fn of this.functions) {
      if (fn.kind !== 'function' || fn.internal) continue;
      for (const place of fn.places) if (place.member.definition && !place.member.test) withFunctions.add(place.file);
    }

    const owners = new Map();
    for (const table of this.types.values()) {
      for (const entry of table.values()) {
        for (const file of entry.definitionFiles.keys()) {
          if (!owners.has(file)) owners.set(file, new Set());
          owners.get(file).add(entry);
        }
      }
    }

    this.functions = this.functions.filter((fn) => {
      if (!fn.internal || fn.kind === 'typeAlias') return true;
      const file = fn.places[0].file;
      if (file.header || withFunctions.has(file)) return true;
      const classes = owners.get(file);
      if (!classes || classes.size !== 1) return true;
      const [owner] = classes;
      owner.members.push({ kind: fn.kind === 'variable' ? 'field' : 'method', name: fn.name, entry: owner, places: fn.places, declaration: fn.declaration, helper: true });
      return false;
    });
  }

  // ---------------------------------------------------------------------------------------- nodes

  emit() {
    const { graph } = this;
    for (const project of this.projects) this.emitProject(project);

    const usedNamespaces = new Map(); // id → { project, key, name }
    const namespaceNode = (project, key, folder) => {
      const id = namespaceId(project.id, key);
      if (!usedNamespaces.has(id)) {
        usedNamespaces.set(id, true);
        graph.addNode({ id, kind: 'namespace', name: key, fullName: key, parent: projectId(project.id), project: projectId(project.id) });
      }

      return id;
    };

    for (const table of this.types.values()) {
      for (const entry of table.values()) {
        if (entry.outer || !hasOwnContent(entry)) continue;
        const nsKey = entry.namespace || entry.folderNamespace;
        this.emitType(entry, namespaceNode(entry.project, nsKey, !entry.namespace), nsKey);
      }
    }

    // Free functions, globals and aliases, in a holder per (namespace, component).
    const holders = new Map();
    for (const fn of this.functions) {
      if (fn.places.every((p) => p.file.context)) continue;
      const place = fn.places.find((p) => p.file.header) ?? fn.places[0];
      const file = place.file;
      const component = file.component;
      const nsKey = fn.namespace || this.folderNamespace(fn.project, file);
      const id = holderId(fn.project.id, component, nsKey);
      let holder = holders.get(id);
      if (!holder) {
        holder = { id, project: fn.project, nsKey, component, files: new Set(), members: [] };
        holders.set(id, holder);
      }

      for (const p of fn.places) if (!p.file.context || p.file === file) holder.files.add(p.file);
      holder.members.push(fn);
    }

    for (const holder of holders.values()) {
      const parent = namespaceNode(holder.project, holder.nsKey, !holder.members.some((m) => m.namespace));
      const files = [...holder.files].sort((a, b) => (a.header === b.header ? a.rel.localeCompare(b.rel) : a.header ? -1 : 1));
      const first = files[0];
      const node = graph.addNode({
        id: holder.id,
        kind: 'module',
        level: 'type',
        name: basename(holder.component),
        fullName: holder.nsKey.endsWith('/') || holder.nsKey === '(global)' ? holder.component : `${holder.nsKey} (${basename(holder.component)})`,
        parent,
        project: projectId(holder.project.id),
        namespace: holder.nsKey.endsWith('/') || holder.nsKey === '(global)' ? undefined : holder.nsKey,
        accessibility: holder.members.every((m) => m.internal) ? 'private' : 'public',
        location: this.location(first, 1, first.lines),
        extraLocations: files.slice(1).map((f) => this.location(f, 1, f.lines)).filter(Boolean),
        signature: files.map((f) => basename(f.rel)).join(' + '),
        tags: files.every((f) => f.test) ? ['test'] : undefined,
        metrics: {},
      });
      let loc = 0;
      for (const fn of holder.members) loc += this.emitFunction(fn, node, holder.nsKey);
      node.metrics.loc = loc;
      if (node.entry) node.tags = tagsOf(node.tags ?? [], ['entrypoint']);
      delete node.entry;
    }

    this.emitProjectEdges();
  }

  emitProject(project) {
    const own = this.files.filter((f) => f.project === project && !f.context);
    const lines = own.reduce((sum, f) => sum + (f.lines ?? 0), 0);
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
      metrics: { files: own.length, lines },
    });
  }

  emitProjectEdges() {
    for (const project of this.projects) {
      for (const other of project.references) this.graph.addEdge(projectId(project.id), projectId(other.id), 'projectReference');
      for (const library of project.libraries) {
        const id = libraryId(library);
        this.graph.addNode({ id, kind: 'package', name: library, external: true });
        this.graph.addEdge(projectId(project.id), id, 'packageReference');
      }
    }
  }

  emitType(entry, parent, nsKey) {
    const { graph } = this;
    const id = typeId(entry.project.id, entry.qualified);
    entry.id = id;
    const decls = [...entry.decls].sort((a, b) => (a.file.header === b.file.header ? a.file.rel.localeCompare(b.file.rel) || a.decl.line - b.decl.line : a.file.header ? -1 : 1));
    const main = decls[0];
    const decl = main.decl;
    const kind = this.kindOf(entry, decl);
    const modifiers = new Set(decl.modifiers);
    if (decl.kind === 'union') modifiers.add('union');
    if (kind === 'class' || kind === 'struct') {
      if (entry.members.some((m) => m.places.some((p) => p.member.modifiers?.includes('abstract')))) modifiers.add('abstract');
    }

    const extra = [];
    for (const d of decls.slice(1)) extra.push(this.location(d.file, d.decl.line, d.decl.endLine));
    let loc = decls.reduce((sum, d) => sum + (d.decl.endLine - d.decl.line + 1), 0);
    for (const [file, defs] of entry.definitionFiles) {
      if (decls.some((d) => d.file === file)) {
        loc += defs.reduce((sum, d) => sum + (d.endLine - d.line + 1), 0);
        continue;
      }

      const first = Math.min(...defs.map((d) => d.line));
      const last = Math.max(...defs.map((d) => d.endLine));
      extra.push(this.location(file, first, last));
      loc += defs.reduce((sum, d) => sum + (d.endLine - d.line + 1), 0);
    }

    const name = decl.template ? `${entry.name}${templateParams(decl.templateText)}` : entry.name;
    const node = graph.addNode({
      id,
      kind,
      name,
      fullName: entry.qualified.replace(/@.*$/, ''),
      parent,
      project: projectId(entry.project.id),
      namespace: entry.namespace || undefined,
      accessibility: entry.outer ? (decl.access ?? 'public') : entry.local ? 'private' : 'public',
      modifiers: [...modifiers].sort(),
      signature: decl.signature?.slice(0, 200),
      baseType: decl.bases[0]?.text,
      location: this.location(main.file, decl.line, decl.endLine),
      extraLocations: extra.filter(Boolean),
      attributes: decl.attributes,
      doc: decls.map((d) => d.decl.doc).find(Boolean) ?? undefined,
      tags: tagsOf(decls.every((d) => d.file.test) ? ['test'] : [], this.frameworks.typeTags(entry)),
      metrics: { loc, ...(decl.template ? { typeParameters: decl.template } : {}) },
    });
    node.bases = decl.bases; // kept for the resolver, removed before writing

    this.assignMemberIds(entry);
    for (const member of entry.members) if (member.places.some((p) => !p.file.context)) this.emitMember(member, node, entry);
    for (const nested of entry.nested) if (hasOwnContent(nested)) this.emitType(nested, id, nsKey);
  }

  /** class, struct, enum, or interface: a class of pure virtual methods only and no data. */
  kindOf(entry, decl) {
    if (decl.kind === 'enum') return 'enum';
    const declared = this.frameworks.typeKind(entry);
    if (declared) return declared;
    if (decl.kind === 'union') return 'struct';
    const methods = entry.members.filter((m) => m.kind === 'method' && !m.name.startsWith('operator='));
    const fields = entry.members.filter((m) => m.kind === 'field' && !(m.declaration.modifiers ?? []).includes('static'));
    if (methods.length && !fields.length && methods.every((m) => (m.declaration.modifiers ?? []).includes('abstract') || m.places.some((p) => p.member.modifiers?.includes('abstract')))) return 'interface';
    return decl.kind === 'struct' ? 'struct' : 'class';
  }

  /** Member ids: name and parameter types as declared; a const overload, then a repeat, are told apart. */
  assignMemberIds(entry) {
    const seen = new Set();
    for (const member of entry.members) {
      const decl = member.declaration;
      const params = member.kind === 'field' || member.kind === 'property' ? undefined : paramsKey(decl.params, false);
      let id = memberId(entry.id, member.name, params);
      if (seen.has(id) && isConst(decl)) id += ' const';
      if (member.helper && seen.has(id)) id += `@${member.places[0].file.rel}`;
      for (let i = 2; seen.has(id); i++) id = `${memberId(entry.id, member.name, params)}~${i}`;
      seen.add(id);
      member.id = id;
    }
  }

  emitMember(member, owner, entry) {
    const parent = owner.id;
    const decl = member.declaration;
    const definition = member.places.find((p) => p.defined) ?? member.places[0];
    const others = member.places.filter((p) => p !== definition);
    const d = definition.member;
    const modifiers = new Set([...(decl.modifiers ?? []), ...member.places.flatMap((p) => p.member.modifiers ?? [])]);
    if (member.helper) {
      modifiers.add('static');
    }

    const kind = member.kind === 'destructor' ? 'method' : member.kind;
    const complexity = member.places.map((p) => p.member.complexity).find((c) => c !== null && c !== undefined);
    const params = decl.params;
    const access = member.helper ? 'private' : member.places.map((p) => p.member.access).find(Boolean) ?? 'public';
    const node = this.graph.addNode({
      id: member.id,
      kind,
      level: 'member',
      name: member.name,
      fullName: `${entry.qualified.replace(/@.*$/, '')}::${member.name}`,
      parent,
      project: projectId(entry.project.id),
      namespace: entry.namespace || undefined,
      accessibility: access,
      modifiers: [...modifiers].filter((m) => m !== 'abstract' || kind !== 'field').sort(),
      signature: (member.places.find((p) => !p.defined || member.places.length === 1) ?? definition).member.signature?.slice(0, 200),
      location: this.location(definition.file, d.line, d.endLine),
      extraLocations: others.map((p) => this.location(p.file, p.member.line, p.member.endLine)).filter(Boolean),
      attributes: [...new Set(member.places.flatMap((p) => p.member.attributes ?? []))],
      doc: member.places.map((p) => p.member.doc).find(Boolean) ?? undefined,
      tags: tagsOf(member.places.every((p) => p.file.test) ? ['test'] : [], this.frameworks.memberTags(member, entry)),
      metrics: memberMetrics(kind, d, complexity, params),
    });
    node.declaredType = member.kind === 'field' ? decl.type : undefined;
    node.returnType = decl.returns ?? undefined;
    node.paramTypes = params?.map((p) => p.type);
    return node;
  }

  /** A free function, global or alias in its holder; returns its lines. */
  emitFunction(fn, holder, nsKey) {
    const decl = fn.declaration;
    const definition = fn.places.find((p) => p.defined) ?? fn.places[0];
    const others = fn.places.filter((p) => p !== definition);
    const d = definition.member;
    const params = fn.kind === 'function' ? paramsKey(decl.params, false) : undefined;
    const qualified = [fn.namespace, fn.name].filter(Boolean).join('::');
    let id = fn.kind === 'function' ? memberId(holder.id, fn.name, params) : memberId(holder.id, fn.name);
    for (let i = 2; this.graph.has(id); i++) id = `${fn.kind === 'function' ? memberId(holder.id, fn.name, params) : memberId(holder.id, fn.name)}~${i}`;
    fn.id = id;
    const modifiers = new Set(fn.places.flatMap((p) => p.member.modifiers ?? []));
    const complexity = fn.places.map((p) => p.member.complexity).find((c) => c !== null && c !== undefined);
    const node = this.graph.addNode({
      id,
      kind: fn.kind,
      level: 'member',
      name: fn.name,
      fullName: qualified,
      parent: holder.id,
      project: projectId(fn.project.id),
      namespace: fn.namespace || undefined,
      accessibility: fn.internal ? 'private' : 'public',
      modifiers: [...modifiers].sort(),
      signature: (fn.places.find((p) => !p.defined) ?? definition).member.signature?.slice(0, 200),
      location: this.location(definition.file, d.line, d.endLine),
      extraLocations: others.map((p) => this.location(p.file, p.member.line, p.member.endLine)).filter(Boolean),
      attributes: [...new Set(fn.places.flatMap((p) => p.member.attributes ?? []))],
      doc: fn.places.map((p) => p.member.doc).find(Boolean) ?? undefined,
      tags: tagsOf(fn.places.every((p) => p.file.test) ? ['test'] : [], this.frameworks.functionTags(fn)),
      metrics: memberMetrics(fn.kind, d, complexity, decl.params),
    });
    if (node.tags?.includes('entrypoint')) holder.entry = true;
    node.declaredType = fn.kind === 'variable' ? decl.type : fn.kind === 'typeAlias' ? decl.target : undefined;
    node.returnType = decl.returns ?? undefined;
    node.paramTypes = decl.params?.map((p) => p.type);
    return d.endLine - d.line + 1;
  }

  // --------------------------------------------------------------------------------------- places

  /**
   * Code outside any namespace, by folder: the folder relative to the project, without a leading include/ or
   * src/ (a header and its source land together), with a trailing `/`; the project's own folder is (global).
   */
  folderNamespace(project, file) {
    let dir = toPosix(relative(project.base, dirname(file.path)));
    if (dir.startsWith('..')) dir = toPosix(relative(dirname(project.base), dirname(file.path)));
    dir = dir.replace(/^(include|src|source|sources|inc|lib|Public|Private|Classes)(\/|$)/i, '');
    return dir ? `${dir}/` : '(global)';
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

function tagsOf(...lists) {
  const tags = [...new Set(lists.flat())].sort();
  return tags.length ? tags : undefined;
}

/** Whether a type has anything in the files analyzed (not only in headers read as context). */
function hasOwnContent(entry) {
  return entry.decls.some((d) => !d.file.context) || entry.members.some((m) => m.places.some((p) => !p.file.context)) || entry.nested.some(hasOwnContent);
}

function memberKind(fn, owner) {
  if (fn.name.startsWith('~')) return 'destructor';
  if (fn.name === owner.name && !fn.returns) return 'constructor';
  return 'method';
}

function memberMetrics(kind, d, complexity, params) {
  const metrics = { loc: d.endLine - d.line + 1 };
  if (kind === 'method' || kind === 'constructor' || kind === 'function' || kind === 'destructor') {
    if (complexity !== null && complexity !== undefined) metrics.complexity = 1 + complexity;
    metrics.parameters = params?.length ?? 0;
  } else if ((kind === 'field' || kind === 'variable') && d.complexity) {
    metrics.complexity = d.complexity;
  }

  return metrics;
}

/** Whether `arity` arguments (a definition's parameters) fit a declaration's parameters (with defaults, `...`). */
function fitsArity(declared, arity, given) {
  if (!declared) return arity === 0;
  const required = declared.filter((p) => !p.optional).length;
  const variadic = declared.some((p) => p.type === '...');
  if (given && given.length === declared.length) return true;
  return arity >= required && (variadic || arity <= declared.length);
}

/** Parameter types joined; `loose` drops what two spellings of one declaration differ in (const, std::, spaces). */
export function paramsKey(params, loose) {
  if (!params) return '';
  return params.map((p) => {
    let t = normalizeType(p.type);
    if (loose) t = t.replace(/^const\s+(?=[^&*]*$)/, '').replace(/\bstd::/g, '').replace(/\s+/g, '').replace(/\bstruct\b|\bclass\b|\benum\b/g, '');
    return t;
  }).join(',');
}

function isConst(decl) {
  return (decl.modifiers ?? []).includes('const');
}

function templateParams(text) {
  if (!text) return '';
  const names = [...text.matchAll(/(?:typename|class|auto|\w+)\s*(?:\.\.\.)?\s*(\w+)\s*(?:=[^,>]*)?(?=[,>])/g)].map((m) => m[1]);
  return names.length ? `<${names.join(', ')}>` : '<>';
}

/**
 * The folder ids of global code are relative to: the project's folder, or the common parent of it and its own
 * files (headers in ../include of a target defined in src/).
 */
function baseOf(project, files) {
  let base = project.dir;
  for (const file of files) {
    const dir = dirname(file.path);
    while (base && !isUnder(dir, base)) {
      const parent = dirname(base);
      if (parent === base) break;
      base = parent;
    }
  }

  return base;
}

export { extname };
