import { writeFileSync } from 'node:fs';

/**
 * Names to edges. tree-sitter gives syntax only, so the types of expressions come from what the code declares:
 * locals, parameters, fields and globals with their declared types (smart pointers, references and `const` see
 * through to the class), `auto` from what it is initialized with, a call from its callee's return type, a range-for
 * variable from its container. A name is looked up as C++ does: the class and its bases, the enclosing namespaces
 * outward, `using` directives and declarations, the global namespace; across the project and the projects it uses.
 * Overloads are told apart by argument count, then by literal argument types. What cannot be told gives no edge:
 * no guessing (templates' dependent names, macros, an `auto` from an unknown call).
 */

const KEYWORDS = new Set([
  'const', 'volatile', 'typename', 'struct', 'class', 'enum', 'union', 'unsigned', 'signed', 'long', 'short', 'int', 'char', 'bool', 'float',
  'double', 'void', 'auto', 'size_t', 'std', 'mutable', 'constexpr', 'static', 'inline', 'decltype', 'noexcept', 'template', 'nullptr_t',
  'wchar_t', 'char8_t', 'char16_t', 'char32_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  'ptrdiff_t', 'intptr_t', 'uintptr_t', 'ssize_t', 'override', 'final', 'operator',
]);
/** Wrappers whose first template argument is the class the code works with. */
const WRAPPERS = /^(?:std::)?(?:unique_ptr|shared_ptr|weak_ptr|optional|reference_wrapper|atomic|not_null|observer_ptr)$|^(?:QPointer|QSharedPointer|QScopedPointer|QWeakPointer|QSharedDataPointer|QExplicitlySharedDataPointer|TSharedPtr|TSharedRef|TUniquePtr|TWeakPtr|TWeakObjectPtr|TObjectPtr|TSoftObjectPtr|TStrongObjectPtr|ComPtr|CComPtr)$/;
const MAPS = /^(?:std::)?(?:map|unordered_map|multimap|unordered_multimap|flat_map)$|^(?:QMap|QHash|QMultiMap|QMultiHash|TMap|TMultiMap)$/;
const CONTAINERS = /^(?:std::)?(?:vector|list|deque|set|unordered_set|multiset|unordered_multiset|array|span|initializer_list|forward_list|queue|stack|priority_queue|flat_set)$|^(?:QList|QVector|QSet|QStringList|QQueue|QStack|TArray|TSet|TArrayView)$/;
const MAKERS = new Set(['make_unique', 'make_shared', 'make_unique_for_overwrite', 'allocate_shared', 'MakeShared', 'MakeUnique', 'MakeShareable', 'NewObject', 'CreateDefaultSubobject', 'SpawnActor']);

export function resolveReferences(model, graph, { log = () => {}, stats = false, unresolvedFile = null } = {}) {
  const resolver = new Resolver(model, graph);
  resolver.run();
  if (stats) {
    const s = resolver.counts;
    const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : '0.0');
    log(`calls resolved: ${pct(s.resolved, s.calls)}% of ${s.calls}; of the calls to names the code declares: ${pct(s.candidateResolved, s.candidates)}% of ${s.candidates}; ambiguous overloads: ${s.ambiguous}`);
  }

  if (unresolvedFile) writeFileSync(unresolvedFile, JSON.stringify(resolver.unresolved, null, 1));
  return resolver.counts;
}

class Resolver {
  constructor(model, graph) {
    this.model = model;
    this.graph = graph;
    this.counts = { calls: 0, resolved: 0, candidates: 0, candidateResolved: 0, ambiguous: 0 };
    this.unresolved = [];
    this.visible = new Map();
    this.byName = new Map(); // simple type name → [entries], every project
    this.free = new Map(); // project id → Map(namespace → Map(name → [function entries]))
    this.declaredNames = new Set();
    for (const project of model.projects) {
      const seen = new Set([project]);
      const queue = [project];
      while (queue.length) for (const ref of queue.shift().references ?? []) if (!seen.has(ref)) seen.add(ref), queue.push(ref);
      this.visible.set(project.id, [...seen]);
      this.free.set(project.id, new Map());
    }

    for (const table of model.types.values()) {
      for (const entry of table.values()) {
        if (!entry.id) continue;
        if (!this.byName.has(entry.name)) this.byName.set(entry.name, []);
        this.byName.get(entry.name).push(entry);
        for (const m of entry.members) this.declaredNames.add(m.name);
      }
    }

    for (const fn of model.functions) {
      if (!fn.id) continue;
      const table = this.free.get(fn.project.id);
      if (!table.has(fn.namespace)) table.set(fn.namespace, new Map());
      const names = table.get(fn.namespace);
      if (!names.has(fn.name)) names.set(fn.name, []);
      names.get(fn.name).push(fn);
      if (fn.kind === 'function') this.declaredNames.add(fn.name);
    }
  }

