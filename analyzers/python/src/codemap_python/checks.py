"""Checks inside function bodies (CodeMap's --checks): mistakes Python accepts, found in the syntax and with the names
the resolver knows. Rules shared with TypeScript keep their ids (empty-catch, swallowed-exception, unreachable-code,
self-assignment, self-comparison, constant-condition); the rest are Python's own. Test and generated code is not
checked.
"""
from __future__ import annotations

import ast
import builtins
import re

from .resolve import TASK_CALLS, ClassVal, ComprehensionScope, ExtVal, FuncVal, FunctionScope
from .symbols import ClassDecl, FuncDecl, decorator_name, symbols_of

CATCH_ALL = {"Exception", "BaseException", "builtins.Exception", "builtins.BaseException"}
LOGGING = re.compile(r"log|warn|error|report|trace|captur|notify|print|exception|sentry|alert|fail", re.I)
BLOCKING = {
    "time.sleep": "await asyncio.sleep(…)",
    "builtins.input": "a thread (asyncio.to_thread)",
    "os.system": "asyncio.create_subprocess_shell",
    "subprocess.run": "asyncio.create_subprocess_exec", "subprocess.call": "asyncio.create_subprocess_exec",
    "subprocess.check_call": "asyncio.create_subprocess_exec", "subprocess.check_output": "asyncio.create_subprocess_exec",
    "urllib.request.urlopen": "an async HTTP client (httpx.AsyncClient, aiohttp)",
}
REQUESTS = {"get", "post", "put", "patch", "delete", "head", "options", "request"}
MUTABLE_CALLS = {"list", "dict", "set", "bytearray", "collections.defaultdict", "collections.OrderedDict", "collections.deque", "collections.Counter"}
SHADOWED = frozenset(
    "list dict set tuple str int float bool bytes type object id input len max min sum all any filter map open print "
    "range zip iter next hash format sorted reversed round abs vars dir help compile super property slice".split()
)
BUILTINS = frozenset(dir(builtins))
_CONSTANT_TESTS = (bool, int, float, str, bytes, type(None))
_NOQA = re.compile(r"#\s*noqa\b", re.I)


