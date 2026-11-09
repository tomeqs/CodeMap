"""The nodes of an analyzed module: the module, its package, its declarations and its top-level code."""
from __future__ import annotations

import ast
import os
import re

from .complexity import complexity, decisions
from .ids import ROOT_PACKAGE, TOP_LEVEL, member_id
from .resolve import ClassVal, ExtVal
from .symbols import (
    LANGUAGE_DECORATORS,
    ClassDecl,
    FuncDecl,
    VarDecl,
    decorator_name,
    first_sentence,
    is_constant_name,
    symbols_of,
)

_CONFIG_FILES = re.compile(r"^(setup|noxfile|fabfile|dodo|toxfile|conftest_settings)\.py$|(^|/)docs?/(source/)?conf\.py$|\.conf\.py$")
_MODULE_RUNNERS = re.compile(r"(^|/)__main__\.py$")


def is_config_file(path: str) -> bool:
    """A tool's configuration, which the tool loads itself (setup.py, noxfile.py, docs/conf.py, gunicorn.conf.py), or
    settings loaded by name (settings.py, celeryconfig.py, config.py)."""
    stem = os.path.splitext(os.path.basename(path))[0].lower()
    return bool(_CONFIG_FILES.search(path)) or stem in ("config", "conf", "settings", "configuration") or stem.endswith(("config", "settings", "_conf"))


def declare_module(ctx, module) -> list:
    """Adds the nodes of one module and returns the declarations whose code the reference pass walks."""
    table = symbols_of(module)
    graph = ctx.graph
    project_id = ctx.project_ids[id(module.project)]
    package = module.package or ROOT_PACKAGE
    if not graph.has(module.namespace_id):
        graph.add_node({
            "id": module.namespace_id, "kind": "namespace", "name": package, "fullName": package,
            "parent": project_id, "project": project_id, "namespace": package,
        })

    tags = []
    if module.is_test:
        tags.append("test")
    if is_config_file(module.path):
        tags.append("config")
    if module.is_package:
        tags.append("barrel" if table.barrel else "init")
    if module.generated:
        tags.append("generated")
    stem = os.path.splitext(os.path.basename(module.file))[0]
    graph.add_node(_clean({
        "id": module.id, "kind": "module", "level": "type", "name": os.path.basename(module.file), "fullName": module.name,
        "parent": module.namespace_id, "project": project_id, "namespace": package,
        "accessibility": "private" if stem.startswith("_") and not stem.startswith("__") else "public",
        "location": {"file": module.rel, "line": 1, "endLine": max(module.lines, 1)},
        "tags": tags, "doc": table.doc, "metrics": {"loc": module.lines},
    }))
    if module.parse_error:
        return []

    base_tags = ["test"] if module.is_test else []
    if module.generated:
        base_tags.append("generated")
    lines = module.text.splitlines()
    owners = []
    for decl in table.decls:
        node = _decl_node(ctx, module, decl, project_id, package, lines)
        if node is None:
            continue
        node["tags"] = list(dict.fromkeys(base_tags + decl.tags + node.get("tags", [])))
        graph.add_node(_clean(node))
        owners.append(decl)

    if table.top_lines:
        first, last = min(table.top_lines), max(table.top_lines)
        graph.add_node(_clean({
            "id": member_id(module.id, TOP_LEVEL), "kind": "function", "level": "member", "name": TOP_LEVEL,
            "fullName": f"{module.name}.{TOP_LEVEL}" if module.name else TOP_LEVEL,
            "parent": module.id, "project": project_id, "namespace": package, "accessibility": "private",
            "location": {"file": module.rel, "line": first, "endLine": last}, "tags": list(base_tags),
            "metrics": {"loc": last - first + 1, "complexity": 1 + table.top_decisions + decisions(table.top_code)},
        }))
    return owners


