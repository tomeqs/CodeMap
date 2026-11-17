import { normalizeType, oneLine } from './declarations.mjs';

/**
 * What a function body refers to, in a plain form resolved later across files (resolve.mjs): its locals (name and
 * declared type, or the expression an `auto` one is initialized with) and its reference sites: calls (with the
 * callee as an expression), `new`, types named (casts, sizeof, catch, throw, local declarations, template
 * arguments) and member or global accesses. Expressions are small objects:
 *   {t:'id', n}  {t:'this'}  {t:'fld', b, n}  {t:'q', p:[…], a?}  {t:'call', f, argc}  {t:'tf', n, a}
 *   {t:'new', ty}  {t:'cast', ty}  {t:'sub', b}  {t:'deref', b}  {t:'elem', b}  {t:'lit', ty}  {t:'?'}
 */

const CASTS = new Set(['static_cast', 'dynamic_cast', 'reinterpret_cast', 'const_cast', 'static_pointer_cast', 'dynamic_pointer_cast', 'qobject_cast']);
const SKIP_CALLS = new Set(['sizeof', 'alignof', 'decltype', 'typeid', 'noexcept', 'static_assert', 'offsetof']);

export function collectBody(body, extra = [], params = []) {
  const out = { locals: [], sites: [] };
  const localNames = new Set(params.map((p) => p.name).filter(Boolean));
  let lambdas = 0; // how many lambdas the walk is inside: their code runs later, when they are called
  const walk = (node) => {
    switch (node.type) {
      case 'declaration':
      case 'condition_clause':
        if (node.type === 'declaration') declarationSites(node, out, localNames);
        break;
      case 'for_range_loop': {
        const declarator = node.childForFieldName('declarator');
        const name = declaratorName(declarator);
        const right = node.childForFieldName('right');
        if (name) {
          localNames.add(name);
          const type = node.childForFieldName('type');
          const text = type ? typeWithDeclarator(type, declarator) : null;
          out.locals.push(isAuto(text) ? { n: name, e: { t: 'elem', b: expr(right) } } : { n: name, ty: text });
        }

        break;
      }

      case 'catch_clause': {
        const parameters = node.childForFieldName('parameters');
        const param = parameters?.namedChildren.find((c) => c.type === 'parameter_declaration');
        if (param) {
          const type = param.childForFieldName('type');
          const declarator = param.childForFieldName('declarator');
          const byValue = !declarator || declarator.type !== 'reference_declarator' && declarator.type !== 'pointer_declarator' && declarator.type !== 'abstract_reference_declarator' && declarator.type !== 'abstract_pointer_declarator';
          if (type) out.sites.push({ k: 'type', ty: oneLine(type.text), rel: 'catches', line: row(param), ...(byValue ? { byValue: param.startPosition.column + 1 } : {}) });
          const name = declaratorName(param.childForFieldName('declarator'));
          if (name && type) {
            localNames.add(name);
            out.locals.push({ n: name, ty: typeWithDeclarator(type, param.childForFieldName('declarator')) });
          }
        }

        break;
      }

      case 'lambda_expression': {
        const declarator = node.childForFieldName('declarator');
        const parameters = declarator?.childForFieldName('parameters');
        for (const p of parameters?.namedChildren ?? []) {
          const name = declaratorName(p.childForFieldName('declarator'));
          const type = p.childForFieldName('type');
          if (name && type) {
            localNames.add(name);
            out.locals.push({ n: name, ty: typeWithDeclarator(type, p.childForFieldName('declarator')) });
          }
        }

        lambdas++;
        for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i));
        lambdas--;
        return;
      }

      case 'call_expression': {
        const callee = node.childForFieldName('function');
        const args = node.childForFieldName('arguments');
        const name = callee?.type === 'identifier' ? callee.text : null;
        if (name && SKIP_CALLS.has(name)) break;
        const e = expr(callee);
        if (e.t === 'cast') {
          if (e.ty) out.sites.push({ k: 'type', ty: e.ty, rel: 'uses', line: row(node) });
          break;
        }

        // `throw OrderError(…)` is a throw of the type (a site of its own), not an instantiation.
        if (node.parent?.type !== 'throw_statement') {
          const list = args ? args.namedChildren.filter((c) => c.type !== 'comment') : [];
          const site = { k: 'call', f: e, argc: list.length, args: list.map(argType), line: row(node) };
          if (node.parent?.type === 'expression_statement') site.stmt = true;
          if (lambdas) site.deferred = true;
          // Qt's connect(sender, &Sender::signal, receiver, &Receiver::slot): the arguments themselves matter.
          const last = e.t === 'id' ? e.n : e.t === 'q' ? e.p[e.p.length - 1] : e.t === 'fld' ? e.n : null;
          if (last === 'connect') site.argx = list.map(expr);
          out.sites.push(site);
        }

        // Template arguments name types (make_unique<Order>, std::vector<Line>{}).
        for (const type of e.a ?? []) out.sites.push({ k: 'type', ty: type, rel: 'uses', line: row(node) });
        // The callee's own name is the call; what it is called on (obj.f(), get().f()) is code of its own.
        if (callee?.type === 'field_expression') walk(callee.childForFieldName('argument'));
        else if (callee && callee.type !== 'identifier' && callee.type !== 'qualified_identifier' && callee.type !== 'template_function') walk(callee);
        if (args) walk(args);
        return;
      }

      case 'new_expression': {
        const type = node.childForFieldName('type');
        if (type) out.sites.push({ k: 'new', ty: oneLine(type.text), line: row(node), throw: node.parent?.type === 'throw_statement' });
        break;
      }

      case 'throw_statement': {
        const thrown = node.namedChild(0);
        if (thrown) {
          const e = expr(thrown);
          if (e.t === 'call') out.sites.push({ k: 'throw', f: e.f, line: row(node) });
        }

        break;
      }

      case 'field_expression': {
        if (node.parent?.type === 'call_expression' && node.parent.childForFieldName('function')?.id === node.id) break;
        out.sites.push({ k: 'access', e: expr(node), line: row(node) });
        break;
      }

      case 'identifier': {
        const parent = node.parent?.type;
        if (localNames.has(node.text) || !parent) break;
        if (parent === 'call_expression' && node.parent.childForFieldName('function')?.id === node.id) break;
        if (declaredBy(node) || parent === 'goto_statement' || parent === 'labeled_statement' || parent === 'field_designator') break;
        out.sites.push({ k: 'access', e: { t: 'id', n: node.text }, line: row(node) });
        break;
      }

      case 'qualified_identifier': {
        const parent = node.parent;
        if (parent?.type === 'call_expression' && parent.childForFieldName('function')?.id === node.id) break;
        if (declaredBy(node)) return;
        if (parent?.type === 'qualified_identifier') break;
        out.sites.push({ k: 'access', e: expr(node), line: row(node) });
        return; // its parts are not references of their own
      }

      case 'field_initializer': {
        // Order(int id) : id_(id): the constructor writes the field.
        const field = node.namedChildren.find((c) => c.type === 'field_identifier');
        if (field) out.sites.push({ k: 'access', e: { t: 'id', n: field.text }, line: row(node) });
        break;
      }

      case 'compound_literal_expression': {
        // Receipt{…}, (struct point){1, 2}: a value of the type made in place.
        const type = node.childForFieldName('type');
        if (type) out.sites.push({ k: 'construct', ty: oneLine(type.text), rel: 'uses', line: row(node) });
        break;
      }

      case 'cast_expression': {
        const type = node.childForFieldName('type');
        if (type) out.sites.push({ k: 'type', ty: oneLine(type.text), rel: 'uses', line: row(node) });
        break;
      }

      case 'sizeof_expression': {
        const type = node.childForFieldName('type');
        if (type) out.sites.push({ k: 'type', ty: oneLine(type.text), rel: 'uses', line: row(node) });
        break;
      }

      case 'template_function':
      case 'template_type': {
        const args = node.childForFieldName('arguments');
        for (const a of args?.namedChildren ?? []) if (a.type === 'type_descriptor') out.sites.push({ k: 'type', ty: oneLine(a.text), rel: 'uses', line: row(node) });
        break;
      }

      default:
        break;
    }

    for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i));
  };

  for (const node of extra) if (node) walk(node);
  if (body) walk(body);
  return out;
}

