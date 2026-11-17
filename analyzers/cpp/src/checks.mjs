/**
 * Problems inside function bodies (`--checks`), from the syntax and the types the code declares. The rules shared
 * with C#, TypeScript and Python keep their ids; the C and C++ ones are narrowed to stay quiet on real code (see
 * docs/analysis.md). Diagnostics carry no node: CodeMap places each on the deepest declaration around its line.
 */

const RULES = {
  'unreachable-code': ['warning', 'dead-code'],
  'self-assignment': ['warning', 'correctness'],
  'self-comparison': ['warning', 'correctness'],
  'constant-condition': ['info', 'correctness'],
  'duplicate-case': ['warning', 'correctness'],
  'empty-catch': ['warning', 'exceptions'],
  'swallowed-exception': ['info', 'exceptions'],
  'float-equality': ['info', 'correctness'],
  'assignment-in-condition': ['warning', 'correctness'],
  'empty-statement': ['warning', 'correctness'],
  'implicit-fallthrough': ['warning', 'correctness'],
  'missing-virtual-destructor': ['warning', 'resources'],
  'delete-mismatch': ['warning', 'resources'],
  'leaked-new': ['info', 'resources'],
  'unnamed-lock': ['warning', 'concurrency'],
  'virtual-call-in-constructor': ['warning', 'correctness'],
  'catch-by-value': ['warning', 'exceptions'],
  'throw-pointer': ['warning', 'exceptions'],
  'exception-not-thrown': ['warning', 'exceptions'],
  'return-local-address': ['warning', 'correctness'],
  'sizeof-pointer': ['warning', 'correctness'],
  'string-literal-comparison': ['warning', 'correctness'],
  'unsafe-c-function': ['info', 'correctness'],
  'using-namespace-in-header': ['info', 'correctness'],
};

const EXITS = new Set(['return_statement', 'throw_statement', 'break_statement', 'continue_statement', 'goto_statement']);
const NORETURN = /^(?:std::)?(exit|_exit|_Exit|abort|quick_exit|terminate|longjmp|siglongjmp|__builtin_unreachable|unreachable|__assume|qFatal|panic|die|fatal|LOG\(FATAL\)|UE_LOG_FATAL|checkNoEntry)$/;
const LOCKS = /^(?:std::)?(lock_guard|unique_lock|scoped_lock|shared_lock)\b|^(QMutexLocker|QReadLocker|QWriteLocker|FScopeLock|FScopeRWLock)\b/;
const STD_EXCEPTIONS = /^(?:std::)?(exception|runtime_error|logic_error|invalid_argument|out_of_range|length_error|domain_error|range_error|overflow_error|underflow_error|system_error|bad_alloc)$/;
const UNSAFE = { gets: 'warning', strcpy: 'info', strcat: 'info', sprintf: 'info', vsprintf: 'info' };
const SIZED = new Set(['memset', 'memcpy', 'memmove', 'memcmp', 'strncpy', 'strncat', 'snprintf', 'fgets', 'read', 'write', 'fread', 'fwrite', 'recv', 'send', 'bzero']);

export function runChecks(tree, file) {
  const out = [];
  const at = (rule, node, message, severity = null) => {
    const [defaultSeverity, category] = RULES[rule];
    out.push({
      rule,
      source: 'codemap',
      severity: severity ?? defaultSeverity,
      category,
      message,
      location: { file: file.rel, line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
      column: node.startPosition.column + 1,
    });
  };

  const scopes = [];
  const classes = new Map(); // class name → fields allocated and deleted across its functions in this file
  const visit = (node) => {
    let pushed = false;
    if (node.type === 'function_definition' || node.type === 'lambda_expression') {
      const scope = functionScope(node);
      scope.owner = node.type === 'function_definition' ? ownerOf(node) : scopes[scopes.length - 1]?.owner ?? null;
      scopes.push(scope);
      pushed = true;
    }

    const scope = scopes[scopes.length - 1];
    check(node, scope, at, file);
    for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i));
    if (pushed) {
      const done = scopes.pop();
      finishScope(done, at);
      if (done.owner) {
        if (!classes.has(done.owner)) classes.set(done.owner, { allocations: [], deletes: [] });
        const fields = classes.get(done.owner);
        fields.allocations.push(...done.allocations.filter((a) => !done.locals.has(a.name)));
        fields.deletes.push(...done.deletes.filter((d) => !done.locals.has(d.name)));
      }
    }
  };

  visit(tree.rootNode);
  // A field allocated in one member (the constructor) and released in another (the destructor).
  for (const fields of classes.values()) mismatches(fields, at, true);
  return out;
}

