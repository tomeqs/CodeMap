"""What a Python project says about itself: its name, version, dependencies, scripts and where its code is.

Read from pyproject.toml (PEP 621, Poetry, PDM, Hatch, setuptools, uv), setup.cfg, setup.py (literal arguments of
setup(), without running it), Pipfile and requirements files.
"""
from __future__ import annotations

import ast
import configparser
import os
import re

from . import tomlmini

MARKERS = ("pyproject.toml", "setup.py", "setup.cfg", "Pipfile", "requirements.txt")

_REQUIREMENT = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$")
_REQUIREMENT_FILE = re.compile(r"^(requirements([-_.][\w.-]+)?|[\w-]+[-_]requirements)\.(txt|in)$", re.I)


class Dependency:
    __slots__ = ("name", "spec", "path", "workspace")

    def __init__(self, name: str, spec: str = "", path: str | None = None) -> None:
        self.name = name
        self.spec = spec
        self.path = path  # the folder of a local project (path dependency, editable install)
        self.workspace = False  # a member of the same workspace (uv), wherever it is


class Project:
    def __init__(self, directory: str) -> None:
        self.dir = directory
        self.name = ""
        self.declared_name = ""
        self.manifest: str | None = None  # the file that describes the project best
        self.version = ""
        self.requires_python = ""
        self.dependencies: dict[str, Dependency] = {}
        self.scripts: list[str] = []  # entry points: "package.module:function"
        self.roots: list[str] = []  # folders imports start from, most specific first
        self.problems: list[str] = []
        self.pyproject: dict = {}
        self.modules: list = []

    def add_dependency(self, name: str, spec: str = "", path: str | None = None) -> None:
        if not name or name.lower() == "python":
            return
        existing = self.dependencies.get(name.lower())
        if existing is None:
            self.dependencies[name.lower()] = Dependency(name, spec.strip(), path)
        else:
            existing.spec = existing.spec or spec.strip()
            existing.path = existing.path or path


def read_project(directory: str) -> Project:
    project = Project(directory)
    names: list[str] = []
    for reader in (_pyproject, _setup_cfg, _setup_py, _pipfile):
        try:
            name = reader(project)
        except (OSError, ValueError, SyntaxError, RecursionError, configparser.Error) as error:
            project.problems.append(f"{os.path.basename(_manifest_of(reader))}: {error}")
            continue
        if name:
            names.append(name)
    _requirements(project)
    if project.manifest is None:
        for marker in MARKERS:
            if os.path.isfile(os.path.join(directory, marker)):
                project.manifest = os.path.join(directory, marker)
                break
    project.declared_name = names[0] if names else ""
    _source_roots(project)
    return project


def _manifest_of(reader) -> str:
    return {_pyproject: "pyproject.toml", _setup_cfg: "setup.cfg", _setup_py: "setup.py", _pipfile: "Pipfile"}.get(reader, "")


# ---------------------------------------------------------------------------------------------- pyproject.toml


