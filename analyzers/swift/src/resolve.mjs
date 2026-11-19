import { writeFileSync } from 'node:fs';

/**
 * Edges from what the declarations and bodies refer to, once every type of the map is known.
 *
 * Types of expressions come from declared types (parameters, properties, return types), initializer calls
 * (`Order(…)`, `.init(…)` of a declared type), `self` and implicit `self`, static members (`Order.create()`), enum
 * cases, `if let` / `guard let`, `for … in` over arrays, subscripts, casts, `try` / `await`. A call is told apart from
 * its overloads by its argument labels, then by its arity and the types of literal arguments; when it still is not
 * one, no edge is made. Names used on something whose type is not known are kept, so private members of those names
 * are tagged `maybe-used` rather than reported unused.
 *
 * A type is { entry } (a type of the map), { meta: entry } (the type itself: `Order.create()`), { ext: name } (a type
 * from outside: String, View), { array: T }, { dict: [K, V] }, or null.
 */
export function resolveReferences(model, graph, { log = () => {}, stats = false, unresolvedFile = null } = {}) {
  const resolver = new Resolver(model, graph);
  resolver.declarations();
  resolver.bodies();
  resolver.tagMaybeUsed();
  if (stats) {
    const { calls, resolved, implicit, ours, oursResolved } = resolver.counts;
    const share = (a, b) => (b ? ((100 * a) / b).toFixed(1) : '0.0');
    log(`calls: ${resolved} of ${calls} resolved (${share(resolved, calls)}%); of those naming code of the map ${oursResolved} of ${ours} (${share(oursResolved, ours)}%); ${implicit} to an implicit member (.name) not counted`);
  }

  if (unresolvedFile) {
    // The names the map declares first: those are the misses that matter.
    const lines = [...resolver.unresolved.entries()].sort((a, b) => Number(resolver.declared.has(b[0])) - Number(resolver.declared.has(a[0])) || b[1] - a[1]).map(([name, count]) => `${count}\t${resolver.declared.has(name) ? '*' : ' '}\t${name}`);
    writeFileSync(unresolvedFile, lines.join('\n') + '\n');
  }

  return resolver.counts;
}

const KEYWORDS = new Set(['some', 'any', 'inout', 'Self', 'where', 'borrowing', 'consuming', 'throws', 'rethrows', 'async', 'escaping', 'sending', 'isolated', 'each', 'repeat', 'Type', 'Protocol']);
const SEQUENCE_SAME = new Set(['filter', 'sorted', 'reversed', 'shuffled', 'prefix', 'suffix', 'dropFirst', 'dropLast']);
const SEQUENCE_ELEMENT = new Set(['first', 'last', 'randomElement', 'min', 'max', 'popLast', 'removeFirst', 'removeLast']);

class Resolver {
  constructor(model, graph) {
    this.model = model;
    this.graph = graph;
    this.counts = { calls: 0, resolved: 0, implicit: 0, ours: 0, oursResolved: 0 };
    // Names the map declares (members, functions, types): a call of one of them may be resolvable.
    this.declared = new Set();
    for (const table of model.types.values()) for (const entry of table.values()) {
      if (!entry.external) this.declared.add(entry.name);
      for (const m of entry.members) this.declared.add(m.decl.name);
    }

    for (const holder of model.holders.values()) for (const m of holder.members) this.declared.add(m.decl.name);
    this.unresolved = new Map();
    this.untyped = new Set(); // names used on receivers of unknown type
    this.superCache = new Map();
    this.protocolCache = new Map();
    this.memberTypes = new Map();
    // Free functions, globals and type aliases of each target, and its extensions of types from outside, by name.
    this.functions = new Map();
    this.globals = new Map();
    this.aliases = new Map();
    this.outside = new Map();
    for (const project of model.projects) {
      this.functions.set(project.id, new Map());
      this.globals.set(project.id, new Map());
      this.aliases.set(project.id, new Map());
      this.outside.set(project.id, new Map());
    }

    for (const holder of model.holders.values()) {
      const id = holder.file.project.id;
      for (const member of holder.members) {
        member.holder = holder;
        const table = member.decl.kind === 'function' ? this.functions : member.decl.kind === 'variable' ? this.globals : member.decl.kind === 'typeAlias' ? this.aliases : null;
        if (!table) continue;
        const byName = table.get(id);
        if (!byName.has(member.decl.name)) byName.set(member.decl.name, []);
        byName.get(member.decl.name).push(member);
      }
    }

    for (const table of model.types.values()) {
      for (const entry of table.values()) {
        if (!entry.external) continue;
        const byName = this.outside.get(entry.project.id);
        if (!byName.has(entry.name)) byName.set(entry.name, []);
        byName.get(entry.name).push(entry);
      }
    }
  }

  edge(source, target, kind, line = 0) {
    // A call of itself is recursion, kept as the graph keeps it; any other edge to itself is not one.
    if (source && target && (source !== target || kind === 'calls')) this.graph.addEdge(source, target, kind, line);
  }

  visible(project) {
    return [project, ...project.references];
  }

  // ------------------------------------------------------------------------------------------------ types