/** The class a function belongs to: Order::f() defined outside, or the class whose body holds it. */
function ownerOf(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'class_specifier' || p.type === 'struct_specifier') return p.childForFieldName('name')?.text ?? null;
  }

  let d = node.childForFieldName('declarator');
  for (let guard = 0; d && d.type !== 'function_declarator' && guard < 10; guard++) d = d.childForFieldName('declarator') ?? d.namedChildren.find((c) => c.type.endsWith('declarator'));
  const name = d?.childForFieldName('declarator');
  if (name?.type !== 'qualified_identifier') return null;
  const scope = name.childForFieldName('scope');
  return scope ? scope.text.replace(/<.*$/, '').split('::').pop() : null;
}

function mismatches({ allocations, deletes }, at, fields = false) {
  for (const del of deletes) {
    const allocated = allocations.filter((a) => a.name === del.name);
    if (allocated.length && allocated.every((a) => a.array !== del.array)) {
      const what = fields ? `the field ${del.name}` : del.name;
      at('delete-mismatch', del.node, del.array ? `${what} was allocated with new, not new[]: use delete.` : `${what} was allocated with new[]: use delete[].`);
    }
  }
}

/** A function's locals and parameters with what the checks need of their types. */
function functionScope(node) {
  const scope = { locals: new Map(), allocations: [], deletes: [], news: [], returnsReference: false, uses: [] };
  const declarator = node.childForFieldName('declarator');
  if (node.type === 'function_definition') {
    let d = declarator;
    for (let guard = 0; d && d.type !== 'function_declarator' && guard < 10; guard++) {
      if (d.type === 'reference_declarator') scope.returnsReference = true;
      d = d.childForFieldName('declarator') ?? d.namedChildren.find((c) => c.type.endsWith('declarator'));
    }

    const params = d?.childForFieldName('parameters');
    for (const p of params?.namedChildren ?? []) declare(scope, p.childForFieldName('type'), p.childForFieldName('declarator'), { param: true });
  } else {
    const params = declarator?.childForFieldName('parameters');
    for (const p of params?.namedChildren ?? []) declare(scope, p.childForFieldName('type'), p.childForFieldName('declarator'), { param: true });
  }

  return scope;
}

function declare(scope, typeNode, declarator, { param = false, isStatic = false } = {}) {
  if (!declarator) return;
  let pointer = false;
  let array = false;
  let reference = false;
  let d = declarator;
  let name = null;
  for (let guard = 0; d && guard < 20; guard++) {
    if (d.type === 'identifier') {
      name = d.text;
      break;
    }

    if (d.type === 'pointer_declarator') pointer = true;
    else if (d.type === 'reference_declarator') reference = true;
    else if (d.type === 'array_declarator') array = true;
    d = d.childForFieldName('declarator') ?? d.namedChildren.find((c) => c.type.endsWith('declarator') || c.type === 'identifier');
  }

  if (!name) return;
  const type = typeNode?.text ?? '';
  scope.locals.set(name, { type, pointer, array, reference, param, isStatic, float: /^(const\s+)?(float|double|long\s+double)$/.test(type.trim()) && !pointer && !array, char: /\bchar\b/.test(type) && (pointer || array) });
}

