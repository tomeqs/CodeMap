/**
 * Checks inside function bodies (CodeMap's --checks): a short list of compiler diagnostics that point at real bugs,
 * and rules the compiler does not have: lost exceptions, promises nobody awaits or handles, async callbacks that
 * nothing waits for, unreachable code, self-assignments, duplicate cases, constant conditions, loose equality.
 * Rules that need types skip `any` and types the checker could not resolve.
 */

/** Compiler codes kept, with how they count. */
const COMPILER = new Map([
  [2367, ['warning', 'correctness']], // this comparison appears to be unintentional (no overlap)
  [2801, ['warning', 'async']], // this condition is always true: the Promise is always defined (missing await)
  [2774, ['warning', 'correctness']], // this condition is always true: the function is always defined (not called)
  [2454, ['warning', 'correctness']], // variable used before being assigned
  [6133, ['info', 'dead-code']], // declared but never read (only when noUnusedLocals / noUnusedParameters)
  [18047, ['warning', 'nullability']], // possibly null
  [18048, ['warning', 'nullability']], // possibly undefined
  [2531, ['warning', 'nullability']], // object is possibly null
  [2532, ['warning', 'nullability']], // object is possibly undefined
]);
const NULL_CHECKS = new Set([18047, 18048, 2531, 2532]);
/** Robust when imports are missing: what is left in a file whose imports the compiler could not resolve. */
const UNRESOLVED_SAFE = new Set([2367, 2801, 2774]);
const UNRESOLVED = new Set([2307, 2304, 2305, 2724, 2503, 2552]);

const LOGGING = /log|warn|error|report|trace|captur|notify|console|telemetry|sentry/i;

/**
 * The diagnostics of one file, as CodeMap's format writes them: { rule, source, severity, category, message,
 * location: { file, line, endLine }, column }. The node is left to CodeMap (the innermost declaration around the line).
 */
