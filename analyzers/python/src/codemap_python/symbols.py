"""The symbol table of a module: its declarations, its imports and its top-level code, from Python's ast.

Built for every module the analysis needs, also those only imported from the analyzed folder: references are
resolved through their names. Declarations become nodes only in analyzed modules.
"""
from __future__ import annotations

import ast
import io
import re
import tokenize

from .ids import member_id

_MATCH = getattr(ast, "Match", None)
_TRY_STAR = getattr(ast, "TryStar", None)
_TYPE_ALIAS = getattr(ast, "TypeAlias", None)

PROPERTY_DECORATORS = {"property", "cached_property", "functools.cached_property", "abc.abstractproperty", "abstractproperty", "computed_field", "pydantic.computed_field"}
STATIC_DECORATORS = {"staticmethod"}
CLASS_DECORATORS = {"classmethod"}
ABSTRACT_DECORATORS = {"abstractmethod", "abc.abstractmethod", "abstractproperty", "abc.abstractproperty", "abstractclassmethod", "abstractstaticmethod"}
OVERLOAD_DECORATORS = {"overload", "typing.overload", "typing_extensions.overload"}
# Decorators that only say what a declaration is (its kind and modifiers say it too): not attributes.
LANGUAGE_DECORATORS = PROPERTY_DECORATORS | STATIC_DECORATORS | CLASS_DECORATORS | ABSTRACT_DECORATORS | OVERLOAD_DECORATORS | {
    "override", "typing.override", "typing_extensions.override", "final", "typing.final", "typing_extensions.final",
    "abc.abstractclassmethod", "abc.abstractstaticmethod",
}
_DUNDER = re.compile(r"^__\w+__$")
_CONSTANT = re.compile(r"^_?[A-Z][A-Z0-9_]*$")


class Decl:
    """A declaration that is a node on the map: a class, function, method, property, field or variable."""

    kind = ""

    def __init__(self, module, name: str, qualname: str, node: ast.AST, owner: ClassDecl | None) -> None:
        self.module = module
        self.name = name
        self.qualname = qualname
        self.id = member_id(module.id, qualname)
        self.node = node
        self.nodes = [node]  # all its declarations (property setters, overloads, conditional definitions)
        self.owner = owner
        self.decorators: list[ast.expr] = []
        self.tags: list[str] = []

    @property
    def private(self) -> bool:
        return self.name.startswith("_") and not _DUNDER.match(self.name)

    def __repr__(self) -> str:
        return f"<{self.kind} {self.module.name}.{self.qualname}>"


class ClassDecl(Decl):
    kind = "class"

    def __init__(self, module, name, qualname, node: ast.ClassDef, owner) -> None:
        super().__init__(module, name, qualname, node, owner)
        self.members: dict[str, Decl] = {}
        self.code: list[ast.AST] = []  # class-body code that is no member's (nested Meta classes, statements)
        self.decorators = list(node.decorator_list)


class FuncDecl(Decl):
    kind = "function"

    def __init__(self, module, name, qualname, node, owner, flavor: str) -> None:
        super().__init__(module, name, qualname, node, owner)
        self.flavor = flavor  # function, method, constructor, property, static, classmethod
        self.decorators = list(node.decorator_list)
        self.overload_only = True  # every definition so far is an @overload stub

    @property
    def defs(self) -> list:
        """The definitions with code: the real one(s), not the @overload stubs."""
        real = [n for n in self.nodes if not _is_overload(n)]
        return real or self.nodes


class VarDecl(Decl):
    kind = "variable"

    def __init__(self, module, name, qualname, node, owner, kind: str) -> None:
        super().__init__(module, name, qualname, node, owner)
        self.var_kind = kind  # variable, field, typeAlias
        self.annotation: ast.expr | None = None
        self.annotation_owner = None  # the method an annotation of self.x is written in
        self.values: list[tuple[ast.expr, FuncDecl | None]] = []  # assigned values, with the method assigning self.x
        self.class_level = owner is None or kind != "field"  # declared in the class body (or the module), not as self.x
        self.doc = ""