function check(node, scope, at, file) {
  switch (node.type) {
    case 'declaration': {
      if (!scope) {
        // using namespace at file or namespace scope of a header
        break;
      }

      const isStatic = node.namedChildren.some((c) => c.type === 'storage_class_specifier' && c.text === 'static');
      const type = node.childForFieldName('type');
      for (const declarator of node.childrenForFieldName('declarator')) {
        declare(scope, type, declarator, { isStatic });
        const value = declarator.type === 'init_declarator' ? declarator.childForFieldName('value') : null;
        const name = declarator.type === 'init_declarator' ? declarator.childForFieldName('declarator') : null;
        if (value?.type === 'new_expression' && name) {
          const id = innermostName(name);
          if (id) {
            scope.allocations.push({ name: id, array: isArrayNew(value), node: declarator });
            if (pointerDeclarator(name)) scope.news.push({ name: id, node: declarator, args: value.childForFieldName('arguments')?.text ?? '', type: value.childForFieldName('type')?.text ?? '' });
          }
        }

        // std::lock_guard<std::mutex>(m_); declares a new lock named m_, locking nothing that was meant.
        if (type && LOCKS.test(type.text.replace(/\s+/g, '')) && declarator.type === 'parenthesized_declarator') {
          at('unnamed-lock', node, `This declares a new ${type.text.split('<')[0]} named ${declarator.text.replace(/[()\s]/g, '')} instead of locking it; give the lock a name.`);
        }
      }

      break;
    }

    case 'using_declaration':
      // At global scope: inside a namespace of its own (an ADL helper) it does not reach the includer. Literal
      // namespaces (std::chrono_literals, Qt::Literals::StringLiterals) exist to be used this way.
      if (!scope && file.header && /^using\s+namespace\b/.test(node.text) && !/literals\s*;?\s*$/i.test(node.text) && !inFunction(node) && !inNamespace(node)) {
        at('using-namespace-in-header', node, `${node.text.replace(/\s+/g, ' ').replace(/;$/, '')} in a header applies to every file that includes it.`);
      }

      break;

    case 'if_statement':
    case 'while_statement': {
      const condition = node.childForFieldName('condition');
      const value = conditionValue(condition);
      if (value?.type === 'assignment_expression' && value.childForFieldName('operator')?.text === '=') {
        at('assignment-in-condition', value, 'An assignment as the condition: == was probably meant (wrap it in another pair of parentheses if not).');
      }

      if (node.type === 'if_statement' && value && /^(number_literal|true|false)$/.test(value.type) && !/^constexpr/.test(node.text.slice(2).trim())) {
        at('constant-condition', value, `The condition is always ${value.text === '0' || value.text === 'false' ? 'false' : 'true'}.`);
      }

      // if (x); { … }: the block is not the if's (nor a loop's) and always runs.
      const body = node.childForFieldName(node.type === 'if_statement' ? 'consequence' : 'body');
      const alternative = node.childForFieldName('alternative');
      if (body && isEmptyStatement(body) && !alternative && node.nextNamedSibling?.type === 'compound_statement') {
        at('empty-statement', body, `The ${node.type === 'if_statement' ? 'if' : 'loop'} ends at this ';': the block after it always runs.`);
      }

      break;
    }

    case 'for_statement': {
      const body = node.childForFieldName('body');
      if (body && isEmptyStatement(body) && node.nextNamedSibling?.type === 'compound_statement') {
        at('empty-statement', body, "The loop ends at this ';': the block after it runs once.");
      }

      break;
    }

    case 'compound_statement':
      unreachable(node, at, file.sourceLines);
      break;

    case 'switch_statement':
      switchChecks(node, at);
      break;

    case 'assignment_expression': {
      const left = node.childForFieldName('left');
      const right = node.childForFieldName('right');
      if (node.childForFieldName('operator')?.text === '=' && left && right && same(left, right)) {
        at('self-assignment', node, `${left.text} is assigned to itself.`);
      }

      if (scope && right?.type === 'new_expression') {
        const name = left?.type === 'identifier' ? left.text : left?.type === 'field_expression' ? left.childForFieldName('field')?.text : null;
        if (name) scope.allocations.push({ name, array: isArrayNew(right), node });
      }

      break;
    }

    case 'binary_expression': {
      const op = node.childForFieldName('operator')?.text;
      const left = node.childForFieldName('left');
      const right = node.childForFieldName('right');
      if (!left || !right) break;
      if (/^(==|!=|<|>|<=|>=)$/.test(op) && op !== '!=' && same(left, right)) at('self-comparison', node, `${left.text} is compared with itself.`);
      if ((op === '==' || op === '!=') && scope) {
        const integral = /\((int|long|unsigned|short|i64|u64|i32|u32|int64_t|int32_t|sqlite3_int64|size_t)\)|static_cast<\s*(int|long|unsigned|size_t|int64_t|int32_t)/;
        if ((isFloat(left, scope) || isFloat(right, scope)) && !same(left, right) && !integral.test(left.text + ' ' + right.text)) {
          if (!isWholeNumber(left) && !isWholeNumber(right) && !exactOnPurpose(left) && !exactOnPurpose(right)) at('float-equality', node, 'Floating-point values compared with ' + op + ': rounding makes equal values differ; compare with a tolerance.');
        }

        const literal = left.type === 'string_literal' ? right : right.type === 'string_literal' ? left : null;
        if (literal && literal.type === 'identifier' && scope.locals.get(literal.text)?.char) {
          at('string-literal-comparison', node, `${literal.text} is a char pointer: ${op} compares addresses, not text (use strcmp or std::string).`);
        }
      }

      break;
    }

    case 'catch_clause': {
      const parameters = node.childForFieldName('parameters');
      const body = node.childForFieldName('body');
      const all = parameters?.text.replace(/\s/g, '') === '(...)';
      if (body && body.namedChildren.length === 0) {
        at('empty-catch', node, all ? 'Every exception is caught and ignored.' : 'The exception is caught and ignored.');
      } else if (all && body && !/\bthrow\b|\breturn\b|\(|=/.test(body.text.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ''))) {
        at('swallowed-exception', node, 'Every exception is caught and dropped: not rethrown, logged or turned into a result.');
      }

      const param = parameters?.namedChildren.find((c) => c.type === 'parameter_declaration');
      if (param) {
        const declarator = param.childForFieldName('declarator');
        const type = param.childForFieldName('type');
        const byValue = !declarator || !/^[&*]/.test(declarator.text.trim()) && declarator.type !== 'reference_declarator' && declarator.type !== 'pointer_declarator';
        if (type && byValue && !/^(int|long|char|unsigned|short|bool|float|double|size_t|auto)\b/.test(type.text) && /^[A-Za-z_:]/.test(type.text)) {
          at('catch-by-value', param, `${type.text} is caught by value: a derived exception is sliced (catch by const reference).`);
        }
      }

      break;
    }

    case 'throw_statement': {
      const thrown = node.namedChild(0);
      if (thrown?.type === 'new_expression') at('throw-pointer', node, 'A pointer is thrown: catch (const X&) does not catch it, and nobody deletes it (throw the object).');
      break;
    }

    case 'expression_statement': {
      const e = node.namedChild(0);
      if (!e) break;
      const callee = e.type === 'call_expression' ? e.childForFieldName('function') : e.type === 'compound_literal_expression' ? e.childForFieldName('type') : null;
      if (!callee) break;
      const name = callee.text.replace(/\s+/g, '');
      if (LOCKS.test(name)) {
        at('unnamed-lock', node, `This ${name.split('<')[0]} is a temporary: it unlocks at the end of the statement (give it a name).`);
      } else if (STD_EXCEPTIONS.test(name.replace(/^::/, ''))) {
        at('exception-not-thrown', node, `${name}(…) makes an exception and drops it: the throw is missing.`);
      }

      break;
    }

    case 'call_expression': {
      const callee = node.childForFieldName('function');
      const name = callee?.type === 'identifier' ? callee.text : callee?.type === 'qualified_identifier' && /^(::|std::)/.test(callee.text) ? callee.text.replace(/^::|^std::/, '') : null;
      if (name && UNSAFE[name]) {
        at('unsafe-c-function', node, name === 'gets' ? 'gets() cannot know the buffer size and was removed from C and C++ (use fgets).' : `${name}() writes without a size limit (use the n-version or snprintf).`, UNSAFE[name]);
      }

      if (name && SIZED.has(name) && scope) {
        for (const arg of node.childForFieldName('arguments')?.namedChildren ?? []) {
          if (arg.type !== 'sizeof_expression') continue;
          const of = arg.childForFieldName('value') ?? arg.namedChild(0);
          const inner = of?.type === 'parenthesized_expression' ? of.namedChild(0) : of;
          const local = inner?.type === 'identifier' ? scope.locals.get(inner.text) : null;
          // memset(p, 0, sizeof(p)): the pointer is the buffer. memcpy(dst, &p, sizeof(p)) copies the pointer: fine.
          const asBuffer = (node.childForFieldName('arguments')?.namedChildren ?? []).some((a) => a.type === 'identifier' && a.text === inner?.text);
          if (local?.pointer && !local.array && asBuffer) at('sizeof-pointer', arg, `sizeof(${inner.text}) is the size of the pointer, not of what it points at.`);
        }
      }

      break;
    }

    case 'delete_expression': {
      if (!scope) break;
      const target = node.namedChild(0);
      const name = target?.type === 'identifier' ? target.text : target?.type === 'field_expression' ? target.childForFieldName('field')?.text : null;
      if (name) scope.deletes.push({ name, array: /^delete\s*\[\s*\]/.test(node.text), node });
      break;
    }

    case 'return_statement': {
      if (!scope) break;
      const value = node.namedChild(0);
      if (value?.type === 'pointer_expression' && value.text.trim().startsWith('&')) {
        const of = value.childForFieldName('argument');
        const local = of?.type === 'identifier' ? scope.locals.get(of.text) : null;
        if (local && !local.isStatic && !local.reference && !local.pointer && !(local.param && local.array)) {
          at('return-local-address', node, `The address of ${of.text}, which ends with the function, is returned.`);
        }
      } else if (scope.returnsReference && value?.type === 'identifier') {
        const local = scope.locals.get(value.text);
        if (local && !local.isStatic && !local.reference && !local.pointer && !local.param) {
          at('return-local-address', node, `A reference to ${value.text}, which ends with the function, is returned.`);
        }
      }

      break;
    }

    default:
      break;
  }

  if (scope && node.type === 'identifier') scope.uses.push(node);
}

