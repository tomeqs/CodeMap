import { addTag, decoratorsOf, importOf, property, stringOf } from './imports.mjs';
import { dependenciesOf, locationOf, providersOf, serviceOf } from './di.mjs';
import { declarationId } from '../extract/declarations.mjs';
import { memberId } from '../ids.mjs';

/**
 * Angular (decorators from @angular/core): components, directives, pipes, NgModules and services, and the
 * injectors: providedIn 'root' / 'platform' is an application singleton ('any': one per lazy module, scoped),
 * NgModule providers are singletons, component providers live with each component (scoped); components,
 * directives and pipes are created per use (transient). Dependencies come from constructors and inject().
 */
export function angular(ctx, sf, info, owners) {
  const { ts, graph } = ctx;
  const ngDecorators = (node) => decoratorsOf(ctx, node).filter((d) => d.module === '@angular/core');
  const file = graph.nodes.get(info.moduleId);

  for (const owner of owners) {
    if (owner.kind !== 'class' || !ts.isClassDeclaration(owner.node)) continue;
    const cls = owner.node;
    const node = graph.nodes.get(owner.id);
    const decorators = ngDecorators(cls);
    if (!decorators.length) continue;
    const by = Object.fromEntries(decorators.map((d) => [d.name, d]));
    const metadata = (by.Component ?? by.Directive ?? by.Pipe ?? by.NgModule ?? by.Injectable)?.args[0];
    const register = (entry, lifetime, kind = entry.kind) => ctx.di.registrations.push({
      service: entry.service,
      external: entry.external || undefined,
      implementation: entry.implementation,
      lifetime,
      kind,
      registeredIn: owner.id,
      location: locationOf(sf, info, entry.node),
      framework: 'angular',
    });

    if (by.Component || by.Directive || by.Pipe) {
      const role = by.Component ? 'component' : by.Directive ? 'directive' : 'pipe';
      addTag(node, role);
      addTag(file, role);
      register({ service: owner.id, kind: 'component', node: cls.name ?? cls }, 'transient', 'component');
      for (const list of ['providers', 'viewProviders']) for (const entry of providersOf(ctx, property(ts, metadata, list))) register(entry, 'scoped');
    }

    if (by.NgModule) {
      addTag(node, 'module');
      for (const entry of providersOf(ctx, property(ts, metadata, 'providers'))) register(entry, 'singleton');
    }

    if (by.Injectable) {
      addTag(node, 'service');
      const providedIn = stringOf(ts, property(ts, metadata, 'providedIn'));
      if (providedIn) register({ service: owner.id, kind: 'type', node: cls.name ?? cls }, providedIn === 'any' ? 'scoped' : 'singleton');
    }

    if (!by.NgModule) {
      for (const dependency of [...dependenciesOf(ctx, cls, ngDecorators), ...injectCalls(ctx, cls, owner.id)]) {
        ctx.di.dependencies.push({ ...dependency, framework: 'angular' });
      }
    }
  }

  // Standalone applications: the providers of bootstrapApplication(App, { providers }) and of ApplicationConfig
  // objects are root singletons.
  const registerRoot = (config, registeredIn) => {
    for (const entry of standaloneProviders(ctx, property(ts, config, 'providers'))) {
      ctx.di.registrations.push({
        service: entry.service,
        external: entry.external || undefined,
        implementation: entry.implementation,
        lifetime: 'singleton',
        kind: entry.kind,
        registeredIn,
        location: locationOf(sf, info, entry.node),
        framework: 'angular',
      });
    }
  };

  // bootstrapApplication(App) / platformBrowserDynamic().bootstrapModule(AppModule) start the application.
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const source = importOf(ctx, n.expression);
      const name = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : source?.name;
      const bootstrap = source?.module?.startsWith('@angular/') && name === 'bootstrapApplication';
      if (bootstrap || name === 'bootstrapModule') addTag(file, 'entrypoint');
      if (bootstrap && n.arguments[1] && ts.isObjectLiteralExpression(n.arguments[1])) registerRoot(n.arguments[1], ownerOf(n) ?? info.moduleId);
    }

    if (ts.isVariableDeclaration(n) && n.type && ts.isTypeReferenceNode(n.type) && n.initializer && ts.isObjectLiteralExpression(n.initializer)) {
      const type = importOf(ctx, n.type.typeName);
      if (type?.module?.startsWith('@angular/') && type.name === 'ApplicationConfig') registerRoot(n.initializer, declarationId(ctx, n) ?? info.moduleId);
    }

    ts.forEachChild(n, visit);
  };
  const ownerOf = (node) => {
    for (let current = node; current; current = current.parent) {
      const id = current.parent && ts.isSourceFile(current.parent) ? memberId(info.moduleId, '(top-level)') : declarationId(ctx, current);
      if (id && graph.nodes.has(id)) return id;
    }

    return null;
  };
  visit(sf);
}

/**
 * Providers of a standalone application: the usual entries, and `provideX(new T(…))` (an instance of T for the
 * container, as provideTanStackQuery(new QueryClient()) gives). Other provide…() calls are library setups.
 */
function standaloneProviders(ctx, list) {
  const { ts } = ctx;
  const entries = providersOf(ctx, list);
  for (const element of list && ts.isArrayLiteralExpression(list) ? list.elements : []) {
    if (!ts.isCallExpression(element)) continue;
    for (const argument of element.arguments) {
      if (!ts.isNewExpression(argument)) continue;
      const service = serviceOf(ctx, argument.expression);
      if (service) entries.push({ ...service, implementation: service.external ? undefined : service.service, kind: 'instance', node: argument });
    }
  }

  return entries;
}

/** `private http = inject(HttpClient)` and inject() in the constructor. */
function injectCalls(ctx, cls, consumer) {
  const { ts } = ctx;
  const result = [];
  const visit = (n) => {
    if (ts.isCallExpression(n) && importOf(ctx, n.expression)?.module === '@angular/core' && importOf(ctx, n.expression)?.name === 'inject') {
      const service = serviceOf(ctx, n.arguments[0]);
      const optional = ts.isObjectLiteralExpression(n.arguments[1] ?? {}) && property(ts, n.arguments[1], 'optional')?.kind === ts.SyntaxKind.TrueKeyword;
      if (service) result.push({ consumer, ...service, optional: optional || undefined });
    }

    ts.forEachChild(n, visit);
  };
  for (const member of cls.members) {
    if (ts.isPropertyDeclaration(member) && member.initializer) visit(member.initializer);
    if (ts.isConstructorDeclaration(member) && member.body) visit(member.body);
  }

  return result;
}

