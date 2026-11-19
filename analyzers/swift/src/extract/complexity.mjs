/**
 * Cyclomatic complexity of a body: its decisions, counted as for C#, TypeScript, Python and C++: if (each
 * `else if` too), guard, ?:, each case of a switch (not default), for, while, repeat-while, catch, && and ||.
 * Closures count toward the function they are written in. Returns the decisions only; the caller adds the 1.
 */
const DECISIONS = new Set(['if_statement', 'guard_statement', 'ternary_expression', 'for_statement', 'while_statement', 'repeat_while_statement', 'catch_block', 'conjunction_expression', 'disjunction_expression']);

export function complexityOf(node) {
  if (!node) return 0;
  let count = 0;
  const cursor = node.walk();
  try {
    let more = true;
    while (more) {
      const type = cursor.nodeType;
      if (DECISIONS.has(type)) count++;
      else if (type === 'switch_entry' && !cursor.currentNode.namedChildren.some((c) => c.type === 'default_keyword')) count++;
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