def _pyproject(project: Project) -> str:
    path = os.path.join(project.dir, "pyproject.toml")
    if not os.path.isfile(path):
        return ""
    with open(path, encoding="utf-8") as f:
        data = tomlmini.loads(f.read())
    project.manifest = path
    project.pyproject = data
    tool = data.get("tool") or {}
    meta = data.get("project") or {}
    poetry = tool.get("poetry") or {}
    name = _text(meta.get("name")) or _text(poetry.get("name"))
    project.version = _text(meta.get("version")) or _text(poetry.get("version"))
    project.requires_python = _text(meta.get("requires-python"))

    for line in _texts(meta.get("dependencies")):
        _requirement(project, line)
    for group in _tables(meta.get("optional-dependencies")):
        for line in _texts(group):
            _requirement(project, line)
    for group in _tables(data.get("dependency-groups")):
        for line in _texts(group):
            _requirement(project, line)
    for group in _tables((tool.get("pdm") or {}).get("dev-dependencies")):
        for line in _texts(group):
            _requirement(project, line)
    for line in _texts((tool.get("uv") or {}).get("dev-dependencies")):
        _requirement(project, line)

    poetry_groups = [poetry.get("dependencies"), poetry.get("dev-dependencies")]
    poetry_groups += [g.get("dependencies") for g in _tables(poetry.get("group"))]
    for group in poetry_groups:
        for dep, value in (group or {}).items() if isinstance(group, dict) else ():
            if isinstance(value, dict):
                local = value.get("path")
                project.add_dependency(dep, _text(value.get("version")), _local(project, local))
            else:
                project.add_dependency(dep, _text(value))

    sources = (tool.get("uv") or {}).get("sources") or {}
    for dep, value in sources.items() if isinstance(sources, dict) else ():
        if isinstance(value, dict) and (value.get("workspace") or value.get("path")):
            if dep.lower() not in project.dependencies:
                project.add_dependency(dep)
            entry = project.dependencies[dep.lower()]
            entry.path = entry.path or _local(project, value.get("path"))
            entry.workspace = entry.workspace or bool(value.get("workspace"))

    for table in (meta.get("scripts"), meta.get("gui-scripts"), poetry.get("scripts")):
        for value in (table or {}).values() if isinstance(table, dict) else ():
            target = value.get("reference") if isinstance(value, dict) else value
            if isinstance(target, str):
                project.scripts.append(target)
    for group in _tables(meta.get("entry-points")):
        project.scripts.extend(v for v in group.values() if isinstance(v, str))
    return name


# ---------------------------------------------------------------------------------------------- setup.cfg, setup.py


def _setup_cfg(project: Project) -> str:
    path = os.path.join(project.dir, "setup.cfg")
    if not os.path.isfile(path):
        return ""
    config = configparser.ConfigParser(interpolation=None, strict=False)
    with open(path, encoding="utf-8") as f:
        config.read_file(f)
    if project.manifest is None and config.has_section("metadata"):
        project.manifest = path
    name = config.get("metadata", "name", fallback="").strip()
    project.version = project.version or config.get("metadata", "version", fallback="").strip()
    project.requires_python = project.requires_python or config.get("options", "python_requires", fallback="").strip()
    for line in _lines(config.get("options", "install_requires", fallback="")):
        _requirement(project, line)
    if config.has_section("options.extras_require"):
        for _, value in config.items("options.extras_require"):
            for line in _lines(value):
                _requirement(project, line)
    if config.has_section("options.entry_points"):
        for _, value in config.items("options.entry_points"):
            project.scripts.extend(_entry_point(line) for line in _lines(value) if "=" in line)
    for line in _lines(config.get("options", "package_dir", fallback="")):
        key, _, folder = line.partition("=")
        if folder.strip() and not key.strip():
            project.roots.append(os.path.join(project.dir, folder.strip()))
    return name


def _setup_py(project: Project) -> str:
    path = os.path.join(project.dir, "setup.py")
    if not os.path.isfile(path):
        return ""
    with open(path, "rb") as f:
        tree = ast.parse(f.read(), path)
    if project.manifest is None:
        project.manifest = path
    constants = {}
    for statement in tree.body:
        if isinstance(statement, ast.Assign) and len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name):
            constants[statement.targets[0].id] = statement.value
    call = next((n for n in ast.walk(tree) if isinstance(n, ast.Call) and _call_name(n.func) in ("setup", "setuptools.setup", "distutils.core.setup")), None)
    if call is None:
        return ""
    args = {k.arg: _literal(k.value, constants) for k in call.keywords if k.arg}
    project.version = project.version or _text(args.get("version"))
    project.requires_python = project.requires_python or _text(args.get("python_requires"))
    for line in _texts(args.get("install_requires")):
        _requirement(project, line)
    for group in (args.get("extras_require") or {}).values() if isinstance(args.get("extras_require"), dict) else ():
        for line in _texts(group):
            _requirement(project, line)
    entry_points = args.get("entry_points")
    if isinstance(entry_points, dict):
        for group in entry_points.values():
            project.scripts.extend(_entry_point(line) for line in _texts(group) if "=" in line)
    package_dir = args.get("package_dir")
    if isinstance(package_dir, dict) and isinstance(package_dir.get(""), str):
        project.roots.append(os.path.join(project.dir, package_dir[""]))
    return _text(args.get("name"))


