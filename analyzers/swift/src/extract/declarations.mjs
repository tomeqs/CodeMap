import { expr, implicitOf, readBody as readRefs } from './bodies.mjs';
import { complexityOf } from './complexity.mjs';

/**
 * The declarations of a Swift file, from its syntax tree:
 *   { imports, types: [TypeDecl], functions, variables, aliases: [MemberDecl], topLevel: { line, endLine, complexity } }
 *   TypeDecl   = { kind: class | struct | enum | actor | protocol | extension, name (dotted for an extension), access,
 *                  modifiers, attributes, bases: [{ text, name }], generics, where, doc, signature, line, endLine,
 *                  members: [MemberDecl], nested: [TypeDecl], cases: [{ name, labels }] }
 *   MemberDecl = { kind: method | constructor | property | field | typeAlias (variable, function at the top),
 *                  name, labels, params: [{ label, name, type, optional, variadic }], returns, type, access,
 *                  modifiers, attributes, doc, signature, line, endLine, complexity, init }
 * `#if` blocks are flat markers in the tree, so the declarations of every branch are read.
 */
export function extractFile(tree) {
  const facts = { imports: [], types: [], functions: [], variables: [], aliases: [], topLevel: null, previews: null };
  const statements = [];
  const previews = [];
  eachDeclaration(tree.rootNode, (node, doc) => {
    switch (node.type) {
      case 'import_declaration': {
        const name = node.namedChildren.find((c) => c.type === 'identifier')?.text.split('.')[0];
        if (name) facts.imports.push(name);
        return;
      }

      case 'class_declaration':
      case 'protocol_declaration':
        facts.types.push(readType(node, doc));
        return;
      case 'function_declaration':
        facts.functions.push(readFunction(node, doc, 'function', null));
        return;
      case 'property_declaration':
        facts.variables.push(...readProperties(node, doc, 'variable', null));
        return;
      case 'typealias_declaration':
        facts.aliases.push(readAlias(node, doc, null));
        return;
      case 'macro_invocation':
        // #Preview { … }: the views it shows are used by it.
        if (/^#Preview\b/.test(node.text)) {
          previews.push(node);
          return;
        }

        break;
      case 'operator_declaration':
      case 'precedence_group_declaration':
      case 'macro_declaration':
      case 'directive':
      case 'diagnostic':
        return;
      default: {
        // Code at the top of the file (main.swift, scripts).
        const line = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        const top = (facts.topLevel ??= { line, endLine, complexity: 0 });
        top.endLine = Math.max(top.endLine, endLine);
        top.complexity += complexityOf(node);
        statements.push(node);
      }
    }
  });
  if (facts.topLevel) Object.assign(facts.topLevel, readRefs(statements));
  if (previews.length) {
    facts.previews = { line: previews[0].startPosition.row + 1, endLine: previews[previews.length - 1].endPosition.row + 1, ...readRefs(previews) };
  }
  return facts;
}

/** The named children of a file or a body, each with the doc comment (/// or /** *\/) right before it. */
function eachDeclaration(parent, visit) {
  let doc = [];
  for (const node of parent.namedChildren) {
    if (node.type === 'comment' || node.type === 'multiline_comment') {
      if (/^\/\/\/|^\/\*\*/.test(node.text)) doc.push(node.text);
      else doc = [];
      continue;
    }

    visit(node, doc.length ? docText(doc) : undefined);
    doc = [];
  }
}

function docText(comments) {
  const text = comments
    .map((c) => c.replace(/^\/\*\*+/, '').replace(/\*+\/$/, '').split('\n').map((l) => l.replace(/^\s*(\/\/\/|\*(?!\/))\s?/, '')).join('\n'))
    .join('\n')
    .trim();
  return text ? text.slice(0, 1000) : undefined;
}

// ------------------------------------------------------------------------------------------------- types

const TYPE_KINDS = new Set(['class', 'struct', 'enum', 'actor', 'extension', 'protocol']);