/** When a function ends: delete / delete[] against how the same name was allocated; locals newed and never let go. */
function finishScope(scope, at) {
  mismatches({ allocations: scope.allocations.filter((a) => scope.locals.has(a.name)), deletes: scope.deletes.filter((d) => scope.locals.has(d.name)) }, at);

  for (const created of scope.news) {
    if (/^(Q[A-Z]|U[A-Z]|A[A-Z])/.test(created.type.trim()) || /\b(this|parent\w*|owner)\b/i.test(created.args)) continue;
    const later = scope.uses.filter((u) => u.text === created.name && u.startIndex > created.node.endIndex);
    const escapes = later.some((u) => {
      const parent = u.parent;
      if (!parent) return true;
      if (parent.type === 'field_expression' && parent.childForFieldName('argument')?.id === u.id) return false; // p->x, p.x
      if (parent.type === 'pointer_expression' && parent.text.trim().startsWith('*')) return false; // *p
      if (parent.type === 'subscript_expression' && parent.childForFieldName('argument')?.id === u.id) return false; // p[i]
      if (parent.type === 'binary_expression' && /^(==|!=)$/.test(parent.childForFieldName('operator')?.text ?? '')) return false; // p != nullptr
      if (parent.type === 'condition_clause' || parent.type === 'parenthesized_expression' && parent.parent?.type === 'if_statement') return false;
      return true; // deleted, returned, passed, stored, assigned
    });
    if (!escapes) at('leaked-new', created.node, `${created.name} is allocated with new and never deleted, returned or handed on.`);
  }
}