def _call_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return f"{_call_name(node.value)}.{node.attr}"
    return ""


def _literal(node: ast.AST, constants: dict, depth: int = 0):
    """The value of a literal argument of setup(), following names of module-level constants; None if it is computed."""
    if depth > 10:
        return None
    if isinstance(node, ast.Name) and node.id in constants:
        return _literal(constants[node.id], constants, depth + 1)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = _literal(node.left, constants, depth + 1), _literal(node.right, constants, depth + 1)
        if isinstance(left, list) and isinstance(right, list):
            return left + right
        return None
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return [v for v in (_literal(e, constants, depth + 1) for e in node.elts) if v is not None]
    if isinstance(node, ast.Dict):
        out = {}
        for key, value in zip(node.keys, node.values):
            k = _literal(key, constants, depth + 1) if key is not None else None
            if isinstance(k, str):
                out[k] = _literal(value, constants, depth + 1)
        return out
    if isinstance(node, ast.Constant) and isinstance(node.value, (str, int, float)):
        return node.value
    return None


# ---------------------------------------------------------------------------------------------- Pipfile, requirements


def _pipfile(project: Project) -> str:
    path = os.path.join(project.dir, "Pipfile")
    if not os.path.isfile(path):
        return ""
    with open(path, encoding="utf-8") as f:
        data = tomlmini.loads(f.read())
    if project.manifest is None:
        project.manifest = path
    for section in ("packages", "dev-packages"):
        for dep, value in (data.get(section) or {}).items():
            if isinstance(value, dict):
                project.add_dependency(dep, _text(value.get("version")).strip("*"), _local(project, value.get("path")))
            else:
                project.add_dependency(dep, _text(value).strip("*"))
    return ""


def _requirements(project: Project) -> None:
    files = []
    for folder in (project.dir, os.path.join(project.dir, "requirements")):
        try:
            names = sorted(os.listdir(folder))
        except OSError:
            continue
        in_folder = folder != project.dir
        files.extend(os.path.join(folder, n) for n in names if (in_folder and n.endswith((".txt", ".in"))) or _REQUIREMENT_FILE.match(n))
    seen: set[str] = set()
    for path in files:
        _requirements_file(project, path, seen)


def _requirements_file(project: Project, path: str, seen: set[str]) -> None:
    real = os.path.realpath(path)
    if real in seen or not os.path.isfile(real) or len(seen) > 50:
        return
    seen.add(real)
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    except OSError:
        return
    folder = os.path.dirname(path)
    for raw in lines:
        line = raw.split(" #")[0].strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith(("-r ", "--requirement ", "-c ", "--constraint ")):
            if line.startswith(("-r", "--requirement")):
                _requirements_file(project, os.path.join(folder, line.split(None, 1)[1].strip()), seen)
            continue
        editable = line.startswith(("-e ", "--editable "))
        if editable:
            line = line.split(None, 1)[1].strip()
        elif line.startswith("-"):
            continue  # --index-url, --hash and other options
        local = _local_reference(folder, line)
        if local:
            egg = re.search(r"#egg=([\w.-]+)", line)
            project.add_dependency(egg.group(1) if egg else os.path.basename(local.rstrip("/\\")), "", local)
        elif not editable or "://" not in line:
            _requirement(project, line)
        else:
            egg = re.search(r"#egg=([\w.-]+)", line)
            if egg:
                project.add_dependency(egg.group(1), line.split("#")[0])