class ImportBinding:
    """A name an import statement binds: `import a.b` binds a, `from m import n as k` binds k."""

    __slots__ = ("module", "name", "full", "line", "type_checking", "relative", "local")

    def __init__(self, module: str | None, name: str | None, full: str | None, line: int, type_checking: bool, relative: bool, local: bool) -> None:
        self.module = module  # the absolute module name (None: a relative import that leaves the packages)
        self.name = name  # the imported name (None for `import x`)
        self.full = full  # `import a.b.c`: the whole module name, which the import loads
        self.line = line
        self.type_checking = type_checking
        self.relative = relative
        self.local = local  # inside a function


class SymbolTable:
    def __init__(self, module) -> None:
        self.module = module
        self.scope: dict[str, list] = {}  # name → its bindings (declarations, imports) in source order
        self.decls: list[Decl] = []
        self.by_qualname: dict[str, Decl] = {}
        self.imports: list[ImportBinding] = []  # every import in the module, for import edges
        self.star_imports: list[ImportBinding] = []
        self.all_names: list[str] | None = None
        self.top_code: list[ast.AST] = []
        self.top_decisions = 0
        self.top_lines: list[int] = []
        self.main_guard = False
        self.barrel = True  # only imports, __all__ and metadata
        self.empty = True
        self.doc = ""

    def bind(self, name: str, binding) -> None:
        self.scope.setdefault(name, []).append(binding)

    def lookup(self, name: str):
        """What a module-level name refers to: a declaration if one has the name, else its first import."""
        bindings = self.scope.get(name)
        if not bindings:
            return None
        for binding in bindings:
            if isinstance(binding, Decl):
                return binding
        return bindings[0]

    def exported(self, name: str) -> bool:
        """Is the name what `from module import *` takes?"""
        if self.all_names is not None:
            return name in self.all_names
        return not name.startswith("_") and name in self.scope


# ---------------------------------------------------------------------------------------------- reading


def read_source(module) -> None:
    """Reads and parses a module's file once."""
    read_text(module)
    if module.parsed:
        return
    module.parsed = True
    if module.parse_error:
        return
    source = module.text
    for _ in range(50):
        try:
            module.tree = ast.parse(source, module.file)
            return
        except SyntaxError as error:
            repaired = _repair(source, error)
            if repaired is None:
                module.parse_error = f"{error.msg or error} (line {error.lineno or '?'})"
                break
            source = repaired
        except (ValueError, RecursionError, MemoryError) as error:
            module.parse_error = str(error) or type(error).__name__
            break
    module.tree = None


def read_text(module) -> None:
    """Reads a module's file once (its encoding from a coding line or BOM), without parsing it."""
    if module.text is not None:
        return
    try:
        with open(module.file, "rb") as f:
            data = f.read()
    except OSError as error:
        module.text = ""
        module.parse_error = str(error)
        return
    try:
        encoding, _ = tokenize.detect_encoding(io.BytesIO(data).readline)
        text = data.decode(encoding)
    except (SyntaxError, LookupError, UnicodeDecodeError):
        text = data.decode("latin-1")
    if text.startswith("﻿"):
        text = text[1:]
    module.text = text
    module.lines = _line_count(text)


_EXCEPT = re.compile(r"^(\s*except\*?\s+)(?!\()([^:]+?)(\s+as\s+\w+)?\s*:")


def _repair(text: str, error: SyntaxError) -> str | None:
    """Newer syntax an older Python can read once it is spelled the old way, on the same line (so lines stay):
    Python 3.14's `except A, B:` (PEP 758) is `except (A, B):`."""
    if not error.lineno or not any(m in (error.msg or "") for m in ("must be parenthesized", "invalid syntax")):
        return None  # 3.10+ says "must be parenthesized", 3.9 only "invalid syntax": the line itself decides
    lines = text.split("\n")
    line = lines[error.lineno - 1] if error.lineno <= len(lines) else ""
    match = _EXCEPT.match(line)
    if match is None or "," not in match.group(2):
        return None
    lines[error.lineno - 1] = f"{match.group(1)}({match.group(2)}){match.group(3) or ''}:{line[match.end():]}"
    return "\n".join(lines)


def _line_count(text: str) -> int:
    if not text:
        return 0
    count = text.count("\n") + 1
    return count - 1 if text.endswith("\n") else count


def symbols_of(module) -> SymbolTable:
    if module.symbols is None:
        read_source(module)
        module.symbols = Builder(module).build()
    return module.symbols


# ---------------------------------------------------------------------------------------------- building


