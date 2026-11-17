import { collectBody } from './bodies.mjs';
import { complexityOf } from './complexity.mjs';

/**
 * The declarations of one parsed file, in a plain form that outlives the tree (the tree is freed after each
 * file): namespaces, types with their members, free functions and out-of-line definitions (void Order::f()),
 * globals, aliases and `using` directives. Names are resolved later, across files (model.mjs).
 */

const TYPE_SPECIFIERS = new Set(['class_specifier', 'struct_specifier', 'union_specifier', 'enum_specifier']);
const KIND_OF = { class_specifier: 'class', struct_specifier: 'struct', union_specifier: 'union', enum_specifier: 'enum' };
const DOC_COMMENT = /^(\/\/\/|\/\/!|\/\*\*|\/\*!)/;

export function extractFile(tree, { annotations = [], sections = [], lines }) {
  const facts = {
    namespaces: [],
    types: [],
    functions: [],
    variables: [],
    aliases: [],
    usingNamespaces: [],
    usingNames: [],
    namespaceAliases: [],
    // Names passed to macros called at file level (SQLite's IOMETHODS(…, afpClose, …), BENCHMARK(BM_Parse)).
    macroArguments: [],
  };
  const pending = { annotations: annotations.map((a) => ({ ...a, claimed: false })), sections };
  const context = { facts, pending, lines };
  visitScope(tree.rootNode, { namespace: [], internal: false, template: 0 }, context);
  return facts;
}

/** Test macros written like a call followed by a block: Catch2 and doctest (TEST_CASE("…") { … }). */
const BLOCK_TESTS = new Set(['TEST_CASE', 'SCENARIO', 'TEST_CASE_METHOD', 'TEST_CASE_FIXTURE', 'TEMPLATE_TEST_CASE', 'TEMPLATE_PRODUCT_TEST_CASE', 'TEMPLATE_LIST_TEST_CASE', 'METHOD_AS_TEST_CASE', 'TEST_CASE_TEMPLATE']);
const BLOCK_SUITES = new Set(['TEST_SUITE', 'TEST_SUITE_BEGIN']);
/** Test macros written like a function definition: GoogleTest and Boost.Test (TEST(Suite, Name) { … }). */
const FUNCTION_TESTS = {
  TEST: { framework: 'gtest', fixture: false },
  GTEST_TEST: { framework: 'gtest', fixture: false },
  TEST_F: { framework: 'gtest', fixture: 0 },
  TEST_P: { framework: 'gtest', fixture: 0 },
  TYPED_TEST: { framework: 'gtest', fixture: 0 },
  TYPED_TEST_P: { framework: 'gtest', fixture: 0 },
  FRIEND_TEST: null,
  BOOST_AUTO_TEST_CASE: { framework: 'boost', fixture: false, single: true },
  BOOST_AUTO_TEST_CASE_TEMPLATE: { framework: 'boost', fixture: false, single: true },
  BOOST_DATA_TEST_CASE: { framework: 'boost', fixture: false, single: true },
  BOOST_FIXTURE_TEST_CASE: { framework: 'boost', fixture: 1, single: true },
};

/** A namespace-level (or extern "C") list of declarations. */
function visitScope(node, scope, context) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    const next = node.namedChild(i + 1);
    if (child.type === 'expression_statement' && next?.type === 'compound_statement' && blockTest(child, next, scope, context)) {
      i++;
      continue;
    }

    visitDeclaration(child, scope, context, null);
  }
}

/** TEST_CASE("name") { … } (and TEST_SUITE("x") { … } around such tests): a test function with that body. */
function blockTest(statement, block, scope, context) {
  const call = statement.namedChild(0);
  if (call?.type !== 'call_expression') return false;
  const macro = call.childForFieldName('function')?.text;
  if (BLOCK_SUITES.has(macro)) {
    visitScope(block, scope, context);
    return true;
  }

  if (!BLOCK_TESTS.has(macro)) return false;
  const args = call.childForFieldName('arguments')?.namedChildren ?? [];
  const title = args.find((a) => a.type === 'string_literal');
  const fixture = /METHOD|FIXTURE/.test(macro) && args[0]?.type === 'identifier' ? args[0].text : null;
  const name = title ? title.text.replace(/^"|"$/g, '') : `${macro}@${row(statement)}`;
  context.facts.functions.push({
    name,
    qualifiers: [],
    scope: scope.namespace,
    params: [],
    returns: null,
    modifiers: [],
    internal: false,
    definition: true,
    line: row(statement),
    endLine: endRow(block),
    complexity: complexityOf(block),
    template: 0,
    signature: oneLine(call.text).slice(0, 200),
    doc: docOf(statement),
    attributes: [],
    test: { framework: 'catch', fixture },
    body: collectBody(block),
  });
  return true;
}

