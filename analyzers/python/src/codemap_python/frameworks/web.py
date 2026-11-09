"""FastAPI and Flask: routes on apps, routers and blueprints, with the prefixes they are included or registered at.

- FastAPI: `@app.get("/x")` on a FastAPI app or an APIRouter (any verb, api_route, websocket), add_api_route,
  `APIRouter(prefix=…)` and `include_router(router, prefix=…)`;
- Flask: `@app.route("/x", methods=[…])` and the verb shortcuts on an app or a Blueprint, add_url_rule (also with a
  MethodView's as_view), `Blueprint(url_prefix=…)` and `register_blueprint(bp, url_prefix=…)`, and the hooks Flask
  calls (before_request, errorhandler, context_processor, cli commands…);
- the module that creates the app (FastAPI(), Flask(), also in a create_app factory) and uvicorn.run are entry points.
"""
from __future__ import annotations

import ast

from ..resolve import ClassVal, FuncVal, VarVal
from ..symbols import ClassDecl, FuncDecl
from . import Part
from .common import argument, external_name, join_path, keyword, string_of, strings_of, tag

FASTAPI_VERBS = {"get", "post", "put", "patch", "delete", "options", "head", "trace"}
FLASK_VERBS = {"get", "post", "put", "patch", "delete"}
HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"]
FLASK_HOOKS = {
    "before_request", "after_request", "teardown_request", "teardown_appcontext", "before_app_request", "after_app_request",
    "teardown_app_request", "errorhandler", "app_errorhandler", "register_error_handler", "context_processor",
    "app_context_processor", "shell_context_processor", "template_filter", "app_template_filter", "template_global",
    "app_template_global", "template_test", "url_value_preprocessor", "url_defaults", "before_first_request",
    "user_loader", "request_loader", "unauthorized_handler",
}
APPS = {"fastapi.FastAPI", "fastapi.applications.FastAPI", "flask.Flask", "flask.app.Flask", "quart.Quart", "starlette.applications.Starlette"}


def _fastapi(name: str) -> tuple[str, str] | None:
    """('router class', 'method') of a FastAPI app's or router's method: fastapi.routing.APIRouter.get → (APIRouter, get)."""
    parts = name.split(".")
    if len(parts) >= 3 and parts[0] == "fastapi" and parts[-2] in ("FastAPI", "APIRouter"):
        return parts[-2], parts[-1]
    return None


def _flask(name: str) -> tuple[str, str] | None:
    parts = name.split(".")
    if len(parts) >= 3 and parts[0] in ("flask", "quart") and parts[-2] in ("Flask", "Blueprint", "Quart"):
        return parts[-2], parts[-1]
    return None


