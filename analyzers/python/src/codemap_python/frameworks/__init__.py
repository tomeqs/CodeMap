"""What frameworks add to the map, recognised by what the code imports and calls, not by names alone.

- roles: controllers, entities, DTOs, options, handlers, tests, middleware (the tags C# and TypeScript use);
- entry points where the framework calls in: HTTP routes (FastAPI, Flask, Django and Django REST framework, with
  their full paths), tasks (Celery, Dramatiq, RQ), commands (click, typer, Django), signal receivers, hooks;
- FastAPI's dependency injection (Depends), as the registrations and dependencies CodeMap's DI analysis reads;
- edges the code only spells as strings: ORM relations, pytest fixtures, Django settings and URL includes.

Each framework is a part with three steps: `declare` after a module's nodes exist, `on_call` for every call of
something outside the analysis (the reference pass resolves them anyway), and `finish` once every module is read.
"""
from __future__ import annotations

from .common import join_path, tag


class Route:
    __slots__ = ("node_id", "methods", "path", "router", "framework")

    def __init__(self, node_id: str, methods: list[str], path: str, router: str | None, framework: str) -> None:
        self.node_id = node_id
        self.methods = methods
        self.path = path
        self.router = router  # the app or router variable it is declared on (its prefix comes later), or None
        self.framework = framework


class Part:
    def __init__(self, frameworks: Frameworks) -> None:
        self.frameworks = frameworks
        self.ctx = frameworks.ctx
        self.resolver = frameworks.ctx.resolver
        self.graph = frameworks.ctx.graph

    def declare(self, module, owners: list) -> None:
        pass

    def on_call(self, walker, node, name: str, scope) -> None:
        pass

    def finish(self) -> None:
        pass

    def node(self, node_id: str | None) -> dict | None:
        return self.graph.nodes.get(node_id) if node_id else None


class Frameworks:
    def __init__(self, ctx) -> None:
        from .django import Django
        from .fastapi_di import FastApiDi
        from .jobs import Jobs
        from .roles import Roles
        from .testing import Testing
        from .web import Web

        self.ctx = ctx
        self.routes: list[Route] = []
        self.web = Web(self)
        self.di = FastApiDi(self)
        # Roles last: names give a role only to classes no framework gave one.
        self.parts = [self.web, self.di, Django(self), Jobs(self), Testing(self), Roles(self)]

    def declare(self, module, owners: list) -> None:
        for part in self.parts:
            part.declare(module, owners)

    def on_call(self, walker, node, name: str, scope) -> None:
        for part in self.parts:
            part.on_call(walker, node, name, scope)

    def add_route(self, node_id: str, methods: list[str], path: str, router: str | None, framework: str) -> None:
        node = self.ctx.graph.nodes.get(node_id)
        if node is None:
            return
        tag(node, "route", "entrypoint")
        self.routes.append(Route(node_id, methods, path, router, framework))

    def finish(self) -> dict | None:
        for part in self.parts:
            part.finish()
        self._route_docs()
        self._module_roles()
        return self.di.result()

    def _module_roles(self) -> None:
        """A module of handlers (tasks, signal receivers) or of entry points (commands) has that role too, so that call
        flows start there and nothing calls it unused."""
        graph = self.ctx.graph
        roles: dict[str, set[str]] = {}
        for node_id, node in graph.nodes.items():
            if "#" in node_id and node.get("tags"):
                roles.setdefault(node_id.split("#", 1)[0], set()).update(node["tags"])
        for module_id, member_tags in roles.items():
            module = graph.nodes.get(module_id)
            if module is None or module.get("kind") != "module" or "test" in member_tags:
                continue
            if "handler" in member_tags:
                tag(module, "handler")
            elif "entrypoint" in member_tags and "controller" not in module.get("tags", []):
                tag(module, "entrypoint")

    def _route_docs(self) -> None:
        """The route comes first in the handler's doc, its docstring after it; the module is a controller."""
        graph = self.ctx.graph
        texts: dict[str, list[str]] = {}
        for route in self.routes:
            path = join_path(self.web.prefix_of(route.router), route.path) if route.router else route.path
            text = f"{', '.join(route.methods)} {path}".strip()
            if text not in texts.setdefault(route.node_id, []):
                texts[route.node_id].append(text)
        for node_id, routes in texts.items():
            node = graph.nodes[node_id]
            doc = node.get("doc")
            node["doc"] = "; ".join(routes) + (f" · {doc}" if doc else "")
            tag(graph.nodes.get(node_id.split("#", 1)[0]), "controller")