function visitDeclaration(node, scope, context, template) {
  const { facts } = context;
  switch (node.type) {
    case 'namespace_definition': {
      const nameNode = node.childForFieldName('name');
      const body = node.childForFieldName('body');
      const inline = /^inline\b/.test(node.text);
      if (!nameNode) {
        // Anonymous: file-local, in the enclosing namespace.
        if (body) visitScope(body, { ...scope, internal: true }, context);
        return;
      }

      const parts = nameNode.text.split('::').map((p) => p.trim()).filter(Boolean);
      // An inline namespace (versioned ABIs: fmt::v10) is part of its parent, as callers see it.
      const namespace = inline ? scope.namespace : [...scope.namespace, ...parts];
      if (!inline) facts.namespaces.push({ path: namespace, line: row(node) });
      if (body) visitScope(body, { ...scope, namespace }, context);
      return;
    }

    case 'linkage_specification': {
      const body = node.childForFieldName('body');
      if (body?.type === 'declaration_list') visitScope(body, scope, context);
      else if (body) visitDeclaration(body, scope, context, template);
      return;
    }

    case 'template_declaration': {
      const parameters = node.childForFieldName('parameters');
      const count = parameters ? parameters.namedChildCount : 0;
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child.id !== parameters?.id) visitDeclaration(child, scope, context, { count, text: parameters?.text ?? '<>' });
      }

      return;
    }

    case 'function_definition':
      functionDefinition(node, scope, context, template);
      return;

    case 'declaration':
      declaration(node, scope, context, template);
      return;

    case 'type_definition':
      typeDefinition(node, scope, context);
      return;

    case 'alias_declaration':
      facts.aliases.push({ name: node.childForFieldName('name')?.text, target: node.childForFieldName('type')?.text, scope: scope.namespace, line: row(node), endLine: endRow(node), internal: scope.internal, signature: oneLine(node.text) });
      return;

    case 'using_declaration': {
      const text = oneLine(node.text);
      const m = /^using\s+namespace\s+([\w:]+)/.exec(text);
      if (m) facts.usingNamespaces.push({ scope: scope.namespace, target: m[1].replace(/^::/, ''), line: row(node) });
      else facts.usingNames.push({ scope: scope.namespace, name: text.replace(/^using\s+(typename\s+)?/, '').replace(/;$/, '').trim(), line: row(node) });
      return;
    }

    case 'namespace_alias_definition': {
      const name = node.childForFieldName('name')?.text;
      const target = node.namedChild(node.namedChildCount - 1)?.text;
      if (name && target) facts.namespaceAliases.push({ scope: scope.namespace, name, target: target.replace(/^::/, ''), line: row(node) });
      return;
    }

    case 'class_specifier':
    case 'struct_specifier':
    case 'union_specifier':
    case 'enum_specifier':
      typeSpecifier(node, scope, context, null, template, null);
      return;

    case 'expression_statement': {
      // A macro called at file level: the functions it names are used by the code it expands to.
      const call = node.namedChild(0);
      if (call?.type === 'call_expression') identifiersIn(call.childForFieldName('arguments'), context.facts.macroArguments);
      return;
    }

    case 'ERROR':
      // Code the grammar could not place (macros at file level): what it holds may still be declarations.
      visitScope(node, scope, context);
      return;

    default:
      return;
  }
}

