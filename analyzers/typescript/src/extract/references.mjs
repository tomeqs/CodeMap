import { declarationId, referenceKind } from './declarations.mjs';

/**
 * Edges from the code of each member: calls (with the line of the first call, which orders a call flow),
 * `new` and JSX elements (instantiates), throw, reads of variables and properties (accesses), type references
 * (uses; accepts / returns / holds in signatures), constructor parameters (injects), base classes and
 * interfaces down to the members that implement or override, and decorators. References resolve through
 * imports and re-exports to the declaration itself, so a call through a barrel file reaches the real function.
 */
export function collectReferences(ctx, sf, owners) {
  const { ts, graph } = ctx;
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  for (const owner of owners) {
    const node = owner.node;
    const codes = owner.code ? (Array.isArray(owner.code) ? owner.code : [owner.code]) : [];
    const fn = functionLike(ts, node);
    if (fn) {
      typeParameterEdges(ctx, owner.id, fn.typeParameters);
      // const Badge: Renderer<BadgeProps> = (p) => …: the annotation is the function's type.
      if (fn !== node && (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node))) typeEdges(ctx, owner.id, node.type, 'uses');
      for (const parameter of fn.parameters ?? []) {
        typeEdges(ctx, owner.id, parameter.type, 'accepts');
        // Default values and decorators of a declared function's parameters (an arrow function's are in its code;
        // a parameter property is a member of its own).
        if (codes.some((c) => c.pos <= parameter.pos && parameter.end <= c.end) || declarationId(ctx, parameter)) continue;
        if (parameter.initializer) walk(parameter.initializer, owner.id);
        decorate(parameter, owner.id);
      }

      typeEdges(ctx, owner.id, fn.type, 'returns');
      if (ts.isConstructorDeclaration(fn)) {
        const type = graph.nodes.get(owner.id)?.parent;
        for (const parameter of fn.parameters) typeEdges(ctx, type, parameter.type, 'injects');
      }
    } else if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isParameter(node) || (ts.isVariableDeclaration(node) && node.type)) {
      typeEdges(ctx, owner.id, node.type, 'holds');
    } else if (ts.isTypeAliasDeclaration(node)) {
      typeParameterEdges(ctx, owner.id, node.typeParameters);
      typeEdges(ctx, owner.id, node.type, 'uses');
    } else if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      typeParameterEdges(ctx, owner.id, node.typeParameters);
      heritage(ctx, owner, node);
    }

    decorate(node, owner.id);
    for (const code of codes) walk(code, owner.id);
  }

  /** `@Decorator(args)` on a declaration or parameter: an edge to the decorator, and its arguments are code of the owner. */
  function decorate(node, ownerId) {
    for (const decorator of (ts.canHaveDecorators?.(node) && ts.getDecorators(node)) || []) {
      const expr = ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression;
      const target = targetOf(ctx, nameOf(ts, expr));
      if (target) graph.addEdge(ownerId, target.id, 'decoratedWith');
      if (ts.isCallExpression(decorator.expression)) decorator.expression.arguments.forEach((a) => walk(a, ownerId));
    }
  }

  function walk(root, ownerId) {
    const edge = (target, kind, at) => {
      if (target) graph.addEdge(ownerId, target.id, kind, kind === 'calls' || kind === 'instantiates' ? lineOf(at) : 0);
    };
    const visit = (n) => {
      // Code a framework gave to someone else (the handlers of an Express route belong to the route).
      const claimedBy = ctx.claimed?.get(n);
      if (claimedBy && claimedBy !== ownerId) return;

      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        if (callee.kind === ts.SyntaxKind.SuperKeyword) {
          edge(superConstructor(ctx, n), 'calls', n);
        } else if (callee.kind !== ts.SyntaxKind.ImportKeyword) {
          const target = targetOf(ctx, nameOf(ts, callee));
          if (target) edge(target, target.kind === 'uses' ? 'uses' : 'calls', n);
          if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) visit(callee.expression);
          else if (!ts.isIdentifier(callee)) visit(callee);
        }

        n.typeArguments?.forEach(visit);
        n.arguments.forEach(visit);
        return;
      }

      if (ts.isNewExpression(n)) {
        edge(targetOf(ctx, nameOf(ts, n.expression)), 'instantiates', n);
        if (!ts.isIdentifier(n.expression) && !ts.isPropertyAccessExpression(n.expression)) visit(n.expression);
        n.typeArguments?.forEach(visit);
        n.arguments?.forEach(visit);
        return;
      }

      if (ts.isThrowStatement(n) && n.expression && ts.isNewExpression(n.expression)) {
        edge(targetOf(ctx, nameOf(ts, n.expression.expression)), 'throws', n);
      }

      if (ts.isJsxClosingElement(n)) return; // </Comp>: its opening tag made the edge

      if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
        const tag = n.tagName;
        if (!(ts.isIdentifier(tag) && /^[a-z]/.test(tag.text))) edge(targetOf(ctx, nameOf(ts, tag)), 'instantiates', n);
        if (ts.isPropertyAccessExpression(tag)) visit(tag.expression); // <Stack.Navigator>: reads Stack
        visit(n.attributes);
        return;
      }

      if (ts.isTypeNode(n)) {
        typeEdges(ctx, ownerId, n, 'uses');
        return;
      }

      if (ts.isPropertyAccessExpression(n)) {
        const target = targetOf(ctx, n.name);
        if (target) edge(target, target.kind, n);
        visit(n.expression);
        return;
      }

      if (ts.isIdentifier(n)) {
        if (!isDeclarationName(ts, n)) {
          const target = targetOf(ctx, n);
          if (target) edge(target, target.kind, n);
        }

        return;
      }

      ts.forEachChild(n, visit);
    };
    visit(root);
  }
}

