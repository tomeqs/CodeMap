/**
 * What a body refers to, read while its tree is in memory and resolved once every type is known (resolve.mjs).
 * Expressions are small arrays:
 *   ['n', name]  a name         ['self']  ['super']        ['m', E, name]  a member of E
 *   ['c', E, labels, args]  a call of E with its argument labels ('?' for a trailing closure) and argument expressions
 *   ['i', name]  `.name`, a member of the type expected there      ['t', text]  a value of a type as written
 *   ['T', text]  the type itself (`Order` in `let o: Order = .init()`, `\Order.lines`)
 *   ['l', type]  a literal      ['el', E]  an element of E (for-in)      ['sub', E]  E[…]      ['u']  unknown
 * A reference is { ev: call | access | name | type | throw | catch | selector, … , line }; locals are { name → E }.
 */

const unquote = (name) => name.replace(/`/g, '');
const SKIP_NAME_PARENTS = new Set(['navigation_suffix', 'value_argument_label', 'lambda_parameter', 'parameter', 'type_parameter', 'enum_entry', 'function_declaration', 'protocol_function_declaration', 'import_declaration', 'identifier', 'pattern', 'switch_pattern', 'key_path_expression', 'directive']);
const TYPE_NODES = new Set(['user_type', 'array_type', 'dictionary_type', 'optional_type', 'opaque_type', 'existential_type', 'metatype', 'tuple_type', 'function_type']);

/**
 * The references and locals of a body. `params` are the declaration's parameters ({ name, type }); `bodies` the nodes
 * to read (a function body, a property's getter and setter, its initializer, top-level statements).
 */
export function readBody(bodies, params = []) {
  const locals = new Map();
  for (const p of params) if (p.name && p.name !== '_') locals.set(p.name, ['t', p.type ?? '']);
  const refs = [];
  for (const body of bodies) if (body) walk(body, locals, refs);
  return { refs, locals: Object.fromEntries(locals) };
}

function line(node) {
  return node.startPosition.row + 1;
}

function walk(node, locals, refs) {
  const stack = [node];
  while (stack.length) {
    const current = stack.pop();
    if (visit(current, locals, refs) === false) continue;
    const children = current.namedChildren;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
}

/** Notes what one node refers to; returns false when its children need no visit of their own. */
function visit(node, locals, refs) {
  switch (node.type) {
    case 'call_expression': {
      const e = expr(node);
      if (e[0] === 'c') refs.push({ ev: 'call', e, line: line(node) });
      else if (e[0] === 'sub') refs.push({ ev: 'access', e: e[1], line: line(node) });
      // The callee itself is the call: visit what it is called on, and the arguments.
      const callee = node.namedChildren[0];
      if (callee?.type === 'navigation_expression') visitAll(callee.childForFieldName('target'), locals, refs);
      else if (callee && callee.type !== 'simple_identifier' && callee.type !== 'prefix_expression') visitAll(callee, locals, refs);
      for (const child of node.namedChildren.slice(1)) visitAll(child, locals, refs);
      return false;
    }

    case 'navigation_expression': {
      const suffix = unquote(node.childForFieldName('suffix')?.childForFieldName('suffix')?.text ?? '');
      const target = node.childForFieldName('target');
      if (suffix === 'self' && target) refs.push({ ev: 'type', text: target.text, how: 'uses', line: line(node) });
      else refs.push({ ev: 'access', e: expr(node), line: line(node) });
      if (target) visitAll(target, locals, refs);
      return false;
    }

    case 'simple_identifier': {
      const parent = node.parent;
      if (!parent || SKIP_NAME_PARENTS.has(parent.type)) return false;
      const field = fieldOf(node);
      if (field === 'bound_identifier' || field === 'name' || field === 'external_name') return false;
      const name = unquote(node.text);
      if (name.startsWith('$') || locals.has(name)) return false;
      refs.push({ ev: 'name', name, line: line(node) });
      return false;
    }

    case 'property_declaration': {
      const names = node.childrenForFieldName('name');
      const values = node.childrenForFieldName('value');
      const annotation = node.namedChildren.find((c) => c.type === 'type_annotation');
      const declared = annotation?.namedChildren.find((c) => TYPE_NODES.has(c.type))?.text;
      if (declared) refs.push({ ev: 'type', text: declared, how: 'uses', line: line(node) });
      names.forEach((pattern, i) => {
        const bound = pattern.childForFieldName('bound_identifier');
        const value = values[i] ?? values[0];
        if (bound) locals.set(unquote(bound.text), declared ? ['t', declared] : value ? expr(value) : ['u']);
        else for (const id of identifiers(pattern)) locals.set(id, ['u']);
        // `let order: Order = .init(id: 1)`: the implicit member is the declared type's.
        const e = declared && value ? expr(value) : null;
        if (e?.[0] === 'c' && e[1][0] === 'i') refs.push({ ev: 'call', e: ['c', ['m', ['T', declared], e[1][1]], e[2], e[3]], line: line(node) });
      });
      for (const value of values) visitAll(value, locals, refs);
      for (const child of node.namedChildren) if (child.type === 'computed_property' || child.type === 'willset_didset_block') visitAll(child, locals, refs);
      return false;
    }

    case 'if_statement':
    case 'guard_statement':
    case 'while_statement':
      bindConditions(node, locals);
      return true;
    case 'for_statement': {
      const item = node.childForFieldName('item');
      const collection = node.childForFieldName('collection');
      const bound = item?.childForFieldName('bound_identifier');
      if (bound) locals.set(bound.text, collection ? ['el', expr(collection)] : ['u']);
      else if (item) for (const id of identifiers(item)) locals.set(id, ['u']);
      return true;
    }

    case 'lambda_parameter': {
      const names = node.childrenForFieldName('name');
      const name = names.find((n) => n.type === 'simple_identifier')?.text;
      const type = names.find((n) => TYPE_NODES.has(n.type))?.text;
      if (name) locals.set(name, type ? ['t', type] : ['u']);
      return false;
    }

    case 'lambda_function_type': {
      // { a, b in … }: parameters without types are names of their own, not members.
      for (const child of node.namedChildren) if (child.type === 'simple_identifier') locals.set(child.text, ['u']);
      return true;
    }

    case 'catch_block': {
      const pattern = node.childForFieldName('error');
      if (!pattern) {
        locals.set('error', ['u']);
        return true;
      }

      const type = descendant(pattern, 'user_type');
      if (type) refs.push({ ev: 'catch', text: type.text, line: line(node) });
      const bound = descendant(pattern, 'bound_identifier', true);
      if (bound) locals.set(bound.text, type ? ['t', type.text] : ['u']);
      // The pattern's names are not references; its body is.
      for (const child of node.namedChildren) if (child !== pattern) visitAll(child, locals, refs);
      return false;
    }

    case 'switch_pattern':
    case 'pattern':
      for (const id of identifiers(node)) if (/(let|var)\b/.test(node.text)) locals.set(id, ['u']);
      return true;
    case 'control_transfer_statement':
      if (node.namedChildren[0]?.type === 'throw_keyword' && node.namedChildren[1]) refs.push({ ev: 'throw', e: expr(node.namedChildren[1]), line: line(node) });
      return true;
    case 'as_expression':
    case 'check_expression': {
      const exprId = node.childForFieldName('expr')?.id;
      const type = node.namedChildren.find((c) => TYPE_NODES.has(c.type) && c.id !== exprId);
      if (type) refs.push({ ev: 'type', text: type.text, how: 'uses', line: line(node) });
      const inner = node.childForFieldName('expr') ?? node.namedChildren[0];
      if (inner) visitAll(inner, locals, refs);
      return false;
    }

    case 'selector_expression': {
      const call = node.namedChildren[0];
      const e = call ? expr(call) : ['u'];
      refs.push({ ev: 'selector', e: e[0] === 'c' ? e : ['c', e, [], []], line: line(node) });
      return false;
    }

    case 'function_declaration': {
      // A local function: its name is local, its body this member's.
      const name = node.childrenForFieldName('name').find((c) => c.type === 'simple_identifier');
      if (name) locals.set(name.text, ['u']);
      for (const p of node.namedChildren.filter((c) => c.type === 'parameter')) {
        const externalId = p.childForFieldName('external_name')?.id;
        const local = p.namedChildren.find((c) => c.type === 'simple_identifier' && c.id !== externalId);
        const type = [...p.namedChildren].reverse().find((c) => TYPE_NODES.has(c.type));
        if (local) locals.set(local.text, type ? ['t', type.text] : ['u']);
      }

      const body = node.childForFieldName('body');
      if (body) visitAll(body, locals, refs);
      return false;
    }

    case 'type_annotation':
    case 'type_arguments': {
      const type = node.namedChildren.find((c) => TYPE_NODES.has(c.type));
      if (type) refs.push({ ev: 'type', text: type.text, how: 'uses', line: line(node) });
      return false;
    }

    case 'comment':
    case 'multiline_comment':
    case 'line_string_literal':
    case 'directive':
      return node.type === 'line_string_literal';
    default:
      return true;
  }
}

function visitAll(node, locals, refs) {
  if (node) walk(node, locals, refs);
}

function fieldOf(node) {
  const parent = node.parent;
  if (!parent) return null;
  for (let i = 0; i < parent.childCount; i++) if (parent.child(i)?.id === node.id) return parent.fieldNameForChild(i);
  return null;
}

/** `if let x = a, let y = b.c`, `guard let x else`, `if let x` (the same x). */
function bindConditions(node, locals) {
  const children = node.children;
  for (let i = 0; i < children.length; i++) {
    if (node.fieldNameForChild(i) !== 'bound_identifier') continue;
    const name = unquote(children[i].text);
    // Its value: the next named condition before another binding (`=` is a condition too, but not named).
    let value = null;
    for (let j = i + 1; j < children.length; j++) {
      const field = node.fieldNameForChild(j);
      if (field === 'bound_identifier') break;
      if (field === 'condition' && children[j].isNamed && children[j].type !== 'value_binding_pattern') {
        value = children[j];
        break;
      }
    }

    if (value) locals.set(name, expr(value));
    else if (!locals.has(name)) locals.set(name, ['u']);
  }
}

function identifiers(pattern) {
  const out = [];
  const visit = (n) => {
    if (n.type === 'simple_identifier') out.push(n.text);
    else for (const child of n.namedChildren) if (child.type !== 'user_type') visit(child);
  };
  visit(pattern);
  return out;
}

function descendant(node, type, byField = false) {
  const stack = [node];
  while (stack.length) {
    const current = stack.pop();
    if (byField) {
      const bound = current.childForFieldName?.('bound_identifier');
      if (bound) return bound;
    } else if (current.type === type) {
      return current;
    }

    for (const child of current.namedChildren) stack.push(child);
  }

  return null;
}

/** An expression as the resolver reads it. */
export function expr(node) {
  if (!node) return ['u'];
  switch (node.type) {
    case 'simple_identifier':
      return node.text.startsWith('$') ? ['u'] : ['n', unquote(node.text)];
    case 'self_expression':
      return ['self'];
    case 'super_expression':
      return ['super'];
    case 'navigation_expression': {
      const name = unquote(node.childForFieldName('suffix')?.childForFieldName('suffix')?.text ?? '');
      const target = node.childForFieldName('target');
      if (!name) return ['u'];
      if (target?.type === 'key_path_expression') {
        const root = target.namedChildren.find((c) => c.type === 'type_identifier' || c.type === 'user_type');
        return root ? ['m', ['T', root.text], name] : ['u'];
      }

      return ['m', expr(target), name];
    }

    case 'call_expression': {
      const callee = node.namedChildren[0];
      const suffix = node.namedChildren.find((c) => c.type === 'call_suffix');
      const args = suffix?.namedChildren.find((c) => c.type === 'value_arguments');
      if (args && args.text.startsWith('[')) return ['sub', expr(callee)];
      const labels = [];
      const values = [];
      for (const argument of args?.namedChildren ?? []) {
        if (argument.type !== 'value_argument') continue;
        const label = argument.childForFieldName('name') ?? argument.childForFieldName('reference_specifier');
        labels.push(label ? label.text : '_');
        const value = argument.childForFieldName('value');
        values.push(value ? expr(value) : null);
      }

      for (const child of suffix?.namedChildren ?? []) if (child.type === 'lambda_literal' || child.type === 'annotated_lambda') labels.push('?');
      return ['c', expr(callee), labels, values];
    }

    case 'prefix_expression': {
      const target = node.childForFieldName('target');
      if (node.text.startsWith('.') && target?.type === 'simple_identifier') return ['i', unquote(target.text)];
      return ['u'];
    }

    case 'postfix_expression':
      return expr(node.childForFieldName('target'));
    case 'try_expression':
    case 'await_expression':
      return expr(node.childForFieldName('expr') ?? node.namedChildren[node.namedChildren.length - 1]);
    case 'as_expression': {
      const type = node.namedChildren.find((c) => TYPE_NODES.has(c.type));
      return type ? ['t', type.text] : ['u'];
    }

    case 'parenthesized_expression':
      return node.namedChildren.length === 1 ? expr(node.namedChildren[0]) : ['u'];
    case 'nil_coalescing_expression':
      return expr(node.childForFieldName('value') ?? node.namedChildren[0]);
    case 'ternary_expression':
      return expr(node.childForFieldName('if_true') ?? node.namedChildren[1]);
    case 'line_string_literal':
    case 'multi_line_string_literal':
    case 'raw_string_literal':
      return ['l', 'String'];
    case 'integer_literal':
      return ['l', 'Int'];
    case 'real_literal':
      return ['l', 'Double'];
    case 'boolean_literal':
      return ['l', 'Bool'];
    case 'array_literal': {
      const first = node.namedChildren.find((c) => !/comment/.test(c.type));
      return first ? ['arr', expr(first)] : ['u'];
    }

    default:
      return ['u'];
  }
}

