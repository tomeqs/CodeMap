/**
 * Problems inside function bodies (`--checks`), from the syntax. The rules shared with the other languages keep
 * their ids; the Swift ones are narrowed to stay quiet on correct code (see docs/analysis.md). Tests are not
 * checked. Diagnostics carry no node: CodeMap places each on the deepest declaration around its line.
 */

const RULES = {
  'unreachable-code': ['warning', 'dead-code'],
  'self-assignment': ['warning', 'correctness'],
  'self-comparison': ['warning', 'correctness'],
  'constant-condition': ['info', 'correctness'],
  'empty-catch': ['warning', 'exceptions'],
  'float-equality': ['info', 'correctness'],
  'force-try': ['warning', 'exceptions'],
  'force-cast': ['warning', 'correctness'],
  'swallowed-error': ['info', 'exceptions'],
  'implicitly-unwrapped-property': ['info', 'correctness'],
  'main-sync-deadlock': ['warning', 'concurrency'],
  'strong-self-in-stored-closure': ['warning', 'resources'],
  'fatal-error-placeholder': ['warning', 'correctness'],
};

/** Calls that never return: what follows them in the block does not run. */
const NEVER_RETURNS = new Set(['fatalError', 'preconditionFailure', 'exit', 'abort']);
const FLOATS = /^(Double|Float|Float32|Float64|Float80|CGFloat|TimeInterval)$/;
const PLACEHOLDER = /\b(not (yet )?implemented|unimplemented|implement me|todo|fixme|tbd)\b/i;
const OPERATORS = new Set(['==', '!=', '===', '!==', '<', '>', '<=', '>=']);

export function runChecks(tree, file) {
  const out = [];
  const at = (rule, node, message) => {
    const [severity, category] = RULES[rule];
    out.push({ rule, source: 'codemap', severity, category, message, location: { file: file.rel, line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }, column: node.startPosition.column + 1 });
  };

  // Each node with what it is in: the kind of the nearest type (class, struct…) and the nearest function.
  const stack = [[tree.rootNode, null, null]];
  while (stack.length) {
    const [node, type, fn] = stack.pop();
    let innerType = type;
    let innerFn = fn;
    if (node.type === 'class_declaration' || node.type === 'protocol_declaration') innerType = { kind: node.childForFieldName('declaration_kind')?.type ?? 'protocol', node };
    if (node.type === 'function_declaration' || node.type === 'init_declaration' || node.type === 'computed_property' || node.type === 'deinit_declaration') innerFn = { node, floats: floatNames(node) };
    check(node, innerType, innerFn, at);
    for (let i = node.namedChildCount - 1; i >= 0; i--) stack.push([node.namedChild(i), innerType, innerFn]);
  }

  return out;
}

