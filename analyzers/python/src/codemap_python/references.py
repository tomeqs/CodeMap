"""Edges from the code of each declaration: calls (with the line of the first call, which orders a call flow),
class calls (instantiates), raise and except (throws, catches), reads and writes of variables, fields and
properties (accesses), class references (uses; accepts / returns / holds in annotations), constructor parameters
(injects), base classes down to the methods that override or implement theirs, and decorators.
"""
from __future__ import annotations

import ast

from .ids import TOP_LEVEL, member_id
from .resolve import (
    ClassVal,
    ComprehensionScope,
    ContainerVal,
    ExtVal,
    FuncVal,
    FunctionScope,
    InstanceVal,
    TASK_CALLS,
    PropVal,
    VarVal,
    is_abstract,
)
from .symbols import ClassDecl, FuncDecl, VarDecl, symbols_of


def collect_references(ctx, module, owners: list) -> None:
    resolver = ctx.resolver
    for decl in owners:
        walker = Walker(ctx, decl.id, _ancestors(decl))
        if isinstance(decl, FuncDecl):
            _function(ctx, walker, decl)
        elif isinstance(decl, ClassDecl):
            _class(ctx, walker, decl)
        elif isinstance(decl, VarDecl):
            _variable(ctx, walker, decl)
    table = symbols_of(module)
    if table.top_lines:
        walker = Walker(ctx, member_id(module.id, TOP_LEVEL), set())
        scope = resolver.module_scope(module)
        for node in table.top_code:
            walker.visit(node, scope)


def _ancestors(decl) -> set[str]:
    out = set()
    owner = decl.owner
    while owner is not None:
        out.add(owner.id)
        owner = owner.owner
    if isinstance(decl, ClassDecl):
        out.add(decl.id)
    return out


def _function(ctx, walker: Walker, decl: FuncDecl) -> None:
    resolver = ctx.resolver
    outer = resolver.definition_scope(decl)
    for definition in decl.nodes:
        args = definition.args
        every = list(getattr(args, "posonlyargs", [])) + list(args.args) + list(args.kwonlyargs)
        every += [a for a in (args.vararg, args.kwarg) if a is not None]
        for arg in every:
            walker.types(arg.annotation, outer, "accepts")
        walker.types(definition.returns, outer, "holds" if decl.flavor == "property" else "returns")
        if decl.flavor == "constructor" and decl.owner is not None:
            for arg in every[1:]:
                _injects(ctx, decl.owner, arg.annotation, outer)
        for default in list(args.defaults) + [d for d in args.kw_defaults if d is not None]:
            walker.visit(default, outer)
        walker.decorators(definition.decorator_list, outer)
        if definition is decl.node or definition in decl.defs:
            scope = resolver.function_scope(decl, definition)
            for statement in definition.body:
                walker.visit(statement, scope)
    _overrides(ctx, decl)


def _class(ctx, walker: Walker, decl: ClassDecl) -> None:
    resolver = ctx.resolver
    graph = ctx.graph
    outer = resolver.definition_scope(decl)
    interface = resolver.is_interface
    for base in resolver.bases(decl):
        if isinstance(base, ClassVal) and base.cls is not decl:
            graph.add_edge(decl.id, base.cls.id, "implements" if interface(base.cls) else "inherits")
        elif isinstance(base, VarVal):
            graph.add_edge(decl.id, base.var.id, "accesses")
    for base in decl.node.bases:
        if isinstance(base, ast.Subscript):  # Repository[Order]: the type arguments are used
            walker.types(base.slice, outer, "uses")
    for keyword in decl.node.keywords:
        walker.visit(keyword.value, outer)
    walker.decorators(decl.node.decorator_list, outer)
    scope = resolver.scope_of(decl)
    for node in decl.code:
        walker.visit(node, scope)


def _variable(ctx, walker: Walker, decl: VarDecl) -> None:
    resolver = ctx.resolver
    graph = ctx.graph
    scope = resolver.definition_scope(decl)
    if decl.var_kind == "typeAlias":
        for value, _ in decl.values:
            walker.types(value, scope, "uses")
        return
    if decl.annotation is not None:
        annotation_scope = resolver.function_scope(decl.annotation_owner, decl.annotation_owner.node) if decl.annotation_owner is not None else scope
        walker.types(decl.annotation, annotation_scope, "holds")
    else:
        held = resolver.var_type(decl)
        if isinstance(held, ContainerVal):
            held = held.element
        if isinstance(held, InstanceVal) and held.cls.id not in walker.ancestors:
            graph.add_edge(decl.id, held.cls.id, "holds")
    for value, method in decl.values:
        if method is None:
            walker.visit(value, scope)