/** class / struct / union / enum with a body (a definition); `owner` is the enclosing type when nested. */
function typeSpecifier(node, scope, context, owner, template, access) {
  const body = node.childForFieldName('body');
  const nameNode = node.childForFieldName('name');
  if (!body) return null; // a forward declaration or a use (`struct node *next`)
  const kind = KIND_OF[node.type];
  const rawName = nameNode?.text ?? null;
  const type = {
    kind,
    name: rawName ? lastName(rawName) : null,
    qualifiers: rawName && rawName.includes('::') ? rawName.split('::').slice(0, -1).map((s) => s.trim()) : [],
    scope: scope.namespace,
    owner: owner ? owner.path : null,
    path: null,
    line: row(node),
    endLine: endRow(node),
    access: access ?? null,
    internal: scope.internal,
    template: template ? template.count : 0,
    templateText: template?.text ?? null,
    bases: [],
    members: [],
    nested: [],
    modifiers: [],
    attributes: claim(context, row(node)),
    doc: docOf(node),
    signature: null,
    enumerators: 0,
    scoped: kind === 'enum' && /^enum\s+(class|struct)\b/.test(node.text),
  };
  if (/\bfinal\b/.test(headText(node, body))) type.modifiers.push('sealed');
  type.signature = oneLine((template ? `template${template.text} ` : '') + headText(node, body));

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child.type === 'base_class_clause') type.bases = bases(child);
  }

  if (kind === 'enum') {
    type.enumerators = body.namedChildren.filter((c) => c.type === 'enumerator').length;
  } else {
    type.path = [...(owner ? owner.path : []), type.name ?? `(anonymous@${type.line})`];
    classBody(body, type, scope, context);
  }

  if (owner) owner.nested.push(type);
  else context.facts.types.push(type);
  return type;
}

function classBody(body, type, scope, context) {
  let access = type.kind === 'class' ? 'private' : 'public';
  let section = null;
  // Qt properties: Q_PROPERTY(type name READ getter WRITE setter NOTIFY signal …) in the body.
  for (const a of context.pending.annotations) {
    if (a.name !== 'Q_PROPERTY' || a.claimed || a.line < row(body) || a.line > endRow(body)) continue;
    a.claimed = true;
    const m = /^(.*?)\s*\b(\w+)\s+(?=(?:READ|WRITE|MEMBER|NOTIFY|RESET|BINDABLE|CONSTANT|FINAL|STORED|DESIGNABLE|SCRIPTABLE|USER|REQUIRED|REVISION)\b)/.exec(a.args);
    if (!m) continue;
    const part = (key) => new RegExp(`\\b${key}\\s+(\\w+)`).exec(a.args)?.[1] ?? null;
    type.members.push({ kind: 'property', name: m[2], type: normalizeType(m[1]), access: 'public', modifiers: [], line: a.line, endLine: a.line, signature: `Q_PROPERTY(${a.args})`, doc: null, attributes: [], read: part('READ'), write: part('WRITE'), notify: part('NOTIFY'), member: part('MEMBER') });
  }

  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    switch (child.type) {
      case 'access_specifier': {
        access = child.text.replace(/\s|:/g, '');
        const at = context.pending.sections.find((s) => s.line === row(child));
        section = at ? at.kind : null;
        break;
      }

      case 'field_declaration':
        fieldDeclaration(child, type, scope, context, access, section, null);
        break;
      case 'function_definition':
        member(child, type, context, access, section, null, true);
        break;
      case 'declaration':
        member(child, type, context, access, section, null, false);
        break;
      case 'template_declaration': {
        const parameters = child.childForFieldName('parameters');
        const template = { count: parameters ? parameters.namedChildCount : 0, text: parameters?.text ?? '<>' };
        for (let k = 0; k < child.namedChildCount; k++) {
          const inner = child.namedChild(k);
          if (inner.id === parameters?.id) continue;
          if (inner.type === 'function_definition') member(inner, type, context, access, section, template, true);
          else if (inner.type === 'declaration' || inner.type === 'field_declaration') fieldDeclaration(inner, type, scope, context, access, section, template);
          else if (TYPE_SPECIFIERS.has(inner.type)) typeSpecifier(inner, scope, context, type, template, access);
        }

        break;
      }

      case 'friend_declaration':
        type.friends ??= [];
        type.friends.push(oneLine(child.text).replace(/^friend\s+/, '').replace(/;$/, ''));
        break;
      case 'class_specifier':
      case 'struct_specifier':
      case 'union_specifier':
      case 'enum_specifier':
        typeSpecifier(child, scope, context, type, null, access);
        break;
      default:
        break;
    }
  }
}

