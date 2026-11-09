"""What names refer to, through imports and re-exports, and light type inference for the receivers of calls.

Python's ast has no symbols, so the resolver follows the language's own rules: names through the scopes of
functions and modules, imports through the modules of the analysis (re-exports in __init__.py lead to the real
declaration), attributes through classes and their bases (in method resolution order), and the type of a value
from what is written: annotations, constructor calls, `self` and `cls`, return types. Nothing is guessed: when the
type of a receiver cannot be known, its calls make no edge.
"""
from __future__ import annotations

import ast
import builtins
import os
import re

from .symbols import (
    ABSTRACT_DECORATORS,
    ClassDecl,
    FuncDecl,
    ImportBinding,
    VarDecl,
    decorator_name,
    is_dunder,
    symbols_of,
)

BUILTINS = frozenset(dir(builtins))
SELF_TYPES = {"typing.Self", "typing_extensions.Self"}
PROTOCOLS = {"typing.Protocol", "typing_extensions.Protocol"}
ENUMS = {"enum.Enum", "enum.IntEnum", "enum.StrEnum", "enum.Flag", "enum.IntFlag", "enum.ReprEnum"}
ABC_BASES = {"abc.ABC"}
ABC_METAS = {"abc.ABCMeta"}
_UNWRAP = {
    "Optional", "Annotated", "ClassVar", "Final", "Required", "NotRequired", "ReadOnly", "InitVar", "TypeGuard", "TypeIs", "Awaitable", "Unpack",
    "Mapped", "WriteOnlyMapped", "DynamicMapped",  # SQLAlchemy
}
_LAST = {"Coroutine"}
_CONTAINERS = {
    "list", "List", "Sequence", "MutableSequence", "Iterable", "Iterator", "Collection", "Set", "set", "frozenset",
    "FrozenSet", "AbstractSet", "MutableSet", "tuple", "Tuple", "Generator", "AsyncIterator", "AsyncIterable",
    "AsyncGenerator", "Deque", "deque", "KeysView", "ValuesView", "Reversible",
}
_NOT_TYPES = {"Callable", "dict", "Dict", "Mapping", "MutableMapping", "DefaultDict", "defaultdict", "OrderedDict", "Counter", "ChainMap", "Literal", "LiteralString"}
_TYPING_MODULES = ("typing.", "typing_extensions.", "collections.abc.", "builtins.", "collections.", "dataclasses.")
_EXCEPTION_NAME = re.compile(r"(Error|Exception|Warning|Exit|Interrupt)$")


# ---------------------------------------------------------------------------------------------- values


class Value:
    __slots__ = ()

    def key(self):
        raise NotImplementedError

    def __eq__(self, other) -> bool:
        return isinstance(other, Value) and self.key() == other.key()

    def __hash__(self) -> int:
        return hash(self.key())


class ModuleVal(Value):
    """A module (or a package without code of its own)."""

    __slots__ = ("module",)

    def __init__(self, module) -> None:
        self.module = module

    def key(self):
        return ("module", id(self.module))


class ClassVal(Value):
    """A class of the analysis itself (calling it makes an instance)."""

    __slots__ = ("cls",)

    def __init__(self, cls: ClassDecl) -> None:
        self.cls = cls

    def key(self):
        return ("class", id(self.cls))


class InstanceVal(Value):
    __slots__ = ("cls",)

    def __init__(self, cls: ClassDecl) -> None:
        self.cls = cls

    def key(self):
        return ("instance", id(self.cls))


class FuncVal(Value):
    __slots__ = ("func",)

    def __init__(self, func: FuncDecl) -> None:
        self.func = func

    def key(self):
        return ("function", id(self.func))


class PropVal(Value):
    """A property read: its value is what the getter returns."""

    __slots__ = ("func",)

    def __init__(self, func: FuncDecl) -> None:
        self.func = func

    def key(self):
        return ("property", id(self.func))


class VarVal(Value):
    """A module variable or a field: reading it is an access, its value has the variable's type."""

    __slots__ = ("var",)

    def __init__(self, var: VarDecl) -> None:
        self.var = var

    def key(self):
        return ("variable", id(self.var))


class ContainerVal(Value):
    """A list, tuple, set or iterator of one kind of value."""

    __slots__ = ("element",)

    def __init__(self, element: Value) -> None:
        self.element = element

    def key(self):
        return ("container", self.element.key())


class ExtVal(Value):
    """Something from outside the analysis, by its qualified name: `fastapi.FastAPI`, or an instance of it."""

    __slots__ = ("name", "instance")

    def __init__(self, name: str, instance: bool = False) -> None:
        self.name = name
        self.instance = instance

    def key(self):
        return ("external", self.name, self.instance)


class QueryVal(ContainerVal):
    """A query of an ORM's model (Django's Order.objects, SQLAlchemy's session.query(Order)): its rows are instances."""

    __slots__ = ("cls",)

    def __init__(self, cls: ClassDecl) -> None:
        super().__init__(InstanceVal(cls))
        self.cls = cls

    def key(self):
        return ("query", id(self.cls))


class QueryMethodVal(Value):
    """A method of a query: calling it gives another query (filter) or one row (get)."""

    __slots__ = ("cls", "one")

    def __init__(self, cls: ClassDecl, one: bool) -> None:
        self.cls = cls
        self.one = one

    def key(self):
        return ("query-method", id(self.cls), self.one)


