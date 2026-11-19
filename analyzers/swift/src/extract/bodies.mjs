/**
 * What a body refers to, read while its tree is in memory and resolved once every type is known (resolve.mjs).
 * Expressions are small arrays:
 *   ['n', name]  a name that is not a local     ['v', key]  a local (its binding in `locals`)
 *   ['self']  ['super']      ['m', E, name]  a member of E
 *   ['c', E, labels, args]  a call of E with its argument labels ('?' for a trailing closure) and argument expressions
 *   ['i', name]  `.name`, a member of the type expected there      ['t', text]  a value of a type as written
 *   ['T', text]  the type itself (`Order` in `let o: Order = .init()`, `\Order.lines`)
 *   ['l', type]  a literal      ['el', E]  an element of E (for-in)      ['sub', E]  E[…]
 *   ['arr', E]  an array literal of E      ['cl', call, slot, i]  parameter i of the closure passed as argument `slot`
 *   of `call` (a trailing closure's slot follows the labelled arguments)      ['u']  unknown
 * A string literal without interpolation keeps its text: ['l', 'String', text].
 * A reference is { ev: call | access | name | type | throw | catch | selector, … , line }. Locals are scoped: a
 * closure's parameter or an `if let` binding is a local of its block only; `locals` maps each binding's key to
 * what it is bound to.
 */

