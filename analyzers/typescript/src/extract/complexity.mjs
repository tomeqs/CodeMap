/**
 * Cyclomatic complexity: 1 + decision points, counted like the C# analyzer (Complexity.cs) so numbers mean the
 * same in both languages: if, ?:, case, loops, catch, &&, ||, ??, ??= and optional chaining. Nested functions
 * count towards the function they are written in, like C# lambdas.
 */
export function complexity(ts, node) {
  if (!node) return 1;
  let count = 0;
  const visit = (n) => {
    switch (n.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ConditionalExpression:
      case ts.SyntaxKind.CaseClause:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CatchClause:
        count++;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const op = n.operatorToken.kind;
        if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken ||
            op === ts.SyntaxKind.QuestionQuestionEqualsToken || op === ts.SyntaxKind.BarBarEqualsToken || op === ts.SyntaxKind.AmpersandAmpersandEqualsToken) count++;
        break;
      }
      case ts.SyntaxKind.PropertyAccessExpression:
      case ts.SyntaxKind.ElementAccessExpression:
      case ts.SyntaxKind.CallExpression:
        if (n.questionDotToken) count++;
        break;
    }

    ts.forEachChild(n, visit);
  };
  visit(node);
  return 1 + count;
}