# Methods of Django querysets and managers, and of SQLAlchemy queries: those giving a query, and those giving a row.
QUERY_CHAIN = frozenset("""all filter exclude order_by select_related prefetch_related annotate alias distinct only defer using
select_for_update reverse none filter_by join outerjoin options limit offset where""".split())
QUERY_ONE = frozenset("""get first last latest earliest create one one_or_none scalar get_or_404 first_or_404 one_or_404
aget afirst alast alatest aearliest acreate""".split())
# Calls of a task that run it (Celery, Dramatiq, RQ): task.delay(…) calls the task.
# What a session gives for a select: one row (scalar) or the rows (scalars).
SELECTED = {"scalar": True, "scalar_one": True, "scalar_one_or_none": True, "first_or_404": True, "one_or_404": True, "scalars": False}
TASK_CALLS = frozenset("delay apply_async s si signature send send_with_options map starmap chunks".split())
TASK_DECORATORS = frozenset("task shared_task periodic_task actor job".split())


class SuperVal(Value):
    """super(): attributes come from the classes after `cls` in the method resolution order."""

    __slots__ = ("cls",)

    def __init__(self, cls: ClassDecl) -> None:
        self.cls = cls

    def key(self):
        return ("super", id(self.cls))


class PackageStub:
    """A package that is only a folder (a namespace package, or an empty __init__.py the map leaves out)."""

    def __init__(self, name: str, project) -> None:
        self.name = name
        self.names = [name]
        self.project = project
        self.id = ""
        self.symbols = None

    def __repr__(self) -> str:
        return f"<package {self.name}>"


# ---------------------------------------------------------------------------------------------- module index


class ModuleIndex:
    """Modules by every dotted name they can be imported as. A name only the __init__.py chain gives, from a folder that
    is no source root (examples/pydantic/ as "pydantic"), is weak: it does not hide the standard library or a declared
    dependency, and a package never imports itself through it."""

    def __init__(self, discovery) -> None:
        self.by_name: dict[str, list] = {}  # name → [(module, weak top folder or None)]
        self.stubs: dict[str, tuple] = {}  # package name → (stub, weak top folder or None)
        self.by_file = discovery.by_file
        self.tops: dict[str, str | None] = {}  # top-level name → weak top folder, None once a strong name has it
        for module in discovery.modules:
            for name in module.names:
                weak = module.weak.get(name)
                self.by_name.setdefault(name, []).append((module, weak))
                parts = name.split(".")
                self.tops[parts[0]] = weak if self.tops.get(parts[0], weak) is not None and weak is not None else None
                for size in range(1, len(parts)):
                    prefix = ".".join(parts[:size])
                    stub = self.stubs.get(prefix)
                    if stub is None:
                        self.stubs[prefix] = (PackageStub(prefix, module.project), weak)
                    elif stub[1] is not None and weak is None:
                        self.stubs[prefix] = (stub[0], None)

    @staticmethod
    def plausible(weak: str | None, name: str, importer) -> bool:
        if weak is None or importer is None:
            return True
        if "." not in name and importer.file.startswith(weak.rstrip(os.sep) + os.sep):
            return False  # examples/pydantic/tasks.py's `from pydantic import …` is the real pydantic, not its own folder
        top = name.split(".")[0]
        from .distributions import import_names
        from .stdlib import is_stdlib

        declared = {n.split(".")[0] for d in importer.project.dependencies.values() for n in import_names(d.name)}
        return not is_stdlib(top) and top not in declared

    def find(self, name: str, importer=None):
        found = [m for m, weak in self.by_name.get(name, ()) if self.plausible(weak, name, importer)]
        if found:
            if len(found) > 1 and importer is not None:
                same = [m for m in found if m.project is importer.project]
                if same:
                    return same[0]
            return found[0]
        stub = self.stubs.get(name)
        return stub[0] if stub is not None and self.plausible(stub[1], name, importer) else None

    def near(self, importer, name: str):
        """A module next to a script (a folder that is not a package is on sys.path when its script runs)."""
        base = os.path.join(os.path.dirname(importer.file), *name.split("."))
        return self.by_file.get(base + ".py") or self.by_file.get(os.path.join(base, "__init__.py"))

    def is_project_top(self, name: str, importer=None) -> bool:
        """Whether a module name starts in the analysis' own packages (then a module missing there is no PyPI package)."""
        top = name.split(".")[0]
        return top in self.tops and self.plausible(self.tops[top], name, importer)


# ---------------------------------------------------------------------------------------------- scopes


class Scope:
    cls: ClassDecl | None = None

    def __init__(self, resolver: Resolver, module) -> None:
        self.resolver = resolver
        self.module = module

    def lookup(self, name: str) -> Value | None:
        raise NotImplementedError


class ModuleScope(Scope):
    def lookup(self, name: str) -> Value | None:
        value = self.resolver.module_attr(self.module, name)
        if value is None and name in BUILTINS and not self._shadows(name):
            return ExtVal(f"builtins.{name}")
        return value

    def _shadows(self, name: str) -> bool:
        return name in symbols_of(self.module).scope


class ClassScope(Scope):
    """The body of a class: its own names, then the module's (class bodies do not see enclosing classes)."""

    def __init__(self, resolver, module, cls: ClassDecl, parent: Scope) -> None:
        super().__init__(resolver, module)
        self.cls = cls
        self.parent = parent

    def lookup(self, name: str) -> Value | None:
        member = self.cls.members.get(name)
        if member is not None:
            return self.resolver.member_value(member, on_class=True)
        return self.parent.lookup(name)