/** A field_declaration: data members, method declarations, or a nested type (with or without fields of it). */
function fieldDeclaration(node, type, scope, context, access, section, template) {
  const typeNode = node.childForFieldName('type');
  if (typeNode && TYPE_SPECIFIERS.has(typeNode.type) && typeNode.childForFieldName('body')) {
    typeSpecifier(typeNode, scope, context, type, template, access);
  }

  const declarators = node.childrenForFieldName('declarator');
  if (!declarators.length) return;
  if (declarators.some((d) => functionDeclarator(d))) {
    member(node, type, context, access, section, template, false);
    return;
  }

  const modifiers = specifiers(node);
  const attributes = claim(context, row(node));
  for (const declarator of declarators) {
    const name = declaratorName(declarator);
    if (!name) continue;
    type.members.push({
      kind: 'field',
      name,
      type: typeText(typeNode, declarator),
      access,
      modifiers,
      line: row(node),
      endLine: endRow(node),
      signature: oneLine(node.text).replace(/;$/, ''),
      doc: docOf(node),
      attributes,
    });
  }
}

/** A method, constructor, destructor or operator declared or defined in a class body. */
function member(node, type, context, access, section, template, hasBody) {
  const declarator = functionDeclaratorOf(node);
  if (!declarator) {
    if (node.type === 'declaration') fieldLike(node, type, context, access);
    return;
  }

  const nameNode = declarator.childForFieldName('declarator');
  const name = functionName(nameNode, node);
  if (!name) return;
  const parameters = params(declarator.childForFieldName('parameters'));
  const modifiers = functionModifiers(node);
  const tail = declaratorTail(declarator);
  if (tail.const) modifiers.push('const');
  if (tail.override) modifiers.push('override');
  if (tail.final) modifiers.push('sealed');
  const pure = node.type === 'field_declaration' && node.childForFieldName('default_value')?.text === '0';
  if (pure) modifiers.push('abstract');
  if (section === 'signals') modifiers.push('signal');
  const body = node.childForFieldName('body');
  const kind = name.startsWith('~') ? 'destructor' : name === type.name && !node.childForFieldName('type') ? 'constructor' : 'method';
  type.members.push({
    kind,
    name,
    params: parameters,
    returns: returnType(node, declarator),
    access,
    section,
    modifiers: [...new Set(modifiers)],
    line: row(node),
    endLine: endRow(node),
    hasBody: Boolean(body),
    defaulted: Boolean(node.namedChildren.find((c) => c.type === 'default_method_clause' || c.type === 'delete_method_clause')),
    deleted: Boolean(node.namedChildren.find((c) => c.type === 'delete_method_clause')),
    complexity: body ? complexityOf(body) + complexityOf(node.namedChildren.find((c) => c.type === 'field_initializer_list')) : null,
    template: template ? template.count : 0,
    signature: signatureOf(node, body),
    doc: docOf(node),
    attributes: claim(context, row(node)),
    body: body ? collectBody(body, [node.namedChildren.find((c) => c.type === 'field_initializer_list')], parameters) : null,
  });
}

/** `explicit operator bool() const;` and other declarations without a function declarator: kept as fields when named. */
function fieldLike(node, type, context, access) {
  const declarators = node.childrenForFieldName('declarator');
  for (const declarator of declarators) {
    const name = declaratorName(declarator);
    if (!name) continue;
    type.members.push({ kind: 'field', name, type: typeText(node.childForFieldName('type'), declarator), access, modifiers: specifiers(node), line: row(node), endLine: endRow(node), signature: oneLine(node.text).replace(/;$/, ''), doc: docOf(node), attributes: claim(context, row(node)) });
  }
}