function switchChecks(node, at) {
  const body = node.childForFieldName('body');
  if (!body) return;
  const cases = body.namedChildren.filter((c) => c.type === 'case_statement');
  const seen = new Map();
  for (const c of cases) {
    const value = c.childForFieldName('value');
    if (!value) continue;
    const key = value.text.replace(/\s+/g, '');
    if (seen.has(key)) at('duplicate-case', value, `case ${value.text} is already handled above.`);
    else seen.set(key, c);
  }

  for (let i = 0; i < cases.length - 1; i++) {
    const c = cases[i];
    const statements = c.namedChildren.filter((s) => s.id !== c.childForFieldName('value')?.id && s.type !== 'comment' && !isEmptyStatement(s));
    if (!statements.length) continue; // case A: case B: share one body
    // case 6: testcase(x == 6); — coverage and assertion macros on a label do nothing: the labels share a body.
    if (statements.every(assertionLike)) continue;
    const last = statements[statements.length - 1];
    if (terminates(last)) continue;
    const comments = c.namedChildren.filter((s) => s.type === 'comment').map((s) => s.text).join(' ') + ' ' + (cases[i + 1].previousSibling?.type === 'comment' ? cases[i + 1].previousSibling.text : '');
    if (/fall(s|ing)?[\s_-]*thr(ough|u)|no\s*break|\[\[fallthrough\]\]/i.test(comments + ' ' + last.text)) continue;
    at('implicit-fallthrough', last, `case ${c.childForFieldName('value')?.text ?? ''} runs on into the next case (add break, or [[fallthrough]] if meant).`);
  }
}

