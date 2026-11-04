import { declarationId } from '../extract/declarations.mjs';
import { addTag, decoratorsOf, property, stringOf } from './imports.mjs';
import { dependenciesOf, locationOf, providersOf } from './di.mjs';

const HTTP = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Options', 'Head', 'All', 'Search']);
const HANDLERS = new Set(['Query', 'Mutation', 'Subscription', 'ResolveField', 'MessagePattern', 'EventPattern', 'SubscribeMessage', 'Cron', 'Interval', 'Timeout', 'OnEvent', 'Process']);
const ROLE_SUFFIXES = [['Guard', 'guard'], ['Interceptor', 'interceptor'], ['Pipe', 'pipe'], ['Repository', 'repository'], ['Filter', 'filter'], ['Middleware', 'middleware'], ['Strategy', 'strategy']];

/**
 * NestJS (decorators from @nestjs/*): roles (controllers, providers, modules, resolvers, gateways), handler
 * methods as entry points (HTTP routes, GraphQL, messages, schedules), and the container: what each @Module
 * provides, with scopes (Scope.REQUEST → scoped, Scope.TRANSIENT → transient, else singleton), and what each
 * class asks for.
 */
export function nest(ctx, sf, info, owners) {
  const { ts, graph } = ctx;
  const nestDecorators = (node) => decoratorsOf(ctx, node).filter((d) => d.module?.startsWith('@nestjs/'));
  const file = graph.nodes.get(info.moduleId);

  for (const owner of owners) {
    if (owner.kind !== 'class' || !ts.isClassDeclaration(owner.node)) continue;
    const cls = owner.node;
    const node = graph.nodes.get(owner.id);
    const decorators = nestDecorators(cls);
    if (!decorators.length) continue;
    const names = new Set(decorators.map((d) => d.name));

    let prefix = '';
    if (names.has('Controller')) {
      addTag(node, 'controller');
      addTag(file, 'controller');
      const arg = decorators.find((d) => d.name === 'Controller').args[0];
      prefix = stringOf(ts, arg) ?? stringOf(ts, property(ts, arg, 'path')) ?? '';
    }

    if (names.has('Injectable')) {
      addTag(node, 'service');
      for (const [suffix, tag] of ROLE_SUFFIXES) if (cls.name?.text.endsWith(suffix)) addTag(node, tag);
    }

    if (names.has('Module')) addTag(node, 'module');
    if (names.has('Resolver') || names.has('WebSocketGateway')) {
      addTag(node, 'controller');
      addTag(node, names.has('Resolver') ? 'resolver' : 'gateway');
    }

    if (names.has('Catch')) addTag(node, 'filter');

    // Handlers: where requests, messages and schedules come in.
    for (const member of cls.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      const handler = nestDecorators(member).find((d) => HTTP.has(d.name) || HANDLERS.has(d.name));
      if (!handler) continue;
      const method = graph.nodes.get(declarationId(ctx, member));
      if (!method) continue;
      addTag(method, 'entrypoint');
      if (HTTP.has(handler.name)) {
        addTag(method, 'route');
        const path = [prefix, stringOf(ts, handler.args[0]) ?? ''].filter(Boolean).join('/').replace(/\/+/g, '/');
        // The route comes first in the handler's doc, its JSDoc after it; the global prefix is added once every file is read.
        const route = { method, verb: handler.name === 'All' ? 'ALL' : handler.name.toUpperCase(), path, doc: method.doc, projectId: info.projectId };
        ctx.nest.routes.push(route);
        method.doc = routeDoc(route, '');
      }
    }

    // The container.
    const scope = scopeOf(ctx, decorators.find((d) => d.name === 'Injectable' || d.name === 'Controller'));
    if (scope) ctx.nestScopes.set(owner.id, scope);
    if (names.has('Module')) registerModule(ctx, sf, info, owner, decorators.find((d) => d.name === 'Module').args[0]);
    if (!names.has('Module')) for (const dependency of dependenciesOf(ctx, cls, nestDecorators)) ctx.di.dependencies.push({ ...dependency, framework: 'nest' });
  }

  // NestFactory.create(AppModule) starts the application; app.setGlobalPrefix('api') prefixes every route of the package.
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.getText(sf) === 'NestFactory') addTag(file, 'entrypoint');
    else {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'setGlobalPrefix') {
        const prefix = stringOf(ts, n.arguments[0]);
        if (prefix !== null) ctx.nest.prefixes.set(info.projectId, prefix);
      }

      ts.forEachChild(n, visit);
    }
  };
  visit(sf);
}

/** After every file: the global prefix of each package in its routes. */
export function finishNestRoutes(ctx) {
  for (const route of ctx.nest.routes) {
    const prefix = ctx.nest.prefixes.get(route.projectId);
    if (prefix) route.method.doc = routeDoc(route, prefix);
  }
}

/** `GET /api/articles · Lists the articles.` */
function routeDoc(route, prefix) {
  const path = [prefix, route.path].filter(Boolean).join('/').replace(/\/+/g, '/').replace(/^\//, '');
  return `${route.verb} /${path}` + (route.doc ? ` · ${route.doc}` : '');
}

function registerModule(ctx, sf, info, owner, metadata) {
  const { ts } = ctx;
  const add = (entry, kind) => {
    ctx.di.registrations.push({
      service: entry.service,
      external: entry.external || undefined,
      implementation: entry.implementation,
      // A scope written on the provider entry wins; else the class' @Injectable({ scope }), known once all files are read.
      lifetime: lifetimeOf(ctx, entry.scope),
      scopeOf: entry.external && !entry.implementation ? undefined : entry.implementation ?? entry.service,
      kind,
      registeredIn: owner.id,
      location: locationOf(sf, info, entry.node),
      framework: 'nest',
    });
  };

  for (const entry of providersOf(ctx, property(ts, metadata, 'providers'))) add(entry, entry.kind);
  for (const entry of providersOf(ctx, property(ts, metadata, 'controllers'))) add(entry, 'controller');

  // TypeOrmModule.forFeature([Order]) provides Repository<Order>.
  const imports = property(ts, metadata, 'imports');
  for (const element of imports && ts.isArrayLiteralExpression(imports) ? imports.elements : []) {
    if (!ts.isCallExpression(element) || !/\.forFeature$/.test(element.expression.getText(sf))) continue;
    const list = element.arguments[0];
    for (const entity of list && ts.isArrayLiteralExpression(list) ? list.elements : []) {
      add({ service: `Repository<${entity.getText(sf)}>`, external: true, kind: 'factory', node: entity }, 'factory');
    }
  }
}

/** Scope.REQUEST / Scope.TRANSIENT in @Injectable({ scope }) or a provider's scope. */
function scopeOf(ctx, decorator) {
  return decorator ? lifetimeOf(ctx, property(ctx.ts, decorator.args[0], 'scope')) : undefined;
}

function lifetimeOf(ctx, scope) {
  const text = scope?.getText?.() ?? '';
  if (/REQUEST$/.test(text)) return 'scoped';
  if (/TRANSIENT$/.test(text)) return 'transient';
  if (/DEFAULT$/.test(text)) return 'singleton';
  return undefined;
}