class Builder:
    def __init__(self, module) -> None:
        self.module = module
        self.table = SymbolTable(module)

    def build(self) -> SymbolTable:
        tree = self.module.tree
        if tree is None:
            self.table.empty = not (self.module.text or "").strip()
            return self.table
        self.table.doc = first_sentence(ast.get_docstring(tree, clean=True))
        self.collect_imports(tree)
        self.block(tree.body, type_checking=False, first=True)
        self.table.empty = not tree.body or all(_is_docstring(s) or isinstance(s, ast.Pass) for s in tree.body)
        return self.table

    # ---------------------------------------------------------------- imports, everywhere in the module

    def collect_imports(self, tree: ast.Module) -> None:
        """Every import of the module, in functions too: imports are statements, so only statements are walked."""
        stack = [(s, False, False) for s in reversed(tree.body)]  # (statement, under TYPE_CHECKING, inside a function)
        while stack:
            node, type_checking, local = stack.pop()
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                for binding, _ in import_bindings(self.module, node, type_checking, local):
                    self.table.imports.append(binding)
                continue
            inner_local = local or isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            checking = type_checking or (isinstance(node, ast.If) and _is_type_checking(node.test))
            blocks = [node.body] if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) else list(_blocks(node))
            for index, block in enumerate(blocks):
                # the else of `if TYPE_CHECKING:` runs
                flag = checking if not (isinstance(node, ast.If) and index > 0) else type_checking
                stack.extend((s, flag, inner_local) for s in reversed(block))

    # ---------------------------------------------------------------- module-level statements

    def block(self, body: list, type_checking: bool, first: bool = False) -> None:
        table = self.table
        previous = None
        for index, statement in enumerate(body):
            if index == 0 and first and _is_docstring(statement):
                continue
            if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
                table.barrel = False
                self.function(statement, None)
            elif isinstance(statement, ast.ClassDef):
                table.barrel = False
                self.klass(statement, None)
            elif isinstance(statement, (ast.Import, ast.ImportFrom)):
                for binding, name in import_bindings(self.module, statement, type_checking, False):
                    if name == "*":
                        table.star_imports.append(binding)
                    else:
                        table.bind(name, binding)
            elif isinstance(statement, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                previous = self.assignment(statement)
                continue
            elif _TYPE_ALIAS is not None and isinstance(statement, _TYPE_ALIAS):
                table.barrel = False
                previous = self.variable(statement.name.id, statement, None, statement.value, "typeAlias")
                continue
            elif isinstance(statement, ast.If):
                if _is_type_checking(statement.test):
                    self.block(statement.body, True)
                    self.block(statement.orelse, type_checking)
                elif _is_main_guard(statement.test):
                    table.main_guard = True
                    table.barrel = False
                    table.top_decisions += 1
                    self.top(statement.test, statement)
                    for inner in statement.body:
                        self.top(inner, inner)
                    self.block(statement.orelse, type_checking)
                else:
                    table.top_decisions += 1
                    self.top(statement.test, statement, statement=False)
                    self.block(statement.body, type_checking)
                    self.block(statement.orelse, type_checking)
            elif isinstance(statement, ast.Try) or (_TRY_STAR is not None and isinstance(statement, _TRY_STAR)):
                self.block(statement.body, type_checking)
                for handler in statement.handlers:
                    table.top_decisions += 1
                    if handler.type is not None:
                        self.top(handler.type, handler, statement=False)
                    self.block(handler.body, type_checking)
                self.block(statement.orelse, type_checking)
                self.block(statement.finalbody, type_checking)
            elif isinstance(statement, ast.Expr) and _is_docstring(statement):
                if isinstance(previous, VarDecl) and not previous.doc:
                    previous.doc = first_sentence(statement.value.value)
            elif isinstance(statement, ast.Pass):
                pass
            else:
                self.top(statement, statement)
            previous = None

    def top(self, node: ast.AST, at: ast.AST, statement: bool = True) -> None:
        """Code at the top of the module: a statement, or an expression of one (an if's test) when not whole."""
        self.add_top(node, at, statement)

    def assignment(self, statement) -> VarDecl | None:
        table = self.table
        value = statement.value
        if isinstance(statement, ast.AugAssign):
            if _name(statement.target) == "__all__":
                self.extend_all(value)
                return None
            self.add_top(statement, statement)
            return None
        targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
        annotation = statement.annotation if isinstance(statement, ast.AnnAssign) else None
        last = None
        for target in targets:
            name = _name(target)
            if name == "__all__":
                table.all_names = []
                self.extend_all(value)
                continue
            if name is not None:
                if _DUNDER.match(name):
                    continue  # __version__, __author__: metadata
                table.barrel = False
                kind = "typeAlias" if annotation is not None and _annotation_name(annotation) in ("TypeAlias", "typing.TypeAlias", "typing_extensions.TypeAlias") else "variable"
                last = self.variable(name, statement, annotation, value, kind)
            elif isinstance(target, (ast.Tuple, ast.List)) and all(_name(e) for e in target.elts):
                table.barrel = False
                values = value.elts if isinstance(value, (ast.Tuple, ast.List)) and len(value.elts) == len(target.elts) else [None] * len(target.elts)
                for element, element_value in zip(target.elts, values):
                    if not _DUNDER.match(_name(element)):
                        self.variable(_name(element), statement, None, element_value, "variable")
            else:
                self.add_top(statement, statement)  # app.config["X"] = 1, obj.attr = value
                return None
        return last

    def extend_all(self, value) -> None:
        if self.table.all_names is None:
            self.table.all_names = []
        if isinstance(value, (ast.List, ast.Tuple)):
            self.table.all_names.extend(e.value for e in value.elts if isinstance(e, ast.Constant) and isinstance(e.value, str))

    def variable(self, name: str, statement, annotation, value, kind: str) -> VarDecl:
        table = self.table
        existing = table.by_qualname.get(name)
        if isinstance(existing, VarDecl):
            existing.nodes.append(statement)
            if value is not None:
                existing.values.append((value, None))
            if existing.annotation is None and annotation is not None:
                existing.annotation = annotation
            return existing
        if existing is not None:
            return None  # def f(): … then f = wrap(f): the function stays what the name is
        decl = VarDecl(self.module, name, name, statement, None, kind)
        decl.annotation = annotation
        if value is not None:
            decl.values.append((value, None))
        self.add(decl)
        table.bind(name, decl)
        return decl

    def add(self, decl: Decl) -> None:
        self.table.by_qualname[decl.qualname] = decl
        self.table.decls.append(decl)

    def add_top(self, node: ast.AST, statement: ast.AST, is_statement: bool = True) -> None:
        self.table.top_code.append(node)
        if is_statement:
            self.table.barrel = False
            self.table.top_lines.append(statement.lineno)
            self.table.top_lines.append(getattr(statement, "end_lineno", statement.lineno) or statement.lineno)

    # ---------------------------------------------------------------- functions and classes

    def function(self, node, owner: ClassDecl | None) -> FuncDecl | None:
        names = [decorator_name(d) for d in node.decorator_list]
        setter = next((n for n in names if n.endswith((".setter", ".deleter", ".getter"))), None)
        name = setter.rsplit(".", 1)[0] if setter and owner is not None and isinstance(owner.members.get(setter.rsplit(".", 1)[0]), FuncDecl) else node.name
        qualname = f"{owner.qualname}.{name}" if owner else name
        table = self.table
        existing = owner.members.get(name) if owner else table.by_qualname.get(name)
        if isinstance(existing, FuncDecl):
            existing.nodes.append(node)
            existing.decorators.extend(node.decorator_list)
            if existing.overload_only and not _is_overload(node):
                existing.overload_only = False
                existing.node = node  # the definition with code is where the function is
            return existing
        if existing is not None:
            return None
        if owner is None:
            flavor = "function"
        elif any(n in PROPERTY_DECORATORS for n in names):
            flavor = "property"
        elif any(n in STATIC_DECORATORS for n in names):
            flavor = "static"
        elif any(n in CLASS_DECORATORS for n in names) or name in ("__new__", "__init_subclass__", "__class_getitem__"):
            flavor = "classmethod"
        elif name == "__init__":
            flavor = "constructor"
        else:
            flavor = "method"
        decl = FuncDecl(self.module, name, qualname, node, owner, flavor)
        decl.overload_only = _is_overload(node)
        self.add(decl)
        if owner is not None:
            owner.members[name] = decl
        else:
            table.bind(name, decl)
        return decl

    def klass(self, node: ast.ClassDef, owner: ClassDecl | None) -> ClassDecl | None:
        qualname = f"{owner.qualname}.{node.name}" if owner else node.name
        table = self.table
        if (owner.members if owner else table.by_qualname).get(node.name) is not None:
            return None
        decl = ClassDecl(self.module, node.name, qualname, node, owner)
        self.add(decl)
        if owner is not None:
            owner.members[node.name] = decl
        else:
            table.bind(node.name, decl)
        self.class_body(decl, node.body, first=True)
        self.self_attributes(decl)
        return decl

    def class_body(self, decl: ClassDecl, body: list, first: bool = False) -> None:
        previous = None
        for index, statement in enumerate(body):
            if index == 0 and first and _is_docstring(statement):
                continue
            if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.function(statement, decl)
            elif isinstance(statement, ast.ClassDef):
                if any(isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)) for s in statement.body):
                    self.klass(statement, decl)
                else:
                    decl.code.append(statement)  # class Meta: model = Order (what it says is the outer class')
            elif isinstance(statement, (ast.Assign, ast.AnnAssign)):
                previous = self.field_statement(decl, statement)
                continue
            elif isinstance(statement, ast.Expr) and _is_docstring(statement):
                if isinstance(previous, VarDecl) and not previous.doc:
                    previous.doc = first_sentence(statement.value.value)
            elif isinstance(statement, ast.If):
                decl.code.append(statement.test)
                self.class_body(decl, statement.body)
                self.class_body(decl, statement.orelse)
            elif isinstance(statement, ast.Try):
                self.class_body(decl, statement.body)
                for handler in statement.handlers:
                    self.class_body(decl, handler.body)
                self.class_body(decl, statement.orelse)
                self.class_body(decl, statement.finalbody)
            elif not isinstance(statement, ast.Pass) and not (isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Constant)):
                decl.code.append(statement)
            previous = None

    def field_statement(self, owner: ClassDecl, statement) -> VarDecl | None:
        targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
        annotation = statement.annotation if isinstance(statement, ast.AnnAssign) else None
        last = None
        for target in targets:
            name = _name(target)
            if name is None:
                if isinstance(target, (ast.Tuple, ast.List)):
                    for element in target.elts:
                        if _name(element):
                            self.field(owner, _name(element), statement, None, None, None)
                else:
                    owner.code.append(statement)
                continue
            if name in ("__slots__", "__doc__", "__module__", "__qualname__", "__annotations__", "__match_args__"):
                owner.code.append(statement)
                continue
            last = self.field(owner, name, statement, annotation, statement.value, None)
        return last

    def field(self, owner: ClassDecl, name: str, statement, annotation, value, method: FuncDecl | None, annotation_owner=None) -> VarDecl | None:
        existing = owner.members.get(name)
        if existing is not None and not isinstance(existing, VarDecl):
            return None  # a method or property of that name
        if existing is None:
            existing = VarDecl(self.module, name, f"{owner.qualname}.{name}", statement, owner, "field")
            existing.class_level = method is None
            owner.members[name] = existing
            self.add(existing)
        else:
            existing.nodes.append(statement)
        if annotation is not None and existing.annotation is None:
            existing.annotation = annotation
            existing.annotation_owner = annotation_owner
        if value is not None:
            existing.values.append((value, method))
        return existing

    def self_attributes(self, owner: ClassDecl) -> None:
        """Fields a class gets from `self.x = …` in its methods (`cls.x = …` in class methods), __init__ first."""
        methods = [m for m in owner.members.values() if isinstance(m, FuncDecl) and m.flavor not in ("static",)]
        methods.sort(key=lambda m: (m.name not in ("__init__", "__post_init__", "setUp", "setup_method", "__new__"), m.node.lineno))
        for method, definition in [(m, d) for m in methods for d in m.nodes]:
            args = definition.args
            positional = list(getattr(args, "posonlyargs", [])) + list(args.args)
            if not positional:
                continue
            receiver = positional[0].arg
            for node in _walk_function(definition):
                if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                    targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                    for target in _flatten_targets(targets):
                        if isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name) and target.value.id == receiver:
                            annotation = node.annotation if isinstance(node, ast.AnnAssign) else None
                            value = None if isinstance(node, ast.AugAssign) or len(_flatten_targets(targets)) > len(targets) else node.value
                            self.field(owner, target.attr, node, annotation, value, method, method if annotation is not None else None)