  run() {
    for (const table of this.model.types.values()) for (const entry of table.values()) if (entry.id) this.typeEdges(entry);
    for (const table of this.model.types.values()) {
      for (const entry of table.values()) {
        if (!entry.id) continue;
        for (const member of entry.members) if (member.id) this.memberEdges(member, entry);
      }
    }

    for (const fn of this.model.functions) if (fn.id) this.functionEdges(fn);
  }

  // ------------------------------------------------------------------------------------- contexts

  contextOf(entry, file = null) {
    const place = file ?? entry.decls[0]?.file;
    return { project: entry.project, ns: split(entry.namespace), cls: entry, file: place, usings: this.usingsOf(place) };
  }

  usingsOf(file) {
    if (!file) return { namespaces: [], names: new Map(), aliases: new Map() };
    if (!file.usings) {
      const facts = file.facts;
      const names = new Map();
      for (const u of facts.usingNames) names.set(u.name.split('::').pop(), u.name.replace(/^::/, ''));
      file.usings = {
        namespaces: [...new Set(facts.usingNamespaces.map((u) => u.target))],
        names,
        aliases: new Map(facts.namespaceAliases.map((a) => [a.name, a.target])),
      };
    }

    return file.usings;
  }

  // ------------------------------------------------------------------------------------- types

  /** The class a type names (through const, &, *, smart pointers, aliases), or null. */
  classOfText(text, ctx, depth = 0) {
    if (!text || depth > 8) return null;
    let t = text.replace(/\b(const|volatile|typename|struct|class|enum|union|mutable)\b/g, ' ').replace(/[*&]+/g, ' ').replace(/\[\]/g, ' ').trim();
    for (let guard = 0; guard < 4; guard++) {
      const { base, args } = splitTemplate(t);
      if (WRAPPERS.test(base) && args.length) t = args[0].replace(/\b(const|volatile)\b/g, ' ').replace(/[*&]+/g, ' ').trim();
      else {
        t = base;
        break;
      }
    }

    if (!t || KEYWORDS.has(t) || /^std::/.test(t)) return null;
    return this.lookupType(t, ctx, depth);
  }