  /** A type by its name as written in a context: nested types first, then the target's, then those it uses. */
  lookupType(name, ctx, depth = 0) {
    if (!name || depth > 6) return null;
    const parts = name.split('.');
    let found = null;
    for (let e = ctx.entry; e && !found; e = e.outer) {
      if (e.name === parts[0] && !e.external) found = e;
      else found = e.nested.find((n) => n.name === parts[0]) ?? null;
    }

    if (!found && ctx.project) {
      for (const project of this.visible(ctx.project)) {
        const table = this.model.types.get(project.id);
        found = (ctx.file && table?.get(`${parts[0]}@${ctx.file.rel}`)) || table?.get(parts[0]) || null;
        if (found?.external) found = null;
        if (found) break;
      }
    }

    if (!found && parts.length === 1) {
      const alias = this.aliasType(parts[0], ctx, depth);
      if (alias) return alias;
    }

    for (const part of parts.slice(1)) {
      if (!found) break;
      found = found.nested.find((n) => n.name === part) ?? null;
    }

    return found;
  }

  /** A typealias of the enclosing types or of the targets: the type it names. */
  aliasType(name, ctx, depth) {
    for (let e = ctx.entry; e; e = e.outer) {
      const alias = e.members.find((m) => m.decl.kind === 'typeAlias' && m.decl.name === name && m.decl.type);
      if (alias) return this.lookupType(baseName(alias.decl.type), { ...ctx, entry: e }, depth + 1);
    }

    for (const project of ctx.project ? this.visible(ctx.project) : []) {
      const alias = this.aliases.get(project.id)?.get(name)?.[0];
      if (alias?.decl.type) return this.lookupType(baseName(alias.decl.type), { project, entry: null, file: alias.holder.file }, depth + 1);
    }

    return null;
  }

  /** A type as written (`[Order.Line]?`, `Result<Order, Error>`, `some View`) as a resolved type. */
  parseType(text, ctx, self = null) {
    if (!text) return null;
    let t = text.replace(/@\w+(\([^)]*\))?\s*/g, '').replace(/\b(inout|some|any|borrowing|consuming|sending|__owned|__shared)\s+/g, '').trim();
    while (/[?!]$/.test(t)) t = t.slice(0, -1).trim();
    if (t.startsWith('(') && t.endsWith(')') && !/->/.test(t)) {
      const inner = splitTop(t.slice(1, -1), ',');
      return inner.length === 1 ? this.parseType(inner[0], ctx, self) : null;
    }

    if (/->/.test(t)) return null;
    if (t.startsWith('[') && t.endsWith(']')) {
      const inner = t.slice(1, -1);
      const parts = splitTop(inner, ':');
      if (parts.length === 2) return { dict: [this.parseType(parts[0], ctx, self), this.parseType(parts[1], ctx, self)] };
      return { array: this.parseType(inner, ctx, self) };
    }

    const generic = /^([\w.]+)\s*<(.*)>$/.exec(t);
    if (generic) {
      const args = splitTop(generic[2], ',');
      const name = generic[1];
      if (/^(Swift\.)?(Array|Set|ArraySlice|ContiguousArray)$/.test(name)) return { array: this.parseType(args[0], ctx, self) };
      if (/^(Swift\.)?Optional$/.test(name)) return this.parseType(args[0], ctx, self);
      if (/^(Swift\.)?Dictionary$/.test(name) && args.length === 2) return { dict: [this.parseType(args[0], ctx, self), this.parseType(args[1], ctx, self)] };
      t = name;
    }

    if (t === 'Self') return self ?? (ctx.entry && !ctx.entry.external ? { entry: ctx.entry } : null);
    if (/\.Type$/.test(t)) {
      const inner = this.parseType(t.slice(0, -5), ctx, self);
      return inner?.entry ? { meta: inner.entry } : null;
    }