class FunctionScope(Scope):
    """A function's parameters and local names; their types come from annotations and what is assigned."""

    def __init__(self, resolver, module, node, parent: Scope, cls: ClassDecl | None, flavor: str, annotation_scope: Scope | None = None) -> None:
        super().__init__(resolver, module)
        self.node = node
        self.parent = parent
        self.cls = cls
        self.flavor = flavor
        self.annotation_scope = annotation_scope or parent
        self.entries: dict[str, list] | None = None
        self.globals: set[str] = set()
        self.nonlocals: set[str] = set()
        self.cache: dict[str, Value | None] = {}
        self.active: set[str] = set()

    def lookup(self, name: str) -> Value | None:
        if self.entries is None:
            self._collect()
        if name in self.globals:
            return ModuleScope(self.resolver, self.module).lookup(name)
        if name in self.entries and name not in self.nonlocals:
            if name in self.cache:
                return self.cache[name]
            if name in self.active:
                return None
            self.active.add(name)
            try:
                value = self._type_of(name)
            finally:
                self.active.discard(name)
            self.cache[name] = value
            return value
        return self.parent.lookup(name)

    def _add(self, name: str, entry) -> None:
        self.entries.setdefault(name, []).append(entry)

    def _collect(self) -> None:
        self.entries = {}
        node = self.node
        args = node.args
        positional = list(getattr(args, "posonlyargs", [])) + list(args.args)
        defaults = [None] * (len(positional) - len(args.defaults)) + list(args.defaults)
        for index, (arg, default) in enumerate(zip(positional, defaults)):
            implicit = None
            if index == 0 and self.cls is not None:
                if self.flavor in ("method", "constructor", "property"):
                    implicit = "self"
                elif self.flavor == "classmethod":
                    implicit = "cls"
            self._add(arg.arg, ("param", arg.annotation, default, implicit))
        for arg, default in zip(args.kwonlyargs, args.kw_defaults):
            self._add(arg.arg, ("param", arg.annotation, default, None))
        if args.vararg is not None:
            self._add(args.vararg.arg, ("vararg", args.vararg.annotation))
        if args.kwarg is not None:
            self._add(args.kwarg.arg, ("unknown", None))
        if isinstance(node, ast.Lambda):
            return
        # Names are bound by statements (and :=, the only expression that binds: then every node is looked at).
        walrus = ":=" in (getattr(self.module, "text", None) or ":=")
        for child in (_local_nodes(node) if walrus else _local_statements(node)):
            self._collect_node(child)

    def _collect_node(self, node) -> None:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                self._target(target, node.value)
        elif isinstance(node, ast.AnnAssign):
            if isinstance(node.target, ast.Name):
                self._add(node.target.id, ("ann", node.annotation))
                if node.value is not None:
                    self._add(node.target.id, ("assign", node.value))
        elif isinstance(node, ast.AugAssign):
            if isinstance(node.target, ast.Name):
                self._add(node.target.id, ("keep", None))
        elif isinstance(node, (ast.For, ast.AsyncFor)):
            if isinstance(node.target, ast.Name):
                self._add(node.target.id, ("for", node.iter))
            elif _is_enumerate(node):
                index, item = node.target.elts
                if isinstance(item, ast.Name):
                    self._add(item.id, ("for", node.iter.args[0]))
                for name in _names(index):
                    self._add(name, ("unknown", None))
            else:
                for name in _names(node.target):
                    self._add(name, ("unknown", None))
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                if item.optional_vars is not None:
                    if isinstance(item.optional_vars, ast.Name):
                        self._add(item.optional_vars.id, ("with", item.context_expr))
                    else:
                        for name in _names(item.optional_vars):
                            self._add(name, ("unknown", None))
        elif isinstance(node, ast.ExceptHandler):
            if node.name:
                self._add(node.name, ("except", node.type))
        elif isinstance(node, ast.NamedExpr):
            if isinstance(node.target, ast.Name):
                self._add(node.target.id, ("assign", node.value))
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            from .symbols import import_bindings

            for binding, name in import_bindings(self.module, node, False, True):
                if name != "*":
                    self._add(name, ("import", binding))
        elif isinstance(node, ast.Global):
            self.globals.update(node.names)
        elif isinstance(node, ast.Nonlocal):
            self.nonlocals.update(node.names)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            self._add(node.name, ("unknown", None))
        elif isinstance(node, ast.Delete):
            pass
        elif type(node).__name__ in ("MatchAs", "MatchStar") and getattr(node, "name", None):
            self._add(node.name, ("unknown", None))
        elif type(node).__name__ == "MatchMapping" and getattr(node, "rest", None):
            self._add(node.rest, ("unknown", None))

    def _target(self, target, value) -> None:
        if isinstance(target, ast.Name):
            self._add(target.id, ("assign", value))
        elif isinstance(target, (ast.Tuple, ast.List)):
            if isinstance(value, (ast.Tuple, ast.List)) and len(value.elts) == len(target.elts) and not any(isinstance(e, ast.Starred) for e in target.elts):
                for element, element_value in zip(target.elts, value.elts):
                    self._target(element, element_value)
            else:
                for name in _names(target):
                    self._add(name, ("unknown", None))
        elif isinstance(target, ast.Starred):
            for name in _names(target):
                self._add(name, ("unknown", None))

    def _type_of(self, name: str) -> Value | None:
        resolver = self.resolver
        entries = self.entries[name]
        for kind, *payload in entries:
            if kind == "param":
                annotation, _, implicit = payload
                if annotation is not None:
                    return resolver.annotation_value(annotation, self.annotation_scope)
                if implicit == "self":
                    return InstanceVal(self.cls)
                if implicit == "cls":
                    return ClassVal(self.cls)
            elif kind == "ann":
                return resolver.annotation_value(payload[0], self)
            elif kind == "import":
                return resolver.import_value(payload[0], self.module)
            elif kind == "vararg" and payload[0] is not None:
                element = resolver.annotation_value(payload[0], self.annotation_scope)
                return ContainerVal(element) if element is not None else None
        values = []
        for kind, *payload in entries:
            if kind == "assign":
                values.append(resolver.infer(payload[0], self))
            elif kind == "for":
                values.append(resolver.element_of(resolver.infer(payload[0], self)))
            elif kind == "with":
                values.append(resolver.enter_value(resolver.infer(payload[0], self)))
            elif kind == "except":
                values.append(resolver.exception_value(payload[0], self))
            elif kind == "param" and payload[1] is not None:
                values.append(resolver.infer(payload[1], self.parent))
            elif kind == "param" and resolver.parameter_hook is not None and payload[0] is None and payload[2] is None:
                values.append(resolver.parameter_hook(self.module, self.node, name))
            elif kind == "unknown":
                return None
        return agree(values)