/**
 * Whether a name is the one its declarator declares (`sum` in `int sum = base_;`), not what the declaration reads:
 * the value it starts with (`base_`, `Config::kMax`) or the size of its array (`int buf[kSize]`).
 */
function declaredBy(node) {
  const parent = node.parent;
  if (!parent || !/declarator$/.test(parent.type)) return false;
  if (parent.type === 'init_declarator') return parent.childForFieldName('value')?.id !== node.id;
  if (parent.type === 'array_declarator') return parent.childForFieldName('size')?.id !== node.id;
  return true;
}

/** Locals declared, the type they name (uses), and objects constructed (`Order o(1);`, `Order o{…}`). */
function declarationSites(node, out, localNames) {
  const type = node.childForFieldName('type');
  if (!type) return;
  const text = oneLine(type.text);
  for (const declarator of node.childrenForFieldName('declarator')) {
    const name = declaratorName(declarator);
    if (!name) continue;
    localNames.add(name);
    const full = typeWithDeclarator(type, declarator);
    if (isAuto(text)) {
      const value = declarator.type === 'init_declarator' ? declarator.childForFieldName('value') : null;
      out.locals.push({ n: name, e: value ? expr(value) : { t: '?' } });
    } else {
      out.locals.push({ n: name, ty: full });
      const byValue = !/[*&]/.test(full.slice(text.length));
      const constructs = declarator.type === 'init_declarator' || declarator.type === 'identifier';
      out.sites.push({ k: byValue && constructs ? 'construct' : 'type', ty: text, rel: 'uses', line: row(node) });
    }
  }
}