function check(node, type, fn, at) {
  switch (node.type) {
    case 'statements':
      unreachable(node, at);
      return;
    case 'assignment': {
      const target = node.childForFieldName('target');
      const result = node.childForFieldName('result');
      const operator = node.childForFieldName('operator')?.text ?? node.children.find((c) => !c.isNamed && /=$/.test(c.type))?.type;
      // x = x of a property is a compile error in Swift; self.x = self.x is how code fires didSet: left out.
      if (target && result && (operator === '=' || !operator) && same(target.text, result.text) && !/[(.]/.test(result.text)) {
        at('self-assignment', node, `${result.text} is assigned to itself: a typo for self.${result.text.replace(/^self\./, '')} = …?`);
      }

      if (type && (type.kind === 'class' || type.kind === 'actor') && result?.type === 'lambda_literal' && storesProperty(target)) strongSelf(result, node, at);
      return;
    }

    case 'equality_expression':
    case 'comparison_expression': {
      const lhs = node.childForFieldName('lhs');
      const rhs = node.childForFieldName('rhs');
      const op = node.childForFieldName('op')?.text ?? node.children.find((c) => OPERATORS.has(c.type))?.type;
      if (!lhs || !rhs) return;
      if (same(lhs.text, rhs.text) && !/[(]/.test(lhs.text) && op !== '!=' && !lhs.text.startsWith('$')) at('self-comparison', node, `${lhs.text} ${op ?? '=='} ${rhs.text} compares a value with itself: always ${op === '==' || op === '===' || op === '<=' || op === '>=' ? 'true' : 'false'}.`);
      else if ((op === '==' || op === '!=') && isFloat(lhs, rhs, fn)) at('float-equality', node, `${op} between floating-point numbers: rounding makes equal values differ; compare with a tolerance.`);
      return;
    }

    case 'if_statement':
    case 'guard_statement':
    case 'while_statement': {
      const conditions = node.childrenForFieldName('condition').filter((c) => c.isNamed);
      if (conditions.length === 1 && conditions[0].type === 'boolean_literal' && !(node.type === 'while_statement' && conditions[0].text === 'true')) {
        at('constant-condition', conditions[0], `${node.type === 'guard_statement' ? 'guard' : node.type === 'while_statement' ? 'while' : 'if'} ${conditions[0].text}: ${conditions[0].text === 'true' ? 'the condition always holds' : 'the block never runs'}.`);
      }

      return;
    }

    case 'catch_block': {
      const body = node.namedChildren.find((c) => c.type === 'statements');
      const braces = node.text.slice(node.text.indexOf('{'));
      // do { try await Task.sleep(…) } catch {}: its only error is cancellation.
      const tried = node.parent?.namedChildren.find((c) => c.type === 'statements')?.text ?? '';
      if (!body && !/\/\/|\/\*/.test(braces) && /^\{\s*\}$/.test(braces.trim()) && !/^\s*try\s+await\s+Task\.sleep\b[^;\n]*$/.test(tried)) at('empty-catch', node, 'An empty catch block: the error is silently ignored.');
      return;
    }

    case 'try_expression': {
      const operator = node.namedChildren.find((c) => c.type === 'try_operator')?.text ?? node.text.slice(0, 4);
      if (/^try!/.test(operator)) at('force-try', node, `try! crashes the program when ${node.childForFieldName('expr')?.text.split('(')[0] ?? 'the call'} throws; handle the error or use try?.`);
      else if (/^try\?/.test(operator) && dropped(node) && !/^(await\s+)?Task\.sleep\b/.test(node.childForFieldName('expr')?.text ?? '')) at('swallowed-error', node, `try? whose result is dropped: the error of ${node.childForFieldName('expr')?.text.split('(')[0] ?? 'the call'} disappears without a trace.`);
      return;
    }

    case 'as_expression': {
      const operator = node.namedChildren.find((c) => c.type === 'as_operator')?.text;
      if (operator === 'as!') at('force-cast', node, `as! crashes the program when ${node.childForFieldName('expr')?.text ?? 'the value'} is not a ${node.namedChildren.find((c) => c.type === 'user_type' || /_type$/.test(c.type))?.text ?? 'the type'}; use as? and handle the other case.`);
      return;
    }

    case 'property_declaration': {
      if (!type || fn || (type.kind !== 'class' && type.kind !== 'struct' && type.kind !== 'actor')) return;
      const annotation = node.namedChildren.find((c) => c.type === 'type_annotation');
      const declared = annotation?.text.replace(/^:\s*/, '') ?? '';
      const attributes = node.namedChildren.find((c) => c.type === 'modifiers')?.text ?? '';
      if (/!\s*$/.test(declared) && !/@IBOutlet|@IBInspectable|@NSManaged/.test(attributes)) {
        at('implicitly-unwrapped-property', node, `${node.childForFieldName('name')?.text ?? 'The property'}: ${declared} crashes on any use before it is set; make it optional or set it in init.`);
      }

      const value = node.childForFieldName('value');
      if ((type.kind === 'class' || type.kind === 'actor') && value?.type === 'lambda_literal' && /\blazy\b/.test(attributes)) strongSelf(value, node, at);
      return;
    }

    case 'call_expression': {
      const callee = node.namedChildren[0]?.text ?? '';
      if (/^DispatchQueue\.main\.sync$/.test(callee) && !/isMainThread|dispatchPrecondition|getSpecific/.test(fn?.node.text ?? '')) {
        at('main-sync-deadlock', node, 'DispatchQueue.main.sync deadlocks when it runs on the main thread: check Thread.isMainThread first, or use async.');
      }

      if (callee === 'fatalError' || callee === 'preconditionFailure') {
        const message = node.namedChildren.find((c) => c.type === 'call_suffix')?.text ?? '';
        const inInitCoder = fn?.node.type === 'init_declaration' && /\bcoder\b/.test(fn.node.text.split('{')[0]);
        if (PLACEHOLDER.test(message) && !inInitCoder) at('fatal-error-placeholder', node, `${callee}${message.length > 60 ? '(…)' : message}: a placeholder that crashes the program when this code runs.`);
      }

      return;
    }

    default:
  }
}

/** The first statement after return, throw, break, continue or a call that never returns, in the same block. */
function unreachable(block, at) {
  if (block.hasError) return; // what the parser could not follow says nothing about what runs
  const statements = block.namedChildren.filter((c) => c.type !== 'comment' && c.type !== 'multiline_comment');
  for (let i = 0; i < statements.length - 1; i++) {
    const statement = statements[i];
    if (!exits(statement)) continue;
    const next = statements[i + 1];
    // #if / #else between them: the other branch is other code, and declarations (a local function) are not run.
    if (next.type === 'directive' || /declaration$/.test(next.type)) continue;
    // `return` with its value on the next line: Swift reads it as `return value`.
    if (statement.text.trim() === 'return' && !/statement$/.test(next.type)) continue;
    // A view's modifiers under #if go on with the returned expression; a lone break after fatalError is style.
    if (/^(#if\b|\.)/.test(next.text.trim()) || (next.text.trim() === 'break' && statement.type === 'call_expression')) continue;
    at('unreachable-code', next, `This statement never runs: it comes after ${statement.text.split(/[\s(]/)[0]}.`);
    return;
  }
}

function exits(statement) {
  // yield (in a _modify accessor) comes back; fallthrough goes to the next case, which runs.
  if (statement.type === 'control_transfer_statement') return !/^(fallthrough|yield)\b/.test(statement.text);
  if (statement.type === 'call_expression') return NEVER_RETURNS.has(statement.namedChildren[0]?.text ?? '');
  return false;
}

function same(a, b) {
  return a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
}

/** A try? that is a statement of its own or assigned to _: its value, and the error, are dropped. */
function dropped(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === 'statements') return true;
  if (parent.type === 'assignment') return parent.childForFieldName('target')?.text.trim() === '_';
  return false;
}

/** `self.onChange = { … }`, `handler = { … }`: a closure stored in a property of the object. */
function storesProperty(target) {
  const text = target?.text.trim() ?? '';
  return /^self\.\w+$/.test(text);
}

/** A closure stored in the object that uses self strongly: the object keeps the closure, the closure the object. */
function strongSelf(lambda, node, at) {
  const captures = lambda.namedChildren.find((c) => c.type === 'capture_list')?.text ?? '';
  if (/\b(weak|unowned)\s+(var\s+)?self\b|\b(weak|unowned)\b/.test(captures)) return;
  if (!/\bself\b/.test(lambda.text.replace(/\[[^\]]*\]/, ''))) return;
  at('strong-self-in-stored-closure', node, 'A closure stored in the object captures self strongly: the object and the closure keep each other alive; capture [weak self].');
}

/** The names of a function's Double / Float parameters and locals (declared or from a decimal literal). */
function floatNames(fn) {
  const names = new Set();
  for (const p of fn.namedChildren.filter((c) => c.type === 'parameter')) {
    const type = [...p.namedChildren].reverse().find((c) => /type$/.test(c.type));
    const local = p.namedChildren.filter((c) => c.type === 'simple_identifier').pop();
    if (type && local && FLOATS.test(type.text.replace(/[?!]$/, ''))) names.add(local.text);
  }

  const stack = [fn];
  while (stack.length) {
    const node = stack.pop();
    if (node.type === 'property_declaration') {
      const name = node.childForFieldName('name')?.childForFieldName('bound_identifier')?.text;
      const annotation = node.namedChildren.find((c) => c.type === 'type_annotation')?.text.replace(/^:\s*/, '');
      const value = node.childForFieldName('value');
      if (name && ((annotation && FLOATS.test(annotation.replace(/[?!]$/, ''))) || (!annotation && value?.type === 'real_literal'))) names.add(name);
    }

    for (const child of node.namedChildren) if (child.type !== 'function_declaration' && child.type !== 'class_declaration') stack.push(child);
  }

  return names;
}

/** == between floating-point values: a decimal literal that is not whole against a name, or two float names. */
function isFloat(lhs, rhs, fn) {
  const fractional = (n) => n.type === 'real_literal' && !/^-?\d+\.0*$/.test(n.text.replace(/_/g, ''));
  const whole = (n) => n.type === 'integer_literal' || (n.type === 'real_literal' && !fractional(n));
  const named = (n) => n.type === 'simple_identifier' && fn?.floats.has(n.text);
  if (whole(lhs) || whole(rhs)) return false;
  return (fractional(lhs) && !rhs.text.includes('(')) || (fractional(rhs) && !lhs.text.includes('(')) || (named(lhs) && (named(rhs) || fractional(rhs))) || (named(rhs) && fractional(lhs));
}
