"""What the frameworks share: reading call arguments, the names of what decorators and calls resolve to, tags, routes."""
from __future__ import annotations

import ast

from ..resolve import ExtVal


def string_of(node) -> str | None:
    """A string the code writes as a constant (also "a" "b" and "a" + "b")."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = string_of(node.left), string_of(node.right)
        return left + right if left is not None and right is not None else None
    return None


def strings_of(node) -> list[str]:
    """Strings of a list, tuple or set literal (or one string)."""
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return [s for s in (string_of(e) for e in node.elts) if s is not None]
    text = string_of(node)
    return [text] if text is not None else []


def argument(call: ast.Call, index: int, name: str | None = None):
    """A call's argument by position, or by keyword."""
    if name is not None:
        for keyword in call.keywords:
            if keyword.arg == name:
                return keyword.value
    positional = [a for a in call.args if not isinstance(a, ast.Starred)]
    return positional[index] if index < len(positional) else None


def keyword(call: ast.Call, name: str):
    for item in call.keywords:
        if item.arg == name:
            return item.value
    return None


def is_false(node) -> bool:
    return isinstance(node, ast.Constant) and node.value is False


def external_name(resolver, node, scope) -> str:
    """The qualified name of what an expression stands for outside the analysis (fastapi.APIRouter.get), else ""."""
    value = resolver.infer(node, scope)
    return value.name if isinstance(value, ExtVal) else ""


def decorator_target(decorator):
    return decorator.func if isinstance(decorator, ast.Call) else decorator


def tag(node: dict | None, *tags: str) -> None:
    if node is None:
        return
    existing = node.setdefault("tags", [])
    for name in tags:
        if name not in existing:
            existing.append(name)


def location(module, node) -> dict:
    return {"file": module.rel, "line": node.lineno, "endLine": getattr(node, "end_lineno", None) or node.lineno}


def join_path(*parts: str) -> str:
    """URL paths joined with one / between them; a trailing / of the last part stays (Django's style)."""
    pieces = [p.strip("/") for p in parts if p and p.strip("/")]
    path = "/" + "/".join(pieces)
    last = next((p for p in reversed(parts) if p), "")
    if last.endswith("/") and path != "/":
        path += "/"
    return path


def short(name: str) -> str:
    return name.rsplit(".", 1)[-1]


def package_of(name: str) -> str:
    return name.split(".", 1)[0]