/** An expression as a small object (see the module comment). */
export function expr(node) {
  if (!node) return { t: '?' };
  switch (node.type) {
    case 'identifier':
    case 'field_identifier':
      return { t: 'id', n: node.text };
    case 'this':
      return { t: 'this' };
    case 'parenthesized_expression':
      return expr(node.namedChild(0));
    case 'field_expression':
      return { t: 'fld', b: expr(node.childForFieldName('argument')), n: fieldName(node.childForFieldName('field')) };
    case 'qualified_identifier': {
      const parts = [];
      let args = null;
      let d = node;
      for (let guard = 0; d && d.type === 'qualified_identifier' && guard < 20; guard++) {
        const scope = d.childForFieldName('scope');
        if (scope) parts.push(scope.type === 'template_type' ? scope.childForFieldName('name')?.text ?? scope.text : scope.text);
        d = d.childForFieldName('name');
      }

      if (d?.type === 'template_function') {
        parts.push(d.childForFieldName('name')?.text);
        args = templateArgs(d);
      } else if (d) {
        parts.push(d.type === 'destructor_name' ? '~' + d.text.replace(/^~\s*/, '') : d.text);
      }

      const flat = parts.filter(Boolean).flatMap((p) => p.split('::')).filter(Boolean);
      if (CASTS.has(flat[flat.length - 1])) return { t: 'cast', ty: args?.[0] ?? null };
      return args ? { t: 'q', p: flat, a: args } : { t: 'q', p: flat };
    }

    case 'template_function': {
      const name = node.childForFieldName('name')?.text;
      const args = templateArgs(node);
      if (CASTS.has(name)) return { t: 'cast', ty: args[0] ?? null };
      return { t: 'tf', n: name, a: args };
    }

    case 'call_expression': {
      const f = expr(node.childForFieldName('function'));
      if (f.t === 'cast') return f;
      const args = node.childForFieldName('arguments');
      return { t: 'call', f, argc: args ? args.namedChildren.filter((c) => c.type !== 'comment').length : 0 };
    }

    case 'new_expression':
      return { t: 'new', ty: oneLine(node.childForFieldName('type')?.text ?? '') };
    case 'cast_expression':
      return { t: 'cast', ty: oneLine(node.childForFieldName('type')?.text ?? '') };
    case 'subscript_expression':
      return { t: 'sub', b: expr(node.childForFieldName('argument')) };
    case 'pointer_expression':
      return node.text.trimStart().startsWith('*') ? { t: 'deref', b: expr(node.childForFieldName('argument')) } : { t: 'addr', b: expr(node.childForFieldName('argument')) };
    case 'conditional_expression':
      return expr(node.childForFieldName('consequence'));
    case 'compound_literal_expression':
      return { t: 'cast', ty: oneLine(node.childForFieldName('type')?.text ?? '') };
    case 'string_literal':
    case 'raw_string_literal':
    case 'concatenated_string':
      return { t: 'lit', ty: 'string', s: node.text.replace(/^[a-zA-Z0-9]*"|"$/g, '') };
    case 'number_literal':
      return { t: 'lit', ty: /[.eE]/.test(node.text) && !/^0[xX]/.test(node.text) ? 'double' : 'int' };
    case 'true':
    case 'false':
      return { t: 'lit', ty: 'bool' };
    case 'char_literal':
      return { t: 'lit', ty: 'char' };
    case 'null':
    case 'nullptr':
      return { t: 'lit', ty: 'nullptr' };
    default:
      return { t: '?' };
  }
}

