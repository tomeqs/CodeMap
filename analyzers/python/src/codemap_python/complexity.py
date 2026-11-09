"""Cyclomatic complexity: 1 + decision points, counted like the C# analyzer (Complexity.cs) so the numbers mean the
same in every language: if and elif, conditional expressions, loops, except clauses, each `and` / `or`, each `for`
and `if` of a comprehension, and match cases (not the catch-all `case _`). Nested functions and lambdas count
towards the function they are written in, like C# lambdas.
"""
from __future__ import annotations

import ast

_MATCH_CASE = getattr(ast, "match_case", None)
_MATCH_AS = getattr(ast, "MatchAs", None)
_SIMPLE = (ast.If, ast.IfExp, ast.For, ast.AsyncFor, ast.While, ast.ExceptHandler)


def decisions(nodes) -> int:
    """Decision points in the given nodes (statements or expressions) and everything inside them."""
    count = 0
    stack = list(nodes) if isinstance(nodes, (list, tuple)) else [nodes]
    while stack:
        node = stack.pop()
        if isinstance(node, _SIMPLE):
            count += 1
        elif isinstance(node, ast.BoolOp):
            count += len(node.values) - 1
        elif isinstance(node, ast.comprehension):
            count += 1 + len(node.ifs)
        elif _MATCH_CASE is not None and isinstance(node, _MATCH_CASE):
            pattern = node.pattern
            if not (isinstance(pattern, _MATCH_AS) and pattern.pattern is None and pattern.name is None and node.guard is None):
                count += 1
        stack.extend(ast.iter_child_nodes(node))
    return count


def complexity(nodes) -> int:
    return 1 + decisions(nodes)
