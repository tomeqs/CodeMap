"""The raw graph of a folder, project or file (CodeMap's plugin protocol, version 1): projects, packages,
modules, declarations and the edges between them."""
from __future__ import annotations

import os
import sys

from .declarations import declare_module
from .discover import discover, is_generated
from .distributions import distribution_of, import_names
from .graph import Graph
from .ids import TOP_LEVEL, member_id, normalize, package_id, project_id
from .projects import MARKERS
from .references import collect_references
from .resolve import ModuleIndex, PackageStub, Resolver
from .stdlib import is_stdlib
from .symbols import Decl, read_source, symbols_of

_LEVEL_RANK = {"project": 0, "namespace": 1, "type": 2, "member": 3}


class Context:
    def __init__(self) -> None:
        self.graph = Graph()
        self.resolver: Resolver | None = None
        self.index: ModuleIndex | None = None
        self.project_ids: dict[int, str] = {}
        self.stats = {"calls": 0, "resolved": 0}
        self.unresolved: list[str] = []


def analyze(request: dict, log=lambda message: None) -> dict:
    target = os.path.abspath(request["target"])
    is_file = os.path.isfile(target)
    manifest = is_file and (os.path.basename(target) in MARKERS or os.path.basename(target).startswith("requirements"))
    scan = os.path.dirname(target) if manifest else target
    root = os.path.abspath(request.get("root") or (os.path.dirname(target) if is_file else target))
    options = request.get("options") or {}
    include_tests = options.get("includeTests", True) is not False
    include_generated = bool(options.get("includeGenerated"))

    discovery = discover(scan, root)
    ctx = Context()
    ctx.index = ModuleIndex(discovery)
    ctx.resolver = Resolver(ctx.index)
    graph = ctx.graph
    warnings: list[str] = []
    parse_errors: list[str] = []
    skipped = {"generated": 0, "test": 0}

    for project in discovery.analyzed_projects:
        ctx.project_ids[id(project)] = project_id(project.name)
        for problem in project.problems:
            warnings.append(f"{project.name}: {problem}")

    # Modules on the map: analyzed, parsed, not left out.
    mapped = []
    for module in discovery.modules:
        if not module.analyzed:
            continue
        read_source(module)
        if module.is_test and not include_tests:
            module.skipped = "test"
            skipped["test"] += 1
            continue
        if is_generated(module.path, module.text or ""):
            if not include_generated:
                module.skipped = "generated"
                skipped["generated"] += 1
                continue
            module.generated = True
        if module.parse_error:
            parse_errors.append(f"{module.rel} ({module.parse_error})")
        elif module.is_package and symbols_of(module).empty:
            module.skipped = "empty"
            continue
        mapped.append(module)

    for index, project in enumerate(discovery.analyzed_projects):
        modules = [m for m in mapped if m.project is project]
        if modules:
            log(f"[{index + 1}/{len(discovery.analyzed_projects)}] {project.name}: {len(modules)} file(s)")
        _add_project(ctx, project, modules, root)

    owners = {}
    for module in mapped:
        try:
            owners[id(module)] = declare_module(ctx, module)
        except RecursionError:
            parse_errors.append(f"{module.rel} (too deeply nested to analyze)")
            owners[id(module)] = []

    for module in mapped:
        try:
            collect_references(ctx, module, owners[id(module)])
        except RecursionError:
            warnings.append(f"{module.rel}: too deeply nested to follow all its references.")
        _imports(ctx, module)

    _entry_points(ctx, discovery, mapped)
    _packages(ctx, discovery)

    if parse_errors:
        more = ", …" if len(parse_errors) > 5 else ""
        version = ".".join(str(v) for v in sys.version_info[:2])
        warnings.append(f"{len(parse_errors)} file(s) could not be parsed by Python {version} (newer syntax, Python 2, or broken): {', '.join(parse_errors[:5])}{more}.")
    if ctx.unresolved:
        more = ", …" if len(ctx.unresolved) > 5 else ""
        warnings.append(f"{len(ctx.unresolved)} import(s) of the project's own modules could not be resolved: {', '.join(ctx.unresolved[:5])}{more}.")
    if skipped["generated"]:
        warnings.append(f"{skipped['generated']} generated file(s) were skipped.")
    if skipped["test"]:
        warnings.append(f"{skipped['test']} test file(s) were left out.")
    if os.environ.get("CODEMAP_PY_STATS"):
        calls, resolved = ctx.stats["calls"], ctx.stats["resolved"]
        log(f"calls: {resolved} of {calls} call sites resolved to the analyzed code ({100 * resolved / max(calls, 1):.0f}%)")

    nodes = sorted(graph.nodes.values(), key=lambda n: (_rank(n), n["id"]))
    edges = sorted(graph.connected_edges(), key=lambda e: (e["source"], e["kind"], e["target"]))
    analysis: dict = {"warnings": warnings}
    if options.get("checks"):
        analysis["diagnostics"] = []

    if manifest:
        project = next((p for p in discovery.analyzed_projects if p.dir == scan), None)
        source = {"path": target, "root": root, "kind": "project", "name": project.name if project else os.path.basename(scan)}
    else:
        source = {"path": target, "root": root, "kind": "file" if is_file else "directory", "name": os.path.basename(target)}
    return {"source": source, "nodes": nodes, "edges": edges, "analysis": analysis}