    const entry = this.lookupType(t, ctx);
    return entry ? { entry } : /^[A-Z]/.test(t) ? { ext: t.split('.').pop() } : null;
  }

  /** Every type of the map named in a type as written (generic arguments, closures and tuples included). */
  typesIn(text, ctx) {
    if (!text) return [];
    const out = new Set();
    for (const match of text.replace(/@\w+(\([^)]*\))?/g, '').matchAll(/[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/g)) {
      if (KEYWORDS.has(match[0])) continue;
      const entry = this.lookupType(match[0], ctx);
      if (entry) out.add(entry);
    }

    return [...out];
  }

  /** A class's superclass of the map. */
  superclassOf(entry) {
    if (this.superCache.has(entry)) return this.superCache.get(entry);
    this.superCache.set(entry, null);
    let result = null;
    if (entry.kind === 'class' || entry.kind === 'actor') {
      const decl = entry.decls[0]?.decl;
      const first = decl?.bases[0];
      const found = first ? this.lookupType(first.name, this.ctxOf(entry)) : null;
      if (found && (found.kind === 'class' || found.kind === 'actor')) result = found;
    }

    this.superCache.set(entry, result);
    return result;
  }

  /** The protocols of the map a type conforms to, those of its extensions and the ones they inherit included. */
  protocolsOf(entry) {
    if (this.protocolCache.has(entry)) return this.protocolCache.get(entry);
    this.protocolCache.set(entry, []);
    const out = new Set();
    const ctx = this.ctxOf(entry);
    for (const place of [...entry.decls, ...entry.extensions]) {
      for (const base of place.decl.bases) {
        const found = this.lookupType(base.name, { ...ctx, file: place.file });
        if (found?.kind === 'protocol') {
          out.add(found);
          for (const inherited of this.protocolsOf(found)) out.add(inherited);
        }
      }
    }

    const result = [...out];
    this.protocolCache.set(entry, result);
    return result;
  }

  ctxOf(entry) {
    return { entry, project: entry.project, file: entry.decls[0]?.file ?? entry.extensions[0]?.file ?? null };
  }

  /** Members of a name: the type's own (its extensions'), its superclasses', then its protocols' (defaults too). */
  membersNamed(entry, name) {
    const out = [];
    const seen = new Set();
    const add = (e) => {
      if (!e || seen.has(e)) return;
      seen.add(e);
      for (const m of e.members) if (m.decl.name === name) out.push(m);
    };
    for (let e = entry, i = 0; e && i < 32; e = this.superclassOf(e), i++) add(e);
    for (let e = entry, i = 0; e && i < 32; e = this.superclassOf(e), i++) for (const p of this.protocolsOf(e)) add(p);
    return out;
  }

  /** Members of a name a target adds to a type from outside (extension String { … }) that a context can see. */
  outsideMembers(typeName, name, project) {
    const out = [];
    for (const p of this.visible(project)) for (const entry of this.outside.get(p.id)?.get(typeName) ?? []) for (const m of entry.members) if (m.decl.name === name) out.push(m);
    return out;
  }

  /** The type of a property, field or global: declared, or what its initializer calls. */
  typeOfMember(member) {
    if (this.memberTypes.has(member)) return this.memberTypes.get(member);
    this.memberTypes.set(member, null);
    const decl = member.decl;
    const ctx = member.holder ? { entry: null, project: member.holder.file.project, file: member.holder.file } : this.ctxOf(member.entry);
    let type = null;
    if (decl.type) type = this.parseType(decl.type, ctx);
    else if (decl.kind === 'property' && decl.name === 'subscript' && decl.returns) type = this.parseType(decl.returns, ctx);
    else if (decl.init?.call) {
      const entry = this.lookupType(decl.init.call, ctx);
      type = entry ? { entry } : { ext: decl.init.call };
    } else if (decl.init?.literal) type = { ext: decl.init.literal };
    else if (decl.initE) {
      // `let AF = Session.default`, `static let shared = Manager.make()`: the type of the expression.
      const owner = member.entry && !member.entry.external ? member.entry : null;
      type = this.typeOf(decl.initE, { owner, project: ctx.project, ctx, locals: {}, cache: new Map(), resolving: new Set() });
    }
    this.memberTypes.set(member, type);
    return type;
  }

  /** What a call of a member gives: the type for an initializer, else its return type (`Self`: the receiver's). */
  returnOf(member, receiver) {
    const decl = member.decl;
    if (decl.kind === 'constructor') return member.entry && !member.entry.external ? { entry: member.entry } : receiver;
    if (!decl.returns) return null;
    const ctx = member.holder ? { entry: null, project: member.holder.file.project, file: member.holder.file } : this.ctxOf(member.entry);
    return this.parseType(decl.returns, ctx, receiver?.entry ? receiver : null);
  }

  // ------------------------------------------------------------------------------------------- expressions

  /** The type of an expression in a body's scope. */
  typeOf(e, scope, depth = 0) {
    if (!e || depth > 24) return null;
    switch (e[0]) {
      case 'v': {
        const key = e[1];
        if (scope.resolving.has(key)) return null;
        if (scope.cache.has(key)) return scope.cache.get(key);
        scope.resolving.add(key);
        const type = this.typeOf(scope.locals[key], scope, depth + 1);
        scope.resolving.delete(key);
        scope.cache.set(key, type);
        return type;
      }

      case 'n': {
        const name = e[1];
        if (scope.owner) {
          const member = this.membersNamed(scope.owner, name).find((m) => isVariable(m));
          if (member) return this.typeOfMember(member);
        }

        const global = this.globalNamed(name, scope.project);
        if (global) return this.typeOfMember(global);
        const entry = this.lookupType(name, scope.ctx);
        if (entry) return { meta: entry };
        return /^[A-Z]/.test(name) ? { metaExt: name } : null;
      }

      case 'self':
        if (!scope.owner) return null;
        return scope.owner.external ? { ext: scope.owner.name } : { entry: scope.owner };
      case 'super': {
        const parent = scope.owner ? this.superclassOf(scope.owner) : null;
        return parent ? { entry: parent } : null;
      }

      case 'm':
        return this.memberType(this.typeOf(e[1], scope, depth + 1), e[2], scope);
      case 'c': {
        const call = this.resolveCall(e, scope, depth);
        if (call.member) return this.returnOf(call.member, call.receiver);
        if (call.type) return { entry: call.type };
        // Array methods that keep the array or give an element.
        const callee = e[1];
        if (callee[0] === 'm') {
          const receiver = this.typeOf(callee[1], scope, depth + 1);
          if (receiver?.array && SEQUENCE_SAME.has(callee[2])) return receiver;
          if (receiver?.array && SEQUENCE_ELEMENT.has(callee[2])) return receiver.array;
        }

        return null;
      }

      case 't':
        return this.parseType(e[1], scope.ctx);
      case 'E':
        return { meta: e[1] };
      case 'T': {
        const t = this.parseType(e[1], scope.ctx);
        return t?.entry ? { meta: t.entry } : t?.ext ? { metaExt: t.ext } : null;
      }
      case 'l':
        return { ext: e[1] };
      case 'el': {
        const t = this.typeOf(e[1], scope, depth + 1);
        return t?.array ?? null;
      }

      case 'sub': {
        const t = this.typeOf(e[1], scope, depth + 1);
        if (t?.array) return t.array;
        if (t?.dict) return t.dict[1];
        if (t?.entry) {
          const subscript = this.membersNamed(t.entry, 'subscript')[0];
          if (subscript) return this.typeOfMember(subscript);
        }

        return null;
      }

      case 'arr': {
        const element = this.typeOf(e[1], scope, depth + 1);
        return element ? { array: element } : null;
      }

      default:
        return null;
    }
  }

  /** The type of `receiver.name`. */
  memberType(receiver, name, scope) {
    if (!receiver) return null;
    if (receiver.meta) {
      const entry = receiver.meta;
      if (name === 'self') return { meta: entry };
      const nested = entry.nested.find((n) => n.name === name);
      if (nested) return { meta: nested };
      if (entry.cases.some((c) => c.name === name)) return { entry };
      const member = this.membersNamed(entry, name).find((m) => isVariable(m));
      return member ? this.typeOfMember(member) : null;
    }

    if (receiver.entry) {
      const member = this.membersNamed(receiver.entry, name).find((m) => isVariable(m));
      return member ? this.typeOfMember(member) : null;
    }

    if (receiver.array) return SEQUENCE_ELEMENT.has(name) ? receiver.array : null;
    if (receiver.ext) {
      const member = this.outsideMembers(receiver.ext, name, scope.project).find((m) => isVariable(m));
      return member ? this.typeOfMember(member) : null;
    }

    return null;
  }

  globalNamed(name, project) {
    for (const p of this.visible(project)) {
      const found = this.globals.get(p.id)?.get(name)?.[0];
      if (found) return found;
    }

    return null;
  }

  /**
   * What a call reaches: { member, type, receiver, viaType, enumCase }. `type` is the type an initializer call makes
   * (`Order(…)`, `Order.init(…)`); `viaType` a static member called on a type.
   */
  resolveCall(e, scope, depth = 0) {
    const [, fn, labels, args] = e;
    const typeOfArg = (a) => (a[0] === 'l' ? { ext: a[1], literal: true } : this.typeOf(a, scope, depth + 1));
    const fits = (type, parameter, candidate) => this.fits(type, parameter, candidate);
    const pick = (candidates) => choose(candidates, labels, args, typeOfArg, fits);
    const pickInit = (entry) => chooseInit(entry, labels, args, typeOfArg, fits);
    if (fn[0] === 'v') return {}; // a closure held in a local
    if (fn[0] === 'n') {
      const name = fn[1];
      if (scope.owner) {
        const member = pick(this.membersNamed(scope.owner, name).filter(isCallable));
        if (member) return { member, receiver: scope.owner.external ? null : { entry: scope.owner } };
      }

      const type = this.lookupType(name, scope.ctx);
      if (type) return { type, member: pickInit(type), receiver: { entry: type } };
      const functions = [];
      for (const p of this.visible(scope.project)) functions.push(...(this.functions.get(p.id)?.get(name) ?? []));
      return { member: pick(functions) };
    }

    if (fn[0] === 'm') {
      const name = fn[2];
      const target = fn[1];
      if (name === 'init' && (target[0] === 'self' || target[0] === 'super')) {
        const owner = target[0] === 'self' ? scope.owner : scope.owner && this.superclassOf(scope.owner);
        return owner && !owner.external ? { member: pickInit(owner), delegated: true } : {};
      }

      const receiver = this.typeOf(target, scope, depth + 1);
      if (receiver?.meta) {
        const entry = receiver.meta;
        if (name === 'init') return { type: entry, member: pickInit(entry), receiver: { entry } };
        const nested = entry.nested.find((n) => n.name === name);
        if (nested) return { type: nested, member: pickInit(nested), receiver: { entry: nested } };
        if (entry.cases.some((c) => c.name === name)) return { enumCase: entry };
        return { member: pick(this.membersNamed(entry, name).filter(isCallable)), receiver, viaType: entry };
      }

      if (receiver?.entry) return { member: pick(this.membersNamed(receiver.entry, name).filter(isCallable)), receiver };
      if (receiver?.ext) return { member: pick(this.outsideMembers(receiver.ext, name, scope.project).filter(isCallable)), receiver };
      if (receiver?.metaExt) return { member: pick(this.outsideMembers(receiver.metaExt, name, scope.project).filter(isCallable)), receiver };
      return { unknownReceiver: !receiver };
    }

    return {};
  }

  /**
   * Whether an argument of a known type can go to a parameter, for telling overloads apart: false only when the map
   * shows it cannot (a type of the map that is not the parameter's type nor conforms to it, a type from outside the
   * map that no extension makes conform to a protocol of the map, two different concrete types).
   */
  fits(type, parameter, candidate) {
    const ctx = candidate.holder ? { entry: null, project: candidate.holder.file.project, file: candidate.holder.file } : this.ctxOf(candidate.entry);
    const target = this.parseType(parameter, ctx);
    if (!target || target.array || target.dict || type.array || type.dict) return Boolean(target?.array) === Boolean(type.array) || !target || (!type.array && !type.dict && !type.entry && !type.ext);
    if (target.entry) {
      const wanted = target.entry;
      if (type.entry) {
        if (type.entry === wanted) return true;
        if (wanted.kind === 'protocol') return this.protocolsOf(type.entry).includes(wanted);
        for (let e = this.superclassOf(type.entry), i = 0; e && i < 32; e = this.superclassOf(e), i++) if (e === wanted) return true;
        return false;
      }

      if (type.ext) {
        if (wanted.kind !== 'protocol') return false;
        for (const p of this.model.projects) for (const ext of this.outside.get(p.id)?.get(type.ext) ?? []) {
          if (ext.extensions.some((x) => x.decl.bases.some((b) => this.lookupType(b.name, this.ctxOf(ext)) === wanted))) return true;
        }

        return false;
      }

      return true;
    }

    return argumentFits(type, parameter);
  }

  // ------------------------------------------------------------------------------------------ declarations

  /** Edges the declarations alone give: inheritance, conformance, overrides, and the types members name. */
  declarations() {
    for (const table of this.model.types.values()) {
      for (const entry of table.values()) {
        if (!entry.id) continue;
        const ctx = this.ctxOf(entry);
        if (entry.external) {
          // An extension of a type of another target of the map extends it.
          const extended = this.lookupType(entry.name, { entry: null, project: entry.project, file: ctx.file });
          if (extended && extended !== entry) this.edge(entry.id, extended.id, 'extends');
        }

        const parent = this.superclassOf(entry);
        if (parent) this.edge(entry.id, parent.id, 'inherits');
        for (const place of [...entry.decls, ...entry.extensions]) {
          for (const base of place.decl.bases) {
            const found = this.lookupType(base.name, { ...ctx, file: place.file });
            if (!found || found === parent) continue;
            if (found.kind === 'protocol') this.edge(entry.id, found.id, entry.kind === 'protocol' ? 'inherits' : 'implements');
          }

          for (const name of constraintNames(place.decl)) {
            const found = this.lookupType(name, { ...ctx, file: place.file });
            if (found) this.edge(entry.id, found.id, 'uses');
          }

          for (const attribute of place.decl.attributes) {
            const found = this.lookupType(attribute, { ...ctx, file: place.file });
            if (found) this.edge(entry.id, found.id, 'decoratedWith');
          }
        }

        this.implementations(entry);
        for (const member of entry.members) this.memberDeclaration(member, ctx);
      }
    }

    for (const holder of this.model.holders.values()) {
      const ctx = { entry: null, project: holder.file.project, file: holder.file };
      for (const member of holder.members) this.memberDeclaration(member, ctx);
    }
  }

  /** A type's members that fulfil its protocols' requirements implement them; an override overrides. */
  implementations(entry) {
    if (entry.kind === 'protocol') return;
    for (const protocol of this.protocolsOf(entry)) {
      for (const requirement of protocol.members) {
        if (requirement.extension) continue; // a default of a protocol extension, not a requirement
        // An extension of a type from outside (`extension Int: Printable`) fulfils them with its own members.
        const candidates = entry.external ? entry.members.filter((m) => m.decl.name === requirement.decl.name) : this.membersNamed(entry, requirement.decl.name);
        const own = candidates.find((m) => m.entry !== protocol && m.entry.kind !== 'protocol' && sameShape(m.decl, requirement.decl));
        if (own?.id && requirement.id) this.edge(own.id, requirement.id, 'implements');
      }
    }

    if (entry.external) return;

    const parent = this.superclassOf(entry);
    if (!parent) return;
    for (const member of entry.members) {
      if (!member.decl.modifiers.includes('override') || !member.id) continue;
      const base = this.membersNamed(parent, member.decl.name).find((m) => m.entry.kind !== 'protocol' && sameShape(m.decl, member.decl));
      if (base?.id) this.edge(member.id, base.id, 'overrides');
    }
  }

  memberDeclaration(member, ctx) {
    const decl = member.decl;
    const id = member.id;
    if (!id) return;
    const isVar = isVariable(member);
    if (isVar || decl.kind === 'typeAlias') {
      for (const entry of this.typesIn(decl.type, ctx)) this.edge(id, entry.id, 'holds');
      if (!decl.type && decl.init?.call) {
        const entry = this.lookupType(decl.init.call, ctx);
        if (entry) this.edge(id, entry.id, 'holds');
      }
    }

    if (decl.returns && decl.name !== 'subscript') for (const entry of this.typesIn(decl.returns, ctx)) this.edge(id, entry.id, 'returns');
    else if (decl.returns) for (const entry of this.typesIn(decl.returns, ctx)) this.edge(id, entry.id, 'holds');
    for (const param of decl.params ?? []) {
      for (const entry of this.typesIn(param.type, ctx)) {
        this.edge(id, entry.id, 'accepts');
        // An initializer's parameters are what the type needs: its dependencies.
        if (decl.kind === 'constructor' && ctx.entry?.id && !ctx.entry.external) this.edge(ctx.entry.id, entry.id, 'injects');
      }
    }

    for (const attribute of decl.attributes ?? []) {
      const entry = this.lookupType(attribute, ctx);
      if (entry) this.edge(id, entry.id, 'decoratedWith');
    }
    for (const name of constraintNames(decl)) {
      const entry = this.lookupType(name, ctx);
      if (entry) this.edge(id, entry.id, 'uses');
    }
  }

  // ------------------------------------------------------------------------------------------------ bodies

  bodies() {
    for (const table of this.model.types.values()) {
      for (const entry of table.values()) {
        if (!entry.id) continue;
        for (const member of entry.members) this.body(member, entry, this.ctxOf(entry));
      }
    }

    for (const holder of this.model.holders.values()) {
      const ctx = { entry: null, project: holder.file.project, file: holder.file };
      for (const member of holder.members) this.body(member, null, ctx);
    }
  }

  body(member, owner, ctx) {
    if (!member.id) return;
    for (const place of member.places) {
      const decl = place.member;
      if (!decl.refs?.length) continue;
      const scope = { owner, project: ctx.project, ctx: { ...ctx, file: place.file }, locals: decl.locals ?? {}, cache: new Map(), resolving: new Set() };
      for (const ref of decl.refs) this.reference(member.id, ref, scope);
    }
  }

  reference(source, ref, scope) {
    switch (ref.ev) {
      case 'call':
      case 'selector': {
        const fn = ref.e[1];
        if (fn[0] === 'i') {
          this.counts.implicit++;
          return;
        }

        this.counts.calls++;
        const call = this.resolveCall(ref.e, scope);
        const name = fn[0] === 'm' ? fn[2] : fn[0] === 'n' ? fn[1] : null;
        // A call on a type from outside the map (DispatchQueue.sync, an array's append) is not one of the map's code.
        const outside = call.receiver && !call.receiver.entry && !call.receiver.meta && !call.member;
        const ours = name !== null && this.declared.has(name) && !outside;
        if (ours) this.counts.ours++;
        if (call.member?.id || call.type?.id || call.enumCase) {
          this.counts.resolved++;
          if (ours) this.counts.oursResolved++;
        } else this.miss(fn, call);
        if (call.member?.id) this.edge(source, call.member.id, 'calls', ref.line);
        if (call.type?.id && !call.delegated) this.edge(source, call.type.id, 'instantiates', ref.line);
        // A type named by itself (Order.make(), Failure.bad(…)) is a use already, from its name.
        const named = fn[0] === 'm' && fn[1][0] === 'n';
        if (call.viaType?.id && !named) this.edge(source, call.viaType.id, 'uses', ref.line);
        if (call.enumCase?.id && !named) this.edge(source, call.enumCase.id, 'uses', ref.line);
        if (call.member) this.implicitArguments(source, ref, call.member, scope);
        return;
      }

      case 'access': {
        const e = ref.e;
        if (e[0] !== 'm') return;
        const receiver = this.typeOf(e[1], scope);
        const name = e[2];
        if (receiver?.meta) {
          const entry = receiver.meta;
          const member = this.membersNamed(entry, name).find((m) => isVariable(m));
          if (member?.id) this.edge(source, member.id, 'accesses', ref.line);
          if (entry.id && e[1][0] !== 'n') this.edge(source, entry.id, 'uses', ref.line);
          return;
        }

        const members = receiver?.entry ? this.membersNamed(receiver.entry, name) : receiver?.ext ? this.outsideMembers(receiver.ext, name, scope.project) : [];
        const member = members.find((m) => isVariable(m)) ?? (members.length === 1 ? members[0] : null);
        if (member?.id) this.edge(source, member.id, isVariable(member) ? 'accesses' : 'calls', ref.line);
        else if (!receiver || receiver.ext) this.untyped.add(name);
        return;
      }

      case 'name': {
        const name = ref.name;
        if (scope.owner) {
          const members = this.membersNamed(scope.owner, name);
          if (members.length) {
            const member = members.find((m) => isVariable(m)) ?? members[0];
            if (member.id) this.edge(source, member.id, isVariable(member) ? 'accesses' : 'calls', ref.line);
            return;
          }
        }

        const global = this.globalNamed(name, scope.project);
        if (global?.id) {
          this.edge(source, global.id, 'accesses', ref.line);
          return;
        }

        const entry = this.lookupType(name, scope.ctx);
        if (entry?.id) {
          this.edge(source, entry.id, 'uses', ref.line);
          return;
        }

        for (const p of this.visible(scope.project)) {
          const fn = this.functions.get(p.id)?.get(name);
          if (fn?.length === 1 && fn[0].id) {
            this.edge(source, fn[0].id, 'calls', ref.line);
            return;
          }
        }

        return;
      }

      case 'type':
        for (const entry of this.typesIn(ref.text, scope.ctx)) this.edge(source, entry.id, 'uses', ref.line);
        return;
      case 'catch':
        for (const entry of this.typesIn(ref.text, scope.ctx)) this.edge(source, entry.id, 'catches', ref.line);
        return;
      case 'throw': {
        const e = ref.e;
        let type = null;
        if (e[0] === 'c') {
          // Its calls come from the call reference of the same expression; here only what it throws.
          const call = this.resolveCall(e, scope);
          type = call.type ?? call.enumCase ?? (call.member ? this.returnOf(call.member, call.receiver)?.entry : null) ?? null;
        } else {
          const t = this.typeOf(e, scope);
          type = t?.entry ?? t?.meta ?? null;
        }

        if (type?.id) this.edge(source, type.id, 'throws', ref.line);
        return;
      }

      default:
    }
  }

  /** `pay(.init(amount: 1))`, `charge(.card)`: an implicit member of the type the parameter expects. */
  implicitArguments(source, ref, member, scope) {
    const [, , labels, args] = ref.e;
    const params = member.decl.params ?? [];
    const binding = bindArguments(params, labels) ?? [];
    for (let i = 0; i < (args ?? []).length; i++) {
      const param = params[binding[i]];
      if (!param?.type || !args[i]) continue;
      // [.init(…)] for a parameter of an array type: the element's type.
      const inArray = args[i][0] === 'arr';
      const arg = inArray ? args[i][1] : args[i];
      const implicit = arg[0] === 'i' ? arg : arg[0] === 'c' && arg[1][0] === 'i' ? arg[1] : null;
      if (!implicit) continue;
      const ctx = member.holder ? { entry: null, project: member.holder.file.project, file: member.holder.file } : this.ctxOf(member.entry);
      const declared = this.parseType(param.type, ctx);
      const expected = inArray ? declared?.array : declared;
      const entry = expected?.entry;
      if (!entry?.id) continue;
      if (arg[0] === 'c') {
        this.counts.implicit--;
        const call = this.resolveCall(['c', ['m', ['E', entry], implicit[1]], arg[2], arg[3]], scope);
        if (call.member?.id) this.edge(source, call.member.id, 'calls', ref.line);
        if (call.type?.id) this.edge(source, call.type.id, 'instantiates', ref.line);
        if (call.enumCase?.id || call.viaType?.id) this.edge(source, entry.id, 'uses', ref.line);
      } else {
        const property = this.membersNamed(entry, implicit[1]).find((m) => isVariable(m));
        if (property?.id) this.edge(source, property.id, 'accesses', ref.line);
        this.edge(source, entry.id, 'uses', ref.line);
      }
    }
  }

  miss(fn, call) {
    const name = fn[0] === 'm' ? fn[2] : fn[0] === 'n' ? fn[1] : null;
    if (!name) return;
    this.unresolved.set(name, (this.unresolved.get(name) ?? 0) + 1);
    if (fn[0] === 'm' && (call.unknownReceiver || call.receiver?.ext || call.receiver?.metaExt)) this.untyped.add(name);
  }

  /** Private members of a name used on something of unknown type may be what it calls: not reported unused. */
  tagMaybeUsed() {
    const each = (member) => {
      if (!member.id || !this.untyped.has(member.decl.name)) return;
      const node = this.graph.get(member.id);
      if (!node || node.accessibility !== 'private') return;
      node.tags = [...new Set([...(node.tags ?? []), 'maybe-used'])].sort();
    };
    for (const table of this.model.types.values()) for (const entry of table.values()) entry.members.forEach(each);
    for (const holder of this.model.holders.values()) holder.members.forEach(each);
  }
}