class ComprehensionScope(Scope):
    """The variables of a comprehension: elements of what they iterate over."""

    def __init__(self, resolver, module, generators, parent: Scope) -> None:
        super().__init__(resolver, module)
        self.parent = parent
        self.cls = parent.cls
        self.bindings: dict[str, tuple] = {}
        for index, generator in enumerate(generators):
            if isinstance(generator.target, ast.Name):
                self.bindings[generator.target.id] = (generator.iter, index)
            else:
                for name in _names(generator.target):
                    self.bindings[name] = (None, index)
        self.cache: dict[str, Value | None] = {}

    def lookup(self, name: str) -> Value | None:
        if name not in self.bindings:
            return self.parent.lookup(name)
        if name in self.cache:
            return self.cache[name]
        self.cache[name] = None  # x = [x for x in x]: the first iterable is the enclosing x
        iterable, index = self.bindings[name]
        scope = self.parent if index == 0 else self
        value = self.resolver.element_of(self.resolver.infer(iterable, scope)) if iterable is not None else None
        self.cache[name] = value
        return value


# ---------------------------------------------------------------------------------------------- the resolver


class Resolver:
    def __init__(self, index: ModuleIndex) -> None:
        self.index = index
        self._attrs: dict = {}
        self._active: set = set()
        self._var_types: dict = {}
        self._returns: dict = {}
        self._mro: dict = {}
        self._bases: dict = {}
        self._scopes: dict = {}
        self._module_scopes: dict = {}
        self._strings: dict = {}
        self._yields: dict = {}
        # What a parameter without annotation is, when a framework says (pytest: the fixture it names); set by the frameworks.
        self.parameter_hook = None

    # ---------------------------------------------------------------- modules and imports

    def module_scope(self, module) -> ModuleScope:
        scope = self._module_scopes.get(id(module))
        if scope is None:
            scope = self._module_scopes[id(module)] = ModuleScope(self, module)
        return scope

    def find_module(self, name: str, importer):
        found = self.index.find(name, importer)
        if found is None and importer is not None and not getattr(importer, "in_package", True):
            found = self.index.near(importer, name)
        return found

    def module_value(self, name: str, importer) -> Value | None:
        if not name:
            return None
        found = self.find_module(name, importer)
        if found is not None:
            return ModuleVal(found)
        if self.index.is_project_top(name, importer):
            return None  # a module of the project's packages that is not there
        return ExtVal(name)

    def import_value(self, binding: ImportBinding, importer) -> Value | None:
        if binding.module is None:
            return None
        if binding.name is None:
            return self.module_value(binding.module, importer)
        if binding.module == "":
            return self.module_value(binding.name, importer)  # from . import x, in a module at the root
        base = self.module_value(binding.module, importer)
        if base is None:
            return None
        if isinstance(base, ExtVal):
            return ExtVal(f"{base.name}.{binding.name}")
        return self.module_attr(base.module, binding.name)

    def module_attr(self, module, name: str) -> Value | None:
        key = (id(module), name)
        if key in self._attrs:
            return self._attrs[key]
        if key in self._active:
            return None
        self._active.add(key)
        try:
            value = self._module_attr(module, name)
        finally:
            self._active.discard(key)
        self._attrs[key] = value
        return value

    def _module_attr(self, module, name: str) -> Value | None:
        if isinstance(module, PackageStub):
            sub = self.index.find(f"{module.name}.{name}", None)
            return ModuleVal(sub) if sub is not None else None
        table = symbols_of(module)
        binding = table.lookup(name)
        if binding is not None:
            value = self.binding_value(binding, module)
            if value is not None:
                return value
        for star in table.star_imports:
            target = self.module_value(star.module, module) if star.module else None
            if isinstance(target, ModuleVal) and not isinstance(target.module, PackageStub):
                inner = symbols_of(target.module)
                if inner.exported(name) or (inner.all_names is None and not name.startswith("_") and inner.star_imports):
                    value = self.module_attr(target.module, name)
                    if value is not None:
                        return value
        sub = self.index.find(f"{module.name}.{name}", module) if module.name else None
        if sub is not None and sub is not module:
            return ModuleVal(sub)
        return None

    def binding_value(self, binding, module) -> Value | None:
        if isinstance(binding, ImportBinding):
            return self.import_value(binding, module)
        return self.member_value(binding, on_class=True)

    # ---------------------------------------------------------------- scopes of declarations

    def scope_of(self, decl) -> Scope:
        """The scope a declaration's own code runs in (a function's body, a class body, the module)."""
        scope = self._scopes.get(id(decl))
        if scope is not None:
            return scope
        if isinstance(decl, FuncDecl):
            scope = self.function_scope(decl, decl.node)
        elif isinstance(decl, ClassDecl):
            scope = ClassScope(self, decl.module, decl, self.definition_scope(decl))
        else:
            scope = self.definition_scope(decl)
        self._scopes[id(decl)] = scope
        return scope

    def function_scope(self, decl: FuncDecl, node) -> FunctionScope:
        key = ("function", id(decl), id(node))
        scope = self._scopes.get(key)
        if scope is None:
            scope = FunctionScope(self, decl.module, node, self.module_scope(decl.module), decl.owner, decl.flavor, self.definition_scope(decl))
            self._scopes[key] = scope
        return scope

    def definition_scope(self, decl) -> Scope:
        """Where a declaration is written: its class body or the module."""
        if decl.owner is not None:
            return self.scope_of(decl.owner)
        return self.module_scope(decl.module)

    # ---------------------------------------------------------------- inference

    def infer(self, node, scope: Scope) -> Value | None:
        kind = type(node)
        if kind is ast.Name:
            return scope.lookup(node.id)
        if kind is ast.Attribute:
            base = self.infer(node.value, scope)
            return self.attribute(base, node.attr) if base is not None else None
        if kind is ast.Call:
            return self.call(node, scope)
        if kind is ast.Subscript:
            return self.subscript(self.infer(node.value, scope), node.slice)
        if kind is ast.Await or kind is ast.NamedExpr:
            return self.infer(node.value, scope)
        if kind is ast.BoolOp:
            return agree([self.infer(v, scope) for v in node.values])
        if kind is ast.IfExp:
            return agree([self.infer(node.body, scope), self.infer(node.orelse, scope)])
        if kind in (ast.List, ast.Tuple, ast.Set):
            element = agree([self.infer(e, scope) for e in node.elts if not isinstance(e, ast.Starred)])
            return ContainerVal(element) if element is not None else None
        if kind in (ast.ListComp, ast.SetComp, ast.GeneratorExp):
            element = self.infer(node.elt, ComprehensionScope(self, scope.module, node.generators, scope))
            return ContainerVal(element) if element is not None else None
        return None

    def deref(self, value: Value | None) -> Value | None:
        if isinstance(value, VarVal):
            return self.var_type(value.var)
        if isinstance(value, PropVal):
            return self.return_type(value.func)
        return value

    def attribute(self, base: Value | None, name: str) -> Value | None:
        base = self.deref(base)
        if base is None:
            return None
        if isinstance(base, ModuleVal):
            return self.module_attr(base.module, name)
        if isinstance(base, ClassVal):
            member = self.member(base.cls, name)
            if member is not None:
                return self.member_value(member, on_class=True)
            if (name == "objects" and self.is_django_model(base.cls)) or (name == "query" and self.is_flask_model(base.cls)):
                return QueryVal(base.cls)
            return None
        if isinstance(base, InstanceVal):
            member = self.member(base.cls, name)
            return self.member_value(member, on_class=False) if member is not None else None
        if isinstance(base, QueryVal):
            if name in QUERY_CHAIN or name in QUERY_ONE:
                return QueryMethodVal(base.cls, name in QUERY_ONE)
            return None
        if isinstance(base, FuncVal):
            return base if name in TASK_CALLS and self.is_task(base.func) else None
        if isinstance(base, SuperVal):
            for cls in self.mro(base.cls)[1:]:
                member = cls.members.get(name)
                if member is not None:
                    return self.member_value(member, on_class=False)
            return None
        if isinstance(base, ExtVal):
            return ExtVal(f"{base.name}.{name}")
        return None

    def member_value(self, member, on_class: bool) -> Value | None:
        if isinstance(member, ClassDecl):
            return ClassVal(member)
        if isinstance(member, FuncDecl):
            return PropVal(member) if member.flavor == "property" else FuncVal(member)
        if isinstance(member, VarDecl):
            return VarVal(member)
        return None

    def call(self, node: ast.Call, scope: Scope) -> Value | None:
        func = node.func
        if isinstance(func, ast.Name) and func.id == "super" and scope.cls is not None and isinstance(scope.lookup("super"), ExtVal):
            return SuperVal(scope.cls)
        return self.call_result(self.infer(func, scope), node, scope)

    def call_result(self, target: Value | None, node: ast.Call, scope: Scope) -> Value | None:
        if isinstance(target, VarVal):
            target = self.var_type(target.var)
        if target is None or isinstance(target, PropVal):
            return None
        if isinstance(target, ClassVal):
            return InstanceVal(target.cls)
        if isinstance(target, FuncVal):
            return self.return_type(target.func)
        if isinstance(target, InstanceVal):
            member = self.member(target.cls, "__call__")
            return self.return_type(member) if isinstance(member, FuncDecl) else None
        if isinstance(target, ExtVal):
            return self._external_call(target, node, scope)
        if isinstance(target, QueryMethodVal):
            return InstanceVal(target.cls) if target.one else QueryVal(target.cls)
        return None

    def _external_call(self, target: ExtVal, node: ast.Call, scope: Scope) -> Value | None:
        name = target.name
        args = node.args
        if name in ("typing.cast", "typing_extensions.cast", "builtins.cast") and args:
            return self.annotation_value(args[0], scope)
        if name in ("builtins.list", "builtins.tuple", "builtins.set", "builtins.frozenset", "builtins.sorted", "builtins.reversed", "builtins.iter") and args:
            element = self.element_of(self.infer(args[0], scope))
            return ContainerVal(element) if element is not None else None
        if name == "builtins.next" and args:
            return self.element_of(self.infer(args[0], scope))
        if name == "builtins.type" and len(args) == 1:
            value = self.deref(self.infer(args[0], scope))
            return ClassVal(value.cls) if isinstance(value, InstanceVal) else None
        if name.startswith("builtins."):
            return None
        last = name.rsplit(".", 1)[-1]
        if args and _is_orm(name):
            model = self.deref(self.infer(args[0], scope))
            if isinstance(model, ClassVal) and (last in ("query", "select") or (last in QUERY_ONE and len(args) >= 2)):
                # session.query(Order), select(Order), session.get(Order, 1), db.get_or_404(Order, 1)
                return QueryVal(model.cls) if last in ("query", "select") else InstanceVal(model.cls)
            if isinstance(model, QueryVal) and last in SELECTED:
                return InstanceVal(model.cls) if SELECTED[last] else model  # session.scalar(select(User).where(…))
        return ExtVal(name, instance=True)

    def subscript(self, base: Value | None, index) -> Value | None:
        base = self.deref(base)
        if isinstance(base, ContainerVal):
            return base if isinstance(index, ast.Slice) else base.element
        if isinstance(base, ClassVal):
            return base  # Repository[Order]: the generic class itself
        if isinstance(base, InstanceVal):
            member = self.member(base.cls, "__getitem__")
            return self.return_type(member) if isinstance(member, FuncDecl) else None
        return None

    def element_of(self, value: Value | None) -> Value | None:
        value = self.deref(value)
        if isinstance(value, ContainerVal):
            return value.element
        if isinstance(value, InstanceVal):
            member = self.member(value.cls, "__iter__")
            if isinstance(member, FuncDecl):
                result = self.return_type(member)
                return result.element if isinstance(result, ContainerVal) else None
        return None

    def enter_value(self, value: Value | None) -> Value | None:
        """What `with value as x` binds: __enter__'s result, an element of a @contextmanager's iterator."""
        value = self.deref(value)
        if isinstance(value, InstanceVal):
            member = self.member(value.cls, "__enter__") or self.member(value.cls, "__aenter__")
            if isinstance(member, FuncDecl):
                return self.return_type(member)
            return None
        if isinstance(value, ContainerVal):
            return value.element
        if isinstance(value, ExtVal):
            return value
        return None

    def exception_value(self, node, scope: Scope) -> Value | None:
        if node is None:
            return None
        if isinstance(node, ast.Tuple):
            return agree([self.exception_value(e, scope) for e in node.elts])
        value = self.deref(self.infer(node, scope))
        if isinstance(value, ClassVal):
            return InstanceVal(value.cls)
        if isinstance(value, ExtVal):
            return ExtVal(value.name, instance=True)
        return None

    # ---------------------------------------------------------------- annotations

    def annotation_value(self, node, scope: Scope, depth: int = 0) -> Value | None:
        """The value an annotation describes: `Order` → an Order, `list[Order]` → a list of them, `type[Order]` → the class."""
        if node is None or depth > 20:
            return None
        if isinstance(node, ast.Constant):
            if isinstance(node.value, str):
                parsed = self.parse_annotation(node.value)
                return self.annotation_value(parsed, scope, depth + 1) if parsed is not None else None
            return None
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
            return agree([self.annotation_value(node.left, scope, depth + 1), self.annotation_value(node.right, scope, depth + 1)])
        if isinstance(node, ast.Subscript):
            return self._generic(node, scope, depth)
        if isinstance(node, (ast.Name, ast.Attribute)):
            value = self.infer(node, scope)
            if isinstance(value, ClassVal):
                return InstanceVal(value.cls)
            if isinstance(value, VarVal):
                return self.alias_value(value.var, depth)
            if isinstance(value, ExtVal):
                if value.name in SELF_TYPES:
                    return InstanceVal(scope.cls) if scope.cls is not None else None
                if value.name.startswith(_TYPING_MODULES):
                    return None
                return ExtVal(value.name, instance=True)
        return None

    def _generic(self, node: ast.Subscript, scope: Scope, depth: int) -> Value | None:
        base = self.infer(node.value, scope)
        args = list(node.slice.elts) if isinstance(node.slice, ast.Tuple) else [node.slice]
        if isinstance(base, ClassVal):
            return InstanceVal(base.cls)
        if isinstance(base, VarVal):
            return self.alias_value(base.var, depth)
        if not isinstance(base, ExtVal):
            return None
        short = base.name.rsplit(".", 1)[-1]
        if short == "Union":
            return agree([self.annotation_value(a, scope, depth + 1) for a in args])
        if short in _UNWRAP:
            return self.annotation_value(args[0], scope, depth + 1)
        if short in _LAST:
            return self.annotation_value(args[-1], scope, depth + 1)
        if short in _CONTAINERS:
            element = self.annotation_value(args[0], scope, depth + 1)
            return ContainerVal(element) if element is not None else None
        if short in ("type", "Type"):
            inner = self.annotation_value(args[0], scope, depth + 1)
            return ClassVal(inner.cls) if isinstance(inner, InstanceVal) else None
        if short in _NOT_TYPES or base.name.startswith(_TYPING_MODULES):
            return None
        return ExtVal(base.name, instance=True)

    def alias_value(self, var: VarDecl, depth: int) -> Value | None:
        """A type alias: `OrderList = list[Order]`, `OrderId: TypeAlias = int`."""
        if not var.values or var.owner is not None:
            return None
        return self.annotation_value(var.values[0][0], self.module_scope(var.module), depth + 1)

    def parse_annotation(self, text: str):
        if text not in self._strings:
            try:
                self._strings[text] = ast.parse(text.strip(), mode="eval").body
            except (SyntaxError, ValueError):
                self._strings[text] = None
        return self._strings[text]

    def annotation_targets(self, node, scope: Scope, depth: int = 0) -> list:
        """The declarations an annotation names, type arguments too: `dict[str, list[Order]]` → Order."""
        out: list = []
        if node is None or depth > 20:
            return out
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            parsed = self.parse_annotation(node.value)
            return self.annotation_targets(parsed, scope, depth + 1) if parsed is not None else out
        if isinstance(node, (ast.Name, ast.Attribute)):
            value = self.infer(node, scope)
            if isinstance(value, (ClassVal, VarVal)):
                out.append(value.cls if isinstance(value, ClassVal) else value.var)
            return out
        if isinstance(node, ast.Subscript):
            out.extend(self.annotation_targets(node.value, scope, depth + 1))
            base = self.infer(node.value, scope)
            if isinstance(base, ExtVal) and base.name.rsplit(".", 1)[-1] in ("Literal", "Annotated"):
                if base.name.endswith("Annotated"):
                    first = node.slice.elts[0] if isinstance(node.slice, ast.Tuple) else node.slice
                    out.extend(self.annotation_targets(first, scope, depth + 1))
                return out
            out.extend(self.annotation_targets(node.slice, scope, depth + 1))
            return out
        if isinstance(node, (ast.Tuple, ast.List)):
            for element in node.elts:
                out.extend(self.annotation_targets(element, scope, depth + 1))
            return out
        if isinstance(node, ast.BinOp):
            out.extend(self.annotation_targets(node.left, scope, depth + 1))
            out.extend(self.annotation_targets(node.right, scope, depth + 1))
        return out

    # ---------------------------------------------------------------- types of declarations

    def var_type(self, var: VarDecl) -> Value | None:
        key = id(var)
        if key in self._var_types:
            return self._var_types[key]
        guard = ("var", key)
        if guard in self._active:
            return None
        self._active.add(guard)
        try:
            value = self._var_type(var)
        finally:
            self._active.discard(guard)
        self._var_types[key] = value
        return value

    def _var_type(self, var: VarDecl) -> Value | None:
        owner = var.owner
        if owner is not None and self.is_enum_member(var):
            return InstanceVal(owner)
        if var.annotation is not None:
            scope = self.function_scope(var.annotation_owner, var.annotation_owner.node) if var.annotation_owner is not None else self.definition_scope(var)
            value = self.annotation_value(var.annotation, scope)
            if value is not None or not var.values:
                return value
        values = []
        for expr, method in var.values:
            scope = self.function_scope(method, method.node) if method is not None else self.definition_scope(var)
            values.append(self.infer(expr, scope))
        return agree(values)

    def return_type(self, func: FuncDecl) -> Value | None:
        key = id(func)
        if key in self._returns:
            return self._returns[key]
        guard = ("return", key)
        if guard in self._active:
            return None
        self._active.add(guard)
        try:
            value = self._return_type(func)
        finally:
            self._active.discard(guard)
        self._returns[key] = value
        return value

    def yield_type(self, func: FuncDecl) -> Value | None:
        """What a generator yields (a pytest fixture that yields its value, a @contextmanager)."""
        key = id(func)
        if key in self._yields:
            return self._yields[key]
        guard = ("yield", key)
        if guard in self._active:
            return None
        self._active.add(guard)
        try:
            scope = self.function_scope(func, func.node)
            value = agree([self.infer(n.value, scope) for n in _local_nodes(func.node) if isinstance(n, ast.Yield) and n.value is not None])
        finally:
            self._active.discard(guard)
        self._yields[key] = value
        return value

    def _return_type(self, func: FuncDecl) -> Value | None:
        node = func.node
        if node.returns is not None:
            return self.annotation_value(node.returns, self.definition_scope(func))
        values = []
        scope = self.function_scope(func, node)
        for statement in _returns(node):
            if statement.value is None or (isinstance(statement.value, ast.Constant) and statement.value.value is None):
                continue
            values.append(self.infer(statement.value, scope))
        return agree(values)

    # ---------------------------------------------------------------- classes

    def bases(self, cls: ClassDecl) -> list[Value]:
        """The values a class' bases name, in order (classes of the analysis, external names, variables)."""
        key = id(cls)
        if key in self._bases:
            return self._bases[key]
        guard = ("bases", key)
        if guard in self._active:
            return []
        self._active.add(guard)
        try:
            scope = self.definition_scope(cls)
            out = []
            for base in cls.node.bases:
                expressions = [base]
                if isinstance(base, ast.Call) and (decorator_name(base) or "").endswith("with_metaclass"):
                    expressions = base.args[1:]
                for expression in expressions:
                    if isinstance(expression, ast.Subscript):
                        expression = expression.value
                    value = self.infer(expression, scope)
                    if value is not None:
                        out.append(value)
                    if isinstance(value, VarVal):  # Base = declarative_base(): the variable, and what it holds
                        held = self.var_type(value.var)
                        if held is not None:
                            out.append(held)
        finally:
            self._active.discard(guard)
        self._bases[key] = out
        return out

    def mro(self, cls: ClassDecl) -> list[ClassDecl]:
        key = id(cls)
        if key in self._mro:
            return self._mro[key]
        guard = ("mro", key)
        if guard in self._active:
            return [cls]
        self._active.add(guard)
        try:
            parents = [b.cls for b in self.bases(cls) if isinstance(b, ClassVal) and b.cls is not cls]
            order = _c3([cls], [self.mro(p) for p in parents] + [parents])
            if order is None:  # an inconsistent hierarchy: depth first, each class once
                order = [cls]
                for parent in parents:
                    order.extend(c for c in self.mro(parent) if c not in order)
        finally:
            self._active.discard(guard)
        self._mro[key] = order
        return order

    def member(self, cls: ClassDecl, name: str):
        for klass in self.mro(cls):
            member = klass.members.get(name)
            if member is not None:
                return member
        return None

    def external_bases(self, cls: ClassDecl) -> set[str]:
        """Qualified names of the external classes a class derives from, through its bases of the analysis."""
        names: set[str] = set()
        for klass in self.mro(cls):
            for base in self.bases(klass):
                if isinstance(base, ExtVal):
                    names.add(base.name)
        return names

    def own_external_bases(self, cls: ClassDecl) -> set[str]:
        return {b.name for b in self.bases(cls) if isinstance(b, ExtVal)}

    def metaclass(self, cls: ClassDecl) -> str:
        for keyword in cls.node.keywords:
            if keyword.arg == "metaclass":
                value = self.infer(keyword.value, self.definition_scope(cls))
                if isinstance(value, ExtVal):
                    return value.name
        return ""

    def is_django_model(self, cls: ClassDecl) -> bool:
        return any(n.startswith("django.") and (n.endswith(".Model") or n.rsplit(".", 1)[-1].startswith("Abstract")) for n in self.external_bases(cls))

    def is_flask_model(self, cls: ClassDecl) -> bool:
        return any(n.startswith("flask_sqlalchemy.") and n.endswith(".Model") for n in self.external_bases(cls))

    def is_task(self, func: FuncDecl) -> bool:
        return any(decorator_name(d).rsplit(".", 1)[-1] in TASK_DECORATORS for d in func.decorators)

    def is_enum(self, cls: ClassDecl) -> bool:
        return bool(self.external_bases(cls) & ENUMS)

    def is_enum_member(self, var: VarDecl) -> bool:
        owner = var.owner
        if owner is None or not var.class_level or var.annotation is not None or var.name.startswith("_") or not self.is_enum(owner):
            return False
        return not any(isinstance(v, (ast.Lambda,)) for v, _ in var.values)

    def is_protocol(self, cls: ClassDecl) -> bool:
        return bool(self.own_external_bases(cls) & PROTOCOLS)

    def is_abc(self, cls: ClassDecl) -> bool:
        return bool(self.own_external_bases(cls) & ABC_BASES) or self.metaclass(cls) in ABC_METAS

    def abstract_methods(self, cls: ClassDecl) -> list[FuncDecl]:
        return [m for m in cls.members.values() if isinstance(m, FuncDecl) and is_abstract(m)]

    def is_interface(self, cls: ClassDecl) -> bool:
        """A Protocol, or an ABC whose methods are all abstract (and that holds no values)."""
        if self.is_protocol(cls):
            return True
        if not self.is_abc(cls):
            return False
        methods = [m for m in cls.members.values() if isinstance(m, FuncDecl)]
        fields = [m for m in cls.members.values() if isinstance(m, VarDecl) and m.values]
        return bool(methods) and all(is_abstract(m) for m in methods) and not fields

    def is_exception(self, cls: ClassDecl) -> bool:
        return any(_EXCEPTION_NAME.search(name) or name == "builtins.BaseException" for name in self.external_bases(cls))