  /** Every class a type mentions, template arguments included (`map<Id, vector<Order>>` → Order). */
  classesInText(text, ctx) {
    const out = new Set();
    if (!text) return out;
    for (const m of text.matchAll(/(?:::)?[A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*/g)) {
      const name = m[0].replace(/\s+/g, '');
      if (KEYWORDS.has(name) || name.startsWith('std::') || name.startsWith('::std::')) continue;
      const entry = this.lookupType(name, ctx);
      if (entry) out.add(entry);
    }

    return out;
  }

  lookupType(name, ctx, depth = 0) {
    const parts = name.replace(/^::/, '').split('::').map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return null;
    const absolute = name.startsWith('::');
    const visible = (this.visible.get(ctx.project.id) ?? [ctx.project]).map((p) => this.model.types.get(p.id)).filter(Boolean);
    // The projects it uses first, then the rest of the repository (a target the build file reader could not link).
    const tables = [...visible, ...[...this.model.types.values()].filter((t) => !visible.includes(t))];
    const find = (key) => {
      for (const table of tables) {
        const hit = table.get(key) ?? (ctx.file ? table.get(`${key}@${ctx.file.rel}`) : undefined);
        if (hit?.id) return hit;
      }

      return null;
    };

    // Nested types of the class, its outer classes and its bases.
    if (!absolute && ctx.cls) {
      for (let c = ctx.cls; c; c = c.outer) {
        const hit = find(`${c.qualified}::${parts.join('::')}`) ?? this.nestedInBases(c, parts, ctx);
        if (hit) return hit;
      }
    }

    const namespaces = absolute ? [[]] : [...ctx.ns.map((_, i) => ctx.ns.slice(0, ctx.ns.length - i)), []];
    for (const ns of namespaces) {
      const hit = find([...ns, ...parts].join('::'));
      if (hit) return hit;
    }

    const head = parts[0];
    const aliasNs = ctx.usings.aliases.get(head);
    if (aliasNs) {
      const hit = find([aliasNs, ...parts.slice(1)].join('::'));
      if (hit) return hit;
    }

    for (const using of ctx.usings.namespaces) {
      for (const ns of [using, ...ctx.ns.map((_, i) => [...ctx.ns.slice(0, ctx.ns.length - i), using].join('::'))]) {
        const hit = find(`${ns}::${parts.join('::')}`);
        if (hit) return hit;
      }
    }

    const used = ctx.usings.names.get(head);
    if (used) {
      const hit = find([used, ...parts.slice(1)].join('::'));
      if (hit) return hit;
    }

    // An alias (typedef, using X = …) of a class.
    const alias = this.lookupFree(parts, ctx, 'typeAlias');
    if (alias && depth < 8) {
      const target = alias.declaration.target;
      const hit = target ? this.classOfText(target, this.contextOfFree(alias), depth + 1) : null;
      if (hit) return hit;
    }

    // A name declared once in the code (headers reached through includes the scoping above does not follow).
    if (parts.length === 1) {
      const all = (this.byName.get(head) ?? []).filter((e) => !e.local || e.decls.some((d) => d.file === ctx.file));
      if (all.length === 1) return all[0];
    }

    return null;
  }

  nestedInBases(entry, parts, ctx, seen = new Set()) {
    for (const base of this.basesOf(entry)) {
      if (seen.has(base)) continue;
      seen.add(base);
      const key = `${base.qualified}::${parts.join('::')}`;
      for (const table of this.model.types.values()) if (table.get(key)?.id) return table.get(key);
      const deeper = this.nestedInBases(base, parts, ctx, seen);
      if (deeper) return deeper;
    }

    return null;
  }

  basesOf(entry) {
    if (!entry.baseEntries) {
      entry.baseEntries = [];
      const ctx = { ...this.contextOf(entry), cls: entry.outer ?? null };
      const seen = new Set();
      for (const { decl } of entry.decls) {
        for (const base of decl.bases ?? []) {
          const hit = this.classOfText(base.text, ctx);
          if (hit && hit !== entry && !seen.has(hit)) {
            seen.add(hit);
            entry.baseEntries.push(hit);
          }
        }
      }
    }

    return entry.baseEntries;
  }

  // ---------------------------------------------------------------------------------- functions

  contextOfFree(fn, file = null) {
    const place = file ?? fn.places[0].file;
    return { project: fn.project, ns: split(fn.namespace), cls: null, file: place, usings: this.usingsOf(place) };
  }

  /** A free function, global or alias by (qualified) name, from the enclosing namespace outward. */
  lookupFree(parts, ctx, kind = null) {
    const name = parts[parts.length - 1];
    const qual = parts.slice(0, -1);
    const visible = this.visible.get(ctx.project.id) ?? [ctx.project];
    const projects = [...visible, ...this.model.projects.filter((p) => !visible.includes(p))];
    const at = (ns) => {
      const out = [];
      for (const p of projects) {
        const list = this.free.get(p.id)?.get(ns)?.get(name);
        if (list) for (const fn of list) if ((!kind || fn.kind === kind) && (!fn.internal || fn.places.some((pl) => pl.file === ctx.file))) out.push(fn);
      }

      return out;
    };

    const tryNamespaces = (base) => {
      for (const ns of base) {
        const found = at([...ns, ...qual].join('::'));
        if (found.length) return found;
      }

      return null;
    };

    const absolute = parts[0] === '';
    const scopes = absolute ? [[]] : [...ctx.ns.map((_, i) => ctx.ns.slice(0, ctx.ns.length - i)), []];
    let found = tryNamespaces(scopes);
    if (!found && ctx.cls) {
      // Inside a member, the class's own namespace counts (a definition written outside it).
      found = tryNamespaces([split(ctx.cls.namespace)]);
    }

    if (!found && qual.length && ctx.usings.aliases.has(qual[0])) found = at([ctx.usings.aliases.get(qual[0]), ...qual.slice(1)].join('::')) || null;
    if (!found) {
      for (const using of ctx.usings.namespaces) {
        const hit = at([using, ...qual].join('::'));
        if (hit.length) {
          found = hit;
          break;
        }
      }
    }

    if (!found && !qual.length && ctx.usings.names.has(name)) {
      const full = split(ctx.usings.names.get(name));
      const hit = at(full.slice(0, -1).join('::'));
      if (hit.length) found = hit;
    }

    if (!found) return null;
    return kind ? found[0] : found;
  }

  /** Members named so in a class or, when it has none, its bases (a derived name hides the base's). */
  membersNamed(entry, name, seen = new Set()) {
    if (!entry || seen.has(entry)) return [];
    seen.add(entry);
    const own = entry.members.filter((m) => m.id && m.name === name);
    if (own.length) return own.map((m) => ({ member: m, owner: entry }));
    for (const base of this.basesOf(entry)) {
      const found = this.membersNamed(base, name, seen);
      if (found.length) return found;
    }

    return [];
  }

  /** Of functions with one name, the one a call with these arguments reaches; null when it cannot be told. */
  pick(candidates, argc, argTypes) {
    const params = (c) => (c.member ?? c).declaration.params ?? [];
    const fits = candidates.filter((c) => {
      const p = params(c);
      const required = p.filter((x) => !x.optional).length;
      return argc >= required && (argc <= p.length || p.some((x) => x.type === '...'));
    });
    if (fits.length === 1) return fits[0];
    if (!fits.length) return candidates.length === 1 ? candidates[0] : null;
    const exact = fits.filter((c) => params(c).length === argc);
    const pool = exact.length ? exact : fits;
    if (pool.length === 1) return pool[0];
    const scored = pool.map((c) => ({ c, score: argTypes.reduce((sum, t, i) => sum + matchScore(t, params(c)[i]?.type), 0) }));
    scored.sort((a, b) => b.score - a.score);
    if (scored[0].score > 0 && scored[0].score > scored[1].score) return scored[0].c;
    // The same function seen twice (declared in two headers): one target.
    const ids = new Set(pool.map((c) => (c.member ?? c).id));
    if (ids.size === 1) return pool[0];
    this.counts.ambiguous++;
    return null;
  }

  // ------------------------------------------------------------------------------- expressions

  /** {entry} or {text, ctx} for an expression's type, or null. */
  typeOf(e, scope, depth = 0) {
    if (!e || depth > 12) return null;
    switch (e.t) {
      case 'this':
        return scope.ctx.cls ? { entry: scope.ctx.cls } : null;
      case 'id': {
        const local = scope.locals.get(e.n);
        if (local) {
          if (local.ty) return { text: local.ty, ctx: scope.ctx };
          if (local.e) return this.typeOf(local.e, { ...scope, locals: scope.without(e.n) }, depth + 1);
          return null;
        }

        const field = scope.ctx.cls ? this.membersNamed(scope.ctx.cls, e.n).find((m) => m.member.kind === 'field') : null;
        if (field) return { text: field.member.declaration.type, ctx: this.contextOf(field.owner) };
        const global = this.lookupFree([e.n], scope.ctx, 'variable');
        if (global) return { text: global.declaration.type, ctx: this.contextOfFree(global) };
        return null;
      }

      case 'fld': {
        const owner = this.classOf(this.typeOf(e.b, scope, depth + 1));
        const field = owner ? this.membersNamed(owner, e.n).find((m) => m.member.kind === 'field') : null;
        return field ? { text: field.member.declaration.type, ctx: this.contextOf(field.owner) } : null;
      }

      case 'call': {
        const target = this.callee(e.f, e.argc, [], scope, depth + 1);
        if (!target) return null;
        if (target.type) return { entry: target.type };
        if (target.made) return { text: target.made, ctx: scope.ctx };
        if (!target.member && !target.fn) return null;
        const decl = (target.member ?? target.fn).declaration;
        if (!decl.returns) return null;
        return { text: decl.returns, ctx: target.owner ? this.contextOf(target.owner) : this.contextOfFree(target.fn) };
      }

      case 'q': {
        const type = this.lookupType(e.p.join('::'), scope.ctx);
        if (type) return { entry: type };
        const owner = e.p.length > 1 ? this.lookupType(e.p.slice(0, -1).join('::'), scope.ctx) : null;
        const field = owner ? this.membersNamed(owner, e.p[e.p.length - 1]).find((m) => m.member.kind === 'field') : null;
        if (field) return { text: field.member.declaration.type, ctx: this.contextOf(field.owner) };
        const global = this.lookupFree(e.p, scope.ctx, 'variable');
        return global ? { text: global.declaration.type, ctx: this.contextOfFree(global) } : null;
      }

      case 'new':
      case 'cast':
        return e.ty ? { text: e.ty, ctx: scope.ctx } : null;
      case 'deref':
      case 'addr':
        return this.typeOf(e.b, scope, depth + 1);
      case 'sub':
      case 'elem': {
        const container = this.typeOf(e.b, scope, depth + 1);
        return container?.text ? this.elementOf(container) : null;
      }

      default:
        return null;
    }
  }

  classOf(info) {
    if (!info) return null;
    return info.entry ?? this.classOfText(info.text, info.ctx);
  }

  /** The element type of a container (vector<Order> → Order, a map's mapped type, T[] → T). */
  elementOf(info) {
    let text = info.text.replace(/\b(const|volatile)\b/g, ' ').replace(/[&]+/g, ' ').trim();
    if (/\[\]$/.test(text)) return { text: text.slice(0, -2), ctx: info.ctx };
    if (/\*$/.test(text)) return { text: text.slice(0, -1), ctx: info.ctx };
    for (let guard = 0; guard < 3; guard++) {
      const { base, args } = splitTemplate(text);
      if (WRAPPERS.test(base) && args.length) {
        text = args[0];
        continue;
      }

      if (MAPS.test(base) && args.length > 1) return { text: args[1], ctx: info.ctx };
      if (CONTAINERS.test(base) && args.length) return { text: args[0], ctx: info.ctx };
      // A class of the code that is a container: what its operator[] or begin() returns.
      const entry = this.classOfText(text, info.ctx);
      const access = entry ? this.membersNamed(entry, 'operator[]')[0] ?? this.membersNamed(entry, 'begin')[0] : null;
      if (access?.member.declaration.returns) return { text: access.member.declaration.returns, ctx: this.contextOf(access.owner) };
      return null;
    }

    return null;
  }

  /**
   * What a call reaches: {member, owner} (a method), {fn} (a free function), {type} (a constructor: the class),
   * {made} (make_unique<T>: T), or null.
   */
  callee(f, argc, argTypes, scope, depth = 0) {
    switch (f.t) {
      case 'id': {
        if (scope.locals.has(f.n)) return null; // a lambda or a function pointer held in a local
        if (scope.ctx.cls) {
          const named = this.membersNamed(scope.ctx.cls, f.n);
          const methods = named.filter((m) => m.member.kind !== 'field');
          if (methods.length) return this.pick(methods, argc, argTypes);
          if (named.length) return { field: named[0].member }; // a function pointer or functor held in a field
        }

        const fns = this.lookupFree([f.n], scope.ctx);
        const functions = fns?.filter((fn) => fn.kind === 'function');
        if (functions?.length) {
          const chosen = this.pick(functions, argc, argTypes);
          return chosen ? { fn: chosen } : null;
        }

        const held = fns?.find((fn) => fn.kind === 'variable');
        if (held) return { variable: held };

        const type = this.lookupType(f.n, scope.ctx);
        return type ? { type } : null;
      }

      case 'tf': {
        if (MAKERS.has(f.n) && f.a?.length) return { made: f.a[0], type: this.classOfText(f.a[0], scope.ctx), maker: true };
        return this.callee({ t: 'id', n: f.n }, argc, argTypes, scope, depth);
      }

      case 'q': {
        const name = f.p[f.p.length - 1];
        if (MAKERS.has(name) && f.a?.length) return { made: f.a[0], type: this.classOfText(f.a[0], scope.ctx), maker: true };
        if (f.p[0] === 'std' && !this.model.namespaces.get(scope.ctx.project.id)?.has('std')) return null;
        const whole = this.lookupType(f.p.join('::'), scope.ctx);
        if (whole) return { type: whole };
        const owner = f.p.length > 1 ? this.lookupType(f.p.slice(0, -1).join('::'), scope.ctx) : null;
        if (owner) {
          if (name === owner.name) return { type: owner };
          const methods = this.membersNamed(owner, name).filter((m) => m.member.kind !== 'field');
          return methods.length ? this.pick(methods, argc, argTypes) : null;
        }

        const fns = this.lookupFree(f.p, scope.ctx);
        const functions = fns?.filter((fn) => fn.kind === 'function');
        if (functions?.length) {
          const chosen = this.pick(functions, argc, argTypes);
          return chosen ? { fn: chosen } : null;
        }

        return null;
      }

      case 'fld': {
        const owner = this.classOf(this.typeOf(f.b, scope, depth + 1));
        if (!owner) return null;
        const named = this.membersNamed(owner, f.n);
        const methods = named.filter((m) => m.member.kind !== 'field');
        if (methods.length) return this.pick(methods, argc, argTypes);
        return named.length ? { field: named[0].member } : null;
      }

      default:
        return null;
    }
  }

  // ------------------------------------------------------------------------------------ edges

  /** Inheritance, implementations and overrides of a class; friends; constructors' parameters (injects). */
  typeEdges(entry) {
    for (const base of this.basesOf(entry)) this.graph.addEdge(entry.id, base.id, this.graph.get(base.id)?.kind === 'interface' ? 'implements' : 'inherits');
    const ctx = this.contextOf(entry);
    for (const { decl } of entry.decls) {
      for (const friend of decl.friends ?? []) for (const target of this.classesInText(friend.replace(/^(class|struct)\s+/, ''), ctx)) if (target !== entry) this.graph.addEdge(entry.id, target.id, 'uses');
    }

    for (const member of entry.members) {
      if (!member.id || member.kind === 'field') continue;
      if (member.kind === 'constructor' && !member.helper) {
        for (const p of member.declaration.params ?? []) for (const target of this.classesInText(p.type, ctx)) if (target !== entry) this.graph.addEdge(entry.id, target.id, 'injects');
      }

      if (member.kind === 'method' || member.kind === 'destructor') this.overrides(member, entry);
    }
  }

  /** A method overrides the base's virtual of the same name and parameters; implements it when that one is pure. */
  overrides(member, entry) {
    const name = member.name;
    const params = paramsKey(member.declaration.params);
    const visit = (owner, seen) => {
      for (const base of this.basesOf(owner)) {
        if (seen.has(base)) continue;
        seen.add(base);
        const match = base.members.find((m) => m.id && m.name === name && m.kind !== 'field' && (name.startsWith('~') || paramsKey(m.declaration.params) === params));
        if (match && (isVirtual(match) || isVirtual(member))) {
          const pure = isAbstract(match) || this.graph.get(base.id)?.kind === 'interface';
          this.graph.addEdge(member.id, match.id, pure ? 'implements' : 'overrides');
          const node = this.graph.get(member.id);
          if (node && !node.modifiers?.includes('override')) node.modifiers = [...(node.modifiers ?? []), 'override'].sort();
          return true;
        }

        if (visit(base, seen)) return true;
      }

      return false;
    };
    visit(entry, new Set([entry]));
  }

  memberEdges(member, entry) {
    const decl = member.declaration;
    const ctx = this.contextOf(entry);
    if (member.kind === 'field' || member.kind === 'property') {
      for (const target of this.classesInText(decl.type, ctx)) if (target !== entry) this.graph.addEdge(member.id, target.id, 'holds');
      if (member.kind === 'property') {
        // Q_PROPERTY: its READ / WRITE functions run when it is used; MEMBER is the field it is; NOTIFY the signal.
        for (const [name, kind] of [[decl.read, 'calls'], [decl.write, 'calls'], [decl.member, 'accesses'], [decl.notify, 'uses']]) {
          const wanted = kind === 'accesses' ? 'field' : 'method';
          const target = name ? this.membersNamed(entry, name).find((m) => m.member.kind === wanted) : null;
          if (target) this.graph.addEdge(member.id, target.member.id, kind);
        }
      }
    } else {
      for (const p of decl.params ?? []) for (const target of this.classesInText(p.type, ctx)) this.graph.addEdge(member.id, target.id, 'accepts');
      if (decl.returns) for (const target of this.classesInText(decl.returns, ctx)) this.graph.addEdge(member.id, target.id, 'returns');
    }

    for (const place of member.places) {
      const body = place.member.body;
      if (body) this.bodyEdges(member.id, body, { ...this.contextOf(entry, place.file), cls: entry }, place.member.params ?? decl.params, place.file);
    }
  }

  functionEdges(fn) {
    const decl = fn.declaration;
    const ctx = this.contextOfFree(fn);
    if (fn.kind === 'variable') {
      for (const target of this.classesInText(decl.type, ctx)) this.graph.addEdge(fn.id, target.id, 'holds');
    } else if (fn.kind === 'typeAlias') {
      for (const target of this.classesInText(decl.target, ctx)) this.graph.addEdge(fn.id, target.id, 'uses');
    } else {
      for (const p of decl.params ?? []) for (const target of this.classesInText(p.type, ctx)) this.graph.addEdge(fn.id, target.id, 'accepts');
      if (decl.returns) for (const target of this.classesInText(decl.returns, ctx)) this.graph.addEdge(fn.id, target.id, 'returns');
    }

    for (const place of fn.places) {
      const body = place.member.body;
      if (!body) continue;
      const ctx = this.contextOfFree(fn, place.file);
      // A fixture test (TEST_F, BOOST_FIXTURE_TEST_CASE, TEST_CASE_METHOD) runs as a member of its fixture.
      const fixture = place.member.test?.fixture ? this.lookupType(place.member.test.fixture, ctx) : null;
      if (fixture) {
        this.graph.addEdge(fn.id, fixture.id, 'uses');
        ctx.cls = fixture;
      }

      this.bodyEdges(fn.id, body, ctx, place.member.params ?? decl.params, place.file);
    }
  }

  bodyEdges(source, body, ctx, params, file) {
    const locals = new Map();
    for (const p of params ?? []) if (p.name) locals.set(p.name, { ty: p.type });
    for (const local of body.locals) locals.set(local.n, local);
    const scope = { ctx, locals, without: (name) => new Map([...locals].filter(([k]) => k !== name)) };
    const add = (target, kind, line) => {
      if (target && target !== source) this.graph.addEdge(source, target, kind, kind === 'calls' || kind === 'instantiates' ? line : 0);
      else if (target && kind === 'calls') this.graph.addEdge(source, target, kind, line); // recursion
    };

    for (const site of body.sites) {
      switch (site.k) {
        case 'call': {
          this.counts.calls++;
          const name = calleeName(site.f);
          const receiver = site.f.t === 'fld' ? this.typeOf(site.f.b, scope) : null;
          const external = receiver?.text && /^(const\s+)?(std|boost|absl|Q[A-Z]\w*|::std)\b/.test(receiver.text.replace(/^const\s+/, '')) && !this.classOf(receiver);
          const std = site.f.t === 'q' && (site.f.p[0] === 'std' || site.f.p[0] === '');
          const candidate = name && this.declaredNames.has(name) && !external && !std;
          if (candidate) this.counts.candidates++;
          const target = this.callee(site.f, site.argc, site.args ?? [], scope);
          if (!target && site.argx) this.connect(source, site.argx, scope);
          if (!target) {
            if (candidate) this.unresolved.push([file.rel, site.line, describe(site.f), receiverType(site.f, scope, this)]);
            break;
          }

          if (site.argx) this.connect(source, site.argx, scope);
          this.counts.resolved++;
          if (candidate) this.counts.candidateResolved++;
          if (target.member) add(target.member.id, 'calls', site.line);
          else if (target.fn) add(target.fn.id, 'calls', site.line);
          else if (target.type) add(target.type.id, 'instantiates', site.line);
          else if (target.field) add(target.field.id, 'accesses', site.line);
          else if (target.variable) add(target.variable.id, 'accesses', site.line);
          break;
        }

        case 'new': {
          const type = this.classOfText(site.ty, ctx);
          if (type) add(type.id, site.throw ? 'throws' : 'instantiates', site.line);
          break;
        }

        case 'construct': {
          const type = this.classOfText(site.ty, ctx);
          if (type && this.graph.get(type.id)?.kind !== 'interface') add(type.id, 'instantiates', site.line);
          break;
        }

        case 'type': {
          for (const type of this.classesInText(site.ty, ctx)) if (type !== ctx.cls) add(type.id, site.rel, site.line);
          break;
        }

        case 'throw': {
          const target = this.callee(site.f, 1, [], scope);
          if (target?.type) add(target.type.id, 'throws', site.line);
          else if (target?.member) add(target.member.id, 'calls', site.line);
          else if (target?.fn) add(target.fn.id, 'calls', site.line);
          break;
        }

        case 'access':
          this.access(site.e, scope, add, site.line);
          break;
        default:
          break;
      }
    }
  }

  /**
   * Qt's connect(sender, &Sender::signal, receiver, &Receiver::slot) (or with SIGNAL()/SLOT() names): the connecting
   * code subscribes to the signal and uses the slot, as C# code subscribing to an event. The signal does not call the
   * slot on the map: its class does not depend on every receiver (that would make a cycle of each connection).
   */
  connect(source, args, scope) {
    const memberOf = (e, owner) => {
      if (e?.t === 'addr' && e.b?.t === 'q' && e.b.p.length > 1) {
        const type = this.lookupType(e.b.p.slice(0, -1).join('::'), scope.ctx);
        return type ? this.membersNamed(type, e.b.p[e.b.p.length - 1]).find((m) => m.member.kind !== 'field')?.member ?? null : null;
      }

      if (e?.t === 'lit' && e.s && owner) return this.membersNamed(owner, e.s).find((m) => m.member.kind !== 'field')?.member ?? null;
      return null;
    };
    const sender = this.classOf(this.typeOf(args[0], scope));
    const signal = memberOf(args[1], sender);
    if (!signal) return;
    this.graph.addEdge(source, signal.id, 'subscribes');
    const receiver = args.length > 3 ? this.classOf(this.typeOf(args[2], scope)) : null;
    const slot = args.length > 3 ? memberOf(args[3], receiver) : memberOf(args[2], null);
    if (slot) this.graph.addEdge(source, slot.id, 'uses');
  }

  /** A field or global read or written (accesses), a function named as a value (uses), a type named (uses). */
  access(e, scope, add, line) {
    if (e.t === 'id') {
      if (scope.locals.has(e.n)) return;
      if (scope.ctx.cls) {
        const member = this.membersNamed(scope.ctx.cls, e.n)[0];
        if (member) {
          add(member.member.id, member.member.kind === 'field' ? 'accesses' : 'uses', line);
          return;
        }
      }

      const free = this.lookupFree([e.n], scope.ctx);
      if (free?.length) {
        const target = free[0];
        add(target.id, target.kind === 'variable' ? 'accesses' : 'uses', line);
        return;
      }

      return;
    }

    if (e.t === 'fld') {
      const owner = this.classOf(this.typeOf(e.b, scope));
      const member = owner ? this.membersNamed(owner, e.n)[0] : null;
      if (member) add(member.member.id, member.member.kind === 'field' ? 'accesses' : 'uses', line);
      return;
    }

    if (e.t === 'q') {
      if (e.p[0] === 'std') return;
      const type = this.lookupType(e.p.join('::'), scope.ctx);
      if (type) {
        if (type !== scope.ctx.cls) add(type.id, 'uses', line);
        return;
      }

      const owner = e.p.length > 1 ? this.lookupType(e.p.slice(0, -1).join('::'), scope.ctx) : null;
      if (owner) {
        const member = this.membersNamed(owner, e.p[e.p.length - 1])[0];
        if (member) add(member.member.id, member.member.kind === 'field' ? 'accesses' : 'uses', line);
        else if (owner !== scope.ctx.cls) add(owner.id, 'uses', line); // an enumerator: Status::Paid
        return;
      }

      const free = this.lookupFree(e.p, scope.ctx);
      if (free?.length) add(free[0].id, free[0].kind === 'variable' ? 'accesses' : 'uses', line);
    }
  }
}

// --------------------------------------------------------------------------------------------- helpers

function split(namespace) {
  return namespace ? namespace.split('::').filter(Boolean) : [];
}

/** `vector<Order, Alloc>` → base `vector`, args [Order, Alloc] (top-level commas only). */
export function splitTemplate(text) {
  const open = text.indexOf('<');
  if (open === -1 || !text.endsWith('>')) return { base: text.trim(), args: [] };
  const base = text.slice(0, open).trim();
  const inner = text.slice(open + 1, -1);
  const args = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '<' || c === '(') depth++;
    else if (c === '>' || c === ')') depth--;
    else if (c === ',' && depth === 0) {
      args.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }

