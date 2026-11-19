/**
 * What frameworks say about the code, from its own declarations and calls (nothing is run):
 * - entry points: `@main` types and their `main()`, app and scene delegates, SwiftUI's App;
 * - tests: XCTestCase subclasses with their test… methods and setUp / tearDown, Swift Testing's @Test and @Suite,
 *   PreviewProvider and #Preview;
 * - SwiftUI: views are components; @Environment and @EnvironmentObject properties are what the view needs (injects);
 * - UIKit / AppKit: view controllers, views and cells are components; @IBAction methods are handlers; @IBOutlet and
 *   @objc members may be used by Interface Builder and the Objective-C runtime;
 * - Vapor: `app.get("orders", ":id") { … }`, `routes.grouped(…)`, `group(…) { … }` and `use: handler` are routes with
 *   their full path; a RouteCollection's boot(routes:) is an entry point; middleware; Fluent models are entities.
 */

const UI_COMPONENT = /^(UI|NS)\w*(ViewController|View|Cell|Window|Button|Control|NavigationController|TabBarController|SplitViewController|WindowController)$/;
/** Attributes the runtime, the linker or C reach a member by: it may be used though nothing in Swift calls it. */
const RUNTIME = new Set(['IBOutlet', 'IBInspectable', 'GKInspectable', 'objc', 'NSManaged', '_cdecl', '_silgen_name', '_dynamicReplacement', '_spi', 'dynamicCallable', 'dynamicMemberLookup']);
/** The types Vapor registers routes on. */
const BUILDERS = new Set(['Application', 'RoutesBuilder', 'Routes', 'any RoutesBuilder', 'some RoutesBuilder']);
const DELEGATES = new Set(['UIApplicationDelegate', 'NSApplicationDelegate', 'UIWindowSceneDelegate', 'UISceneDelegate', 'WKApplicationDelegate', 'WKExtensionDelegate']);
const TEST_LIFECYCLE = new Set(['setUp', 'tearDown', 'setUpWithError', 'tearDownWithError']);
const HTTP = new Set(['get', 'post', 'put', 'patch', 'delete', 'on', 'webSocket']);
const ENVIRONMENT = new Set(['Environment', 'EnvironmentObject', 'ObservedObject', 'Bindable']);

export function applyFrameworks(model, resolver, graph) {
  const tag = (id, ...tags) => {
    const node = id && graph.get(id);
    if (node) node.tags = [...new Set([...(node.tags ?? []), ...tags])].sort();
    return node;
  };

  for (const table of model.types.values()) {
    for (const entry of table.values()) {
      if (!entry.id || entry.external) continue;
      const bases = baseNames(entry, resolver);
      const attributes = new Set([...entry.decls, ...entry.extensions].flatMap((d) => d.decl.attributes));
      const ctx = resolver.ctxOf(entry);

      // Entry points.
      if (attributes.has('main') || attributes.has('UIApplicationMain') || attributes.has('NSApplicationMain')) {
        tag(entry.id, 'entrypoint');
        for (const m of entry.members) if (m.decl.name === 'main' && m.decl.modifiers.includes('static')) tag(m.id, 'entrypoint');
      }

      if ([...bases].some((b) => DELEGATES.has(b)) || bases.has('App') && imports(entry, 'SwiftUI')) tag(entry.id, 'entrypoint');

      // Tests.
      const xctest = bases.has('XCTestCase');
      if (xctest || attributes.has('Suite') || bases.has('PreviewProvider')) tag(entry.id, 'test');
      for (const m of entry.members) {
        const decl = m.decl;
        const testing = decl.attributes?.includes('Test');
        // XCTest runs instance methods named test… without parameters.
        const runs = xctest && decl.kind === 'method' && !decl.modifiers.includes('static') && ((/^test/.test(decl.name) && !(decl.params ?? []).length) || TEST_LIFECYCLE.has(decl.name));
        if (testing || runs) {
          tag(m.id, 'test');
          tag(entry.id, 'test');
        }
      }

      // UI.
      if ((bases.has('View') && imports(entry, 'SwiftUI')) || [...bases].some((b) => UI_COMPONENT.test(b))) tag(entry.id, 'component');
      for (const m of entry.members) {
        const attrs = m.decl.attributes ?? [];
        if (attrs.includes('IBAction') || attrs.includes('IBSegueAction')) tag(m.id, 'handler');
        // An @objc extension makes its members @objc.
        if (attrs.some((a) => RUNTIME.has(a)) || m.extension?.attributes?.includes('objc')) tag(m.id, 'maybe-used');
        // @Environment(Store.self) var store, @EnvironmentObject var cart: Cart: what the view is given.
        const environment = attrs.find((a) => ENVIRONMENT.has(a));
        if (environment) {
          const type = m.decl.type ?? /^([\w.]+)\.self$/.exec(m.decl.attributeArguments?.[environment] ?? '')?.[1];
          for (const needed of resolver.typesIn(type, ctx)) resolver.edge(entry.id, needed.id, 'injects');
        }
      }

      // Vapor and Fluent.
      if (bases.has('Middleware') || bases.has('AsyncMiddleware')) tag(entry.id, 'middleware');
      if (bases.has('RouteCollection')) {
        tag(entry.id, 'controller');
        for (const m of entry.members) if (m.decl.name === 'boot' && (m.decl.labels ?? []).join(':') === 'routes') tag(m.id, 'entrypoint');
      }

      if (bases.has('Model') && (imports(entry, 'Fluent') || imports(entry, 'FluentKit'))) tag(entry.id, 'entity');
    }
  }

  for (const holder of model.holders.values()) {
    for (const m of holder.members) {
      if (m.decl.attributes?.includes('Test')) tag(m.id, 'test');
      if (m.decl.attributes?.some((a) => RUNTIME.has(a))) tag(m.id, 'maybe-used');
    }
  }

  routes(model, resolver, graph, tag);
}

