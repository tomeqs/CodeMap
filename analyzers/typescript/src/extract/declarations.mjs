import { complexity } from './complexity.mjs';
import { memberId } from '../ids.mjs';

/**
 * Declarations of a file become its members on the map: functions, classes, interfaces, type aliases, enums
 * and top-level variables (a `const f = () => …` is a function), with the members of classes and interfaces
 * inside them. Ids name the declaration by file and name only (`ts:api:src/orders.ts#OrdersService.place`),
 * so references from any package can point at it without sharing a compiler program.
 */

/** File info of a declaration's file, if it is one of the analyzed files. */
export function fileOf(ctx, node) {
  const file = node.getSourceFile?.();
  return file ? ctx.files.get(file.fileName) ?? null : null;
}

function isTopLevel(ts, node) {
  if (ts.isSourceFile(node.parent)) return true;
  // const x = … : VariableDeclaration → VariableDeclarationList → VariableStatement → SourceFile
  return ts.isVariableDeclaration(node) && node.parent?.parent && ts.isVariableStatement(node.parent.parent) && ts.isSourceFile(node.parent.parent.parent);
}

function hasModifier(ts, node, kind) {
  return !!ts.getModifiers?.(node)?.some((m) => m.kind === kind) || !!node.modifiers?.some?.((m) => m.kind === kind);
}

/** The name a top-level declaration gets on the map (null: not one we show). */
export function topLevelName(ts, node) {
  if (!isTopLevel(ts, node)) return null;
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return node.name?.text ?? (hasModifier(ts, node, ts.SyntaxKind.DefaultKeyword) ? 'default' : null);
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) return node.name.text;
  if (ts.isVariableDeclaration(node)) return ts.isIdentifier(node.name) ? node.name.text : null;
  if (ts.isExportAssignment(node) && !node.isExportEquals) return 'default';
  return null;
}

function memberName(ts, node) {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  const name = node.name;
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null; // computed names
}

/** Id of the map node that stands for a declaration, or null (locals, parameters, code that was not analyzed). */
export function declarationId(ctx, decl) {
  const { ts } = ctx;
  const info = fileOf(ctx, decl);
  if (!info) return null;
  if (ts.isSourceFile(decl)) return info.moduleId;

  const top = topLevelName(ts, decl);
  if (top) return memberId(info.moduleId, top);

  // Members of top-level classes and interfaces; constructor parameter properties are properties.
  let owner;
  let name;
  if (ts.isParameter(decl)) {
    if (!ts.isParameterPropertyDeclaration?.(decl, decl.parent) || !ts.isIdentifier(decl.name)) return null;
    owner = decl.parent.parent;
    name = decl.name.text;
  } else if (ts.isClassElement(decl) || ts.isTypeElement(decl)) {
    owner = decl.parent;
    name = ts.isClassStaticBlockDeclaration?.(decl) || ts.isIndexSignatureDeclaration(decl) ? '' : memberName(ts, decl);
  }

  if (owner && (ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner))) {
    const ownerName = topLevelName(ts, owner);
    if (ownerName && name !== null && name !== undefined) return memberId(info.moduleId, name ? `${ownerName}.${name}` : ownerName);
  }

  if (ts.isEnumMember(decl) && decl.parent && topLevelName(ts, decl.parent)) return memberId(info.moduleId, topLevelName(ts, decl.parent));
  return null;
}

/** Is this declaration code that runs (calls), a value that is read, or a type? */
export function referenceKind(ts, decl) {
  if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl) || ts.isConstructorDeclaration(decl)) return 'calls';
  if (ts.isVariableDeclaration(decl) && decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) return 'calls';
  if (ts.isPropertyDeclaration(decl) && decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) return 'calls';
  if (ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl) || ts.isEnumDeclaration(decl) || ts.isEnumMember(decl)) return 'uses';
  if (ts.isExportAssignment(decl) || ts.isSourceFile(decl)) return 'uses';
  return 'accesses';
}

/**
 * Adds the nodes of one file. Returns what the reference pass walks: every member with its code
 * (body, initializer, the file's top-level statements) and the classes with their base types.
 */