/** A function defined at namespace scope: a free function, or a member defined out of its class (`Order::f`). */
function functionDefinition(node, scope, context, template) {
  const declarator = functionDeclaratorOf(node);
  if (!declarator) return;
  const nameNode = declarator.childForFieldName('declarator');
  const qualified = qualifiedName(nameNode);
  if (!qualified) return;
  const body = node.childForFieldName('body');
  const modifiers = functionModifiers(node);
  const tail = declaratorTail(declarator);
  if (tail.const) modifiers.push('const');
  const parameters = params(declarator.childForFieldName('parameters'));
  const macro = !node.childForFieldName('type') && !qualified.qualifiers.length ? FUNCTION_TESTS[qualified.name] : undefined;
  if (macro !== undefined) {
    if (!macro) return; // FRIEND_TEST and the like declare nothing of their own
    const args = parameters.map((p) => p.type);
    const name = macro.single ? args[0] : `${args[0]}.${args[1]}`;
    const fixture = macro.fixture === false ? null : args[macro.fixture];
    context.facts.functions.push({
      name: name ?? qualified.name,
      qualifiers: [],
      scope: scope.namespace,
      params: [],
      returns: null,
      modifiers: [],
      internal: false,
      definition: true,
      line: row(node),
      endLine: endRow(node),
      complexity: body ? complexityOf(body) : 0,
      template: 0,
      signature: signatureOf(node, body),
      doc: docOf(node),
      attributes: claim(context, row(node)),
      test: { framework: macro.framework, fixture },
      body: body ? collectBody(body) : null,
    });
    return;
  }

  context.facts.functions.push({
    name: qualified.name,
    qualifiers: qualified.qualifiers,
    scope: scope.namespace,
    params: parameters,
    body: body ? collectBody(body, [node.namedChildren.find((c) => c.type === 'field_initializer_list')], parameters) : null,
    returns: returnType(node, declarator),
    modifiers: [...new Set(modifiers)],
    internal: scope.internal || modifiers.includes('static') && !qualified.qualifiers.length,
    definition: true,
    line: row(node),
    endLine: endRow(node),
    complexity: body ? complexityOf(body) + complexityOf(node.namedChildren.find((c) => c.type === 'field_initializer_list')) : 1,
    template: template ? template.count : 0,
    signature: signatureOf(node, body),
    doc: docOf(node),
    attributes: claim(context, row(node)),
    noBody: !body,
  });
}

/** A declaration at namespace scope: function prototypes, globals (with their initializers), types declared in it. */
function declaration(node, scope, context, template) {
  const typeNode = node.childForFieldName('type');
  if (typeNode && TYPE_SPECIFIERS.has(typeNode.type) && typeNode.childForFieldName('body')) typeSpecifier(typeNode, scope, context, null, template, null);
  const modifiers = specifiers(node);
  for (const declarator of node.childrenForFieldName('declarator')) {
    const fn = functionDeclarator(declarator);
    if (fn) {
      const qualified = qualifiedName(fn.childForFieldName('declarator'));
      if (!qualified) continue;
      const tail = declaratorTail(fn);
      context.facts.functions.push({
        name: qualified.name,
        qualifiers: qualified.qualifiers,
        scope: scope.namespace,
        params: params(fn.childForFieldName('parameters')),
        returns: returnType(node, fn),
        modifiers: [...new Set([...modifiers.filter((m) => m !== 'const'), ...(tail.const ? ['const'] : [])])],
        internal: scope.internal || modifiers.includes('static') && !qualified.qualifiers.length,
        definition: false,
        line: row(node),
        endLine: endRow(node),
        complexity: null,
        template: template ? template.count : 0,
        signature: oneLine(node.text).replace(/;$/, ''),
        doc: docOf(node),
        attributes: claim(context, row(node)),
      });
      continue;
    }

    const name = declaratorName(declarator);
    if (!name) continue;
    const init = declarator.type === 'init_declarator' ? declarator.childForFieldName('value') : null;
    context.facts.variables.push({
      name: lastName(name),
      qualifiers: name.includes('::') ? name.split('::').slice(0, -1) : [],
      scope: scope.namespace,
      type: typeText(typeNode, declarator),
      modifiers,
      internal: scope.internal || modifiers.includes('static'),
      extern: modifiers.includes('extern') && !init,
      line: row(node),
      endLine: endRow(node),
      complexity: init ? complexityOf(init) : 0,
      // What the initializer names: a table of callbacks, a factory called once.
      body: init ? collectBody(null, [init]) : null,
      signature: oneLine(node.text).replace(/;$/, '').slice(0, 200),
      doc: docOf(node),
      attributes: claim(context, row(node)),
    });
  }
}

/** typedef: `typedef struct {…} name;` names the struct; other typedefs are aliases. */
function typeDefinition(node, scope, context) {
  const typeNode = node.childForFieldName('type');
  const declarators = node.childrenForFieldName('declarator');
  let defined = null;
  if (typeNode && TYPE_SPECIFIERS.has(typeNode.type) && typeNode.childForFieldName('body')) {
    defined = typeSpecifier(typeNode, scope, context, null, null, null);
  }

  for (const declarator of declarators) {
    const name = declaratorName(declarator);
    if (!name) continue;
    if (defined && !defined.name && declarator.type === 'type_identifier') {
      defined.name = name;
      defined.path = [name];
      continue;
    }

    if (defined && defined.name === name) continue; // typedef struct node {…} node;
    context.facts.aliases.push({ name, target: defined ? defined.name : typeText(typeNode, declarator), scope: scope.namespace, line: row(node), endLine: endRow(node), internal: scope.internal, signature: oneLine(node.text).replace(/;$/, '').slice(0, 200) });
  }
}