// --------------------------------------------------------------------------------------------- helpers

function isVariable(member) {
  const kind = member.decl.kind;
  return (kind === 'field' || kind === 'property' || kind === 'variable') && member.decl.name !== 'subscript';
}

function isCallable(member) {
  const kind = member.decl.kind;
  return kind === 'method' || kind === 'function' || kind === 'constructor';
}

/** Two declarations of one member: a requirement and what fulfils it, a method and its override. */
function sameShape(a, b) {
  if (isVariable({ decl: a }) || isVariable({ decl: b })) return isVariable({ decl: a }) === isVariable({ decl: b }) && a.name === b.name;
  if (a.kind !== b.kind && !(a.kind === 'method' && b.kind === 'method')) return false;
  return (a.labels ?? []).join(':') === (b.labels ?? []).join(':');
}

/** The initializer of a type a call with these labels reaches. */
function chooseInit(entry, labels, args, typeOfArg, fits) {
  const inits = entry.members.filter((m) => m.decl.kind === 'constructor');
  return inits.length ? choose(inits, labels, args, typeOfArg, fits) : null;
}

/**
 * The one candidate whose parameters take these labels; of the same shape, the first (a type's own member before its
 * superclass's and its protocols': an override, an implementation); then by arity, then by the arguments' types.
 */