# ---------------------------------------------------------------------------------------------- helpers


def _is_orm(name: str) -> bool:
    """A call of SQLAlchemy (select), its session or Flask-SQLAlchemy's (session.get, db.session.query, db.get_or_404)."""
    return name.startswith(("sqlalchemy.", "sqlmodel.", "flask_sqlalchemy.")) or ".session." in name.lower() or ".Session." in name


def agree(values) -> Value | None:
    """The one value all the known ones are (None when they differ or none is known)."""
    found = None
    for value in values:
        if value is None:
            continue
        if found is None:
            found = value
        elif found != value:
            return None
    return found


def is_abstract(func: FuncDecl) -> bool:
    return any(decorator_name(d) in ABSTRACT_DECORATORS for d in func.decorators)


def _c3(head: list, sequences: list[list]) -> list | None:
    result = list(head)
    sequences = [list(s) for s in sequences if s]
    while sequences:
        for sequence in sequences:
            candidate = sequence[0]
            if not any(candidate in s[1:] for s in sequences):
                break
        else:
            return None
        result.append(candidate)
        sequences = [[c for c in s if c is not candidate] for s in sequences]
        sequences = [s for s in sequences if s]
    return result


def _names(target) -> list[str]:
    if isinstance(target, ast.Name):
        return [target.id]
    if isinstance(target, (ast.Tuple, ast.List)):
        return [n for e in target.elts for n in _names(e)]
    if isinstance(target, ast.Starred):
        return _names(target.value)
    return []


