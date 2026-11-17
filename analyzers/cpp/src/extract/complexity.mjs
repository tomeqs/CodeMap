/**
 * Cyclomatic complexity of a function body: 1 + its decisions, counted as for C#, TypeScript and Python: if,
 * ?:, each case label (not default), for, range-for, while, do, catch, && and || (also `and` / `or`). Lambdas
 * count toward the function they are written in. Returns the decisions only; the caller adds the 1.
 */
const DECISIONS = new Set(['if_statement', 'conditional_expression', 'for_statement', 'for_range_loop', 'while_statement', 'do_statement', 'catch_clause']);

export function complexityOf(node) {
  if (!node) return 0;
  let count = 0;
  const cursor = node.walk();
  try {
    let more = true;
    while (more) {
      const type = cursor.nodeType;
      if (DECISIONS.has(type)) count++;
      else if (type === 'case_statement') {
        if (!cursor.currentNode.text.trimStart().startsWith('default')) count++;
      } else if (type === 'binary_expression') {
        const op = cursor.currentNode.childForFieldName('operator')?.type;
        if (op === '&&' || op === '||' || op === 'and' || op === 'or') count++;
      }

      if (cursor.gotoFirstChild()) continue;
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent() || cursor.currentNode.id === node.id) {
          more = false;
          break;
        }
      }
    }
  } finally {
    cursor.delete();
  }

  return count;
}