class Checker:
    def __init__(self, ctx, module) -> None:
        self.ctx = ctx
        self.resolver = ctx.resolver
        self.module = module
        self.table = symbols_of(module)
        self.lines = module.text.splitlines()
        self.out: list[dict] = []
        self.in_class = False  # in a class body (not a method's): x = x copies the module's x into the class
        self.decls = {id(d.node): d for d in self.table.decls if isinstance(d, (FuncDecl, ClassDecl))}
        for decl in self.table.decls:
            if isinstance(decl, FuncDecl):
                for node in decl.nodes:
                    self.decls[id(node)] = decl

    def report(self, node, rule: str, severity: str, category: str, message: str) -> None:
        line = self.lines[node.lineno - 1] if 0 < node.lineno <= len(self.lines) else ""
        if _NOQA.search(line):
            return  # # noqa: the author knows
        self.out.append({
            "rule": rule, "source": "codemap", "severity": severity, "category": category, "message": message,
            "location": {"file": self.module.rel, "line": node.lineno, "endLine": getattr(node, "end_lineno", None) or node.lineno},
            "column": node.col_offset + 1,
        })

    def text(self, node, limit: int = 60) -> str:
        try:
            text = ast.unparse(node)
        except (ValueError, RecursionError):
            text = "…"
        text = re.sub(r"\s+", " ", text)
        return text if len(text) <= limit else text[: limit - 1] + "…"

    # ---------------------------------------------------------------- walking

    def run(self) -> list[dict]:
        tree = self.module.tree
        self.unused_imports(tree)
        self.redefinitions(tree.body)
        self.block(tree.body, self.resolver.module_scope(self.module), None)
        return self.out

    def block(self, statements: list, scope, function) -> None:
        """A list of statements: what follows a return / raise / break / continue never runs."""
        for index, statement in enumerate(statements):
            self.statement(statement, scope, function)
            if isinstance(statement, (ast.Return, ast.Raise, ast.Continue, ast.Break)) and index + 1 < len(statements):
                following = statements[index + 1]
                self.report(following, "unreachable-code", "warning", "dead-code", "This code can never run: it comes after a return, raise, break or continue.")
                break

    def statement(self, node, scope, function) -> None:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            self.function(node, scope)
            return
        if isinstance(node, ast.ClassDef):
            for child in node.decorator_list + node.bases + [k.value for k in node.keywords]:
                self.expression(child, scope, function)
            self.redefinitions(node.body)
            cls = self.decls.get(id(node))
            inner = self.resolver.scope_of(cls) if isinstance(cls, ClassDecl) else scope
            outer, self.in_class = self.in_class, True
            self.block(node.body, inner, function)
            self.in_class = outer
            return
        if isinstance(node, ast.Expr):
            self.expression_statement(node, scope, function)
            return
        if isinstance(node, ast.Assign):
            if len(node.targets) == 1 and _same(node.targets[0], node.value) and not (self.in_class and isinstance(node.value, ast.Name)):
                self.report(node, "self-assignment", "warning", "correctness", f"'{self.text(node)}' assigns a value to itself: probably a typo.")
            if not self.in_class:
                self.shadowing(node.targets, function)
        elif isinstance(node, ast.AnnAssign) and node.value is not None and not self.in_class:
            self.shadowing([node.target], function)
        elif isinstance(node, ast.Assert) and isinstance(node.test, ast.Tuple) and node.test.elts:
            self.report(node, "assert-tuple", "warning", "correctness", "This assert checks a tuple, which is never empty: it always passes. Write assert condition, \"message\".")
        elif isinstance(node, (ast.If, ast.While)):
            self.condition(node, scope)
        elif isinstance(node, ast.Raise) and node.exc is not None:
            raised = node.exc.func if isinstance(node.exc, ast.Call) else node.exc
            value = scope.lookup(raised.id) if isinstance(raised, ast.Name) else None
            if isinstance(value, ExtVal) and value.name == "builtins.NotImplemented":
                self.report(node, "raise-not-implemented", "warning", "correctness", "NotImplemented is a value for binary operators, not an exception: raise NotImplementedError.")
        elif isinstance(node, (ast.Try, getattr(ast, "TryStar", ast.Try))):
            self.try_statement(node, scope, function)
            return
        for _, value in ast.iter_fields(node):
            if isinstance(value, list) and value and isinstance(value[0], ast.stmt):
                self.block(value, scope, function)
            elif isinstance(value, list):
                for item in value:
                    if isinstance(item, ast.AST):
                        self.child(item, scope, function)
            elif isinstance(value, ast.AST):
                self.child(value, scope, function)

    def child(self, node, scope, function) -> None:
        if isinstance(node, ast.stmt):
            self.statement(node, scope, function)
        elif isinstance(node, ast.expr):
            self.expression(node, scope, function)
        elif isinstance(node, ast.ExceptHandler):
            self.block(node.body, scope, function)
        else:
            for child in ast.iter_child_nodes(node):
                if isinstance(child, ast.stmt):
                    self.statement(child, scope, function)
                elif isinstance(child, ast.expr):
                    self.expression(child, scope, function)

    def function(self, node, scope) -> None:
        decl = self.decls.get(id(node))
        for decorator in node.decorator_list:
            self.expression(decorator, scope, None)
        self.mutable_defaults(node, scope)
        for default in list(node.args.defaults) + [d for d in node.args.kw_defaults if d is not None]:
            self.expression(default, scope, None)
        if isinstance(decl, FuncDecl) and node in decl.nodes:
            inner = self.resolver.function_scope(decl, node)
        else:
            inner = FunctionScope(self.resolver, self.module, node, scope, scope.cls, "function")
        self.redefinitions(node.body)
        self.unused_variables(node)
        outer, self.in_class = self.in_class, False
        self.block(node.body, inner, node)
        self.in_class = outer

    # ---------------------------------------------------------------- expressions

    def expression(self, node, scope, function, argument: bool = False) -> None:
        stack = [(node, argument)]
        while stack:
            current, in_argument = stack.pop()
            kind = type(current)
            if kind in (ast.Lambda,):
                inner = FunctionScope(self.resolver, self.module, current, scope, scope.cls, "function")
                self.expression(current.body, inner, current)
                continue
            if kind in (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp):
                inner = ComprehensionScope(self.resolver, self.module, current.generators, scope)
                for generator in current.generators:
                    self.expression(generator.iter, scope, function)
                    for condition in generator.ifs:
                        self.expression(condition, inner, function)
                for part in ([current.key, current.value] if kind is ast.DictComp else [current.elt]):
                    self.expression(part, inner, function)
                continue
            if kind is ast.Compare:
                self.comparison(current, in_argument)
            elif kind is ast.Dict:
                self.dict_keys(current)
            elif kind is ast.JoinedStr:
                if not any(isinstance(v, ast.FormattedValue) for v in current.values):
                    self.report(current, "fstring-without-placeholders", "info", "correctness", "An f-string without placeholders: a {…} is missing, or the f is.")
                continue
            elif kind is ast.Call:
                if function is not None and isinstance(function, ast.AsyncFunctionDef):
                    self.blocking(current, scope)
                stack.append((current.func, in_argument))
                stack.extend((a, True) for a in current.args)
                stack.extend((k.value, True) for k in current.keywords)
                continue
            stack.extend((child, in_argument) for child in ast.iter_child_nodes(current))

    def expression_statement(self, node: ast.Expr, scope, function) -> None:
        value = node.value
        if isinstance(value, ast.Call):
            target = self.resolver.infer(value.func, scope)
            task_call = isinstance(value.func, ast.Attribute) and value.func.attr in TASK_CALLS
            if isinstance(target, FuncVal) and self._coroutine(target.func) and not task_call:
                self.report(value, "missing-await", "warning", "async", f"'{self.text(value)}' makes a coroutine that is never awaited: the call does nothing. Await it, or schedule it with asyncio.create_task.")
            elif self._exception_class(target):
                self.report(value, "exception-not-raised", "warning", "correctness", f"'{self.text(value)}' creates an exception and drops it: the raise is missing.")
        self.expression(value, scope, function)

    def condition(self, node, scope) -> None:
        test = node.test
        if isinstance(test, ast.Constant) and isinstance(test.value, _CONSTANT_TESTS) and not (isinstance(node, ast.While) and test.value):
            self.report(test, "constant-condition", "info", "correctness", f"The condition '{self.text(test)}' never changes: a leftover from debugging, or a branch that never runs.")
        elif isinstance(test, ast.Call):
            target = self.resolver.infer(test.func, scope)
            if isinstance(target, FuncVal) and self._coroutine(target.func):
                self.report(test, "missing-await", "warning", "async", f"'{self.text(test)}' is a coroutine, which is always true: the await is missing.")

    def comparison(self, node: ast.Compare, in_argument: bool) -> None:
        left = node.left
        for op, right in zip(node.ops, node.comparators):
            if isinstance(op, (ast.Eq, ast.NotEq)) and (_is_none(left) or _is_none(right)) and not in_argument:
                # In a call's argument it is usually an ORM's filter (Model.column == None means IS NULL).
                self.report(node, "none-comparison", "info", "correctness", f"'{self.text(node)}': compare with None using 'is' ('is not'); == can be overridden.")
            elif isinstance(op, (ast.Is, ast.IsNot)) and (_is_literal(left) or _is_literal(right)):
                self.report(node, "is-literal", "warning", "correctness", f"'{self.text(node)}' compares identity with a literal, which depends on interning: use ==.")
            elif not isinstance(op, (ast.NotEq, ast.In, ast.NotIn)) and _same(left, right) and not _has_call(left):
                self.report(node, "self-comparison", "warning", "correctness", f"'{self.text(node)}' compares a value with itself: always the same result, probably a typo.")
            left = right

    def dict_keys(self, node: ast.Dict) -> None:
        seen: set = set()
        for key in node.keys:
            if isinstance(key, ast.Constant) and isinstance(key.value, (str, int, bytes, float, bool, type(None))):
                marker = (type(key.value), key.value)
                if marker in seen:
                    self.report(key, "duplicate-dict-key", "warning", "correctness", f"The key {self.text(key)} appears twice in this dict: the first value is lost.")
                seen.add(marker)

    def blocking(self, call: ast.Call, scope) -> None:
        target = self.resolver.infer(call.func, scope)
        if not isinstance(target, ExtVal):
            return
        name = target.name
        advice = BLOCKING.get(name)
        if advice is None and name.split(".")[0] == "requests" and name.rsplit(".", 1)[-1] in REQUESTS:
            advice = "an async HTTP client (httpx.AsyncClient, aiohttp)"
        if advice is not None:
            self.report(call, "blocking-in-async", "warning", "async", f"{name.replace('builtins.', '')} blocks the event loop inside an async function: use {advice}.")

    # ---------------------------------------------------------------- functions

    def mutable_defaults(self, node, scope) -> None:
        for default in list(node.args.defaults) + [d for d in node.args.kw_defaults if d is not None]:
            mutable = isinstance(default, (ast.List, ast.Dict, ast.Set, ast.ListComp, ast.DictComp, ast.SetComp))
            if isinstance(default, ast.Call) and not default.args and not default.keywords:
                target = self.resolver.infer(default.func, scope)
                mutable = isinstance(target, ExtVal) and target.name.replace("builtins.", "") in MUTABLE_CALLS
            if mutable:
                self.report(default, "mutable-default", "warning", "correctness", f"The default {self.text(default)} is made once and shared by every call: default to None and create it inside.")

    def unused_variables(self, node) -> None:
        """Locals assigned and never read (not _names, unpacked tuples, loop variables, globals)."""
        assigned: dict[str, ast.AST] = {}
        loaded: set[str] = set()
        declared: set[str] = set()
        dynamic = False
        for child in _own_nodes(node):
            if isinstance(child, (ast.Global, ast.Nonlocal)):
                declared.update(child.names)
            elif isinstance(child, ast.Assign):
                for target in child.targets:
                    if isinstance(target, ast.Name):
                        assigned.setdefault(target.id, target)
            elif isinstance(child, (ast.AnnAssign, ast.NamedExpr)) and isinstance(child.target, ast.Name) and getattr(child, "value", None) is not None:
                assigned.setdefault(child.target.id, child.target)
            elif isinstance(child, ast.ExceptHandler) and child.name:
                assigned.setdefault(child.name, child)
            elif isinstance(child, ast.Name) and not isinstance(child.ctx, ast.Store):
                loaded.add(child.id)
            elif isinstance(child, ast.Call) and isinstance(child.func, ast.Name) and child.func.id in ("locals", "vars", "exec", "eval"):
                dynamic = True
        for inner in ast.walk(node):  # closures and comprehensions read the function's locals too
            if isinstance(inner, ast.Name) and not isinstance(inner.ctx, ast.Store):
                loaded.add(inner.id)
            elif isinstance(inner, ast.AugAssign) and isinstance(inner.target, ast.Name):
                loaded.add(inner.target.id)
        if dynamic:
            return
        for name, where in assigned.items():
            if name in loaded or name in declared or name.startswith("_") or name == "__tracebackhide__":
                continue
            if isinstance(where, ast.ExceptHandler):
                self.report(where, "unused-variable", "info", "dead-code", f"The exception is bound to '{name}' and never used: write 'except {self.text(where.type) if where.type else 'Exception'}:'.")
            else:
                self.report(where, "unused-variable", "info", "dead-code", f"'{name}' is assigned but never read.")

    def shadowing(self, targets, function) -> None:
        for target in targets:
            if isinstance(target, ast.Name) and target.id in SHADOWED:
                where = "this function" if function is not None else "the module"
                self.report(target, "shadowed-builtin", "info", "correctness", f"'{target.id}' hides the built-in {target.id}() in {where}.")

    def redefinitions(self, body: list) -> None:
        """def f(): … then def f(): … again in the same block, neither decorated: the first is never used."""
        seen: dict[str, ast.AST] = {}
        for statement in body:
            if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                first = seen.get(statement.name)
                if first is not None and not first.decorator_list and not statement.decorator_list:
                    self.report(statement, "redefined-function", "warning", "correctness", f"'{statement.name}' is defined again here: the definition on line {first.lineno} is never used.")
                seen[statement.name] = statement

    # ---------------------------------------------------------------- exceptions

    def try_statement(self, node, scope, function) -> None:
        self.block(node.body, scope, function)
        for handler in node.handlers:
            catch_all = handler.type is None or (isinstance(handler.type, (ast.Name, ast.Attribute)) and self._catch_all(handler.type, scope))
            if handler.type is None:
                self.report(handler, "bare-except", "warning", "exceptions", "A bare except also catches KeyboardInterrupt and SystemExit: catch Exception, or what can really happen.")
            if catch_all and _empty(handler.body):
                if not self._commented(handler):
                    self.report(handler, "empty-catch", "warning", "exceptions", "The error is silently ignored: handle it, log it, or say in a comment why ignoring it is safe.")
            elif catch_all and not self._handled(handler):
                self.report(handler, "swallowed-exception", "info", "exceptions", "Every exception is caught and dropped: nothing logs it, re-raises it or looks at it, so failures disappear without a trace.")
            if handler.type is not None:
                self.expression(handler.type, scope, function)
            self.block(handler.body, scope, function)
        self.block(node.orelse, scope, function)
        self.final(node.finalbody)
        self.block(node.finalbody, scope, function)

    def final(self, body: list) -> None:
        """return, break and continue in a finally block drop the exception leaving the try."""
        stack = [(s, False) for s in body]
        while stack:
            statement, in_loop = stack.pop()
            if isinstance(statement, ast.Return) or (isinstance(statement, (ast.Break, ast.Continue)) and not in_loop):
                word = "return" if isinstance(statement, ast.Return) else "break" if isinstance(statement, ast.Break) else "continue"
                self.report(statement, "return-in-finally", "warning", "exceptions", f"A {word} in finally discards the exception that may be leaving the try block.")
            if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                continue
            loop = in_loop or isinstance(statement, (ast.For, ast.AsyncFor, ast.While))
            for child in ast.iter_child_nodes(statement):
                if isinstance(child, ast.stmt):
                    stack.append((child, loop))
                elif isinstance(child, ast.ExceptHandler):
                    stack.extend((s, loop) for s in child.body)

    def _catch_all(self, node, scope) -> bool:
        value = self.resolver.infer(node, scope)
        return isinstance(value, ExtVal) and value.name in CATCH_ALL

    def _commented(self, handler) -> bool:
        first, last = handler.lineno - 1, (handler.end_lineno or handler.lineno)
        return any("#" in line for line in self.lines[first:last])

    def _handled(self, handler) -> bool:
        for node in ast.walk(ast.Module(body=handler.body, type_ignores=[])):
            if isinstance(node, ast.Raise):
                return True
            if handler.name and isinstance(node, ast.Name) and node.id == handler.name:
                return True
            if isinstance(node, ast.Call) and LOGGING.search(decorator_name(node)):
                return True
            if isinstance(node, (ast.Return, ast.Assign, ast.AugAssign, ast.AnnAssign)):
                return True  # a fallback value: the code chose what failure means
        return False

    # ---------------------------------------------------------------- module level

    def unused_imports(self, tree) -> None:
        if self.module.is_package:
            return  # an __init__.py imports to re-export
        used: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Name):
                used.add(node.id)
            elif isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value and len(node.value) < 200:
                parsed = self.resolver.parse_annotation(node.value) if _looks_like_annotation(node.value) else None
                if parsed is not None:
                    used.update(n.id for n in ast.walk(parsed) if isinstance(n, ast.Name))
        exported = set(self.table.all_names or [])
        for statement, optional in _module_imports(tree.body):
            if optional:
                continue
            for alias in statement.names:
                if alias.name == "*" or (isinstance(statement, ast.ImportFrom) and statement.module == "__future__"):
                    continue
                bound = alias.asname or alias.name.split(".")[0]
                if alias.asname and alias.asname == alias.name.split(".")[-1] and isinstance(statement, ast.ImportFrom):
                    continue  # from x import y as y: an explicit re-export
                if bound in used or bound in exported:
                    continue
                self.report(statement, "unused-import", "info", "dead-code", f"'{bound}' is imported but never used.")

    # ---------------------------------------------------------------- what values are

    def _coroutine(self, func: FuncDecl) -> bool:
        node = func.node
        if not isinstance(node, ast.AsyncFunctionDef):
            return False
        from .resolve import _local_nodes

        return not any(isinstance(n, (ast.Yield, ast.YieldFrom)) for n in _local_nodes(node))  # an async generator is iterated

    def _exception_class(self, value) -> bool:
        if isinstance(value, ClassVal):
            return self.resolver.is_exception(value.cls)
        if isinstance(value, ExtVal) and value.name.startswith("builtins."):
            short = value.name[len("builtins."):]
            return short in BUILTINS and (short.endswith(("Error", "Exception")) or short in ("BaseException", "StopIteration", "KeyboardInterrupt", "SystemExit"))
        return False


