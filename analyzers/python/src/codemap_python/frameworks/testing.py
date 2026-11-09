"""Tests: unittest (and Django's, DRF's…) TestCase classes wherever they are, and pytest fixtures.

pytest gives a test the fixtures its parameters name: one of the test's module, else of the nearest conftest.py up
the folders. Those become calls from the test (and from fixtures that use other fixtures), also for
`@pytest.mark.usefixtures("name")`; parameters that `@pytest.mark.parametrize` fills are no fixtures.
"""
from __future__ import annotations

import ast
import os

from ..symbols import ClassDecl, FuncDecl, decorator_name
from . import Part
from .common import argument, external_name, keyword, short, string_of, strings_of, tag

FIXTURES = {"pytest.fixture", "pytest_asyncio.fixture", "_pytest.fixtures.fixture"}


class Testing(Part):
    def __init__(self, frameworks) -> None:
        super().__init__(frameworks)
        self.fixtures: dict[str, dict[str, FuncDecl]] = {}  # folder → fixture name → its function (module and conftest.py)
        self.module_fixtures: dict[str, dict[str, FuncDecl]] = {}  # module id → its own fixtures
        self.requests: list[tuple[FuncDecl, object]] = []  # tests and fixtures, with their module

    def declare(self, module, owners: list) -> None:
        for decl in owners:
            if isinstance(decl, ClassDecl) and any(short(n).endswith("TestCase") for n in self.resolver.external_bases(decl)):
                self._test_class(decl)
            elif isinstance(decl, FuncDecl):
                scope = self.resolver.definition_scope(decl)
                fixture = next((d for d in decl.decorators if external_name(self.resolver, d.func if isinstance(d, ast.Call) else d, scope) in FIXTURES), None)
                if fixture is not None:
                    name = string_of(keyword(fixture, "name")) if isinstance(fixture, ast.Call) else None
                    self.module_fixtures.setdefault(module.id, {})[name or decl.name] = decl
                    if os.path.basename(module.file) == "conftest.py":
                        self.fixtures.setdefault(os.path.dirname(module.file), {})[name or decl.name] = decl
                    self.requests.append((decl, module))
                elif module.is_test and (decl.name.startswith("test") or (decl.owner is not None and "test" in (self.node(decl.owner.id) or {}).get("tags", []))):
                    self.requests.append((decl, module))

    def _test_class(self, decl: ClassDecl) -> None:
        tag(self.node(decl.id), "test")
        for member in decl.members.values():
            tag(self.node(member.id), "test")
            if isinstance(member, ClassDecl):
                self._test_class(member)

    def finish(self) -> None:
        for decl, module in self.requests:
            names = self._requested(decl)
            for name in names:
                fixture = self._fixture(name, module, decl)
                if fixture is not None and fixture is not decl:
                    self.graph.add_edge(decl.id, fixture.id, "calls", decl.node.lineno)

    def _requested(self, decl: FuncDecl) -> list[str]:
        args = decl.node.args
        params = [a.arg for a in list(getattr(args, "posonlyargs", [])) + list(args.args) + list(args.kwonlyargs)]
        if decl.owner is not None and params:
            params = params[1:]  # self
        filled: set[str] = set()
        for decorator in decl.decorators:
            if not isinstance(decorator, ast.Call):
                continue
            name = decorator_name(decorator)
            if name.endswith("parametrize"):
                first = argument(decorator, 0, "argnames")
                for text in strings_of(first):
                    filled.update(part.strip() for part in text.split(","))
            elif name.endswith("usefixtures"):
                params.extend(s for a in decorator.args for s in strings_of(a))
        return [p for p in params if p not in filled and p not in ("request",)]

    def _fixture(self, name: str, module, decl: FuncDecl) -> FuncDecl | None:
        if decl.owner is not None:
            own = decl.owner.members.get(name)
            if isinstance(own, FuncDecl) and own is not decl:
                return own
        found = self.module_fixtures.get(module.id, {}).get(name)
        if found is not None:
            return found
        folder = os.path.dirname(module.file)
        top = module.project.dir
        while True:
            found = self.fixtures.get(folder, {}).get(name)
            if found is not None:
                return found
            parent = os.path.dirname(folder)
            if parent == folder or not (folder + os.sep).startswith(top.rstrip(os.sep) + os.sep) or folder == top:
                return None
            folder = parent