def _rank(node: dict) -> int:
    if node["kind"] == "package":
        return 4
    level = node.get("level") or ("project" if node["kind"] == "project" else "namespace" if node["kind"] == "namespace" else "type")
    return _LEVEL_RANK.get(level, 5)


# ---------------------------------------------------------------------------------------------- projects


def _add_project(ctx: Context, project, modules: list, root: str) -> None:
    pid = ctx.project_ids[id(project)]
    lines = sum(m.lines for m in modules)
    manifest = project.manifest
    manifest_rel = os.path.relpath(manifest, root).replace(os.sep, "/") if manifest else ""
    inside = manifest and not manifest_rel.startswith("../") and manifest_rel != ".."
    if manifest:
        full_name = manifest_rel if inside else project.name
    else:
        full_name = os.path.relpath(project.dir, root).replace(os.sep, "/") or "."
        if full_name.startswith(".."):
            full_name = project.name
    signature = " · ".join(p for p in (
        project.version,
        f"Python {project.requires_python}" if project.requires_python else "",
        "" if manifest else "no project file",
    ) if p)
    tags = []
    if modules and all(m.is_test for m in modules):
        tags.append("test-project")
    if project.scripts:
        tags.append("entrypoint")
    node = {"id": pid, "kind": "project", "name": project.name, "fullName": full_name, "project": pid, "metrics": {"files": len(modules), "lines": lines}}
    if signature:
        node["signature"] = signature
    if inside:
        node["location"] = {"file": manifest_rel, "line": 1, "endLine": 1}
    if tags:
        node["tags"] = tags
    ctx.graph.add_node(node)


def _packages(ctx: Context, discovery) -> None:
    """Declared dependencies: other projects of the analysis (projectReference) or PyPI packages (packageReference)."""
    graph = ctx.graph
    by_dir = {p.dir: p for p in discovery.projects}
    by_name = {normalize(p.declared_name): p for p in discovery.projects if p.declared_name}
    for project in discovery.analyzed_projects:
        pid = ctx.project_ids[id(project)]
        for key in sorted(project.dependencies):
            dependency = project.dependencies[key]
            local = by_dir.get(dependency.path) if dependency.path else None
            local = local or by_name.get(normalize(dependency.name))
            if local is not None and local is not project:
                graph.add_edge(pid, project_id(local.name), "projectReference")
            elif local is None and not dependency.path and not dependency.workspace:
                _ensure_package(ctx, dependency.name, dependency.spec)
                graph.add_edge(pid, package_id(dependency.name), "packageReference")


def _ensure_package(ctx: Context, name: str, spec: str = "") -> None:
    node_id = package_id(name)
    if not ctx.graph.has(node_id):
        node = {"id": node_id, "kind": "package", "name": name, "fullName": name, "external": True}
        if spec:
            node["signature"] = spec
        ctx.graph.add_node(node)