# ---------------------------------------------------------------------------------------------- imports


def import_bindings(module, node, type_checking: bool, local: bool):
    """(binding, bound name) for each name an import statement binds."""
    line = node.lineno
    if isinstance(node, ast.Import):
        for alias in node.names:
            if alias.asname:
                yield ImportBinding(alias.name, None, alias.name, line, type_checking, False, local), alias.asname
            else:
                top = alias.name.split(".")[0]
                yield ImportBinding(top, None, alias.name, line, type_checking, False, local), top
        return
    base = absolute_module(module, node.level, node.module)
    for alias in node.names:
        binding = ImportBinding(base, alias.name, None, line, type_checking, node.level > 0, local)
        yield binding, alias.asname or alias.name


def absolute_module(module, level: int, name: str | None) -> str | None:
    """The module `from <level dots><name> import …` reads from, as an absolute dotted name ("" is the root)."""
    if not level:
        return name
    package = module.package
    parts = package.split(".") if package else []
    if level - 1 > len(parts):
        return None
    if level > 1:
        parts = parts[: len(parts) - (level - 1)]
    prefix = ".".join(parts)
    if name:
        return f"{prefix}.{name}" if prefix else name
    return prefix


# ---------------------------------------------------------------------------------------------- helpers


def decorator_name(node: ast.expr) -> str:
    """`@app.get("/x")` → app.get; `@dataclass` → dataclass."""
    if isinstance(node, ast.Call):
        node = node.func
    return dotted_name(node) or "…"


