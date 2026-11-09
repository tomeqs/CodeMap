"""Django and Django REST framework.

- Models are entities; ForeignKey, OneToOneField and ManyToManyField (to a class, "Model", "app.Model" or "self")
  make the field hold the model they point at.
- Views: class-based views and DRF API views and viewsets are controllers, their HTTP methods (and a viewset's
  actions) routes. urls.py: path() and re_path() route to views, include() nests other URLconfs (by module name, as
  a module, or a DRF router's urls), and the routes get their full paths. Function views a URL routes to are routes.
- What Django loads itself, by name or by setting, is an entry point: admin.py, apps.py, URLconfs, management
  commands, template tags, wsgi.py / asgi.py, signal receivers, AppConfig.ready. Settings modules are config (the
  dotted paths they name, MIDDLEWARE, INSTALLED_APPS, ROOT_URLCONF…, are Roles' part, as in every config module).
- Serializers and forms are DTOs, ModelAdmins config, middleware named in MIDDLEWARE middleware.
"""
from __future__ import annotations

import ast
import os

from ..resolve import ClassVal, FuncVal, ModuleVal, PackageStub, VarVal
from ..symbols import ClassDecl, FuncDecl, VarDecl, decorator_name, symbols_of
from . import Part
from .common import argument, external_name, join_path, keyword, short, string_of, strings_of, tag

RELATIONS = {"ForeignKey", "OneToOneField", "ManyToManyField", "ForeignObject", "ParentalKey", "ParentalManyToManyField"}
VIEWSET_ACTIONS = {
    "list": ("GET", False), "create": ("POST", False), "retrieve": ("GET", True), "update": ("PUT", True),
    "partial_update": ("PATCH", True), "destroy": ("DELETE", True),
}
HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"]