function choose(candidates, labels, args, typeOfArg, accepts = (t, p) => argumentFits(t, p)) {
  if (!candidates.length) return null;
  const seen = new Set();
  const fitting = candidates.filter((c) => {
    if (!bindArguments(c.decl.params ?? [], labels)) return false;
    const shape = `${c.decl.kind === 'constructor' ? 'init' : 'fn'}|${(c.decl.labels ?? []).join(':')}|${(c.decl.params ?? []).map((p) => compact(p.type)).join(',')}`;
    if (seen.has(shape)) return false;
    seen.add(shape);
    return true;
  });
  if (fitting.length <= 1) return fitting[0] ?? null;
  const exact = fitting.filter((c) => (c.decl.params ?? []).length === labels.length);
  if (exact.length === 1) return exact[0];
  const pool = exact.length ? exact : fitting;
  const types = (args ?? []).map((a) => (a && typeOfArg ? typeOfArg(a) : null));
  const typed = pool.filter((c) => {
    // Each argument against the parameter it goes to (not the one at its index: defaults may be left out).
    const binding = bindArguments(c.decl.params ?? [], labels) ?? [];
    return types.every((t, i) => {
      const param = c.decl.params[binding[i]];
      return !t || !param?.type || accepts(t, param.type, c);
    });
  });
  if (typed.length === 1) return typed[0];
  // A requirement and its default, or a method and the protocol's: the same member to the map's eyes.
  const own = (typed.length ? typed : pool).filter((c) => c.entry?.kind !== 'protocol');
  return own.length === 1 ? own[0] : null;
}