function argType(node) {
  const e = expr(node);
  return e.t === 'lit' ? e.ty : null;
}

function templateArgs(node) {
  const args = node.childForFieldName('arguments');
  return (args?.namedChildren ?? []).filter((a) => a.type === 'type_descriptor' || a.type === 'type_identifier' || a.type === 'qualified_identifier' || a.type === 'template_type').map((a) => oneLine(a.text));
}

function fieldName(node) {
  if (!node) return null;
  if (node.type === 'template_method') return node.childForFieldName('name')?.text ?? null;
  if (node.type === 'destructor_name') return '~' + node.text.replace(/^~\s*/, '');
  return node.text;
}

function declaratorName(declarator) {
  let d = declarator;
  for (let guard = 0; d && guard < 20; guard++) {
    if (d.type === 'identifier' || d.type === 'field_identifier') return d.text;
    if (d.type === 'structured_binding_declarator') return null;
    d = d.childForFieldName('declarator') ?? (['pointer_declarator', 'reference_declarator', 'array_declarator', 'parenthesized_declarator', 'attributed_declarator'].includes(d.type) ? d.namedChildren.find((c) => c.type.endsWith('declarator') || c.type === 'identifier') : null);
  }

  return null;
}

function typeWithDeclarator(type, declarator) {
  let text = type.text;
  let d = declarator;
  for (let guard = 0; d && guard < 20; guard++) {
    if (d.type === 'pointer_declarator') text += '*';
    else if (d.type === 'reference_declarator') text += d.text.trimStart().startsWith('&&') ? '&&' : '&';
    else if (d.type === 'array_declarator') text += '[]';
    else if (d.type !== 'init_declarator' && d.type !== 'attributed_declarator') break;
    d = d.childForFieldName('declarator') ?? d.namedChildren.find((c) => c.type.endsWith('declarator') || c.type === 'identifier');
  }

  return normalizeType(text);
}

function isAuto(text) {
  return !text || /^(const\s+)?(auto|decltype\(auto\))\b/.test(text);
}

const row = (node) => node.startPosition.row + 1;