export function declareModule(ctx, sf, info) {
  const { ts, graph } = ctx;
  const owners = [];
  const exported = exportedNames(ts, sf);
  const location = (node) => {
    const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const end = sf.getLineAndCharacterOfPosition(node.end).line + 1;
    return { file: info.rel, line: start, endLine: end };
  };
  const tags = info.isTest ? ['test'] : undefined;
  const base = { level: 'member', project: info.projectId, namespace: info.folder };

  graph.addNode({
    id: info.moduleId,
    kind: 'module',
    level: 'type',
    name: info.name,
    fullName: info.path,
    parent: info.folderId,
    project: info.projectId,
    namespace: info.folder,
    accessibility: 'public',
    location: { file: info.rel, line: 1, endLine: info.lines },
    tags: info.isTest ? ['test'] : undefined,
    metrics: { loc: info.lines },
  });

  const add = (id, fields, node, code) => {
    const fresh = { id, ...base, ...fields, location: location(node), tags: tags ? [...tags] : undefined };
    const existing = graph.nodes.get(id);
    if (existing) {
      // Overloads and merged declarations: one node; the declaration with code is the main location.
      if (code && !existing.hasCode) {
        existing.extraLocations = [...(existing.extraLocations ?? []), existing.location];
        Object.assign(existing, { location: fresh.location, signature: fresh.signature, metrics: fresh.metrics, hasCode: true });
      } else {
        existing.extraLocations = [...(existing.extraLocations ?? []), fresh.location];
      }
    } else {
      graph.addNode({ ...fresh, hasCode: !!code });
      if (fresh.metrics?.loc === undefined) graph.nodes.get(id).metrics = { ...(fresh.metrics ?? {}), loc: fresh.location.endLine - fresh.location.line + 1 };
    }

    owners.push({ id, node, code, kind: fields.kind });
    return graph.nodes.get(id);
  };

  const topLevel = [];
  for (const statement of sf.statements) {
    if (ts.isVariableStatement(statement)) {
      const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const decl of statement.declarationList.declarations) {
        const name = topLevelName(ts, decl);
        if (!name) continue;
        const init = decl.initializer;
        const isFunction = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        const isClass = init && ts.isClassExpression(init);
        const exportedHere = hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword) || exported.has(name);
        add(memberId(info.moduleId, name), {
          kind: isFunction ? 'function' : isClass ? 'class' : 'variable',
          name,
          fullName: `${info.path}#${name}`,
          parent: info.moduleId,
          accessibility: exportedHere ? 'public' : 'private',
          modifiers: modifiers(ts, statement, isConst && !isFunction ? ['const'] : []),
          signature: signature(sf, statement, isFunction ? init.body : null),
          doc: doc(ts, statement),
          metrics: isFunction ? { complexity: complexity(ts, init.body) } : undefined,
        }, decl, init ?? null);
      }
    } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) {
      const name = topLevelName(ts, statement);
      if (!name) continue;
      const kind = ts.isFunctionDeclaration(statement) ? 'function' : ts.isClassDeclaration(statement) ? 'class'
        : ts.isInterfaceDeclaration(statement) ? 'interface' : ts.isTypeAliasDeclaration(statement) ? 'typeAlias' : 'enum';
      const isExported = hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword) || exported.has(name);
      const id = memberId(info.moduleId, name);
      const isFunction = kind === 'function';
      add(id, {
        kind,
        name,
        fullName: `${info.path}#${name}`,
        parent: info.moduleId,
        accessibility: isExported ? 'public' : 'private',
        modifiers: modifiers(ts, statement),
        signature: signature(sf, statement, isFunction ? statement.body : ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) ? firstMember(statement) : null),
        attributes: decorators(ts, statement),
        doc: doc(ts, statement),
        metrics: isFunction ? { complexity: complexity(ts, statement.body) } : undefined,
      }, statement, isFunction ? statement.body ?? null : null);

      if (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) declareMembers(ctx, sf, info, statement, id, name, add);
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expr = statement.expression;
      const isFunction = ts.isArrowFunction(expr) || ts.isFunctionExpression(expr);
      if (isFunction || ts.isClassExpression(expr)) {
        add(memberId(info.moduleId, 'default'), {
          kind: isFunction ? 'function' : 'class',
          name: 'default',
          fullName: `${info.path}#default`,
          parent: info.moduleId,
          accessibility: 'public',
          signature: signature(sf, statement, isFunction ? expr.body : null),
          metrics: isFunction ? { complexity: complexity(ts, expr.body) } : undefined,
        }, statement, expr);
      } else {
        topLevel.push(statement);
      }
    } else if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement) && !ts.isModuleDeclaration(statement) &&
        !ts.isImportEqualsDeclaration(statement) && statement.kind !== ts.SyntaxKind.EmptyStatement) {
      topLevel.push(statement);
    }
  }

  // Code at the top of the file (bootstrap calls, app.use(…), route registrations) is one more member.
  if (topLevel.some((s) => containsCode(ts, s))) {
    const id = memberId(info.moduleId, '(top-level)');
    const first = location(topLevel[0]);
    const last = location(topLevel[topLevel.length - 1]);
    graph.addNode({
      id,
      ...base,
      kind: 'function',
      name: '(top-level)',
      fullName: `${info.path}#(top-level)`,
      parent: info.moduleId,
      accessibility: 'private',
      location: { file: info.rel, line: first.line, endLine: last.endLine },
      tags: tags ? [...tags] : undefined,
      metrics: { loc: last.endLine - first.line + 1, complexity: topLevel.reduce((sum, s) => sum + complexity(ts, s) - 1, 1) },
    });
    owners.push({ id, node: sf, code: topLevel, kind: 'function', topLevel: true });
  }

  return owners;
}