function readType(node, doc) {
  const kindNode = node.childForFieldName('declaration_kind');
  const kind = TYPE_KINDS.has(kindNode?.type) ? kindNode.type : node.type === 'protocol_declaration' ? 'protocol' : 'class';
  const nameNode = node.childForFieldName('name');
  const { access, modifiers, attributes } = readModifiers(node);
  const body = node.childForFieldName('body');
  const decl = {
    kind,
    name: kind === 'extension' ? typeName(nameNode) : unquote(nameNode?.text ?? ''),
    access,
    modifiers,
    attributes,
    bases: node.namedChildren.filter((c) => c.type === 'inheritance_specifier').map((s) => {
      const type = s.childForFieldName('inherits_from') ?? s.namedChildren[0];
      return { text: type?.text ?? s.text, name: typeName(type) };
    }),
    generics: node.namedChildren.find((c) => c.type === 'type_parameters')?.text,
    where: node.namedChildren.find((c) => c.type === 'type_constraints')?.text,
    doc,
    signature: signatureOf(node, body),
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    members: [],
    nested: [],
    cases: [],
  };

  if (body) readBody(body, decl);
  return decl;
}

function readBody(body, decl) {
  const inProtocol = decl.kind === 'protocol';
  eachDeclaration(body, (node, doc) => {
    switch (node.type) {
      case 'function_declaration':
      case 'protocol_function_declaration':
        decl.members.push(readFunction(node, doc, 'method', decl));
        return;
      case 'init_declaration':
        decl.members.push(readFunction(node, doc, 'constructor', decl));
        return;
      case 'deinit_declaration':
        decl.members.push(readFunction(node, doc, 'deinit', decl));
        return;
      case 'subscript_declaration':
        decl.members.push(readFunction(node, doc, 'subscript', decl));
        return;
      case 'property_declaration':
      case 'protocol_property_declaration':
        decl.members.push(...readProperties(node, doc, inProtocol ? 'property' : 'field', decl));
        return;
      case 'typealias_declaration':
        decl.members.push(readAlias(node, doc, decl));
        return;
      case 'associatedtype_declaration': {
        const alias = readAlias(node, doc, decl);
        alias.modifiers.push('associatedtype');
        decl.members.push(alias);
        return;
      }

      case 'class_declaration':
      case 'protocol_declaration':
        decl.nested.push(readType(node, doc));
        return;
      case 'enum_entry':
        for (const name of node.childrenForFieldName('name')) {
          if (name.type !== 'simple_identifier') continue;
          const data = node.childForFieldName('data_contents');
          decl.cases.push({ name: unquote(name.text), labels: data ? caseLabels(data) : null, line: node.startPosition.row + 1 });
        }

        return;
      default:
    }
  });
}

/** `case shipped(at: Date, Int)` → ['at', '_'] */
function caseLabels(data) {
  const labels = [];
  let label = null;
  for (const child of data.namedChildren) {
    if (child.type === 'simple_identifier') label = child.text;
    else if (!/comment/.test(child.type)) {
      labels.push(label ?? '_');
      label = null;
    }
  }

  return labels;
}