/** A statement that only checks something: assert(x), testcase(a == b), Q_ASSERT(…). */
function assertionLike(node) {
  if (node.type !== 'expression_statement') return false;
  const e = node.namedChild(0);
  if (e?.type !== 'call_expression') return false;
  const name = e.childForFieldName('function')?.text ?? '';
  if (/assert|testcase|coverage|check/i.test(name)) return true;
  const args = e.childForFieldName('arguments')?.namedChildren ?? [];
  return args.length === 1 && args[0].type === 'binary_expression' && /^(==|!=|<|>|<=|>=|&&|\|\|)$/.test(args[0].childForFieldName('operator')?.text ?? '');
}

/** Whether control cannot go on after a statement. */
/** `while (true)`, `while (1)`, `for (;;)`, `do … while (true)`. */
function endless(loop) {
  if (loop.type === 'for_statement') return !loop.childForFieldName('condition');
  const condition = loop.childForFieldName('condition')?.text.replace(/[()\s]/g, '');
  return condition === 'true' || condition === '1';
}

/** A break that leaves this statement: not one of a loop or switch inside it, nor of a lambda. */
function breaksOut(node) {
  if (!node) return false;
  if (node.type === 'break_statement') return true;
  if (/^(while|for|for_range_loop|do|switch)_statement$/.test(node.type) || node.type === 'lambda_expression') return false;
  for (let i = 0; i < node.namedChildCount; i++) if (breaksOut(node.namedChild(i))) return true;
  return false;
}