/** The function-like declaration behind a member (a method, a function, `const f = () => …`), if any. */
function functionLike(ts, node) {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return node;
  if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    return node.initializer;
  }

  if (ts.isExportAssignment(node) && (ts.isArrowFunction(node.expression) || ts.isFunctionExpression(node.expression))) return node.expression;
  return null;
}

/** Base class / interfaces of a class or interface, and which of its members implement or override theirs. */
function heritage(ctx, owner, node) {
  const { ts, graph, checker } = ctx;
  for (const clause of node.heritageClauses ?? []) {
    const implementsClause = clause.token === ts.SyntaxKind.ImplementsKeyword;
    for (const type of clause.types) {
      const target = targetOf(ctx, nameOf(ts, type.expression));
      if (target) graph.addEdge(owner.id, target.id, implementsClause ? 'implements' : 'inherits');
      type.typeArguments?.forEach((t) => typeEdges(ctx, owner.id, t, 'uses'));
      if (ts.isInterfaceDeclaration(node)) continue;

      let base;
      try {
        base = checker.getTypeAtLocation(type);
      } catch {
        continue;
      }

      for (const member of node.members) {
        if (ts.isConstructorDeclaration(member) || !member.name) continue;
        const memberId = declarationId(ctx, member);
        const property = base?.getProperty?.(member.name.getText());
        if (!memberId || !property) continue;
        for (const decl of property.declarations ?? []) {
          const id = declarationId(ctx, decl);
          const inInterface = ts.isInterfaceDeclaration(decl.parent);
          if (id && id !== memberId) graph.addEdge(memberId, id, inInterface ? 'implements' : 'overrides');
        }
      }
    }
  }
}

/** `<T extends Constraint = Default>`: the constraints and defaults of type parameters are types the declaration uses. */
function typeParameterEdges(ctx, sourceId, typeParameters) {
  for (const parameter of typeParameters ?? []) {
    typeEdges(ctx, sourceId, parameter.constraint, 'uses');
    typeEdges(ctx, sourceId, parameter.default, 'uses');
  }
}

