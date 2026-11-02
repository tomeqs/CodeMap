import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadTypeScript } from '../src/load-typescript.mjs';
import { analyze } from '../src/analyze.mjs';

const ts = loadTypeScript();

function run(name) {
  const dir = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  const graph = analyze(ts, { target: dir, root: dir, options: {} });
  const node = (id) => graph.nodes.find((n) => n.id === id) ?? assert.fail(`no node ${id}`);
  const hasEdge = (source, kind, target) =>
    assert.ok(graph.edges.some((e) => e.source === source && e.kind === kind && e.target === target), `missing ${source} -${kind}-> ${target}`);
  return { graph, node, hasEdge, di: graph.analysis.di ?? { registrations: [], dependencies: [] } };
}

test('Express: routes are members of their file, their handlers\' code is theirs', () => {
  const { graph, node, hasEdge } = run('express');
  const R = 'ts:shop-gateway:src/orders/orders.routes.ts';
  const routes = graph.nodes.filter((n) => n.tags?.includes('route')).map((n) => n.name).sort();
  assert.deepEqual(routes, ['DELETE /cache', 'GET /', 'GET /:id', 'GET /health', 'POST /:id/lines']);
  const get = node(`${R}#route:GET /:id`);
  assert.deepEqual([get.kind, get.level, get.parent, get.tags], ['function', 'member', R, ['route', 'entrypoint']]);
  assert.equal(get.metrics.complexity, 2); // the inline handler's if
  assert.deepEqual(node(R).tags, ['controller']);
  // Named handler and middleware: called by the route; an inline handler's calls are the route's.
  hasEdge(`${R}#route:GET /`, 'calls', 'ts:shop-gateway:src/orders/orders.handlers.ts#listOrders');
  hasEdge(`${R}#route:GET /`, 'calls', 'ts:shop-gateway:src/middleware/auth.ts#auth');
  hasEdge(`${R}#route:GET /:id`, 'calls', 'ts:shop-gateway:src/orders/orders.handlers.ts#getOrder');
  hasEdge(`${R}#route:POST /:id/lines`, 'calls', 'ts:shop-gateway:src/orders/orders.handlers.ts#addLine');
  assert.ok(!graph.edges.some((e) => e.source === `${R}#(top-level)` && e.kind === 'calls'), 'the top-level code does not call the handlers itself');
  assert.equal(node(`${R}#(top-level)`).metrics.complexity, 1);
  node('ts:shop-gateway:src/legacy.js#route:DELETE /cache'); // CommonJS, express.Router()
});

test('NestJS: roles, handlers as entry points, providers and what classes ask for', () => {
  const { node, di } = run('nest');
  const O = 'ts:shop-api:src/orders/';
  assert.ok(node(`${O}orders.controller.ts#OrdersController`).tags.includes('controller'));
  const find = node(`${O}orders.controller.ts#OrdersController.find`);
  assert.deepEqual([find.tags, find.doc], [['entrypoint', 'route'], 'GET /orders/:id']);
  assert.deepEqual(node(`${O}cleanup.task.ts#CleanupTask.cleanup`).tags, ['entrypoint']); // @Cron
  assert.deepEqual(node('ts:shop-api:src/auth/auth.guard.ts#AuthGuard').tags, ['service', 'guard']);
  assert.deepEqual(node('ts:shop-api:src/app.module.ts#AppModule').tags, ['module']);
  assert.ok(node('ts:shop-api:src/main.ts').tags.includes('entrypoint')); // NestFactory.create

  const registration = (service) => di.registrations.find((r) => r.service === service) ?? assert.fail(`no registration of ${service}`);
  assert.equal(registration(`${O}request-context.ts#RequestContext`).lifetime, 'scoped'); // @Injectable({ scope: Scope.REQUEST })
  assert.equal(registration(`${O}orders.service.ts#OrdersService`).lifetime, 'singleton');
  assert.deepEqual(
    [registration(`${O}orders.repository.ts#ORDERS_REPOSITORY`).implementation, registration(`${O}orders.repository.ts#ORDERS_REPOSITORY`).kind],
    [`${O}orders.repository.ts#SqlOrdersRepository`, 'type'],
  );
  assert.deepEqual([registration('CLOCK').kind, registration('CLOCK').external], ['instance', true]);
  assert.equal(registration(`${O}pricing.ts#PricingService`).kind, 'factory');
  assert.equal(registration(`${O}orders.controller.ts#OrdersController`).kind, 'controller');
  assert.equal(registration('Repository<Order>').external, true); // TypeOrmModule.forFeature([Order])
  assert.ok(di.registrations.every((r) => r.framework === 'nest' && r.registeredIn === `${O}orders.module.ts#OrdersModule`));

  const needs = di.dependencies.filter((d) => d.consumer === `${O}orders.service.ts#OrdersService`).map((d) => [d.service, !!d.external, !!d.optional]);
  assert.deepEqual(needs, [
    [`${O}orders.repository.ts#ORDERS_REPOSITORY`, false, false], // @Inject(TOKEN) wins over the type
    [`${O}request-context.ts#RequestContext`, false, false],
    ['Repository<Order>', true, false], // @InjectRepository(Order)
    [`${O}pricing.ts#Pricing`, false, false],
    [`${O}orders.service.ts#AuditLog`, false, true], // @Optional
  ]);
});

test('Angular: components, services, providedIn and component providers, inject()', () => {
  const { node, di } = run('angular');
  const A = 'ts:shop-web:src/app/';
  assert.deepEqual(node(`${A}app.component.ts#AppComponent`).tags, ['component']);
  assert.deepEqual(node(`${A}money.pipe.ts#MoneyPipe`).tags, ['pipe']);
  assert.ok(node('ts:shop-web:src/main.ts').tags.includes('entrypoint')); // bootstrapApplication

  const lifetimes = Object.fromEntries(di.registrations.map((r) => [`${r.service.replace(A, '')} (${r.kind})`, r.lifetime]));
  assert.deepEqual(lifetimes, {
    'app.component.ts#AppComponent (component)': 'transient',
    'panel.state.ts#PanelState (type)': 'scoped', // provided by a component
    'money.pipe.ts#MoneyPipe (component)': 'transient',
    'orders.component.ts#OrdersComponent (component)': 'transient',
    'orders.store.ts#OrdersStore (type)': 'singleton', // providedIn: 'root'
  });
  const needs = di.dependencies.map((d) => `${d.consumer.replace(A, '')} → ${d.service.replace(A, '')}${d.optional ? ' (optional)' : ''}`);
  assert.deepEqual(needs.sort(), [
    'app.component.ts#AppComponent → orders.store.ts#OrdersStore', // inject()
    'orders.component.ts#OrdersComponent → orders.store.ts#OrdersStore',
    'orders.component.ts#OrdersComponent → panel.state.ts#PanelState (optional)',
    'orders.store.ts#OrdersStore → HttpClient',
    'orders.store.ts#OrdersStore → panel.state.ts#PanelState',
  ]);
  assert.ok(di.dependencies.every((d) => d.framework === 'angular'));
});