def _declared_imports(project) -> dict[str, str]:
    cache = getattr(project, "_imports", None)
    if cache is None:
        cache = {}
        for dependency in project.dependencies.values():
            for name in import_names(dependency.name):
                cache.setdefault(name, dependency.name)
        project._imports = cache
    return cache


# ---------------------------------------------------------------------------------------------- imports


def _imports(ctx: Context, module) -> None:
    """Module → module `imports` (as written: through a package's __init__.py the edge goes to it); imports under
    TYPE_CHECKING only describe types, so they are `uses`. Imports of other projects' modules reference that project,
    imports of anything else not in the standard library reference its PyPI package."""
    index = ctx.index
    resolver = ctx.resolver
    table = symbols_of(module)
    pid = ctx.project_ids[id(module.project)]
    for binding in table.imports:
        kind = "uses" if binding.type_checking else "imports"
        if binding.module is None:
            ctx.unresolved.append(f"{module.rel}:{binding.line}")
            continue
        if binding.name is None:
            name = binding.full or binding.module
            target = resolver.find_module(name, module)
            if target is None:
                _external(ctx, module, pid, name)
            else:
                _link(ctx, module, pid, target, kind)
            continue
        base_name = binding.module
        base = resolver.find_module(base_name, module) if base_name else None
        if base is None and base_name:
            if binding.relative:
                ctx.unresolved.append(f"{module.rel} → {'.' if binding.relative else ''}{base_name}")
            else:
                _external(ctx, module, pid, base_name)
            continue
        if binding.name == "*":
            _link(ctx, module, pid, base, kind)
            continue
        sub_name = f"{base.name}.{binding.name}" if base is not None and base.name else binding.name
        sub = index.find(sub_name, module)
        declared = symbols_of(base).lookup(binding.name) if base is not None and not isinstance(base, PackageStub) else None
        if sub is not None and not isinstance(sub, PackageStub) and not isinstance(declared, Decl):
            _link(ctx, module, pid, sub, kind)
        elif base is not None:
            _link(ctx, module, pid, base, kind)


def _link(ctx: Context, module, pid: str, target, kind: str) -> None:
    if isinstance(target, PackageStub) or target is module:
        return
    ctx.graph.add_edge(module.id, target.id, kind)
    if target.project is not module.project:
        target_pid = ctx.project_ids.get(id(target.project))
        if target_pid:
            ctx.graph.add_edge(pid, target_pid, "projectReference")


def _external(ctx: Context, module, pid: str, name: str) -> None:
    top = name.split(".")[0]
    if not top or top == "__future__" or is_stdlib(top):
        return
    if ctx.index.is_project_top(top):
        ctx.unresolved.append(f"{module.rel} → {name}")
        return
    distribution = distribution_of(name, _declared_imports(module.project))
    declared = module.project.dependencies.get(distribution.lower())
    if declared is not None and (declared.path or declared.workspace):
        return  # another project of the repository, outside the analysis
    _ensure_package(ctx, distribution, declared.spec if declared else "")
    ctx.graph.add_edge(pid, package_id(distribution), "packageReference")


# ---------------------------------------------------------------------------------------------- entry points


def _entry_points(ctx: Context, discovery, mapped: list) -> None:
    """Where code starts: `if __name__ == "__main__":`, __main__.py, scripts (#!), and the functions a project
    publishes as commands ([project.scripts], console_scripts)."""
    graph = ctx.graph

    def tag(node_id: str) -> None:
        node = graph.nodes.get(node_id)
        if node is not None:
            tags = node.setdefault("tags", [])
            if "entrypoint" not in tags:
                tags.append("entrypoint")

    for module in mapped:
        if module.parse_error:
            continue
        table = symbols_of(module)
        script = (module.text or "").startswith("#!")
        if table.main_guard or os.path.basename(module.file) == "__main__.py" or script:
            tag(module.id)
            tag(member_id(module.id, TOP_LEVEL))

    for project in discovery.analyzed_projects:
        for script in project.scripts:
            module_name, _, attribute = script.partition(":")
            target = ctx.index.find(module_name.strip(), project.modules[0] if project.modules else None)
            if target is None or isinstance(target, PackageStub) or not target.analyzed:
                continue
            tag(target.id)
            if attribute.strip():
                tag(member_id(target.id, attribute.strip()))