class Web(Part):
    def __init__(self, frameworks) -> None:
        super().__init__(frameworks)
        self.routers: dict[str, object] = {}  # router key (its variable's id) → the variable
        self.mounts: dict[str, list[tuple[str | None, str, bool]]] = {}  # child → (parent, prefix, replaces the child's own)
        self.endpoints: list[tuple[str, str | None, object, object]] = []  # FastAPI routes: (handler id, router, decorator, scope)

    # ---------------------------------------------------------------- decorators

    def declare(self, module, owners: list) -> None:
        for decl in owners:
            if isinstance(decl, FuncDecl):
                self._function(module, decl)
            elif isinstance(decl, ClassDecl) and self._is_method_view(decl):
                tag(self.node(decl.id), "controller")

    def _function(self, module, decl: FuncDecl) -> None:
        scope = self.resolver.definition_scope(decl)
        for decorator in decl.decorators:
            if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
                if isinstance(decorator, ast.Attribute):
                    self._hook(decl, external_name(self.resolver, decorator, scope))
                continue
            name = external_name(self.resolver, decorator.func, scope)
            if not name:
                continue
            fastapi = _fastapi(name)
            flask = _flask(name)
            if fastapi and (fastapi[1] in FASTAPI_VERBS or fastapi[1] in ("api_route", "websocket")):
                path = string_of(argument(decorator, 0, "path"))
                if path is None:
                    continue
                verb = fastapi[1]
                methods = ["WS"] if verb == "websocket" else [m.upper() for m in strings_of(keyword(decorator, "methods"))] or ["GET"] if verb == "api_route" else [verb.upper()]
                router = self._router(decorator.func.value, scope)
                self.frameworks.add_route(decl.id, methods, path, router, "fastapi")
                self.endpoints.append((decl.id, router, decorator, scope))
            elif flask and (flask[1] == "route" or flask[1] in FLASK_VERBS):
                path = string_of(argument(decorator, 0, "rule"))
                if path is None:
                    continue
                methods = [m.upper() for m in strings_of(keyword(decorator, "methods"))] or ["GET"] if flask[1] == "route" else [flask[1].upper()]
                self.frameworks.add_route(decl.id, methods, path, self._router(decorator.func.value, scope), "flask")
            else:
                self._hook(decl, name)

    def _hook(self, decl: FuncDecl, name: str) -> None:
        """Functions Flask (or Flask-Login) calls itself: request hooks, error handlers, template helpers, commands."""
        if not name:
            return
        parts = name.split(".")
        if parts[0] in ("flask", "quart", "flask_login") and (parts[-1] in FLASK_HOOKS or parts[-2:] == ["cli", "command"]):
            tag(self.node(decl.id), "entrypoint")

    def _router(self, node, scope) -> str | None:
        """The app or router a route is declared on, as a key routes and includes share: its variable's id."""
        value = self.resolver.infer(node, scope)
        if isinstance(value, VarVal):
            self.routers.setdefault(value.var.id, value.var)
            return value.var.id
        return None

    def _is_method_view(self, decl: ClassDecl) -> bool:
        return any(n.startswith(("flask.views.", "quart.views.")) for n in self.resolver.external_bases(decl))

    # ---------------------------------------------------------------- calls

    def on_call(self, walker, node, name: str, scope) -> None:
        if name in APPS:
            self._app_created(walker, scope)
            return
        if name in ("uvicorn.run", "hypercorn.run", "waitress.serve"):
            self._app_created(walker, scope)
            return
        fastapi = _fastapi(name)
        flask = _flask(name)
        method = (fastapi or flask or ("", ""))[1]
        if not isinstance(node.func, ast.Attribute) or not method:
            return
        if fastapi and method == "include_router":
            child = self._router(argument(node, 0, "router"), scope)
            if child is not None:
                prefix = string_of(keyword(node, "prefix")) or ""
                self.mounts.setdefault(child, []).append((self._router(node.func.value, scope), prefix, False))
                self.frameworks.di.router_dependencies(child, keyword(node, "dependencies"), scope)
        elif flask and method == "register_blueprint":
            child = self._router(argument(node, 0, "blueprint"), scope)
            if child is not None:
                prefix = string_of(keyword(node, "url_prefix"))
                self.mounts.setdefault(child, []).append((self._router(node.func.value, scope), prefix or "", prefix is not None))
        elif fastapi and method == "add_api_route":
            path = string_of(argument(node, 0, "path"))
            target = self.resolver.infer(argument(node, 1, "endpoint"), scope) if argument(node, 1, "endpoint") is not None else None
            if path is not None and isinstance(target, FuncVal):
                methods = [m.upper() for m in strings_of(keyword(node, "methods"))] or ["GET"]
                router = self._router(node.func.value, scope)
                self.frameworks.add_route(target.func.id, methods, path, router, "fastapi")
                self.endpoints.append((target.func.id, router, node, scope))
        elif flask and method == "add_url_rule":
            self._url_rule(node, scope)

    def _url_rule(self, node: ast.Call, scope) -> None:
        """add_url_rule("/x", "name", view) or add_url_rule("/x", view_func=View.as_view("name"))."""
        path = string_of(argument(node, 0, "rule"))
        view = argument(node, 2, "view_func")
        if path is None or view is None:
            return
        router = self._router(node.func.value, scope)
        methods = [m.upper() for m in strings_of(keyword(node, "methods"))]
        if isinstance(view, ast.Call) and isinstance(view.func, ast.Attribute) and view.func.attr == "as_view":
            target = self.resolver.infer(view.func.value, scope)
            if isinstance(target, ClassVal):
                self.class_routes(target.cls, path, router, "flask")
            return
        target = self.resolver.infer(view, scope)
        if isinstance(target, FuncVal):
            self.frameworks.add_route(target.func.id, methods or ["GET"], path, router, "flask")

    def class_routes(self, cls: ClassDecl, path: str, router: str | None, framework: str) -> None:
        """A class-based view: each HTTP method it defines (or inherits from a class of the analysis) is a route."""
        tag(self.node(cls.id), "controller")
        for name in HTTP_METHODS:
            member = self.resolver.member(cls, name)
            if isinstance(member, FuncDecl):
                self.frameworks.add_route(member.id, [name.upper()], path, router, framework)

    def _app_created(self, walker, scope) -> None:
        """The module that creates the application (and the factory that does) is where a server starts it."""
        tag(self.node(scope.module.id), "entrypoint")
        source = self.node(walker.source)
        if source is not None and source.get("kind") in ("function", "method") and "(top-level)" not in walker.source:
            tag(source, "entrypoint")

    # ---------------------------------------------------------------- prefixes

    def own_prefix(self, key: str) -> str:
        var = self.routers.get(key)
        if var is None or not var.values:
            return ""
        value = var.values[0][0]
        if isinstance(value, ast.Call):
            return string_of(keyword(value, "prefix")) or string_of(keyword(value, "url_prefix")) or ""
        return ""

    def prefix_of(self, key: str | None, seen: frozenset = frozenset()) -> str:
        """The path a router's routes start with: where it is included (the first place, as Express' are), and its own prefix."""
        if key is None or key in seen:
            return ""
        own = self.own_prefix(key)
        mounts = self.mounts.get(key)
        if not mounts:
            return own
        parent, prefix, replaces = mounts[0]
        base = self.prefix_of(parent, seen | {key})
        return join_path(base, prefix) if replaces else join_path(base, prefix, own)