function declareMembers(ctx, sf, info, owner, ownerId, ownerName, add) {
  const { ts } = ctx;
  const isInterface = ts.isInterfaceDeclaration(owner);
  for (const member of owner.members) {
    const name = memberName(ts, member);
    if (!name || ts.isIndexSignatureDeclaration(member) || ts.isClassStaticBlockDeclaration?.(member) || ts.isCallSignatureDeclaration?.(member) || ts.isConstructSignatureDeclaration?.(member)) continue;
    const id = memberId(info.moduleId, `${ownerName}.${name}`);
    const fullName = `${info.path}#${ownerName}.${name}`;
    const accessibility = isInterface ? 'public' : memberAccessibility(ts, member);
    if (ts.isConstructorDeclaration(member)) {
      add(id, { kind: 'constructor', name, fullName, parent: ownerId, accessibility, modifiers: modifiers(ts, member), signature: signature(sf, member, member.body),
        attributes: decorators(ts, member), metrics: { complexity: complexity(ts, member.body) } }, member, member.body ?? null);
      for (const parameter of member.parameters) {
        if (!ts.isParameterPropertyDeclaration?.(parameter, member) || !ts.isIdentifier(parameter.name)) continue;
        add(memberId(info.moduleId, `${ownerName}.${parameter.name.text}`), {
          kind: 'property', name: parameter.name.text, fullName: `${info.path}#${ownerName}.${parameter.name.text}`, parent: ownerId,
          accessibility: memberAccessibility(ts, parameter), modifiers: modifiers(ts, parameter), signature: signature(sf, parameter, null),
        }, parameter, null);
      }

      continue;
    }

    const functionValue = ts.isPropertyDeclaration(member) && member.initializer && (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer));
    const isMethod = ts.isMethodDeclaration(member) || ts.isMethodSignature(member) || functionValue;
    const isAccessor = ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member);
    const body = ts.isMethodDeclaration(member) || isAccessor ? member.body : functionValue ? member.initializer.body : null;
    const code = ts.isPropertyDeclaration(member) ? member.initializer ?? null : body ?? null;
    const node = add(id, {
      kind: isMethod ? 'method' : 'property',
      name,
      fullName,
      parent: ownerId,
      accessibility,
      modifiers: modifiers(ts, member),
      signature: signature(sf, member, body),
      attributes: decorators(ts, member),
      doc: doc(ts, member),
      metrics: body || code ? { complexity: complexity(ts, body ?? code) } : undefined,
    }, member, code);
    if (isAccessor && node.hasCode && code && node.metrics) node.metrics.complexity = Math.max(node.metrics.complexity ?? 1, complexity(ts, body));
  }
}