const unquote = (name) => name.replace(/`/g, '');
const SKIP_NAME_PARENTS = new Set(['navigation_suffix', 'value_argument_label', 'lambda_parameter', 'parameter', 'type_parameter', 'enum_entry', 'function_declaration', 'protocol_function_declaration', 'import_declaration', 'identifier', 'pattern', 'switch_pattern', 'key_path_expression', 'directive']);
const TYPE_NODES = new Set(['user_type', 'array_type', 'dictionary_type', 'optional_type', 'opaque_type', 'existential_type', 'metatype', 'tuple_type', 'function_type']);
/** Statements whose block has locals of its own. */
const SCOPES = new Set(['lambda_literal', 'switch_entry', 'do_statement', 'repeat_while_statement', 'computed_getter', 'computed_setter', 'computed_modify', 'willset_clause', 'didset_clause']);

/**
 * The references and locals of a body. `params` are the declaration's parameters ({ name, type }); `bodies` the nodes
 * to read (a function body, a property's getter and setter, its initializer, top-level statements).
 */
export function readBody(bodies, params = []) {
  const reader = new Reader();
  const scope = new Map();
  for (const p of params) if (p.name && p.name !== '_') reader.bind(scope, p.name, ['t', p.type ?? '']);
  for (const body of bodies) if (body) reader.walk(body, scope);
  return { refs: reader.refs, locals: reader.bindings };
}

/** An expression outside a body (a property's initializer): no locals. */
export function expr(node) {
  return new Reader().expr(node, new Map());
}

function line(node) {
  return node.startPosition.row + 1;
}

class Reader {
  constructor() {
    this.refs = [];
    this.bindings = {};
    this.next = 0;
  }

  bind(scope, name, value) {
    const key = `${name}#${this.next++}`;
    this.bindings[key] = value;
    scope.set(name, key);
  }

  /** Each node with the scope it is in; a node may give its children a scope of their own. */
  walk(node, scope) {
    const stack = [[node, scope]];
    while (stack.length) {
      const [current, at] = stack.pop();
      const result = this.visit(current, at);
      if (result === false) continue;
      const inner = result instanceof Map ? result : at;
      const children = current.namedChildren;
      for (let i = children.length - 1; i >= 0; i--) stack.push([children[i], inner]);
    }
  }

  /** Notes what a node refers to and binds; false when its children need no visit, a Map for a scope of their own. */
  visit(node, scope) {
    switch (node.type) {
      case 'call_expression': {
        const callee = node.namedChildren[0];
        const e = this.expr(node, scope);
        if (e[0] === 'c') this.refs.push({ ev: 'call', e, line: line(node) });
        else if (e[0] === 'sub') {
          // `lines[0]`, `self.lines[0]`: the property read.
          if (e[1][0] === 'm') this.refs.push({ ev: 'access', e: e[1], line: line(node) });
          else if (e[1][0] === 'n') this.refs.push({ ev: 'name', name: e[1][1], line: line(node) });
        }

        // The callee is the call: visit what it is called on, and the arguments; a closure knows the call it is given to.
        if (callee?.type === 'navigation_expression') this.walkOptional(callee.childForFieldName('target'), scope);
        else if (callee && callee.type !== 'simple_identifier' && callee.type !== 'prefix_expression') this.walkOptional(callee, scope);
        const suffix = node.namedChildren.find((c) => c.type === 'call_suffix');
        const args = suffix?.namedChildren.find((c) => c.type === 'value_arguments');
        let slot = 0;
        for (const argument of args?.namedChildren ?? []) {
          if (argument.type !== 'value_argument') continue;
          const value = argument.childForFieldName('value');
          if (value?.type === 'lambda_literal' && e[0] === 'c') this.walkClosure(value, scope, e, slot);
          else this.walkOptional(value, scope);
          slot++;
        }

        for (const child of suffix?.namedChildren ?? []) {
          if (child.type !== 'lambda_literal' && child.type !== 'annotated_lambda') continue;
          const lambda = child.type === 'lambda_literal' ? child : child.namedChildren.find((c) => c.type === 'lambda_literal');
          if (lambda && e[0] === 'c') this.walkClosure(lambda, scope, e, slot);
          else this.walkOptional(child, scope);
          slot++;
        }

        for (const child of node.namedChildren.slice(1)) if (child.type !== 'call_suffix') this.walkOptional(child, scope);
        return false;
      }

      case 'navigation_expression': {
        const suffix = unquote(node.childForFieldName('suffix')?.childForFieldName('suffix')?.text ?? '');
        const target = node.childForFieldName('target');
        if (suffix === 'self' && target) this.refs.push({ ev: 'type', text: target.text, how: 'uses', line: line(node) });
        else this.refs.push({ ev: 'access', e: this.expr(node, scope), line: line(node) });
        if (target) this.walkOptional(target, scope);
        return false;
      }

      case 'simple_identifier': {
        const parent = node.parent;
        if (!parent || SKIP_NAME_PARENTS.has(parent.type)) return false;
        const field = fieldOf(node);
        if (field === 'bound_identifier' || field === 'name' || field === 'external_name') return false;
        // `$isPresented`: the projected value of a property wrapper is a use of the property.
        const name = unquote(node.text).replace(/^\$(?=[A-Za-z_])/, '');
        if (name.startsWith('$') || scope.has(name)) return false;
        this.refs.push({ ev: 'name', name, line: line(node) });
        return false;
      }

      case 'property_declaration': {
        const names = node.childrenForFieldName('name');
        const values = node.childrenForFieldName('value');
        const annotation = node.namedChildren.find((c) => c.type === 'type_annotation');
        const declared = annotation?.namedChildren.find((c) => TYPE_NODES.has(c.type))?.text;
        if (declared) this.refs.push({ ev: 'type', text: declared, how: 'uses', line: line(node) });
        // The values first: `let x = x` reads the x outside.
        const bound = names.map((pattern, i) => [pattern, values[i] ?? values[0]]).map(([pattern, value]) => [pattern, value ? this.expr(value, scope) : null]);
        for (const value of values) this.walkOptional(value, scope);
        for (const child of node.namedChildren) if (child.type === 'computed_property' || child.type === 'willset_didset_block') this.walkOptional(child, new Map(scope));
        for (const [pattern, e] of bound) {
          const name = pattern.childForFieldName('bound_identifier');
          if (name) this.bind(scope, unquote(name.text), declared ? ['t', declared] : e ?? ['u']);
          else for (const id of identifiers(pattern)) this.bind(scope, id, ['u']);
          // `let order: Order = .init(id: 1)`: the implicit member is the declared type's.
          const implicit = implicitOf(declared, e);
          if (implicit) this.refs.push({ ev: 'call', e: implicit, line: line(node) });
        }

        return false;
      }

      case 'if_statement':
      case 'while_statement': {
        const inner = new Map(scope);
        this.bindConditions(node, scope, inner);
        return inner;
      }

      case 'guard_statement':
        // A guard's bindings are the enclosing block's from here on.
        this.bindConditions(node, scope, scope);
        return new Map(scope);
      case 'for_statement': {
        const item = node.childForFieldName('item');
        const collection = node.childForFieldName('collection');
        const element = collection ? ['el', this.expr(collection, scope)] : ['u'];
        if (collection) this.walkOptional(collection, scope);
        const inner = new Map(scope);
        const bound = item?.childForFieldName('bound_identifier');
        if (bound) this.bind(inner, unquote(bound.text), element);
        else if (item) for (const id of identifiers(item)) this.bind(inner, id, ['u']);
        for (const child of node.namedChildren) if (child.id !== item?.id && child.id !== collection?.id) this.walkOptional(child, inner);
        return false;
      }

      case 'lambda_parameter': {
        const names = node.childrenForFieldName('name');
        const name = names.find((n) => n.type === 'simple_identifier')?.text;
        const type = names.find((n) => TYPE_NODES.has(n.type))?.text;
        if (name) this.bind(scope, unquote(name), type ? ['t', type] : ['u']);
        return false;
      }

      case 'lambda_function_type':
        // { a, b in … }: parameters without types.
        for (const child of node.namedChildren) if (child.type === 'simple_identifier') this.bind(scope, unquote(child.text), ['u']);
        return true;
      case 'catch_block': {
        const inner = new Map(scope);
        const pattern = node.childForFieldName('error');
        if (!pattern) {
          this.bind(inner, 'error', ['u']);
          return inner;
        }

        const type = descendant(pattern, 'user_type');
        if (type) this.refs.push({ ev: 'catch', text: type.text, line: line(node) });
        const bound = descendant(pattern, 'bound_identifier', true);
        if (bound) this.bind(inner, unquote(bound.text), type ? ['t', type.text] : ['u']);
        // The pattern's names are not references; its body is.
        for (const child of node.namedChildren) if (child.id !== pattern.id) this.walkOptional(child, inner);
        return false;
      }

      case 'switch_pattern':
      case 'pattern':
        // `case .some(let x)`, `case let .shipped(date)`: what it binds, not the case names.
        if (/\b(let|var)\b/.test(node.text)) for (const id of boundNames(node)) this.bind(scope, id, ['u']);
        return true;
      case 'control_transfer_statement':
        if (node.namedChildren[0]?.type === 'throw_keyword' && node.namedChildren[1]) this.refs.push({ ev: 'throw', e: this.expr(node.namedChildren[1], scope), line: line(node) });
        return true;
      case 'as_expression':
      case 'check_expression': {
        const exprId = node.childForFieldName('expr')?.id;
        const type = node.namedChildren.find((c) => TYPE_NODES.has(c.type) && c.id !== exprId);
        if (type) this.refs.push({ ev: 'type', text: type.text, how: 'uses', line: line(node) });
        const inner = node.childForFieldName('expr') ?? node.namedChildren[0];
        if (inner) this.walkOptional(inner, scope);
        return false;
      }

      case 'selector_expression': {
        const call = node.namedChildren[0];
        const e = call ? this.expr(call, scope) : ['u'];
        this.refs.push({ ev: 'selector', e: e[0] === 'c' ? e : ['c', e, [], []], line: line(node) });
        return false;
      }

      case 'function_declaration': {
        // A local function: its name is local, its parameters its own.
        const name = node.childrenForFieldName('name').find((c) => c.type === 'simple_identifier');
        if (name) this.bind(scope, unquote(name.text), ['u']);
        const inner = new Map(scope);
        for (const p of node.namedChildren.filter((c) => c.type === 'parameter')) {
          const externalId = p.childForFieldName('external_name')?.id;
          const local = p.namedChildren.find((c) => c.type === 'simple_identifier' && c.id !== externalId);
          const type = [...p.namedChildren].reverse().find((c) => TYPE_NODES.has(c.type));
          if (local) this.bind(inner, unquote(local.text), type ? ['t', type.text] : ['u']);
        }

        const body = node.childForFieldName('body');
        if (body) this.walkOptional(body, inner);
        return false;
      }

      case 'type_annotation':
      case 'type_arguments': {
        const type = node.namedChildren.find((c) => TYPE_NODES.has(c.type));
        if (type) this.refs.push({ ev: 'type', text: type.text, how: 'uses', line: line(node) });
        return false;
      }

      case 'comment':
      case 'multiline_comment':
      case 'directive':
        return false;
      default:
        return SCOPES.has(node.type) ? new Map(scope) : true;
    }
  }

  walkOptional(node, scope) {
    if (node) this.walk(node, scope);
  }

  /**
   * A closure passed to a call: its parameters (and $0, $1…) are what the callee gives it, known once the callee is
   * (resolve.mjs): ['cl', call, slot, i]; a parameter with a type is that type.
   */
  walkClosure(lambda, scope, call, slot) {
    const inner = new Map(scope);
    const type = lambda.childForFieldName('type');
    let count = 0;
    const params = type?.namedChildren.find((c) => c.type === 'lambda_function_type_parameters');
    for (const p of params?.namedChildren ?? []) {
      if (p.type !== 'lambda_parameter') continue;
      const names = p.childrenForFieldName('name');
      const name = names.find((n) => n.type === 'simple_identifier')?.text;
      const declared = names.find((n) => TYPE_NODES.has(n.type))?.text;
      if (name) this.bind(inner, unquote(name), declared ? ['t', declared] : ['cl', call, slot, count]);
      count++;
    }

    // { a, b in … }
    for (const child of type?.namedChildren ?? []) if (child.type === 'simple_identifier') this.bind(inner, unquote(child.text), ['cl', call, slot, count++]);
    if (!count) for (let i = 0; i < 4; i++) this.bind(inner, `$${i}`, ['cl', call, slot, i]);
    for (const child of lambda.namedChildren) if (child.id !== type?.id) this.walk(child, inner);
  }

  /** `if let x = a, let y = b.c`, `guard let x else`, `if let x` (the same x): bound into `into`. */
  bindConditions(node, scope, into) {
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

      // `if let x` / `guard let x`: the x around it, a local or a property (which it reads).
      const e = value ? this.expr(value, into) : into.has(name) ? ['v', into.get(name)] : ['n', name];
      if (e[0] === 'n') this.refs.push({ ev: 'name', name, line: children[i].startPosition.row + 1 });
      this.bind(into, name, e);
    }
  }

  /** An expression as the resolver reads it; locals of `scope` are ['v', key]. */
  expr(node, scope) {
    if (!node) return ['u'];
    switch (node.type) {
      case 'simple_identifier': {
        const name = unquote(node.text);
        if (scope.has(name)) return ['v', scope.get(name)];
        if (/^\$[A-Za-z_]/.test(name)) return ['n', name.slice(1)];
        return name.startsWith('$') ? ['u'] : ['n', name];
      }

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

        return ['m', this.expr(target, scope), name];
      }

      case 'call_expression': {
        const callee = node.namedChildren[0];
        const suffix = node.namedChildren.find((c) => c.type === 'call_suffix');
        const args = suffix?.namedChildren.find((c) => c.type === 'value_arguments');
        if (args && args.text.startsWith('[')) return ['sub', this.expr(callee, scope)];
        const labels = [];
        const values = [];
        for (const argument of args?.namedChildren ?? []) {
          if (argument.type !== 'value_argument') continue;
          const label = argument.childForFieldName('name') ?? argument.childForFieldName('reference_specifier');
          labels.push(label ? unquote(label.text) : '_');
          const value = argument.childForFieldName('value');
          values.push(value ? this.expr(value, scope) : null);
        }

        for (const child of suffix?.namedChildren ?? []) if (child.type === 'lambda_literal' || child.type === 'annotated_lambda') labels.push('?');
        return ['c', this.expr(callee, scope), labels, values];
      }

      case 'prefix_expression': {
        const target = node.childForFieldName('target');
        if (node.text.startsWith('.') && target?.type === 'simple_identifier') return ['i', unquote(target.text)];
        return ['u'];
      }

      case 'postfix_expression':
        return this.expr(node.childForFieldName('target'), scope);
      case 'try_expression':
      case 'await_expression':
        return this.expr(node.childForFieldName('expr') ?? node.namedChildren[node.namedChildren.length - 1], scope);
      case 'as_expression': {
        const type = node.namedChildren.find((c) => TYPE_NODES.has(c.type));
        return type ? ['t', type.text] : ['u'];
      }

      case 'parenthesized_expression':
        return node.namedChildren.length === 1 ? this.expr(node.namedChildren[0], scope) : ['u'];
      case 'nil_coalescing_expression':
        return this.expr(node.childForFieldName('value') ?? node.namedChildren[0], scope);
      case 'ternary_expression':
        return this.expr(node.childForFieldName('if_true') ?? node.namedChildren[1], scope);
      case 'line_string_literal':
      case 'multi_line_string_literal':
      case 'raw_string_literal': {
        const parts = node.namedChildren;
        const plain = parts.every((c) => c.type === 'line_str_text' || c.type === 'multi_line_str_text');
        return plain ? ['l', 'String', parts.map((c) => c.text).join('')] : ['l', 'String'];
      }
      case 'integer_literal':
        return ['l', 'Int'];
      case 'real_literal':
        return ['l', 'Double'];
      case 'boolean_literal':
        return ['l', 'Bool'];
      case 'array_literal': {
        const first = node.namedChildren.find((c) => !/comment/.test(c.type));
        return first ? ['arr', this.expr(first, scope)] : ['u'];
      }

      default:
        return ['u'];
    }
  }
}