// ---------------------------------------------------------------------------------------------- helpers

function bases(clause) {
  const out = [];
  let access = null;
  let virtual = false;
  for (let i = 0; i < clause.childCount; i++) {
    const c = clause.child(i);
    if (c.type === 'access_specifier') access = c.text;
    else if (c.type === 'virtual') virtual = true;
    else if (c.type === ',' || c.type === ':') {
      if (c.type === ',') {
        access = null;
        virtual = false;
      }
    } else if (c.isNamed) {
      out.push({ text: oneLine(c.text), access, virtual });
    }
  }

  return out;
}

function functionDeclaratorOf(node) {
  for (const declarator of node.childrenForFieldName('declarator')) {
    const fn = functionDeclarator(declarator);
    if (fn) return fn;
  }

  return null;
}

function identifiersIn(node, out) {
  if (!node) return;
  if (node.type === 'identifier') out.push(node.text);
  for (let i = 0; i < node.namedChildCount; i++) identifiersIn(node.namedChild(i), out);
}

/** The function_declarator under pointer / reference declarators (`const T& get()` → get()). */
function functionDeclarator(declarator) {
  let d = declarator;
  while (d) {
    if (d.type === 'function_declarator') {
      // `int (*fp)(int)` declares a pointer, not a function; `int (*compareFor(int key))(const void*)` is a
      // function returning one (SQLite's ftsCompareFunction): the function is the declarator inside.
      const inner = d.childForFieldName('declarator');
      if (inner?.type === 'parenthesized_declarator') {
        let e = inner.namedChild(0);
        while (e && (e.type === 'pointer_declarator' || e.type === 'reference_declarator' || e.type === 'parenthesized_declarator')) {
          e = e.type === 'parenthesized_declarator' ? e.namedChild(0) : e.childForFieldName('declarator');
        }

        return e?.type === 'function_declarator' ? functionDeclarator(e) : null;
      }

      return d;
    }

    if (d.type === 'pointer_declarator' || d.type === 'reference_declarator' || d.type === 'attributed_declarator') {
      d = d.childForFieldName('declarator') ?? d.namedChild(d.namedChildCount - 1);
    } else {
      return null;
    }
  }

  return null;
}

/** Name of a declared thing (variable, field, alias): the identifier under pointer / array / init declarators. */
function declaratorName(declarator) {
  let d = declarator;
  for (let guard = 0; d && guard < 20; guard++) {
    switch (d.type) {
      case 'identifier':
      case 'field_identifier':
      case 'type_identifier':
        return d.text;
      case 'qualified_identifier':
        return oneLine(d.text);
      case 'init_declarator':
      case 'pointer_declarator':
      case 'reference_declarator':
      case 'array_declarator':
      case 'attributed_declarator':
        d = d.childForFieldName('declarator') ?? d.namedChild(0);
        break;
      case 'parenthesized_declarator':
        d = d.namedChild(0);
        break;
      case 'function_declarator':
        d = d.childForFieldName('declarator');
        break;
      default:
        return null;
    }
  }

  return null;
}

/** The name a function declarator gives: identifier, ~Name, operator==, operator bool. */
function functionName(nameNode, declaration) {
  if (!nameNode) {
    const cast = declaration.namedChildren.find((c) => c.type === 'operator_cast');
    return cast ? 'operator ' + oneLine(cast.childForFieldName('type')?.text ?? '') : null;
  }

  switch (nameNode.type) {
    case 'identifier':
    case 'field_identifier':
      return nameNode.text;
    case 'destructor_name':
      return '~' + nameNode.text.replace(/^~\s*/, '');
    case 'operator_name':
      return oneLine(nameNode.text).replace(/^operator\s*/, 'operator');
    case 'template_function':
    case 'template_method':
      return nameNode.childForFieldName('name')?.text ?? null;
    case 'qualified_identifier':
      return qualifiedName(nameNode)?.name ?? null;
    case 'operator_cast':
      return 'operator ' + oneLine(nameNode.childForFieldName('type')?.text ?? '');
    default:
      return null;
  }
}