def dotted_name(node) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = dotted_name(node.value)
        return f"{base}.{node.attr}" if base else None
    return None


def first_sentence(text: str | None) -> str:
    if not text:
        return ""
    paragraph = text.strip().split("\n\n")[0]
    sentence = re.split(r"(?<=[.!?])\s", paragraph, maxsplit=1)[0]
    sentence = re.sub(r"\s+", " ", sentence).strip()
    return sentence if len(sentence) <= 300 else sentence[:299] + "…"


def _name(node) -> str | None:
    return node.id if isinstance(node, ast.Name) else None


def _annotation_name(node) -> str:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return dotted_name(node) or ""


def _is_docstring(statement) -> bool:
    return isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Constant) and isinstance(statement.value.value, str)


def _is_type_checking(test) -> bool:
    name = dotted_name(test)
    return name in ("TYPE_CHECKING", "typing.TYPE_CHECKING", "typing_extensions.TYPE_CHECKING")


def _is_main_guard(test) -> bool:
    if not isinstance(test, ast.Compare) or len(test.ops) != 1 or not isinstance(test.ops[0], ast.Eq):
        return False
    sides = [test.left, test.comparators[0]]
    return any(isinstance(s, ast.Name) and s.id == "__name__" for s in sides) and any(isinstance(s, ast.Constant) and s.value == "__main__" for s in sides)