/** A name without the backticks that let a keyword be one: `default` → default. */
export const unquote = (name) => name.replace(/`/g, '');

/** A type's name as written, without its generic arguments: Order, Order.Line, Array. */
export function typeName(node) {
  if (!node) return '';
  if (node.type === 'user_type') {
    const parts = node.namedChildren.filter((c) => c.type === 'type_identifier').map((c) => unquote(c.text));
    if (parts.length) return parts.join('.');
  }

  return node.text.replace(/<[^]*>/, '').replace(/\s+/g, '');
}

// ------------------------------------------------------------------------------------------------ members

const ACCESS = { open: 'public', public: 'public', package: 'internal', internal: 'internal', fileprivate: 'private', private: 'private' };
const KEPT = new Set(['open', 'package', 'fileprivate']);

/**
 * Access, modifiers and attributes. Swift's open and package are public and internal, fileprivate is private; they
 * stay as modifiers too. `private(set)` limits the setter only: a modifier.
 */
export function readModifiers(node) {
  const modifiers = new Set();
  const attributes = [];
  let access = null;
  const take = (child) => {
    if (child.type === 'attribute') {
      const name = child.namedChildren.find((c) => c.type === 'user_type')?.text ?? child.text.replace(/^@/, '').replace(/\(.*$/s, '');
      attributes.push(name);
    } else if (child.type === 'visibility_modifier') {
      const text = child.text.replace(/\s+/g, '');
      if (/\(set\)$/.test(text)) modifiers.add(text);
      else if (ACCESS[text]) {
        access = ACCESS[text];
        if (KEPT.has(text)) modifiers.add(text);
      }
    } else if (/_modifier$/.test(child.type)) {
      modifiers.add(child.text.replace(/\(.*\)$/, '').trim());
    }
  };
  // Only what comes before the declaration: `@unchecked Sendable` in a type's bases and `@escaping` on a
  // parameter are not the declaration's attributes.
  for (const child of node.children) {
    if (child.type === 'modifiers') for (const m of child.namedChildren) take(m);
    else if (child.type === 'attribute') take(child);
    else if (!/comment/.test(child.type)) break;
  }

  return { access, modifiers: [...modifiers], attributes };
}

function readFunction(node, doc, kind, owner) {
  const { access, modifiers: base, attributes } = readModifiers(node);
  const modifiers = new Set(base);
  let name;
  if (kind === 'constructor') name = 'init';
  else if (kind === 'deinit') name = 'deinit';
  else if (kind === 'subscript') name = 'subscript';
  else {
    const field = node.childrenForFieldName('name').find((c) => c.type === 'simple_identifier');
    name = unquote(field?.text ?? /func\s+([^\s(<]+)/.exec(node.text)?.[1] ?? '?');
  }

  const params = [];
  const children = node.children;
  let returns = null;
  let body = null;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === 'parameter') params.push(readParameter(child, kind === 'subscript'));
    else if (node.fieldNameForChild(i) === 'default_value' && params.length) params[params.length - 1].optional = true;
    else if (child.type === 'async') modifiers.add('async');
    else if (child.type === 'throws' || child.type === 'throws_clause') modifiers.add(child.text.startsWith('rethrows') ? 'rethrows' : 'throws');
    else if (child.type === 'class' && kind === 'method') modifiers.add('static');
    else if (child.type === '->') returns = children.slice(i + 1).find((c) => c.isNamed && c.type !== 'comment')?.text ?? null;
    else if (child.type === 'function_body' || child.type === 'computed_property') body = child;
  }

  if (modifiers.has('class')) {
    modifiers.delete('class');
    modifiers.add('static');
  }

  if (/^init[?!]/.test(node.text.replace(/^[^]*?\binit\b/, 'init'))) modifiers.add('failable');
  const { refs, locals } = body ? readRefs([body], params) : { refs: [], locals: {} };
  return {
    refs,
    locals,
    generics: node.namedChildren.find((c) => c.type === 'type_parameters')?.text,
    where: node.namedChildren.find((c) => c.type === 'type_constraints')?.text,
    kind: kind === 'deinit' ? 'method' : kind === 'subscript' ? 'property' : kind,
    name,
    labels: params.map((p) => p.label),
    params,
    returns,
    access,
    modifiers: [...modifiers],
    attributes,
    doc,
    signature: signatureOf(node, body),
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    complexity: body ? complexityOf(body) : null,
    requirement: !body && (owner?.kind === 'protocol' || node.type === 'protocol_function_declaration'),
    owner: owner?.name,
  };
}

function readParameter(node, subscript) {
  // Nodes are new objects on every call: told apart by id. With an external name, the local one is the second.
  const externalNode = node.childForFieldName('external_name');
  const external = externalNode ? unquote(externalNode.text) : undefined;
  const names = node.namedChildren.filter((c) => c.type === 'simple_identifier' && c.id !== externalNode?.id);
  const local = names[0] ? unquote(names[0].text) : '_';
  const type = [...node.namedChildren].reverse().find((c) => c.type !== 'simple_identifier' && c.type !== 'parameter_modifiers' && !/comment/.test(c.type));
  return {
    label: external ?? (subscript ? '_' : local),
    name: local,
    type: type?.text ?? null,
    optional: false,
    variadic: node.children.some((c) => c.type === '...'),
  };
}

function readProperties(node, doc, defaultKind, owner) {
  const { access, modifiers, attributes } = readModifiers(node);
  const out = [];
  const binding = (n) => n.type === 'value_binding_pattern' && n.text.trim() === 'let';
  const isLet = node.children.some(binding) || node.childrenForFieldName('name').some((p) => p.namedChildren.some(binding));
  let current = null;
  const children = node.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const field = node.fieldNameForChild(i);
    if (field === 'name' && child.type === 'pattern') {
      for (const name of patternNames(child)) {
        current = { name, type: null, value: null, computed: null, observers: false };
        out.push(current);
      }
    } else if (!current) {
      continue;
    } else if (child.type === 'type_annotation') {
      current.type = child.namedChildren.find((c) => !/comment/.test(c.type))?.text ?? null;
    } else if (field === 'value') {
      current.value = child;
    } else if (field === 'computed_value' || child.type === 'computed_property') {
      current.computed = child;
    } else if (child.type === 'willset_didset_block') {
      current.observers = true;
    } else if (child.type === 'protocol_property_requirements') {
      current.computed = child;
    }
  }

  const shared = new Set(modifiers);
  if (isLet) shared.add('readonly');
  return out.map((p) => {
    const kind = p.computed ? 'property' : defaultKind === 'property' ? 'property' : defaultKind;
    const bodies = [p.computed && p.computed.type !== 'protocol_property_requirements' ? p.computed : null, p.value].filter(Boolean);
    const { refs, locals } = bodies.length ? readRefs(bodies) : { refs: [], locals: {} };
    // `let made: Line = .init()`: the implicit member is the declared type's.
    const implicit = p.type && p.value ? implicitOf(p.type, expr(p.value)) : null;
    if (implicit) refs.push({ ev: 'call', e: implicit, line: p.value.startPosition.row + 1 });
    return {
      refs,
      locals,
      kind,
      name: p.name,
      labels: null,
      params: null,
      returns: null,
      type: p.type,
      init: initOf(p.value),
      initE: p.value && !p.type ? expr(p.value) : undefined,
      access,
      modifiers: [...shared],
      attributes,
      doc,
      signature: signatureOf(node, p.computed ?? p.value ?? null),
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      complexity: p.computed && p.computed.type !== 'protocol_property_requirements' ? complexityOf(p.computed) : null,
      requirement: owner?.kind === 'protocol',
      owner: owner?.name,
    };
  });
}

/** The names a binding pattern binds: `x`, `(a, b)`. */
function patternNames(pattern) {
  const bound = pattern.childForFieldName('bound_identifier');
  if (bound) return [unquote(bound.text)];
  const names = [];
  const visit = (node) => {
    if (node.type === 'simple_identifier') names.push(unquote(node.text));
    else for (const child of node.namedChildren) if (child.type === 'pattern' || child.type === 'simple_identifier') visit(child);
  };
  visit(pattern);
  return names;
}

/** What an initializer says about the type: a call of a type (`Order(…)`, `Order.init(…)`) or a literal. */
function initOf(value) {
  if (!value) return null;
  switch (value.type) {
    case 'line_string_literal':
    case 'multi_line_string_literal':
    case 'raw_string_literal':
      return { literal: 'String' };
    case 'integer_literal':
    case 'hex_literal':
    case 'bin_literal':
    case 'oct_literal':
      return { literal: 'Int' };
    case 'real_literal':
      return { literal: 'Double' };
    case 'boolean_literal':
      return { literal: 'Bool' };
    case 'call_expression': {
      const callee = value.namedChildren[0];
      if (callee?.type === 'simple_identifier' && /^[A-Z]/.test(callee.text)) return { call: callee.text };
      if (callee?.type === 'navigation_expression' && /\.init$/.test(callee.text)) return { call: callee.text.replace(/\.init$/, '') };
      return { expression: true };
    }

    default:
      return { expression: true };
  }
}

function readAlias(node, doc, owner) {
  const { access, modifiers, attributes } = readModifiers(node);
  const names = node.childrenForFieldName('name');
  const name = names[0]?.text ?? '';
  return {
    kind: 'typeAlias',
    name,
    labels: null,
    params: null,
    returns: null,
    type: names[1]?.text ?? null,
    access,
    modifiers: [...modifiers],
    attributes,
    doc,
    signature: signatureOf(node, null),
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    complexity: null,
    requirement: false,
    owner: owner?.name,
  };
}

/** A declaration's text before its body, on one line, without its attributes. */
function signatureOf(node, body) {
  const end = body ? body.startIndex - node.startIndex : node.text.length;
  let text = node.text.slice(0, end);
  text = text.replace(/^(\s*@[\w.]+(\([^()]*(\([^()]*\))*[^()]*\))?\s*)+/, '');
  return text.replace(/\/\/[^\n]*|\/\*[^]*?\*\//g, ' ').replace(/\s+/g, ' ').replace(/[{=]\s*$/, '').trim().slice(0, 200) || undefined;
}