/** Edges to the declarations a type annotation names: `Promise<Order[]>` → Order. */
function typeEdges(ctx, sourceId, typeNode, kind) {
  if (!typeNode || !sourceId) return;
  const { ts, graph } = ctx;
  if (kind === 'injects') {
    // A constructor is given the type itself (also `Service | undefined`); what its type arguments name
    // (`Repository<Article>`, `Array<Item>`) or anything nested deeper is only used.
    if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) typeNode.types.forEach((t) => typeEdges(ctx, sourceId, t, kind));
    else if (ts.isParenthesizedTypeNode(typeNode)) typeEdges(ctx, sourceId, typeNode.type, kind);
    else if (ts.isTypeReferenceNode(typeNode)) {
      // A constructor depends on services: classes and interfaces, not on aliases of strings and numbers.
      const target = targetOf(ctx, rightmost(ts, typeNode.typeName));
      if (target && (ts.isClassDeclaration(target.decl) || ts.isInterfaceDeclaration(target.decl))) graph.addEdge(sourceId, target.id, kind);
      typeNode.typeArguments?.forEach((t) => typeEdges(ctx, sourceId, t, 'uses'));
    } else typeEdges(ctx, sourceId, typeNode, 'uses');
    return;
  }

  const visit = (n) => {
    if (ts.isTypeReferenceNode(n)) {
      const target = targetOf(ctx, rightmost(ts, n.typeName));
      if (target) graph.addEdge(sourceId, target.id, kind);
    } else if (ts.isExpressionWithTypeArguments(n) || ts.isTypeQueryNode(n)) {
      const target = targetOf(ctx, nameOf(ts, n.expression ?? n.exprName));
      if (target) graph.addEdge(sourceId, target.id, kind);
    }

    ts.forEachChild(n, visit);
  };
  visit(typeNode);
}

/** The constructor `super(…)` calls: the base class' own, else the base class itself. */
function superConstructor(ctx, call) {
  const { ts } = ctx;
  let cls = call.parent;
  while (cls && !ts.isClassDeclaration(cls) && !ts.isClassExpression(cls)) cls = cls.parent;
  const extendsClause = cls?.heritageClauses?.find((c) => c.token === ts.SyntaxKind.ExtendsKeyword);
  const base = extendsClause?.types[0];
  if (!base) return null;
  const target = targetOf(ctx, nameOf(ts, base.expression));
  if (!target) return null;
  // From the declaration, not from the graph: the base class may be in a package not analyzed yet.
  const declaresConstructor = ts.isClassDeclaration(target.decl) && target.decl.members.some((m) => ts.isConstructorDeclaration(m));
  return declaresConstructor ? { id: `${target.id}.constructor`, kind: 'calls' } : target;
}

/** The identifier that names what an expression refers to: `a.b.c` → c. */
function nameOf(ts, expr) {
  if (!expr) return null;
  if (ts.isIdentifier(expr) || ts.isPrivateIdentifier?.(expr)) return expr;
  if (ts.isPropertyAccessExpression(expr)) return expr.name;
  if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr) || ts.isAsExpression?.(expr)) return nameOf(ts, expr.expression);
  if (ts.isJsxNamespacedName?.(expr)) return expr.name;
  return null;
}

function rightmost(ts, name) {
  return ts.isQualifiedName(name) ? name.right : name;
}

function isDeclarationName(ts, node) {
  const parent = node.parent;
  // `{ list }` names a property and refers to `list`: a reference (see targetOf).
  if (parent && ts.isShorthandPropertyAssignment(parent)) return false;
  return !!parent && parent.name === node && (ts.isDeclaration?.(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isPropertyAssignment(parent) ||
    ts.isBindingElement(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent));
}

/** What a name refers to, through imports and re-exports, as a node id and the kind of edge a reference makes. */
export function targetOf(ctx, name) {
  if (!name) return null;
  const { ts, checker } = ctx;
  let symbol;
  try {
    // In `{ list }` the name is the property; what it refers to is the value's symbol.
    symbol = name.parent && ts.isShorthandPropertyAssignment(name.parent) && name.parent.name === name
      ? checker.getShorthandAssignmentValueSymbol(name.parent)
      : checker.getSymbolAtLocation(name);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      // const helper = require('./helper'): a reference to `helper` reads that variable, not the module.
      const variable = symbol.declarations?.find((d) => ts.isVariableDeclaration(d) && isRequire(ts, d.initializer));
      const id = variable && declarationId(ctx, variable);
      if (id) return { id, kind: 'accesses', decl: variable };
      symbol = checker.getAliasedSymbol(symbol);
    }
  } catch {
    return null;
  }

  for (const decl of symbol?.declarations ?? []) {
    const id = declarationId(ctx, decl);
    if (id) return { id, kind: referenceKind(ts, decl), decl };
  }

  return null;
}

/** `require('x')`, the CommonJS import. */
export function isRequire(ts, node) {
  return !!node && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' &&
    node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]);
}