def _is_overload(node) -> bool:
    return any(decorator_name(d) in OVERLOAD_DECORATORS for d in getattr(node, "decorator_list", ()))


def _blocks(statement):
    """The statement lists inside a compound statement (not function or class bodies)."""
    if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
        return
    for field in ("body", "orelse", "finalbody"):
        block = getattr(statement, field, None)
        if isinstance(block, list):
            yield block
    for handler in getattr(statement, "handlers", ()) or ():
        yield handler.body
    for case in getattr(statement, "cases", ()) or ():
        yield case.body


def _walk_function(node):
    """The nodes of a function's body and its nested functions' (not nested classes')."""
    stack = list(node.body)
    while stack:
        current = stack.pop()
        yield current
        for child in ast.iter_child_nodes(current):
            if not isinstance(child, ast.ClassDef):
                stack.append(child)


def _flatten_targets(targets):
    out = []
    for target in targets:
        if isinstance(target, (ast.Tuple, ast.List)):
            out.extend(_flatten_targets(target.elts))
        elif isinstance(target, ast.Starred):
            out.extend(_flatten_targets([target.value]))
        else:
            out.append(target)
    return out


def is_constant_name(name: str) -> bool:
    return bool(_CONSTANT.match(name))


def is_dunder(name: str) -> bool:
    return bool(_DUNDER.match(name))