const LITERALS = { String: /^(String|Substring|Character|StaticString)$|StringProtocol/, Int: /^(U?Int\d*|Double|Float\d*|CGFloat|Decimal|TimeInterval)$/, Double: /^(Double|Float\d*|CGFloat|Decimal|TimeInterval)$/, Bool: /^Bool$/ };
const CONCRETE = /^(String|Substring|Character|U?Int\d*|Double|Float\d*|CGFloat|Decimal|Bool|Data|Date|URL|UUID)$/;

/** Whether an argument of a known type can go to a parameter: false only when both are clearly different types. */
function argumentFits(type, parameter) {
  const name = parameter.replace(/@\w+\s*/g, '').replace(/\b(inout|some|any)\s+/g, '').replace(/[?!]+$/, '').trim();
  if (type.ext && LITERALS[type.ext] && (CONCRETE.test(name) || type.literal)) return LITERALS[type.ext].test(name);
  const own = type.entry?.name ?? type.ext;
  if (!own || /[<[(]/.test(name)) return true;
  const last = name.split('.').pop();
  if (last === own) return true;
  // A concrete type against another concrete one: no; anything else (protocols, generics): maybe.
  return !(CONCRETE.test(last) || (type.entry && CONCRETE.test(own)));
}

function compact(type) {
  return (type ?? '').replace(/\s+/g, '');
}

/**
 * The parameter each argument of a call goes to, or null when the parameters do not take its labels: in order,
 * parameters with defaults may be left out, a variadic one takes the unlabelled arguments after it. Trailing closures
 * ('?') come last and fill the parameters after the labelled ones, those without a default first.
 */
function bindArguments(params, labels) {
  const trailing = labels.filter((l) => l === '?').length;
  const explicit = labels.slice(0, labels.length - trailing);
  const binding = [];
  let i = 0;
  for (let j = 0; j < explicit.length; ) {
    const p = params[i];
    if (!p) return null;
    if (p.label === explicit[j] || explicit[j] === '?') {
      binding.push(i);
      j++;
      if (p.variadic) while (j < explicit.length && explicit[j] === '_') {
        binding.push(i);
        j++;
      }

      i++;
      continue;
    }

    if (p.optional) {
      i++;
      continue;
    }

    return null;
  }

  const rest = params.map((p, k) => k).slice(i);
  const required = rest.filter((k) => !params[k].optional);
  if (trailing ? required.length > trailing || trailing > rest.length : required.length) return null;
  // The trailing closures: the parameters without a default, then the others in order.
  const filled = [...required, ...rest.filter((k) => params[k].optional)].slice(0, trailing).sort((a, b) => a - b);
  return [...binding, ...filled];
}

/** The types a declaration's generic constraints name (`<T: Codable>`, `where Element: Order`). */
function constraintNames(decl) {
  const text = [decl.generics, decl.where].filter(Boolean).join(' ');
  if (!text) return [];
  const params = new Set([...(decl.generics ?? '').matchAll(/[<,]\s*(\w+)/g)].map((m) => m[1]));
  return [...text.matchAll(/[:=]\s*([A-Z][\w.]*)/g)].map((m) => m[1]).filter((n) => !params.has(n) && !KEYWORDS.has(n));
}

/** `a, b` at the top level of a type (not inside <>, [], ()). */
function splitTop(text, separator) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '<' || c === '[' || c === '(') depth++;
    else if (c === '>' || c === ']' || c === ')') depth--;
    else if (c === separator && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }

  out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

function baseName(text) {
  return text.replace(/<.*$/, '').replace(/[?!]+$/, '').trim();
}
