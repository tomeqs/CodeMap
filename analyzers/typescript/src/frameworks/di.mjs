import { declarationId } from '../extract/declarations.mjs';
import { targetOf } from '../extract/references.mjs';
import { importOf, property, stringOf } from './imports.mjs';

/**
 * What NestJS and Angular providers have in common: provider lists (`[A, { provide: X, useClass: Y }]`) and the
 * services a class asks for (constructor parameters by type or token, @Inject, @Optional), as the raw DI data
 * CodeMap's analysis expects: registrations and dependencies with node ids, or names for what is not in the code.
 */

/** A service reference: a node id, or the name of something outside the analyzed code (a token, a library class). */
export function serviceOf(ctx, expr) {
  const { ts } = ctx;
  if (!expr) return null;
  if (ts.isCallExpression(expr) && importOf(ctx, expr.expression)?.name === 'forwardRef') {
    const fn = expr.arguments[0];
    return fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && !ts.isBlock(fn.body) ? serviceOf(ctx, fn.body) : null;
  }

  const text = stringOf(ts, expr);
  if (text !== null) return { service: text, external: true };
  const name = ts.isPropertyAccessExpression(expr) ? expr.name : ts.isIdentifier(expr) ? expr : null;
  if (!name) return null;
  const target = targetOf(ctx, name);
  if (target) return { service: target.id };
  return { service: name.text, external: true };
}

/** The service a type annotation names (`OrdersRepository`, `Repository<Order>`), or null for primitives. */
export function serviceOfType(ctx, type) {
  const { ts } = ctx;
  if (!type || !ts.isTypeReferenceNode(type)) return null;
  const name = ts.isQualifiedName(type.typeName) ? type.typeName.right : type.typeName;
  const target = targetOf(ctx, name);
  if (target) return { service: target.id };
  return { service: type.getText().replace(/\s+/g, ''), external: true };
}

/**
 * Entries of a provider list. Each: { service, external, implementation, kind, scope, node }.
 * kind: type (a class the container builds), instance (useValue), factory (useFactory), forward (useExisting).
 */
export function providersOf(ctx, list) {
  const { ts } = ctx;
  const entries = [];
  if (!list || !ts.isArrayLiteralExpression(list)) return entries;
  for (const element of list.elements) {
    if (ts.isIdentifier(element) || ts.isPropertyAccessExpression(element)) {
      const service = serviceOf(ctx, element);
      if (service) entries.push({ ...service, kind: 'type', node: element });
    } else if (ts.isObjectLiteralExpression(element)) {
      const service = serviceOf(ctx, property(ts, element, 'provide'));
      if (!service) continue;
      const useClass = property(ts, element, 'useClass');
      const useExisting = property(ts, element, 'useExisting');
      const kind = useClass ? 'type' : property(ts, element, 'useValue') ? 'instance' : property(ts, element, 'useFactory') ? 'factory' : useExisting ? 'forward' : 'type';
      const implementation = serviceOf(ctx, useClass ?? useExisting);
      entries.push({ ...service, implementation: implementation && !implementation.external ? implementation.service : undefined, kind, scope: property(ts, element, 'scope'), node: element });
    }
  }

  return entries;
}

/** Location of a node in its file. */
export function locationOf(sf, info, node) {
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  return { file: info.rel, line: start, endLine: sf.getLineAndCharacterOfPosition(node.end).line + 1 };
}

/**
 * What a class asks the container for: constructor parameters (by type; @Inject(TOKEN) / @InjectRepository(E)
 * / @InjectModel(N) win; @Optional) and decorated properties. `frameworkDecorators(node)` gives the
 * framework's decorators of a node.
 */
export function dependenciesOf(ctx, classNode, frameworkDecorators) {
  const { ts } = ctx;
  const consumer = declarationId(ctx, classNode);
  if (!consumer) return [];
  const result = [];
  const fromDecorated = (decorated, type) => {
    let service = null;
    let optional = false;
    for (const d of frameworkDecorators(decorated)) {
      if (d.name === 'Inject') service = serviceOf(ctx, d.args[0]) ?? service;
      else if (d.name === 'InjectRepository' && d.args[0]) service = { service: `Repository<${d.args[0].getText()}>`, external: true };
      else if (d.name === 'InjectModel' && d.args[0]) service = { service: `Model<${d.args[0].getText()}>`, external: true };
      else if (d.name === 'Optional') optional = true;
    }

    return { service, optional, typed: type ? serviceOfType(ctx, type) : null };
  };

  const constructor = classNode.members.find((m) => ts.isConstructorDeclaration(m) && m.body);
  for (const parameter of constructor?.parameters ?? []) {
    const { service, optional, typed } = fromDecorated(parameter, parameter.type);
    const resolved = service ?? typed;
    if (resolved) result.push({ consumer, ...resolved, optional: optional || !!parameter.questionToken || undefined });
  }

  for (const member of classNode.members) {
    if (!ts.isPropertyDeclaration(member)) continue;
    const { service, optional } = fromDecorated(member, null);
    if (service) result.push({ consumer, ...service, optional: optional || undefined });
  }

  return result;
}
