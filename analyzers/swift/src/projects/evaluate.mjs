/**
 * The values of Swift manifests (Package.swift, Tuist's Project.swift) read from their syntax tree, without running
 * them: string, number and boolean literals, arrays, calls with their labelled arguments (`.target(name: "Shop")`,
 * `Package(name:…)`), `let` constants defined before, and `+` of arrays. Anything else (string interpolation,
 * functions of the manifest, conditions) is null, and readers skip it, as the CMake reader does.
 *
 * A call is `{ call: 'target', args: { name: 'Shop', … }, positional: [...], line }`.
 */
export function evaluate(node, env = new Map()) {
  if (!node) return null;
  switch (node.type) {
    case 'line_string_literal':
    case 'multi_line_string_literal':
      return stringOf(node);
    case 'raw_string_literal':
      return /^#*"([^"\\]*)"#*$/.exec(node.text)?.[1] ?? null;
    case 'integer_literal':
      return Number(node.text.replace(/_/g, ''));
    case 'boolean_literal':
      return node.text === 'true';
    case 'array_literal':
      return node.namedChildren.filter((c) => c.type !== 'comment' && c.type !== 'multiline_comment').map((c) => evaluate(c, env));
    case 'simple_identifier':
      return env.has(node.text) ? env.get(node.text) : null;
    case 'parenthesized_expression':
    case 'tuple_expression':
      return node.namedChildren.length === 1 ? evaluate(node.namedChildren[0], env) : null;
    case 'prefix_expression': {
      // `.app`, `.upToNextMajor(…)` without a call: a member of the expected type.
      const target = node.childForFieldName('target');
      return node.text.startsWith('.') && target?.type === 'simple_identifier' ? { call: target.text, args: {}, positional: [], line: node.startPosition.row + 1 } : null;
    }
    case 'call_expression':
      return callOf(node, env);
    case 'additive_expression': {
      const lhs = evaluate(node.childForFieldName('lhs'), env);
      const rhs = evaluate(node.childForFieldName('rhs'), env);
      if (Array.isArray(lhs) && Array.isArray(rhs)) return [...lhs, ...rhs];
      if (typeof lhs === 'string' && typeof rhs === 'string') return lhs + rhs;
      return null;
    }
    default:
      return null;
  }
}

/** A string literal's text, or null when it interpolates. */
function stringOf(node) {
  let out = '';
  for (const child of node.namedChildren) {
    if (child.type === 'line_str_text' || child.type === 'multi_line_str_text') out += child.text;
    else if (child.type === 'str_escaped_char') out += unescape(child.text);
    else if (child.type === 'interpolated_expression') return null;
  }

  return node.type === 'multi_line_string_literal' ? out.replace(/^\n/, '').replace(/\n[ \t]*$/, '') : out;
}

function unescape(text) {
  const map = { n: '\n', t: '\t', r: '\r', '0': '\0', '"': '"', "'": "'", '\\': '\\' };
  return map[text[1]] ?? text.slice(1);
}

function callOf(node, env) {
  const callee = node.namedChildren[0];
  const suffix = node.namedChildren.find((c) => c.type === 'call_suffix');
  if (!callee || !suffix) return null;
  let name = null;
  if (callee.type === 'simple_identifier') name = callee.text; // Package(…), Target(…)
  else if (callee.type === 'prefix_expression') name = callee.childForFieldName('target')?.text ?? null; // .target(…)
  else if (callee.type === 'navigation_expression') name = lastSuffix(callee); // Target.target(…), .init(…)
  if (!name) return null;
  const args = {};
  const positional = [];
  const list = suffix.namedChildren.find((c) => c.type === 'value_arguments');
  for (const argument of list?.namedChildren ?? []) {
    if (argument.type !== 'value_argument') continue;
    const label = argument.childForFieldName('name')?.text ?? null;
    const value = evaluate(argument.childForFieldName('value'), env);
    if (label) args[label] = value;
    else positional.push(value);
  }

  return { call: name, args, positional, line: node.startPosition.row + 1 };
}

function lastSuffix(navigation) {
  const suffix = navigation.childForFieldName('suffix');
  return suffix?.childForFieldName('suffix')?.text ?? suffix?.text?.replace(/^\./, '') ?? null;
}

/**
 * The top-level `let` / `var` constants of a manifest in order, and the statements that change one afterwards
 * (`package.targets += […]`, `package.targets.append(…)`), applied to the value the first call returns.
 */
export function topLevel(root) {
  const env = new Map();
  const changes = [];
  for (const statement of root.namedChildren) {
    if (statement.type === 'property_declaration') {
      const names = statement.childrenForFieldName('name');
      const values = statement.childrenForFieldName('value');
      for (let i = 0; i < names.length; i++) {
        const name = names[i].childForFieldName('bound_identifier')?.text ?? names[i].text;
        if (values[i]) env.set(name, evaluate(values[i], env));
      }
    } else if (statement.type === 'assignment') {
      const target = statement.childForFieldName('target')?.text.replace(/\s+/g, '');
      const operator = statement.childForFieldName('operator')?.text ?? statement.children.find((c) => /=$/.test(c.type))?.type;
      const value = evaluate(statement.childForFieldName('result'), env);
      if (target && value !== null) changes.push({ target, operator, value });
    } else if (statement.type === 'call_expression') {
      // package.targets.append(.target(…)), package.dependencies.append(contentsOf: […])
      const callee = statement.namedChildren[0];
      if (callee?.type !== 'navigation_expression' || lastSuffix(callee) !== 'append') continue;
      const call = callOf(statement, env);
      const target = callee.childForFieldName('target')?.text.replace(/\s+/g, '');
      const value = call?.args.contentsOf ?? (call?.positional.length ? [call.positional[0]] : null);
      if (target && Array.isArray(value)) changes.push({ target, operator: '+=', value });
    }
  }

  return { env, changes };
}