/** `a::B::f` → qualifiers [a, B] and name f (also ~B, operator==, B<T>::f). */
function qualifiedName(node) {
  if (!node) return null;
  const qualifiers = [];
  let d = node;
  for (let guard = 0; d && d.type === 'qualified_identifier' && guard < 20; guard++) {
    const scopeNode = d.childForFieldName('scope');
    if (scopeNode) qualifiers.push(scopeNode.type === 'template_type' ? scopeNode.childForFieldName('name')?.text ?? scopeNode.text : scopeNode.text);
    d = d.childForFieldName('name');
  }

  const name = d ? functionName(d, d) : null;
  if (!name) return null;
  return { name, qualifiers: qualifiers.flatMap((q) => q.split('::')).map((q) => q.trim()).filter(Boolean) };
}

/** const / override / final after the parameters. */
function declaratorTail(declarator) {
  const tail = { const: false, override: false, final: false };
  for (let i = 0; i < declarator.namedChildCount; i++) {
    const c = declarator.namedChild(i);
    if (c.type === 'type_qualifier' && c.text === 'const') tail.const = true;
    else if (c.type === 'virtual_specifier') {
      if (c.text === 'override') tail.override = true;
      if (c.text === 'final') tail.final = true;
    }
  }

  return tail;
}

/** Storage and function specifiers: static, virtual, inline, constexpr, explicit, extern, const (of the type)… */
function specifiers(node) {
  const out = [];
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    const type = c.type;
    if (type === 'storage_class_specifier' || type === 'type_qualifier' || type === 'virtual' || type === 'explicit_function_specifier' || type === 'virtual_function_specifier') {
      const text = c.text.trim();
      if (text === 'register' || text === 'mutable' || text === 'volatile' || text === 'restrict') continue;
      out.push(text.startsWith('explicit') ? 'explicit' : text === 'constinit' ? 'constexpr' : text);
    } else if (type === 'attribute_declaration' && /nodiscard/.test(c.text)) {
      out.push('nodiscard');
    }
  }

  return out;
}

/** A function's own modifiers: `const` before the type belongs to the return type, not the function. */
function functionModifiers(node) {
  return specifiers(node).filter((m) => m !== 'const');
}

/** Parameters: type as written (no name, no default), and whether it has a default. */
function params(list) {
  if (!list) return [];
  const out = [];
  for (let i = 0; i < list.namedChildCount; i++) {
    const p = list.namedChild(i);
    if (p.type === 'variadic_parameter' || p.type === 'variadic_parameter_declaration' && !p.childForFieldName('declarator')) {
      out.push({ type: '...', optional: true });
      continue;
    }

    if (p.type !== 'parameter_declaration' && p.type !== 'optional_parameter_declaration' && p.type !== 'variadic_parameter_declaration') continue;
    const declarator = p.childForFieldName('declarator');
    const name = declarator ? innermostIdentifier(declarator) : null;
    const value = p.childForFieldName('default_value');
    let text = p.text;
    const start = p.startIndex;
    const cut = [];
    if (value) cut.push([value.startIndex - start, value.endIndex - start]);
    if (name) cut.push([name.startIndex - start, name.endIndex - start]);
    cut.sort((a, b) => b[0] - a[0]);
    for (const [from, to] of cut) text = text.slice(0, from) + text.slice(to);
    text = normalizeType(text.replace(/=\s*$/, ''));
    if (text === 'void' && list.namedChildCount === 1) return [];
    out.push({ type: text, name: name?.text ?? null, optional: Boolean(value) });
  }

  return out;
}

function innermostIdentifier(declarator) {
  let d = declarator;
  for (let guard = 0; d && guard < 20; guard++) {
    if (d.type === 'identifier' || d.type === 'field_identifier') return d;
    const wrapper = ['parenthesized_declarator', 'pointer_declarator', 'reference_declarator', 'array_declarator', 'attributed_declarator', 'init_declarator'].includes(d.type);
    const next = d.childForFieldName('declarator') ?? (wrapper ? d.namedChildren.find((c) => c.type.endsWith('declarator') || c.type === 'identifier') : null);
    if (!next) return null;
    d = next;
  }

  return null;
}

/** A type as text without spaces that do not matter: `const Product &` → `const Product&`. */
export function normalizeType(text) {
  return oneLine(text)
    .replace(/\s*([*&,<>()[\]:])\s*/g, '$1')
    .replace(/>>/g, '> >')
    .replace(/> >/g, '>>')
    .trim();
}