/** Every base of a type: its own and its extensions', and through the map's classes and protocols, theirs. */
function baseNames(entry, resolver) {
  const names = new Set();
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length) {
    const current = queue.shift();
    const ctx = resolver.ctxOf(current);
    for (const place of [...current.decls, ...current.extensions]) {
      for (const base of place.decl.bases) {
        names.add(base.name.split('.').pop());
        const found = resolver.lookupType(base.name, { ...ctx, file: place.file });
        if (found && !seen.has(found)) {
          seen.add(found);
          queue.push(found);
        }
      }
    }
  }

  return names;
}

function imports(entry, module) {
  return [...entry.decls, ...entry.extensions].some((d) => d.file.facts?.imports?.includes(module)) || !entry.decls.length;
}

// --------------------------------------------------------------------------------------------- Vapor

/**
 * Routes of files that import Vapor: get / post / … called on a routes builder (an Application or RoutesBuilder,
 * `grouped(…)` of one, the builder of a `group(…) { v1 in … }`) with its unlabelled path components. A collection
 * registered under a group (`api.register(collection: Orders())`) gets that group's path. The handler `use: index`
 * is a route; a closure makes the function that registers it the route's entry point. Each gets `METHOD /path` at
 * the top of its doc.
 */
function routes(model, resolver, graph, tag) {
  const vapor = (place) => place.file.facts?.imports?.includes('Vapor');
  const members = [];
  for (const table of model.types.values()) for (const entry of table.values()) members.push(...entry.members);
  for (const holder of model.holders.values()) members.push(...holder.members);

  // Collections and the path they are registered under.
  const registered = new Map();
  for (const member of members) {
    for (const place of member.places) {
      if (!vapor(place)) continue;
      for (const ref of place.member.refs ?? []) {
        const [, fn, labels, args] = ref.ev === 'call' ? ref.e : [];
        if (!fn || fn[0] !== 'm' || fn[2] !== 'register' || labels[0] !== 'collection') continue;
        const scope = scopeOf(member, place, resolver);
        const prefix = pathOf(fn[1], place.member.locals ?? {}, 0, [], typer(scope, resolver));
        const made = args[0];
        const type = made && scope ? resolver.typeOf(made, scope) : null;
        if (prefix && type?.entry && !registered.has(type.entry)) registered.set(type.entry, prefix);
      }
    }
  }

  for (const member of members) {
    if (!member.id) continue;
    for (const place of member.places) {
      const decl = place.member;
      if (!decl.refs?.length || !vapor(place)) continue;
      const base = member.entry && member.decl.name === 'boot' ? registered.get(member.entry) ?? [] : [];
      const typed = typer(scopeOf(member, place, resolver), resolver);
      for (const ref of decl.refs) {
        if (ref.ev !== 'call') continue;
        const [, fn, labels, args] = ref.e;
        if (fn[0] !== 'm' || !HTTP.has(fn[2])) continue;
        const prefix = pathOf(fn[1], decl.locals ?? {}, 0, base, typed);
        if (prefix === null) continue; // not a routes builder: an HTTP client's get / post
        let method = fn[2].toUpperCase();
        const parts = [];
        let handler = null;
        let bad = false;
        args.forEach((arg, i) => {
          if (!arg) return;
          if (labels[i] === 'use') handler = arg;
          else if (fn[2] === 'on' && i === 0 && arg[0] === 'i') method = arg[1].toUpperCase();
          else if (labels[i] === '_') {
            const part = component(arg);
            if (part === undefined) bad = true;
            else if (part !== null) parts.push(part);
          }
        });
        if (bad || (!handler && !labels.includes('?'))) continue;
        const path = '/' + [...prefix, ...parts].filter(Boolean).join('/');
        const route = `${method === 'WEBSOCKET' ? 'WS' : method} ${path}`;
        const target = handler ? handlerOf(handler, member, place, resolver) : member;
        if (!target?.id) continue;
        const node = tag(target.id, 'route', 'entrypoint');
        if (node && !(node.doc ?? '').split('\n').includes(route)) node.doc = [route, ...(node.doc ? [node.doc] : [])].join('\n');
      }
    }
  }
}

