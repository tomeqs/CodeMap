/**
 * Where a name comes from: `Controller` in `import { Controller } from '@nestjs/common'` → { module:
 * '@nestjs/common', name: 'Controller' }. Frameworks are recognised by this, so it works without the
 * frameworks installed (no node_modules needed).
 */
export function importOf(ctx, expr) {
  const { ts, checker } = ctx;
  if (!expr) return null;
  if (ts.isPropertyAccessExpression(expr)) {
    // express.Router, Nest.Controller: a member of a default or namespace import
    const base = importOf(ctx, expr.expression);
    return base && (base.name === 'default' || base.name === '*') ? { module: base.module, name: expr.name.text } : null;
  }

  if (ts.isCallExpression(expr)) return importOf(ctx, expr.expression);
  if (!ts.isIdentifier(expr)) return null;
  let symbol;
  try {
    symbol = checker.getSymbolAtLocation(expr);
  } catch {
    return null;
  }

  const decl = symbol?.declarations?.[0];
  if (!decl) return null;
  if (ts.isImportSpecifier(decl)) return fromImport(ts, decl, (decl.propertyName ?? decl.name).text);
  if (ts.isImportClause(decl)) return fromImport(ts, decl, 'default');
  if (ts.isNamespaceImport(decl)) return fromImport(ts, decl, '*');
  if (ts.isImportEqualsDeclaration(decl) && ts.isExternalModuleReference(decl.moduleReference)) {
    return { module: decl.moduleReference.expression.text, name: '*' };
  }

  // CommonJS: const express = require('express'); const { Router } = require('express')
  let variable = decl;
  let name = '*';
  if (ts.isBindingElement(decl)) {
    name = (decl.propertyName ?? decl.name).getText();
    while (variable && !ts.isVariableDeclaration(variable)) variable = variable.parent;
  }

  const init = variable && ts.isVariableDeclaration(variable) ? variable.initializer : null;
  if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'require' && init.arguments[0] && ts.isStringLiteral(init.arguments[0])) {
    return { module: init.arguments[0].text, name };
  }

  return null;
}

function fromImport(ts, decl, name) {
  let node = decl;
  while (node && !ts.isImportDeclaration(node)) node = node.parent;
  const spec = node?.moduleSpecifier;
  return spec && ts.isStringLiteral(spec) ? { module: spec.text, name } : null;
}

/** Decorators of a declaration with where they come from: [{ module, name, args, node }]. */
export function decoratorsOf(ctx, node) {
  const { ts } = ctx;
  if (!ts.canHaveDecorators?.(node)) return [];
  return (ts.getDecorators(node) ?? []).map((d) => {
    const call = ts.isCallExpression(d.expression) ? d.expression : null;
    const source = importOf(ctx, call ? call.expression : d.expression);
    return { module: source?.module ?? null, name: source?.name ?? null, args: call?.arguments ?? [], node: d };
  });
}

/** Text of a string literal or a template without substitutions, else null. */
export function stringOf(ts, node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

/** A property of an object literal by name. */
export function property(ts, object, name) {
  if (!object || !ts.isObjectLiteralExpression(object)) return null;
  for (const p of object.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === name) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
  }

  return null;
}

export function addTag(node, tag) {
  if (!node) return;
  node.tags ??= [];
  if (!node.tags.includes(tag)) node.tags.push(tag);
}