/** The declared type of a variable or field: the type plus the declarator's pointers / references / arrays. */
function typeText(typeNode, declarator) {
  let text = typeNode ? typeNode.text : '';
  let d = declarator;
  for (let guard = 0; d && guard < 20; guard++) {
    if (d.type === 'pointer_declarator') text += '*';
    else if (d.type === 'reference_declarator') text += d.text.trimStart().startsWith('&&') ? '&&' : '&';
    else if (d.type === 'array_declarator') text += '[]';
    else if (d.type !== 'init_declarator' && d.type !== 'attributed_declarator') break;
    d = d.childForFieldName('declarator') ?? d.namedChild(0);
  }

  return normalizeType(text);
}

/** The return type of a function: its type, with the pointers and references around its declarator. */
function returnType(node, declarator) {
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return null;
  let text = typeNode.text;
  const qualifiers = node.namedChildren.filter((c) => c.type === 'type_qualifier' && c.endIndex <= typeNode.startIndex).map((c) => c.text);
  if (qualifiers.length) text = qualifiers.join(' ') + ' ' + text;
  let d = node.childForFieldName('declarator');
  for (let guard = 0; d && declarator && d.id !== declarator.id && guard < 20; guard++) {
    if (d.type === 'pointer_declarator') text += '*';
    else if (d.type === 'reference_declarator') text += d.text.trimStart().startsWith('&&') ? '&&' : '&';
    d = d.childForFieldName('declarator') ?? d.namedChild(d.namedChildCount - 1);
  }

  return normalizeType(text);
}

/** The declaration as written up to its body (or all of it), on one line. */
function signatureOf(node, body) {
  const text = body ? node.text.slice(0, body.startIndex - node.startIndex) : node.text;
  return oneLine(text).replace(/[;{]\s*$/, '').replace(/:\s*$/, '').trim().slice(0, 200);
}

function headText(node, body) {
  return node.text.slice(0, body.startIndex - node.startIndex);
}

// The first sentence of a doc comment right above it: ///, //!, /** … */ or /*! … */.
function docOf(node) {
  const comments = [];
  let previous = node.previousNamedSibling ?? node.parent?.previousNamedSibling;
  let line = row(node);
  if (node.parent && ['template_declaration', 'declaration', 'field_declaration', 'type_definition'].includes(node.parent.type) && node.parent.startIndex === node.startIndex) {
    previous = node.parent.previousNamedSibling;
  } else if (node.parent?.type === 'template_declaration') {
    previous = node.parent.previousNamedSibling;
    line = row(node.parent);
  }

  // Lines between the comment and the declaration may hold annotations blanked out (UCLASS(…) above a class).
  for (let p = previous, gap = 3; p && p.type === 'comment'; p = p.previousNamedSibling, gap = 1) {
    if (endRow(p) < line - gap) break;
    if (!DOC_COMMENT.test(p.text)) break;
    comments.unshift(p.text);
    line = row(p);
  }

  if (!comments.length) return null;
  const text = comments.join(' ')
    .replace(/^\s*(\/\/\/<?|\/\/!<?|\/\*\*<?|\/\*!<?)/gm, ' ')
    .replace(/\*\/\s*$/gm, ' ')
    .replace(/^\s*\*+/gm, ' ')
    .replace(/[@\\](brief|short)\b/g, ' ')
    .replace(/[@\\](param|return|returns|tparam|throws|see|note)\b.*$/s, ' ');
  const plain = oneLine(text.replace(/\/\/\/|\/\/!/g, ' '));
  const sentence = /^(.+?[.!?])(\s|$)/.exec(plain)?.[1] ?? plain;
  return sentence ? sentence.slice(0, 300) : null;
}

/** Annotations (UPROPERTY, Q_INVOKABLE…) written on the declaration's line or the few lines above it. */
function claim(context, line) {
  const out = [];
  for (const a of context.pending.annotations) {
    if (a.claimed || a.line > line || a.name === 'Q_PROPERTY') continue;
    if (a.line < line - 6) {
      a.claimed = true;
      continue;
    }

    a.claimed = true;
    out.push(a.args ? `${a.name}(${a.args})` : a.name);
  }

  return out;
}

export function lastName(name) {
  const parts = name.split('::');
  return parts[parts.length - 1].trim();
}

export function oneLine(text) {
  return text.replace(/\s+/g, ' ').trim();
}

const row = (node) => node.startPosition.row + 1;
const endRow = (node) => node.endPosition.row + 1;