/** `T = .init(…)` / `T = .make(…)`: the call of a member of the declared type T. */
export function implicitOf(declared, e) {
  return declared && e?.[0] === 'c' && e[1][0] === 'i' ? ['c', ['m', ['T', declared], e[1][1]], e[2], e[3]] : null;
}

function fieldOf(node) {
  const parent = node.parent;
  if (!parent) return null;
  for (let i = 0; i < parent.childCount; i++) if (parent.child(i)?.id === node.id) return parent.fieldNameForChild(i);
  return null;
}

function identifiers(pattern) {
  const out = [];
  const visit = (n) => {
    if (n.type === 'simple_identifier') out.push(unquote(n.text));
    else for (const child of n.namedChildren) if (child.type !== 'user_type') visit(child);
  };
  visit(pattern);
  return out;
}

/** The names a case pattern binds: identifiers, but not the case names (written after a dot). */
function boundNames(pattern) {
  const text = pattern.text;
  const start = pattern.startIndex;
  return identifiersWithNodes(pattern).filter((n) => text[n.startIndex - start - 1] !== '.' && !/^[A-Z]/.test(n.text)).map((n) => unquote(n.text));
}

function identifiersWithNodes(pattern) {
  const out = [];
  const visit = (n) => {
    if (n.type === 'simple_identifier') out.push(n);
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