function terminates(node) {
  if (!node) return false;
  if (EXITS.has(node.type)) return true;
  if (node.type === 'attributed_statement' && /fallthrough/.test(node.text)) return true;
  if (node.type === 'compound_statement') {
    const children = node.namedChildren.filter((c) => c.type !== 'comment' && !isEmptyStatement(c));
    if (children.some((c) => c.type === 'case_statement')) return true; // case labels inside the block (Duff's device): not judged
    return children.length > 0 && terminates(children[children.length - 1]);
  }

  if (node.type === 'labeled_statement') return terminates(node.namedChildren[node.namedChildren.length - 1]);

  // `while (true) { … return …; }` with no break out of it (nlohmann's lexer: a case that loops until it returns).
  if (node.type === 'while_statement' || node.type === 'for_statement' || node.type === 'do_statement') return endless(node) && !breaksOut(node.childForFieldName('body'));

  // A switch with a default whose last case does not complete, and no break out of it: every way leaves.
  if (node.type === 'switch_statement') {
    const cases = node.childForFieldName('body')?.namedChildren.filter((c) => c.type === 'case_statement') ?? [];
    if (!cases.some((c) => !c.childForFieldName('value')) || breaksOut(node.childForFieldName('body'))) return false;
    const statements = cases[cases.length - 1].namedChildren.filter((c) => c !== cases[cases.length - 1].childForFieldName('value') && c.type !== 'comment');
    return statements.length > 0 && terminates(statements[statements.length - 1]);
  }

  if (node.type === 'if_statement') {
    const alternative = node.childForFieldName('alternative');
    return Boolean(alternative) && terminates(node.childForFieldName('consequence')) && terminates(alternative.type === 'else_clause' ? alternative.namedChild(0) : alternative);
  }

  if (node.type === 'expression_statement') {
    const e = node.namedChild(0);
    if (e?.type === 'call_expression' && NORETURN.test(e.childForFieldName('function')?.text ?? '')) return true;
    // JSON_THROW(…), FMT_THROW(…): a throw, or an abort with exceptions off; stays a call (see preprocess).
    if (e?.type === 'call_expression' && /^(?:[A-Z][A-Z0-9_]*_)?THROW$/.test(e.childForFieldName('function')?.text ?? '')) return true;
    // assert(0) / assert(false) / assert(!"unreachable"): it stops the program.
    if (e?.type === 'call_expression' && /^(assert|ASSERT|DCHECK|CHECK|ALWAYS|NEVER|Q_ASSERT|check|ensure|verify)$/.test(e.childForFieldName('function')?.text ?? '') && /^\(\s*(0|false|!\s*"[^"]*")\s*\)$/.test(e.childForFieldName('arguments')?.text ?? '')) return true;
    if (/fall[\s_-]*thr(ough|u)/i.test(node.text)) return true;
    if (e?.type === 'throw_expression') return true;
  }

  return false;
}

/** Statements after one that leaves the block (labels and case labels start reachable code again). */
function unreachable(block, at, source) {
  const statements = block.namedChildren.filter((c) => c.type !== 'comment');
  for (let i = 0; i < statements.length - 1; i++) {
    if (!EXITS.has(statements[i].type)) continue;
    const next = statements[i + 1];
    if (next.type === 'labeled_statement' || next.type === 'case_statement' || next.type.startsWith('preproc') || next.type === 'declaration' && /^\s*$/.test(next.text)) break;
    // #if … return a; #else … #endif return b;: one branch was kept, the code after #endif is reachable.
    if (source && source.slice(statements[i].endPosition.row, next.startPosition.row + 1).some((line) => /^\s*#/.test(line))) break;
    // return x; break; in a switch: a habit, not a mistake.
    if (next.type === 'break_statement') break;
    at('unreachable-code', next, `This never runs: the ${statements[i].type.replace('_statement', '')} before it leaves the block.`);
    break;
  }
}

function conditionValue(condition) {
  if (!condition) return null;
  // C++: condition_clause (value: …), or a declaration (if (auto* p = f())), which is fine.
  if (condition.type === 'condition_clause') {
    const value = condition.childForFieldName('value');
    return value && value.type !== 'declaration' ? value : null;
  }

  // C: parenthesized_expression; a second pair of parentheses says the assignment is meant.
  if (condition.type === 'parenthesized_expression') {
    const inner = condition.namedChild(0);
    return inner?.type === 'parenthesized_expression' ? null : inner;
  }

  return condition;
}

function isEmptyStatement(node) {
  return node.type === 'expression_statement' && node.namedChildCount === 0 && node.text.trim() === ';';
}

function same(a, b) {
  if (a.type !== b.type) return false;
  if (!/^(identifier|field_expression|subscript_expression|qualified_identifier)$/.test(a.type)) return false;
  if (/\(/.test(a.text)) return false; // calls may differ
  return a.text.replace(/\s+/g, '') === b.text.replace(/\s+/g, '');
}

function isFloat(node, scope) {
  if (node.type === 'number_literal') return /[.eE]/.test(node.text) && !/^0[xX]/.test(node.text);
  if (node.type === 'identifier') return scope.locals.get(node.text)?.float ?? false;
  return false;
}

const ROUNDING = /^(?:std::)?(?:floor|ceil|trunc|round|rint|nearbyint)[fl]?$|^FMath::(?:Floor|Ceil|Round|Trunc)To(?:Float|Double)$/;

/**
 * A side compared exactly on purpose: a rounded value (`floor(k) == k`: is k whole?), a conversion (`d == (double)f`:
 * does the value survive it?) or a constant macro (`d == HUGE_VAL`, `x != -INFINITY`).
 */
function exactOnPurpose(node) {
  let n = node;
  while (n && (n.type === 'parenthesized_expression' || n.type === 'unary_expression' && /^[-+]$/.test(n.childForFieldName('operator')?.text ?? ''))) {
    n = n.type === 'parenthesized_expression' ? n.namedChild(0) : n.childForFieldName('argument');
  }

  if (!n) return false;
  if (n.type === 'identifier') return /^[A-Z][A-Z0-9_]*$/.test(n.text);
  if (n.type === 'cast_expression') return true;
  if (n.type !== 'call_expression') return false;
  const callee = n.childForFieldName('function')?.text.replace(/\s+/g, '') ?? '';
  return ROUNDING.test(callee) || /^static_cast<(?:double|float|longdouble)>$/.test(callee);
}

function isWholeNumber(node) {
  return node.type === 'number_literal' && /^[+-]?\d+(\.0*)?[fFlL]?$/.test(node.text);
}

function isArrayNew(node) {
  if (node.namedChildren.some((c) => c.type === 'new_declarator') || /^new\s+[^(]*\[/.test(node.text)) return true;
  // new T*[n] parses as `new T` and an error: the [ follows the expression in the declaration's text.
  for (let p = node.parent; p && p.type !== 'compound_statement'; p = p.parent) {
    const after = p.text.slice(node.endIndex - p.startIndex);
    if (/^\s*\*?\s*\[/.test(after)) return true;
    if (p.type === 'declaration' || p.type === 'expression_statement') break;
  }

  return false;
}

function innermostName(declarator) {
  let d = declarator;
  for (let guard = 0; d && guard < 10; guard++) {
    if (d.type === 'identifier') return d.text;
    d = d.childForFieldName('declarator') ?? d.namedChildren.find((c) => c.type.endsWith('declarator') || c.type === 'identifier');
  }

  return null;
}

function pointerDeclarator(declarator) {
  return declarator.type === 'pointer_declarator';
}

function inNamespace(node) {
  for (let p = node.parent; p; p = p.parent) if (p.type === 'namespace_definition') return true;
  return false;
}

function inFunction(node) {
  for (let p = node.parent; p; p = p.parent) if (p.type === 'function_definition' || p.type === 'compound_statement') return true;
  return false;
}

/**
 * Classes with virtual functions and a public destructor that is not virtual: deleting through a base pointer
 * leaks the derived part. Not reported for final classes, protected or private destructors, or classes with bases
 * (one of them may give the virtual destructor).
 */
export function classChecks(facts, file) {
  const out = [];
  const visit = (type) => {
    if (type.kind !== 'class' && type.kind !== 'struct') return;
    const virtuals = type.members.filter((m) => m.kind === 'method' && (m.modifiers ?? []).some((x) => x === 'virtual' || x === 'abstract'));
    const destructor = type.members.find((m) => m.kind === 'destructor');
    const sealed = (type.modifiers ?? []).includes('sealed');
    // An Unreal interface (UINTERFACE's I-class): objects are collected, never deleted through it.
    const unrealInterface = /^I[A-Z]/.test(type.name) && facts.types.some((t) => t.name === 'U' + type.name.slice(1) && t.attributes?.some((a) => a.startsWith('UINTERFACE')));
    if (virtuals.length && !sealed && !unrealInterface && !type.bases.length && (!destructor || destructor.access === 'public' && !(destructor.modifiers ?? []).includes('virtual'))) {
      const [severity, category] = RULES['missing-virtual-destructor'];
      const line = destructor ? destructor.line : type.line;
      out.push({ rule: 'missing-virtual-destructor', source: 'codemap', severity, category, message: `${type.name} has virtual functions but its destructor is not virtual: deleting a derived object through ${type.name}* leaks its part.`, location: { file: file.rel, line, endLine: line }, column: 1 });
    }

    for (const nested of type.nested) visit(nested);
  };
  for (const type of facts.types) visit(type);
  return out;
}

export { RULES };