/** A path component: "orders", ":id", "**", .catchall, .anything; undefined for a URL (an HTTP client's call). */
function component(arg) {
  if (arg[0] === 'l' && arg[1] === 'String' && typeof arg[2] === 'string') return /:\/\//.test(arg[2]) ? undefined : arg[2].replace(/^\/+|\/+$/g, '');
  if (arg[0] === 'i') return arg[1] === 'catchall' ? '**' : arg[1] === 'anything' ? '*' : `:${arg[1]}`;
  return null;
}

/**
 * The path a routes builder stands for, or null when it is not one: an Application or RoutesBuilder (`base`, the
 * path a collection is registered under, for those), and what grouped(…) and group(…) { builder in … } add to it.
 */
function pathOf(e, locals, depth, base, typed = () => null) {
  if (!e || depth > 16) return null;
  // Whatever the resolver types as a builder (`let app = try await Application.make()`, `withApp { app in … }`).
  if (BUILDERS.has(typed(e) ?? '')) return base;
  switch (e[0]) {
    case 'v':
      return pathOf(locals[e[1]], locals, depth + 1, base, typed);
    case 't':
      return BUILDERS.has(e[1].replace(/[?!]$/, '').trim()) ? base : null;
    case 'n':
      return e[1] === 'app' || e[1] === 'routes' ? base : null;
    case 'm':
      return e[1][0] === 'self' && (e[2] === 'app' || e[2] === 'routes') ? base : null;
    case 'c': {
      if (e[1][0] !== 'm' || (e[1][2] !== 'grouped' && e[1][2] !== 'group')) return null;
      const before = pathOf(e[1][1], locals, depth + 1, base, typed);
      const parts = (e[3] ?? []).map((a, i) => (a && (e[2][i] === '_') ? component(a) : null)).filter((p) => typeof p === 'string');
      return before === null ? null : [...before, ...parts];
    }

    case 'cl':
      return e[1][1][0] === 'm' && e[1][1][2] === 'group' ? pathOf(e[1], locals, depth + 1, base, typed) : null;
    default:
      return null;
  }
}

/** The name of an expression's type (a type from outside the map by its name), for telling a routes builder. */
function typer(scope, resolver) {
  return (e) => {
    if (!scope) return null;
    const type = resolver.typeOf(e, scope);
    return type?.ext ?? type?.entry?.name ?? null;
  };
}

/** The scope a member's body is resolved in, for typing an expression of it. */
function scopeOf(member, place, resolver) {
  const owner = member.entry && !member.entry.external ? member.entry : null;
  const project = member.entry?.project ?? member.holder?.file.project;
  if (!project) return null;
  const ctx = { entry: owner, project, file: place.file };
  return { owner, project, ctx, locals: place.member.locals ?? {}, cache: new Map(), resolving: new Set() };
}

/** `use: index` (a method of the type, or a function), `use: self.index`, `use: controller.index` (of its type). */
function handlerOf(e, member, place, resolver) {
  const name = e[0] === 'n' ? e[1] : e[0] === 'm' ? e[2] : null;
  if (!name) return null;
  const owner = member.entry && !member.entry.external ? member.entry : null;
  if (e[0] === 'm' && e[1][0] !== 'self') {
    const scope = scopeOf(member, place, resolver);
    const type = scope ? resolver.typeOf(e[1], scope) : null;
    const entry = type?.entry ?? type?.meta;
    return entry ? resolver.membersNamed(entry, name).find((m) => m.decl.kind === 'method') ?? null : null;
  }

  if (owner) {
    const found = resolver.membersNamed(owner, name).find((m) => m.decl.kind === 'method');
    if (found) return found;
  }

  const project = member.entry?.project ?? member.holder?.file.project;
  for (const p of project ? resolver.visible(project) : []) {
    const fn = resolver.functions.get(p.id)?.get(name)?.[0];
    if (fn) return fn;
  }

  return null;
}