def _local_reference(folder: str, line: str) -> str:
    """A local folder a requirement names: ./lib, ../lib, file:../lib, file:///abs/lib, or `name @ file:...`."""
    text = line.split("@", 1)[1].strip() if " @ " in line else line
    text = text.split("#")[0].strip()
    if text.startswith("file:"):
        text = re.sub(r"^file:(//)?", "", text)
    elif not text.startswith((".", "/", "\\")) and not re.match(r"^[A-Za-z]:[\\/]", text):
        return ""
    path = os.path.normpath(os.path.join(folder, text))
    return path if os.path.isdir(path) else ""


def _requirement(project: Project, line: str) -> None:
    if not isinstance(line, str):
        return
    line = line.strip()
    local = _local_reference(project.dir, line) if " @ " in line else ""
    match = _REQUIREMENT.match(line)
    if not match:
        return
    rest = match.group(3).split(";")[0].strip()
    if rest.startswith("@"):
        rest = ""
    project.add_dependency(match.group(1), rest.strip("() "), local or None)


# ---------------------------------------------------------------------------------------------- source roots


def _source_roots(project: Project) -> None:
    data = project.pyproject
    tool = data.get("tool") or {}
    setuptools = tool.get("setuptools") or {}
    package_dir = setuptools.get("package-dir")
    if isinstance(package_dir, dict):
        for key, folder in package_dir.items():
            if not isinstance(folder, str):
                continue
            if key == "":
                project.roots.append(os.path.join(project.dir, folder))
            elif os.path.basename(folder.rstrip("/")) == key.split(".")[-1]:
                project.roots.append(os.path.dirname(os.path.join(project.dir, folder.rstrip("/"))))
    find = (setuptools.get("packages") or {}) if isinstance(setuptools.get("packages"), dict) else {}
    for folder in _texts((find.get("find") or {}).get("where") if isinstance(find.get("find"), dict) else None):
        project.roots.append(os.path.join(project.dir, folder))
    for package in (tool.get("poetry") or {}).get("packages") or []:
        if isinstance(package, dict) and isinstance(package.get("from"), str):
            project.roots.append(os.path.join(project.dir, package["from"]))
    wheel = (((tool.get("hatch") or {}).get("build") or {}).get("targets") or {}).get("wheel") or {}
    for folder in _texts(wheel.get("packages")):
        project.roots.append(os.path.dirname(os.path.join(project.dir, folder.rstrip("/"))))
    hatch_sources = wheel.get("sources")
    for folder in hatch_sources if isinstance(hatch_sources, list) else (hatch_sources or {}).keys() if isinstance(hatch_sources, dict) else ():
        if isinstance(folder, str) and folder:
            project.roots.append(os.path.join(project.dir, folder))
    pdm_dir = ((tool.get("pdm") or {}).get("build") or {}).get("package-dir")
    if isinstance(pdm_dir, str):
        project.roots.append(os.path.join(project.dir, pdm_dir))
    maturin = (tool.get("maturin") or {}).get("python-source")
    if isinstance(maturin, str):
        project.roots.append(os.path.join(project.dir, maturin))
    if os.path.isdir(os.path.join(project.dir, "src")):
        project.roots.append(os.path.join(project.dir, "src"))
    project.roots.append(project.dir)
    unique = []
    for root in project.roots:
        root = os.path.normpath(root)
        if root not in unique and os.path.isdir(root):
            unique.append(root)
    unique.sort(key=lambda r: -len(r))
    project.roots = unique


# ---------------------------------------------------------------------------------------------- helpers


def _local(project: Project, path) -> str | None:
    if not isinstance(path, str) or not path:
        return None
    full = os.path.normpath(os.path.join(project.dir, path))
    return full if os.path.isdir(full) else None


def _entry_point(line: str) -> str:
    return line.split("=", 1)[1].split("[")[0].strip()


def _lines(value: str) -> list[str]:
    return [line.split(" #")[0].strip() for line in value.splitlines() if line.strip() and not line.strip().startswith("#")]


def _text(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def _texts(value) -> list[str]:
    if isinstance(value, str):
        return _lines(value)
    return [v for v in value if isinstance(v, str)] if isinstance(value, list) else []


def _tables(value) -> list:
    return list(value.values()) if isinstance(value, dict) else []