class Django(Part):
    def __init__(self, frameworks) -> None:
        super().__init__(frameworks)
        self.projects: dict[int, bool] = {}
        self.urls: dict[str, list] = {}  # URLconf module id → [(route, target, scope)]
        self.url_modules: dict[str, object] = {}
        self.routers: dict[str, list] = {}  # DRF router variable id → [(prefix, viewset class)]
        self.models: list[ClassDecl] = []
        self.relations: list[tuple] = []  # (field, target expression, scope)

    def uses_django(self, project) -> bool:
        key = id(project)
        if key not in self.projects:
            self.projects[key] = any(m.path == "manage.py" or m.path.endswith("/manage.py") for m in project.modules) or any(
                (b.module or "").split(".")[0] in ("django", "rest_framework")
                for m in project.modules if m.analyzed and m.tree is not None for b in symbols_of(m).imports
            )
        return self.projects[key]

    # ---------------------------------------------------------------- declarations

    def declare(self, module, owners: list) -> None:
        if not self.uses_django(module.project):
            return
        base = os.path.basename(module.file)
        module_node = self.node(module.id)
        if base in ("admin.py", "apps.py", "urls.py", "wsgi.py", "asgi.py") or "/management/commands/" in f"/{module.path}" or "/templatetags/" in f"/{module.path}":
            if base != "__init__.py":
                tag(module_node, "entrypoint")
        if base == "settings.py" or "/settings/" in f"/{module.path}" or base.startswith("settings_"):
            tag(module_node, "config")  # what its settings name by dotted path: Roles, for every config module
        for decl in owners:
            if isinstance(decl, ClassDecl):
                self._class(module, decl)
            elif isinstance(decl, FuncDecl):
                self._function(decl)
            elif isinstance(decl, VarDecl) and decl.owner is not None and decl.values:
                value = decl.values[0][0]
                if isinstance(value, ast.Call) and short(external_name(self.resolver, value.func, self.resolver.definition_scope(decl))) in RELATIONS:
                    self.relations.append((decl, argument(value, 0, "to"), self.resolver.definition_scope(decl)))

    def _class(self, module, decl: ClassDecl) -> None:
        bases = self.resolver.external_bases(decl)
        node = self.node(decl.id)
        if self.resolver.is_django_model(decl):
            tag(node, "entity")
            self.models.append(decl)
        if any(_is_view(n) for n in bases):
            tag(node, "controller")
        if any(n.startswith(("rest_framework.serializers", "django.forms")) for n in bases):
            tag(node, "dto")
        if any(n.startswith("django.contrib.admin") for n in bases):
            tag(node, "config")
        if any(n.startswith("django.core.management") and short(n) == "BaseCommand" for n in bases):
            tag(node, "entrypoint")
            tag(self.node(f"{decl.id}.handle"), "entrypoint")
        if any(short(n) == "AppConfig" and n.startswith("django.apps") for n in bases):
            tag(node, "config")
            tag(self.node(f"{decl.id}.ready"), "entrypoint")

    def _function(self, decl: FuncDecl) -> None:
        scope = self.resolver.definition_scope(decl)
        for decorator in decl.decorators:
            target = decorator.func if isinstance(decorator, ast.Call) else decorator
            name = external_name(self.resolver, target, scope)
            if name in ("django.dispatch.receiver", "django.dispatch.dispatcher.receiver") and isinstance(decorator, ast.Call):
                tag(self.node(decl.id), "handler", "entrypoint")
                for sender in _items(keyword(decorator, "sender")):
                    self._subscribes(decl.id, sender, scope)
            elif name.startswith("django.template.Library.") or name.startswith("django.template.library.Library."):
                tag(self.node(decl.id), "entrypoint")  # @register.filter, @register.simple_tag

    def _subscribes(self, source: str, sender, scope) -> None:
        value = self.resolver.infer(sender, scope)
        if isinstance(value, ClassVal):
            self.graph.add_edge(source, value.cls.id, "subscribes")

    # ---------------------------------------------------------------- calls: URLconfs, routers, signals

    def on_call(self, walker, node, name: str, scope) -> None:
        if not name.startswith(("django.", "rest_framework.")):
            return
        last = short(name)
        if name in ("django.urls.path", "django.urls.re_path", "django.urls.conf.path", "django.urls.conf.re_path", "django.conf.urls.url"):
            route = string_of(argument(node, 0, "route"))
            view = argument(node, 1, "view")
            if route is not None and view is not None:
                if "re_path" in name or name.endswith(".url"):
                    route = route.lstrip("^").rstrip("$")
                self.urls.setdefault(scope.module.id, []).append((route, view, scope))
                self.url_modules[scope.module.id] = scope.module
        elif name.startswith("rest_framework.routers.") and last == "register" and isinstance(node.func, ast.Attribute):
            router = self.resolver.infer(node.func.value, scope)
            prefix = string_of(argument(node, 0, "prefix"))
            viewset = self.resolver.infer(argument(node, 1, "viewset"), scope) if argument(node, 1, "viewset") is not None else None
            if isinstance(router, VarVal) and prefix is not None and isinstance(viewset, ClassVal):
                self.routers.setdefault(router.var.id, []).append((prefix, viewset.cls))
                tag(self.node(viewset.cls.id), "controller")
        elif last == "connect" and ".signals." in name:
            handler = self.resolver.infer(argument(node, 0, "receiver"), scope) if argument(node, 0, "receiver") is not None else None
            if isinstance(handler, FuncVal):
                tag(self.node(handler.func.id), "handler", "entrypoint")
                for sender in _items(keyword(node, "sender")):
                    self._subscribes(handler.func.id, sender, scope)

    # ---------------------------------------------------------------- after every module

    def finish(self) -> None:
        self._relations()
        self._routes()

    def _relations(self) -> None:
        by_name: dict[str, list[ClassDecl]] = {}
        for model in self.models:
            by_name.setdefault(model.name, []).append(model)
        for field, target, scope in self.relations:
            if target is None:
                continue
            text = string_of(target)
            if text is None:
                value = self.resolver.infer(target, scope)
                model = value.cls if isinstance(value, ClassVal) else None
            elif text == "self":
                model = field.owner
            else:
                label, _, model_name = text.rpartition(".")
                candidates = by_name.get(model_name, [])
                same = [m for m in candidates if m.module is field.module] or [m for m in candidates if label and label in m.module.name.split(".")]
                model = (same or candidates or [None])[0]
            if model is not None and model.id != field.id:
                self.graph.add_edge(field.id, model.id, "holds")

    def _routes(self) -> None:
        """URLconfs from the roots (those nothing includes) down, so every route has its full path."""
        includes: dict[str, list[tuple[str, object]]] = {}  # URLconf → [(route, included URLconf id or router)]
        views: dict[str, list[tuple[str, object, object]]] = {}
        for module_id, entries in self.urls.items():
            for route, view, scope in entries:
                if isinstance(view, ast.Call) and short(external_name(self.resolver, view.func, scope)) == "include":
                    target = self._included(argument(view, 0, "arg"), scope)
                    if target is not None:
                        includes.setdefault(module_id, []).append((route, target))
                else:
                    views.setdefault(module_id, []).append((route, view, scope))
        included = {t for entries in includes.values() for _, t in entries}
        prefixes: dict[str, str] = {}
        pending = [(m, "") for m in self.urls if m not in included] + [(r, "") for r in self.routers if r not in included]
        while pending:
            key, prefix = pending.pop()
            if key in prefixes:
                continue
            prefixes[key] = prefix
            for route, target in includes.get(key, []):
                pending.append((target, join_path(prefix, route)))
        for module_id, entries in views.items():
            for route, view, scope in entries:
                self._view(join_path(prefixes.get(module_id, ""), route), view, scope)
        for router, entries in self.routers.items():
            for prefix, viewset in entries:
                self._viewset(join_path(prefixes.get(router, ""), prefix), viewset)

    def _included(self, node, scope) -> str | None:
        if node is None:
            return None
        text = string_of(node)
        if text is not None:
            found = self.resolver.find_module(text, scope.module)
            return found.id if found is not None and not isinstance(found, PackageStub) else None
        if isinstance(node, ast.Tuple) and node.elts:
            return self._included(node.elts[0], scope)
        if isinstance(node, ast.Attribute) and node.attr == "urls":
            router = self.resolver.infer(node.value, scope)
            return router.var.id if isinstance(router, VarVal) else None
        value = self.resolver.infer(node, scope)
        if isinstance(value, ModuleVal) and not isinstance(value.module, PackageStub):
            return value.module.id
        return None

    def _view(self, path: str, view, scope) -> None:
        if isinstance(view, ast.Call) and isinstance(view.func, ast.Attribute) and view.func.attr == "as_view":
            target = self.resolver.infer(view.func.value, scope)
            if isinstance(target, ClassVal):
                actions = view.args[0] if view.args and isinstance(view.args[0], ast.Dict) else None
                if actions is not None:  # ViewSet.as_view({"get": "list"})
                    tag(self.node(target.cls.id), "controller")
                    for method, action in zip(actions.keys, actions.values):
                        member = self.resolver.member(target.cls, string_of(action) or "")
                        if isinstance(member, FuncDecl) and string_of(method):
                            self.frameworks.add_route(member.id, [string_of(method).upper()], path, None, "django")
                else:
                    self._class_view(path, target.cls)
            return
        value = self.resolver.infer(view, scope)
        if isinstance(value, FuncVal):
            methods = _api_view_methods(value.func)
            self.frameworks.add_route(value.func.id, methods, path, None, "django")

    def _class_view(self, path: str, cls: ClassDecl) -> None:
        tag(self.node(cls.id), "controller")
        found = False
        for name in HTTP_METHODS:
            member = self.resolver.member(cls, name)
            if isinstance(member, FuncDecl):
                self.frameworks.add_route(member.id, [name.upper()], path, None, "django")
                found = True
        if not found:  # a generic view that only configures (ListView with a model): the class is the route
            self.frameworks.add_route(cls.id, [], path, None, "django")

    def _viewset(self, path: str, cls: ClassDecl) -> None:
        tag(self.node(cls.id), "controller")
        detail = join_path(path, "{pk}") + "/"
        collection = path if path.endswith("/") else path + "/"
        for name, (method, on_detail) in VIEWSET_ACTIONS.items():
            member = self.resolver.member(cls, name)
            if isinstance(member, FuncDecl):
                self.frameworks.add_route(member.id, [method], detail if on_detail else collection, None, "django")
        for member in cls.members.values():
            if not isinstance(member, FuncDecl):
                continue
            action = next((d for d in member.decorators if isinstance(d, ast.Call) and decorator_name(d).rsplit(".", 1)[-1] == "action"), None)
            if action is None:
                continue
            on_detail = isinstance(keyword(action, "detail"), ast.Constant) and keyword(action, "detail").value is True
            url_path = string_of(keyword(action, "url_path")) or member.name
            methods = [m.upper() for m in strings_of(keyword(action, "methods"))] or ["GET"]
            self.frameworks.add_route(member.id, methods, join_path(detail if on_detail else collection, url_path) + "/", None, "django")


def _is_view(name: str) -> bool:
    if name.startswith(("django.views", "django.contrib.auth.views")):
        return True
    return name.startswith("rest_framework.") and (short(name).endswith(("View", "ViewSet", "APIView")) or ".generics." in name)


def _api_view_methods(func: FuncDecl) -> list[str]:
    """@api_view(["GET", "POST"]) of a DRF function view."""
    for decorator in func.decorators:
        if isinstance(decorator, ast.Call) and decorator_name(decorator).rsplit(".", 1)[-1] == "api_view":
            return [m.upper() for m in strings_of(argument(decorator, 0, "http_method_names"))] or ["GET"]
    return []


def _items(node) -> list:
    if node is None:
        return []
    return list(node.elts) if isinstance(node, (ast.List, ast.Tuple)) else [node]


def _strings_in(node) -> list[str]:
    out = []
    for child in ast.walk(node):
        text = string_of(child) if isinstance(child, ast.Constant) else None
        if text:
            out.append(text)
    return out