def _injects(ctx, owner: ClassDecl, annotation, scope) -> None:
    """A constructor is given the type itself (also Optional[Service]); its type arguments are only used."""
    if annotation is None:
        return
    value = ctx.resolver.annotation_value(annotation, scope)
    if isinstance(value, InstanceVal) and value.cls is not owner:
        ctx.graph.add_edge(owner.id, value.cls.id, "injects")


def _overrides(ctx, decl: FuncDecl) -> None:
    """A method that a base class (of the analysis) also has: it overrides it, or implements an abstract one."""
    owner = decl.owner
    if owner is None or decl.flavor == "constructor" or decl.name in ("__new__", "__init_subclass__"):
        return
    resolver = ctx.resolver
    for base in resolver.mro(owner)[1:]:
        inherited = base.members.get(decl.name)
        if isinstance(inherited, FuncDecl):
            kind = "implements" if resolver.is_interface(base) or is_abstract(inherited) else "overrides"
            ctx.graph.add_edge(decl.id, inherited.id, kind)
            return


class Walker:
    """Walks code, adding the edges of one declaration (its source)."""

    def __init__(self, ctx, source: str, ancestors: set[str]) -> None:
        self.ctx = ctx
        self.resolver = ctx.resolver
        self.graph = ctx.graph
        self.source = source
        self.ancestors = ancestors
        self.stats = ctx.stats

    # ---------------------------------------------------------------- edges

    def reference(self, value, node, call: bool = False) -> None:
        if value is None:
            return
        if isinstance(value, ClassVal):
            kind, target = ("instantiates" if call else "uses"), value.cls.id
        elif isinstance(value, FuncVal):
            kind, target = "calls", value.func.id
        elif isinstance(value, PropVal):
            kind, target = "accesses", value.func.id
        elif isinstance(value, VarVal):
            var = value.var
            if var.owner is not None and self.resolver.is_enum_member(var):
                kind, target = "uses", var.owner.id
            else:
                kind, target = "accesses", var.id
        else:
            return
        if kind == "uses" and target in self.ancestors:
            return  # a method naming its own class
        line = getattr(node, "lineno", 0) if kind in ("calls", "instantiates") else 0
        self.graph.add_edge(self.source, target, kind, line)

    def types(self, annotation, scope, kind: str) -> None:
        if annotation is None:
            return
        for target in self.resolver.annotation_targets(annotation, scope):
            if kind == "uses" and target.id in self.ancestors:
                continue
            self.graph.add_edge(self.source, target.id, kind)

    def decorators(self, decorators, scope) -> None:
        """`@decorator(args)`: an edge to the decorator when it is a function or class of the analysis; the arguments,
        and the object a decorator belongs to (`@router.get`: router), are the declaration's code."""
        for decorator in decorators:
            expression = decorator.func if isinstance(decorator, ast.Call) else decorator
            target = self.resolver.infer(expression, scope)
            if isinstance(target, (FuncVal, ClassVal)):
                self.graph.add_edge(self.source, target.func.id if isinstance(target, FuncVal) else target.cls.id, "decoratedWith")
            elif isinstance(expression, ast.Attribute):
                self.visit(expression.value, scope)
            if isinstance(decorator, ast.Call):
                for arg in decorator.args:
                    self.visit(arg, scope)
                for keyword in decorator.keywords:
                    self.visit(keyword.value, scope)

    # ---------------------------------------------------------------- walking

    def visit(self, node, scope) -> None:
        kind = type(node)
        if kind is ast.Call:
            self.call(node, scope)
        elif kind is ast.Attribute:
            self.reference(self.resolver.infer(node, scope), node)
            self.visit(node.value, scope)
        elif kind is ast.Name:
            if isinstance(node.ctx, ast.Load) or self._is_global(node, scope):
                self.reference(scope.lookup(node.id), node)
        elif kind in (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda):
            self.nested_function(node, scope)
        elif kind is ast.ClassDef:
            for child in node.bases + [k.value for k in node.keywords] + node.decorator_list + node.body:
                self.visit(child, scope)
        elif kind in (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp):
            self.comprehension(node, scope)
        elif kind is ast.Raise:
            if node.exc is not None:
                thrown = node.exc.func if isinstance(node.exc, ast.Call) else node.exc
                value = self.resolver.deref(self.resolver.infer(thrown, scope))
                if isinstance(value, ClassVal):
                    self.graph.add_edge(self.source, value.cls.id, "throws")
                self.visit(node.exc, scope)
            if node.cause is not None:
                self.visit(node.cause, scope)
        elif kind is ast.ExceptHandler:
            if node.type is not None:
                for caught in node.type.elts if isinstance(node.type, ast.Tuple) else [node.type]:
                    value = self.resolver.deref(self.resolver.infer(caught, scope))
                    if isinstance(value, ClassVal):
                        self.graph.add_edge(self.source, value.cls.id, "catches")
            for statement in node.body:
                self.visit(statement, scope)
        elif kind is ast.AnnAssign:
            self.types(node.annotation, scope, "uses")
            self.visit(node.target, scope)
            if node.value is not None:
                self.visit(node.value, scope)
        elif kind in (ast.Import, ast.ImportFrom, ast.Constant, ast.Global, ast.Nonlocal, ast.Pass):
            return
        else:
            for child in ast.iter_child_nodes(node):
                self.visit(child, scope)

    def call(self, node: ast.Call, scope) -> None:
        func = node.func
        value = self.resolver.infer(func, scope)
        self.stats["calls"] += 1
        if isinstance(value, ExtVal) and self.ctx.frameworks is not None:
            self.ctx.frameworks.on_call(self, node, value.name, scope)
        if isinstance(value, InstanceVal):
            member = self.resolver.member(value.cls, "__call__")
            value = FuncVal(member) if isinstance(member, FuncDecl) else None
        if isinstance(value, (FuncVal, ClassVal)):
            self.stats["resolved"] += 1
        self.reference(value, node, call=True)
        if isinstance(func, ast.Attribute):
            # task.delay(…) is one call of the task, not a call and a reference to it.
            task_call = isinstance(value, FuncVal) and func.attr in TASK_CALLS and isinstance(func.value, (ast.Name, ast.Attribute)) \
                and self.resolver.infer(func.value, scope) == value
            if not task_call:
                self.visit(func.value, scope)
        elif not isinstance(func, ast.Name):
            self.visit(func, scope)
        for arg in node.args:
            self.visit(arg, scope)
        for keyword in node.keywords:
            self.visit(keyword.value, scope)

    def nested_function(self, node, scope) -> None:
        args = node.args
        for default in list(args.defaults) + [d for d in args.kw_defaults if d is not None]:
            self.visit(default, scope)
        if isinstance(node, ast.Lambda):
            self.visit(node.body, FunctionScope(self.resolver, scope.module, node, scope, scope.cls, "function"))
            return
        every = list(getattr(args, "posonlyargs", [])) + list(args.args) + list(args.kwonlyargs)
        for arg in every:
            self.types(arg.annotation, scope, "uses")
        self.types(node.returns, scope, "uses")
        self.decorators(node.decorator_list, scope)
        inner = FunctionScope(self.resolver, scope.module, node, scope, scope.cls, "function")
        for statement in node.body:
            self.visit(statement, inner)

    def comprehension(self, node, scope) -> None:
        inner = ComprehensionScope(self.resolver, scope.module, node.generators, scope)
        for index, generator in enumerate(node.generators):
            self.visit(generator.iter, scope if index == 0 else inner)
            for condition in generator.ifs:
                self.visit(condition, inner)
        if isinstance(node, ast.DictComp):
            self.visit(node.key, inner)
            self.visit(node.value, inner)
        else:
            self.visit(node.elt, inner)

    @staticmethod
    def _is_global(node: ast.Name, scope) -> bool:
        """A write to a module variable from a function that declares it global."""
        while scope is not None:
            if isinstance(scope, FunctionScope):
                if scope.entries is None:
                    scope.lookup(node.id)
                if node.id in scope.globals:
                    return True
                return False
            scope = getattr(scope, "parent", None)
        return False