def _is_enumerate(node) -> bool:
    return (
        isinstance(node.target, ast.Tuple)
        and len(node.target.elts) == 2
        and isinstance(node.iter, ast.Call)
        and isinstance(node.iter.func, ast.Name)
        and node.iter.func.id == "enumerate"
        and bool(node.iter.args)
    )


def _local_nodes(function):
    """The nodes of a function's own body: not inside nested functions, classes or lambdas (their names are local)."""
    stack = list(function.body)
    while stack:
        node = stack.pop()
        yield node
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            stack.extend(node.decorator_list)
            continue
        if isinstance(node, ast.Lambda):
            continue
        stack.extend(ast.iter_child_nodes(node))


def _local_statements(function):
    """The statements of a function's own body (and its except handlers and match patterns): nested functions and
    classes are there as statements, not their bodies."""
    stack = list(reversed(function.body))
    while stack:
        node = stack.pop()
        yield node
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        for field in ("body", "orelse", "finalbody"):
            block = getattr(node, field, None)
            if isinstance(block, list):
                stack.extend(reversed(block))
        for handler in getattr(node, "handlers", ()) or ():
            yield handler
            stack.extend(reversed(handler.body))
        for case in getattr(node, "cases", ()) or ():
            yield from ast.walk(case.pattern)
            stack.extend(reversed(case.body))


def _returns(function):
    for node in _local_statements(function):
        if isinstance(node, ast.Return):
            yield node


__all__ = [
    "ClassVal", "ComprehensionScope", "ContainerVal", "ExtVal", "FuncVal", "FunctionScope", "InstanceVal", "ModuleIndex",
    "ModuleScope", "ModuleVal", "PackageStub", "PropVal", "Resolver", "Scope", "SuperVal", "VarVal", "agree", "is_abstract",
    "is_dunder",
]