def _decl_node(ctx, module, decl, project_id: str, package: str, lines: list[str]) -> dict | None:
    resolver = ctx.resolver
    parent = decl.owner.id if decl.owner is not None else module.id
    full = f"{module.name}.{decl.qualname}" if module.name else decl.qualname
    node = {
        "id": decl.id, "level": "member", "name": decl.name, "fullName": full, "parent": parent,
        "project": project_id, "namespace": package, "accessibility": "private" if decl.private else "public",
        "location": _location(module, decl.node),
    }
    extra = [_location(module, n) for n in decl.nodes if n is not decl.node]
    if extra:
        node["extraLocations"] = extra
    attributes = [decorator_name(d) for d in decl.decorators]
    attributes = [a for a in dict.fromkeys(attributes) if a not in LANGUAGE_DECORATORS and not a.endswith((".setter", ".getter", ".deleter"))]
    if attributes:
        node["attributes"] = attributes

    if isinstance(decl, ClassDecl):
        kind = "enum" if resolver.is_enum(decl) else "interface" if resolver.is_interface(decl) else "class"
        node["kind"] = kind
        modifiers = []
        if kind == "class" and (resolver.abstract_methods(decl) or resolver.is_abc(decl)):
            modifiers.append("abstract")
        node["modifiers"] = modifiers
        node["signature"] = _class_signature(decl.node)
        node["doc"] = first_sentence(ast.get_docstring(decl.node, clean=True))
        base = _base_type(resolver, decl)
        if base:
            node["baseType"] = base
        if kind == "class" and resolver.is_exception(decl):
            node["tags"] = ["exception"]
        node["metrics"] = {"loc": _loc(node["location"])}
        return node

    if isinstance(decl, FuncDecl):
        definition = decl.node
        node["kind"] = {"function": "function", "constructor": "constructor", "property": "property"}.get(decl.flavor, "method")
        modifiers = []
        if isinstance(definition, ast.AsyncFunctionDef):
            modifiers.append("async")
        if decl.flavor == "static":
            modifiers.append("static")
        if decl.flavor == "classmethod" and decl.name not in ("__new__", "__init_subclass__", "__class_getitem__"):
            modifiers.append("classmethod")
        from .resolve import is_abstract

        if is_abstract(decl):
            modifiers.append("abstract")
        if _is_generator(definition, lines):
            modifiers.append("generator")
        node["modifiers"] = modifiers
        node["signature"] = _function_signature(definition)
        node["doc"] = first_sentence(ast.get_docstring(definition, clean=True))
        bodies = [d.body for d in decl.defs]
        metrics = {"loc": _loc(node["location"]), "complexity": max(complexity(b) for b in bodies)}
        parameters = _parameter_count(definition, decl.owner is not None and decl.flavor != "static")
        if parameters:
            metrics["parameters"] = parameters
        node["metrics"] = metrics
        return node

    if isinstance(decl, VarDecl):
        if decl.owner is not None and resolver.is_enum_member(decl):
            return None  # enum members are the enum's, as in C#
        node["kind"] = "typeAlias" if decl.var_kind == "typeAlias" else "field" if decl.owner is not None else "variable"
        modifiers = []
        annotation = decorator_name(decl.annotation) if decl.annotation is not None and not isinstance(decl.annotation, ast.Subscript) else (
            decorator_name(decl.annotation.value) if isinstance(decl.annotation, ast.Subscript) else "")
        short = annotation.rsplit(".", 1)[-1]
        if short == "ClassVar":
            modifiers.append("static")
        if short == "Final":
            modifiers.append("readonly" if decl.owner is not None else "const")
        elif decl.owner is None and decl.var_kind == "variable" and is_constant_name(decl.name):
            modifiers.append("const")
        node["modifiers"] = modifiers
        node["signature"] = _source_signature(lines, decl.node)
        node["doc"] = decl.doc
        node["metrics"] = {"loc": _loc(node["location"])}
        return node
    return None


def _location(module, node) -> dict:
    start = node.lineno
    for decorator in getattr(node, "decorator_list", ()) or ():
        start = min(start, decorator.lineno)
    end = getattr(node, "end_lineno", None) or node.lineno
    return {"file": module.rel, "line": start, "endLine": end}


def _loc(location: dict) -> int:
    return location["endLine"] - location["line"] + 1


def _shorten(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= 200 else text[:199] + "…"


def _function_signature(node) -> str:
    prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
    try:
        args = ast.unparse(node.args)
        returns = f" -> {ast.unparse(node.returns)}" if node.returns is not None else ""
    except (ValueError, RecursionError):
        args, returns = "…", ""
    return _shorten(f"{prefix} {node.name}({args}){returns}")


def _class_signature(node: ast.ClassDef) -> str:
    try:
        parts = [ast.unparse(b) for b in node.bases] + [f"{k.arg}={ast.unparse(k.value)}" if k.arg else f"**{ast.unparse(k.value)}" for k in node.keywords]
    except (ValueError, RecursionError):
        parts = ["…"]
    return _shorten(f"class {node.name}({', '.join(parts)})" if parts else f"class {node.name}")


def _source_signature(lines: list[str], node) -> str:
    """The declaration as written, on one line: `MAX_ITEMS: int = 10`, `self.repository = repository`."""
    start = node.lineno - 1
    end = min(getattr(node, "end_lineno", node.lineno) or node.lineno, start + 3)
    text = " ".join(line.strip() for line in lines[start:end])
    text = text.rstrip("\\").rstrip()
    if (getattr(node, "end_lineno", node.lineno) or node.lineno) > end:
        text += " …"
    return _shorten(text)


def _base_type(resolver, decl: ClassDecl) -> str:
    for base in resolver.bases(decl):
        if isinstance(base, ClassVal):
            return f"{base.cls.module.name}.{base.cls.qualname}" if base.cls.module.name else base.cls.qualname
        if isinstance(base, ExtVal) and base.name not in ("builtins.object",):
            return base.name.replace("builtins.", "", 1) if base.name.startswith("builtins.") else base.name
    return ""


def _parameter_count(node, method: bool) -> int:
    args = node.args
    positional = list(getattr(args, "posonlyargs", [])) + list(args.args)
    count = len(positional) + len(args.kwonlyargs) + (args.vararg is not None) + (args.kwarg is not None)
    if method and positional:
        count -= 1
    return count


def _is_generator(node, lines: list[str] | None = None) -> bool:
    from .resolve import _local_nodes

    if lines is not None and not any("yield" in line for line in lines[node.lineno - 1 : node.end_lineno or node.lineno]):
        return False  # no yield written in it: no need to look at every node
    return any(isinstance(n, (ast.Yield, ast.YieldFrom)) for n in _local_nodes(node))


def _clean(node: dict) -> dict:
    """The node as written: no empty fields."""
    return {k: v for k, v in node.items() if v is not None and v != "" and v != [] and v != {}}