/** Names exported by `export { a, b as c }` (not re-exports from other files). */
function exportedNames(ts, sf) {
  const names = new Set();
  for (const statement of sf.statements) {
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) names.add((element.propertyName ?? element.name).text);
    } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      names.add(statement.expression.text);
    } else if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      // CommonJS: module.exports = { a, b: c } / module.exports = a / exports.a = a / module.exports.a = a
      const { left, right } = statement.expression;
      const target = left.getText(sf);
      if (target === 'module.exports') {
        if (ts.isIdentifier(right)) names.add(right.text);
        else if (ts.isObjectLiteralExpression(right)) {
          for (const property of right.properties) {
            if (ts.isShorthandPropertyAssignment(property)) names.add(property.name.text);
            else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)) names.add(property.initializer.text);
          }
        }
      } else if (/^(module\.)?exports\.\w+$/.test(target) && ts.isIdentifier(right)) {
        names.add(right.text);
      }
    }
  }

  return names;
}

function memberAccessibility(ts, node) {
  if (node.name && ts.isPrivateIdentifier(node.name)) return 'private';
  if (hasModifier(ts, node, ts.SyntaxKind.PrivateKeyword)) return 'private';
  if (hasModifier(ts, node, ts.SyntaxKind.ProtectedKeyword)) return 'protected';
  return 'public';
}

const MODIFIER_WORDS = {
  StaticKeyword: 'static', AbstractKeyword: 'abstract', AsyncKeyword: 'async', ReadonlyKeyword: 'readonly',
  DeclareKeyword: 'declare', OverrideKeyword: 'override', DefaultKeyword: 'default', ConstKeyword: 'const',
};

function modifiers(ts, node, extra = []) {
  const words = [...extra];
  for (const m of ts.getModifiers?.(node) ?? []) {
    const word = MODIFIER_WORDS[ts.SyntaxKind[m.kind]];
    if (word && !words.includes(word)) words.push(word);
  }

  if (node.asteriskToken) words.push('generator');
  if (ts.isGetAccessorDeclaration?.(node)) words.push('get');
  if (ts.isSetAccessorDeclaration?.(node)) words.push('set');
  return words.length ? words : undefined;
}

function decorators(ts, node) {
  if (!ts.canHaveDecorators?.(node)) return undefined;
  const names = (ts.getDecorators(node) ?? []).map((d) => {
    const expr = ts.isCallExpression(d.expression) ? d.expression.expression : d.expression;
    return expr.getText().replace(/^@/, '');
  });
  return names.length ? names : undefined;
}

/** The declaration up to its body, on one line: `async place(input: OrderInput): Promise<Order>`. */
function signature(sf, node, body) {
  const start = node.getStart(sf);
  let end = body ? body.getStart(sf) : node.end;
  let text = sf.text.slice(start, end);
  text = text.replace(/^(\s*@[\w.]+(\([^)]*\))?\s*)+/, '').replace(/\s+/g, ' ').replace(/\s*(=>|\{|=)?\s*$/, '').trim();
  return text.length > 200 ? text.slice(0, 199) + '…' : text || undefined;
}

function firstMember(node) {
  return node.members?.[0] ?? null;
}

function doc(ts, node) {
  const comment = node.jsDoc?.[0]?.comment;
  const text = typeof comment === 'string' ? comment : comment ? ts.getTextOfJSDocComment(comment) : '';
  if (!text) return undefined;
  const first = text.split(/(?<=[.!?])\s|\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
  return first.length > 300 ? first.slice(0, 299) + '…' : first;
}

function containsCode(ts, node) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isAwaitExpression(n)) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}