export function collectDiagnostics(ctx, sf, info) {
  const { ts, program, checker } = ctx;
  const out = [];
  const at = (node, rule, source, severity, category, message) => {
    const start = node.getStart(sf);
    const from = sf.getLineAndCharacterOfPosition(start);
    const to = sf.getLineAndCharacterOfPosition(node.getEnd());
    out.push({ rule, source, severity, category, message, location: { file: info.rel, line: from.line + 1, endLine: to.line + 1 }, column: from.character + 1 });
  };

  // -------------------------------------------------------------------- compiler
  const options = ctx.options;
  const strictNull = options.strictNullChecks ?? !!options.strict;
  const noUnused = !!(options.noUnusedLocals || options.noUnusedParameters);
  const semantic = program.getSemanticDiagnostics(sf);
  const unresolved = semantic.some((d) => UNRESOLVED.has(d.code));
  for (const d of semantic) {
    const kept = COMPILER.get(d.code);
    if (!kept || d.start === undefined) continue;
    if (NULL_CHECKS.has(d.code) && !strictNull) continue;
    if (d.code === 6133 && !noUnused) continue;
    if (unresolved && !UNRESOLVED_SAFE.has(d.code)) continue;
    const from = sf.getLineAndCharacterOfPosition(d.start);
    const to = sf.getLineAndCharacterOfPosition(d.start + (d.length ?? 0));
    out.push({
      rule: `TS${d.code}`,
      source: 'compiler',
      severity: kept[0],
      category: kept[1],
      message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
      location: { file: info.rel, line: from.line + 1, endLine: to.line + 1 },
      column: from.character + 1,
    });
  }

  // -------------------------------------------------------------------- CodeMap's rules
  const typeOf = (node) => {
    try {
      return checker.getTypeAtLocation(node);
    } catch {
      return undefined;
    }
  };
  const isPromise = (node) => {
    const type = typeOf(node);
    if (!type || type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return false;
    if (type.isUnion?.()) return type.types.every((t) => promiseLike(t));
    return promiseLike(type);
  };
  const promiseLike = (type) => {
    const name = type.getSymbol()?.getName();
    if (name === 'Promise' || name === 'PromiseLike') return true;
    const then = type.getProperty?.('then');
    return !!then && !!name && /Promise/.test(name);
  };
  const isAsyncFunction = (node) =>
    node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
  const strip = (e) => {
    while (e && ts.isParenthesizedExpression(e)) e = e.expression;
    return e;
  };
  const sameText = (a, b) => (ts.isIdentifier(a) || ts.isPropertyAccessExpression(a)) && a.getText(sf) === b.getText(sf);
  const hasComment = (node) => /\/\/|\/\*/.test(sf.text.slice(node.getStart(sf), node.getEnd()));

  const condition = (expr, node) => {
    const e = strip(expr);
    if (!e) return;
    const literal = e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword || ts.isNumericLiteral(e) || ts.isStringLiteral(e);
    // while (true) and while (1) loop on purpose.
    const loopForever = ts.isWhileStatement(node) && (e.kind === ts.SyntaxKind.TrueKeyword || (ts.isNumericLiteral(e) && Number(e.text) !== 0));
    const doOnce = ts.isDoStatement(node) && (e.kind === ts.SyntaxKind.FalseKeyword || (ts.isNumericLiteral(e) && e.text === '0'));
    if (literal && !loopForever && !doOnce) {
      at(e, 'constant-condition', 'codemap', 'info', 'correctness', `The condition '${e.getText(sf)}' never changes: a leftover from debugging, or a branch that never runs.`);
    } else if (!literal && !ts.isBinaryExpression(e) && isPromise(e)) {
      at(e, 'misused-promise-condition', 'codemap', 'warning', 'async', `'${e.getText(sf)}' is a Promise, which is always truthy: the await is missing.`);
    }
  };

  const unreachable = (statements) => {
    let exited = false;
    for (const statement of statements) {
      if (exited) {
        if (ts.isFunctionDeclaration(statement) || ts.isEmptyStatement(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
        if (ts.isVariableStatement(statement) && statement.declarationList.flags === ts.NodeFlags.None && statement.declarationList.declarations.every((d) => !d.initializer)) continue;
        at(statement, 'unreachable-code', 'codemap', 'warning', 'dead-code', 'This code can never run: it comes after a return, throw, break or continue.');
        return;
      }

      exited = ts.isReturnStatement(statement) || ts.isThrowStatement(statement) || ts.isBreakStatement(statement) || ts.isContinueStatement(statement);
    }
  };

  const visit = (node) => {
    if (ts.isCatchClause(node)) {
      const block = node.block;
      const name = node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name) ? node.variableDeclaration.name.text : null;
      if (block.statements.length === 0) {
        if (!hasComment(block)) at(node, 'empty-catch', 'codemap', 'warning', 'exceptions', 'Empty catch block: the error is silently ignored. Handle it, log it, or say in a comment why ignoring it is safe.');
      } else {
        let throws = false;
        let uses = false;
        let logs = false;
        const scan = (n) => {
          if (ts.isThrowStatement(n)) throws = true;
          else if (name && ts.isIdentifier(n) && n.text === name) uses = true;
          else if (ts.isCallExpression(n) && LOGGING.test(n.expression.getText(sf))) logs = true;
          ts.forEachChild(n, scan);
        };
        scan(block);
        if (!throws && !uses && !logs) at(node, 'swallowed-exception', 'codemap', 'info', 'exceptions', 'The error is caught and dropped: nothing logs it, rethrows it or looks at it, so failures disappear without a trace.');
      }
    } else if (ts.isExpressionStatement(node)) {
      const e = strip(node.expression);
      const handled = ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)
        && (e.expression.name.text === 'catch' || (e.expression.name.text === 'then' && e.arguments.length >= 2));
      if ((ts.isCallExpression(e) || ts.isNewExpression(e)) && !handled && isPromise(e)) {
        at(e, 'floating-promise', 'codemap', 'warning', 'async', `The promise of '${shorten(e.getText(sf))}' is neither awaited, returned nor handled: its errors become unhandled rejections. Await it, return it, or add .catch().`);
      }
    } else if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      condition(node.expression, node);
    } else if (ts.isConditionalExpression(node)) {
      condition(node.condition, node);
    } else if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken && isPromise(strip(node.operand))) {
      at(node, 'misused-promise-condition', 'codemap', 'warning', 'async', `'${node.getText(sf)}' negates a Promise, which is always truthy: the await is missing.`);
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'forEach' && isAsyncFunction(node.arguments[0])) {
      at(node.arguments[0], 'foreach-async', 'codemap', 'warning', 'async', 'forEach does not wait for an async callback: the loop ends before the work, and errors are lost. Use for…of with await, or Promise.all(items.map(…)).');
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Promise' && isAsyncFunction(node.arguments?.[0])) {
      at(node.arguments[0], 'async-promise-executor', 'codemap', 'warning', 'async', 'An async Promise executor loses its exceptions instead of rejecting the promise: make the executor synchronous, or drop new Promise and use an async function.');
    } else if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsToken && sameText(node.left, node.right)) {
        at(node, 'self-assignment', 'codemap', 'warning', 'correctness', `'${node.getText(sf)}' assigns a value to itself: probably meant this.${node.left.getText(sf)} = ${node.right.getText(sf)}.`);
      } else if ([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken,
        ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken].includes(op) && sameText(node.left, node.right)) {
        at(node, 'self-comparison', 'codemap', 'warning', 'correctness', `'${node.getText(sf)}' compares a value with itself: always the same result, probably a typo.`);
      } else if ((op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) && !isNullish(node.left) && !isNullish(node.right) && !samePrimitive(node.left, node.right)) {
        at(node, 'loose-equality', 'codemap', 'info', 'correctness', `'${shorten(node.getText(sf))}' converts types before comparing ('0' == 0, [] == false): use ${op === ts.SyntaxKind.EqualsEqualsToken ? '===' : '!=='}.`);
      }
    } else if (ts.isSwitchStatement(node)) {
      const seen = new Set();
      for (const clause of node.caseBlock.clauses) {
        if (!ts.isCaseClause(clause)) continue;
        const text = clause.expression.getText(sf);
        if (seen.has(text)) at(clause, 'duplicate-case', 'codemap', 'warning', 'correctness', `case ${shorten(text)} appears twice in this switch: the second is never reached.`);
        seen.add(text);
      }
    }

    if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isCaseClause(node) || ts.isDefaultClause(node) || ts.isModuleBlock(node)) unreachable(node.statements);
    ts.forEachChild(node, visit);
  };

  // Two strings, numbers or booleans: == cannot coerce anything (typeof x == 'string' included).
  const primitive = (e) => {
    const type = typeOf(e);
    if (!type) return null;
    const f = type.flags;
    if (f & ts.TypeFlags.StringLike) return 'string';
    if (f & ts.TypeFlags.NumberLike) return 'number';
    if (f & ts.TypeFlags.BooleanLike) return 'boolean';
    if (f & ts.TypeFlags.BigIntLike) return 'bigint';
    return null;
  };
  const samePrimitive = (a, b) => {
    const left = primitive(a);
    return left !== null && left === primitive(b);
  };

  const isNullish = (e) => {
    const s = strip(e);
    return s.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(s) && s.text === 'undefined');
  };

  visit(sf);
  return out;
}

function shorten(text) {
  const line = text.replace(/\s+/g, ' ');
  return line.length > 60 ? line.slice(0, 57) + '…' : line;
}