  args.push(inner.slice(start).trim());
  return { base, args: args.filter(Boolean) };
}

function paramsKey(params) {
  return (params ?? []).map((p) => p.type.replace(/\s+/g, '').replace(/^const(?=[^&*]*$)/, '').replace(/\bstd::/g, '')).join(',');
}

function isVirtual(member) {
  return member.places.some((p) => (p.member.modifiers ?? []).some((m) => m === 'virtual' || m === 'override' || m === 'abstract'));
}

function isAbstract(member) {
  return member.places.some((p) => (p.member.modifiers ?? []).includes('abstract'));
}

/** How well a literal argument fits a parameter type (0: no telling). */
function matchScore(arg, param) {
  if (!arg || !param) return 0;
  const p = param.replace(/\b(const|volatile)\b/g, '').replace(/[&\s]/g, '');
  if (arg === 'string') return /char\*|string|QString|FString|string_view|TCHAR\*/.test(p) ? 2 : -1;
  if (arg === 'double') return /^(double|float|longdouble)$/.test(p) ? 2 : /^(int|long|short|unsigned|size_t|int\d+_t|uint\d+_t|bool|char)/.test(p) ? 0 : -1;
  if (arg === 'int') return /^(int|long|short|unsigned|size_t|int\d+_t|uint\d+_t|longlong|int32|int64|uint32|uint64)/.test(p) ? 2 : /^(double|float)$/.test(p) ? 1 : /\*|string/.test(p) ? -1 : 0;
  if (arg === 'bool') return p === 'bool' ? 2 : 0;
  if (arg === 'char') return p === 'char' ? 2 : 0;
  if (arg === 'nullptr') return /\*|ptr/.test(p) ? 2 : -1;
  return 0;
}

function calleeName(f) {
  if (f.t === 'id' || f.t === 'tf') return f.n;
  if (f.t === 'fld') return f.n;
  if (f.t === 'q') return f.p[f.p.length - 1];
  return null;
}

function describe(e) {
  switch (e?.t) {
    case 'id':
      return e.n;
    case 'this':
      return 'this';
    case 'fld':
      return `${describe(e.b)}.${e.n}`;
    case 'q':
      return e.p.join('::');
    case 'call':
      return `${describe(e.f)}()`;
    case 'tf':
      return `${e.n}<…>`;
    default:
      return '…';
  }
}

function receiverType(f, scope, resolver) {
  if (f.t !== 'fld') return null;
  const info = resolver.typeOf(f.b, scope);
  return info?.entry?.qualified ?? info?.text ?? null;
}