def collect_diagnostics(ctx, module) -> list[dict]:
    if module.tree is None or module.is_test or module.generated:
        return []
    return Checker(ctx, module).run()


# ---------------------------------------------------------------------------------------------- helpers


def _same(a, b) -> bool:
    if isinstance(a, ast.Name) and isinstance(b, ast.Name):
        return a.id == b.id
    if isinstance(a, ast.Attribute) and isinstance(b, ast.Attribute):
        return a.attr == b.attr and _same(a.value, b.value)
    if isinstance(a, ast.Subscript) and isinstance(b, ast.Subscript):
        return ast.dump(a.slice) == ast.dump(b.slice) and _same(a.value, b.value)
    return False


def _has_call(node) -> bool:
    return any(isinstance(n, ast.Call) for n in ast.walk(node))


def _is_none(node) -> bool:
    return isinstance(node, ast.Constant) and node.value is None


def _is_literal(node) -> bool:
    return isinstance(node, ast.Constant) and not isinstance(node.value, bool) and node.value is not None and node.value is not Ellipsis


def _empty(body: list) -> bool:
    return all(isinstance(s, ast.Pass) or (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant)) for s in body)


def _own_nodes(function):
    """A function's nodes, not those of nested functions and classes (their names are their own)."""
    stack = list(function.body)
    while stack:
        node = stack.pop()
        yield node
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            continue
        stack.extend(ast.iter_child_nodes(node))


def _module_imports(body: list, optional: bool = False):
    """Module-level imports, with whether they are optional (inside try: … except ImportError, or under an if)."""
    for statement in body:
        if isinstance(statement, (ast.Import, ast.ImportFrom)):
            yield statement, optional
        elif isinstance(statement, ast.Try):
            yield from _module_imports(statement.body, True)
            for handler in statement.handlers:
                yield from _module_imports(handler.body, True)
        elif isinstance(statement, ast.If):
            yield from _module_imports(statement.body, True)
            yield from _module_imports(statement.orelse, True)


def _looks_like_annotation(text: str) -> bool:
    return bool(re.match(r"^[A-Za-z_][\w.\[\], |'\"]*$", text))


__all__ = ["collect_diagnostics"]
