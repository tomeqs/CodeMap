"""FastAPI's dependency injection, as the registrations and dependencies of CodeMap's DI analysis (framework fastapi).

- What asks: endpoints and dependencies themselves, by their parameters: `x = Depends(provider)`, `Security(…)`,
  `Annotated[T, Depends(provider)]` (also through an alias, `SessionDep = Annotated[Session, Depends(get_db)]`), and
  `Depends()` for the annotated class; the `dependencies=[…]` of a route, a router or include_router.
- What is provided: each provider that is asked for. FastAPI calls it once per request and shares the result within
  the request (scoped), every time with use_cache=False (transient); an @lru_cache provider and a module-level object
  live as long as the application (singleton). Functions are factories, classes are built (type), objects are
  instances. Endpoints are registered as what the app routes to (controller), per request.
"""
from __future__ import annotations

import ast

from ..resolve import ClassVal, ExtVal, FuncVal, InstanceVal, VarVal
from ..symbols import FuncDecl, decorator_name
from . import Part
from .common import argument, external_name, is_false, keyword, location, short

DEPENDS = {"fastapi.Depends", "fastapi.Security", "fastapi.params.Depends", "fastapi.params.Security", "fastapi.param_functions.Depends", "fastapi.param_functions.Security"}
CACHED = {"lru_cache", "cache", "functools.lru_cache", "functools.cache"}


class FastApiDi(Part):
    def __init__(self, frameworks) -> None:
        super().__init__(frameworks)
        self.providers: dict[str, dict] = {}  # service → its registration
        self.uses: dict[str, list[bool]] = {}  # service → use_cache of each Depends asking for it
        self.dependencies: list[dict] = []
        self.asked: set[tuple] = set()  # (consumer, service, external) of every dependency
        self.consumers: set[str] = set()
        self.by_router: dict[str, list[dict]] = {}  # router key → providers its dependencies=[…] ask for

    # ---------------------------------------------------------------- parameters

    def declare(self, module, owners: list) -> None:
        for decl in owners:
            if not isinstance(decl, FuncDecl):
                continue
            consumer = decl.owner.id if decl.flavor == "constructor" and decl.owner is not None else decl.id
            scope = self.resolver.definition_scope(decl)
            for definition in decl.defs:
                args = definition.args
                positional = list(getattr(args, "posonlyargs", [])) + list(args.args)
                defaults = [None] * (len(positional) - len(args.defaults)) + list(args.defaults)
                pairs = list(zip(positional, defaults)) + list(zip(args.kwonlyargs, args.kw_defaults))
                for arg, default in pairs:
                    provided = self.depends(module, arg.annotation, default, scope)
                    if provided is not None:
                        self._depend(consumer, provided)

    def depends(self, module, annotation, default, scope) -> dict | None:
        """The provider a parameter asks for, with where it asks; None when the parameter is no dependency."""
        call = self._depends_call(default, scope)
        declared_type = annotation
        if call is None:
            annotated = self._annotated(annotation, scope)
            if annotated is None:
                return None
            declared_type, call, scope = annotated  # an alias's Depends is read where the alias is written
        provider = argument(call, 0, "dependency")
        if provider is None:  # Depends(): the annotated class
            value = self.resolver.annotation_value(declared_type, scope)
            value = ClassVal(value.cls) if isinstance(value, InstanceVal) else None
        else:
            value = self.resolver.infer(provider, scope)
        service = self._service(value, provider)
        if service is None:
            return None
        service["use_cache"] = not is_false(keyword(call, "use_cache"))
        service["location"] = location(module, call)
        return service

    def _depends_call(self, node, scope) -> ast.Call | None:
        if isinstance(node, ast.Call) and external_name(self.resolver, node.func, scope) in DEPENDS:
            return node
        return None

    def _annotated(self, annotation, scope, depth: int = 0):
        """Annotated[T, Depends(x)] → (T, the Depends call, its scope), also through an alias of it."""
        if annotation is None or depth > 5:
            return None
        if isinstance(annotation, ast.Constant) and isinstance(annotation.value, str):
            return self._annotated(self.resolver.parse_annotation(annotation.value), scope, depth + 1)
        if isinstance(annotation, (ast.Name, ast.Attribute)):
            value = self.resolver.infer(annotation, scope)
            if isinstance(value, VarVal) and value.var.owner is None and value.var.values:
                return self._annotated(value.var.values[0][0], self.resolver.module_scope(value.var.module), depth + 1)
            return None
        if isinstance(annotation, ast.Subscript) and short(external_name(self.resolver, annotation.value, scope)) == "Annotated":
            elements = annotation.slice.elts if isinstance(annotation.slice, ast.Tuple) else [annotation.slice]
            for metadata in elements[1:]:
                call = self._depends_call(metadata, scope)
                if call is not None:
                    return elements[0], call, scope
        return None

    def _service(self, value, provider) -> dict | None:
        if isinstance(value, FuncVal):
            cached = any(decorator_name(d) in CACHED for d in value.func.decorators)
            return {"service": value.func.id, "kind": "factory", "lifetime": "singleton" if cached else None}
        if isinstance(value, ClassVal):
            return {"service": value.cls.id, "kind": "type", "lifetime": None}
        if isinstance(value, VarVal):
            return {"service": value.var.id, "kind": "instance", "lifetime": "singleton"}
        if isinstance(value, InstanceVal):
            return {"service": value.cls.id, "kind": "instance", "lifetime": "singleton"}
        if isinstance(value, ExtVal):
            return {"service": value.name, "external": True, "kind": "instance" if value.instance else "factory", "lifetime": "singleton" if value.instance else None}
        return None

    def _depend(self, consumer: str, provided: dict) -> None:
        service = provided["service"]
        self.uses.setdefault(service, []).append(provided["use_cache"])
        if service not in self.providers:
            registration = {k: v for k, v in provided.items() if k not in ("use_cache",)}
            registration["registeredIn"] = consumer
            self.providers[service] = registration
        dependency = {"consumer": consumer, "service": service, "framework": "fastapi"}
        if provided.get("external"):
            dependency["external"] = True
        key = (consumer, service, bool(provided.get("external")))
        if key not in self.asked:
            self.asked.add(key)
            self.consumers.add(consumer)
            self.dependencies.append(dependency)

    # ---------------------------------------------------------------- routes and routers

    def router_dependencies(self, router: str, node, scope) -> None:
        """dependencies=[Depends(x)] of include_router: every route of the router asks for x."""
        for call in node.elts if isinstance(node, (ast.List, ast.Tuple)) else []:
            provided = self._from_list_item(call, scope)
            if provided is not None:
                self.by_router.setdefault(router, []).append(provided)

    def _from_list_item(self, item, scope) -> dict | None:
        call = self._depends_call(item, scope)
        if call is None:
            return None
        provider = argument(call, 0, "dependency")
        if provider is None:
            return None
        service = self._service(self.resolver.infer(provider, scope), provider)
        if service is not None:
            service["use_cache"] = not is_false(keyword(call, "use_cache"))
            service["location"] = location(scope.module, call)
        return service

    def finish(self) -> None:
        web = self.frameworks.web
        for endpoint, router, decorator, scope in web.endpoints:
            asked = [self._from_list_item(i, scope) for i in (keyword(decorator, "dependencies").elts if isinstance(keyword(decorator, "dependencies"), (ast.List, ast.Tuple)) else [])]
            key, seen = router, set()
            while key is not None and key not in seen:  # the router's own dependencies=[…], and those it is included with
                seen.add(key)
                var = web.routers.get(key)
                if var is not None and var.values and isinstance(var.values[0][0], ast.Call):
                    items = keyword(var.values[0][0], "dependencies")
                    module_scope = self.resolver.module_scope(var.module)
                    asked += [self._from_list_item(i, module_scope) for i in (items.elts if isinstance(items, (ast.List, ast.Tuple)) else [])]
                asked += self.by_router.get(key, [])
                mounts = web.mounts.get(key)
                key = mounts[0][0] if mounts else None
            for provided in asked:
                if provided is not None:
                    self._depend(endpoint, dict(provided))
            if endpoint in self.consumers:
                self.providers.setdefault(endpoint, {
                    "service": endpoint, "kind": "controller", "lifetime": "scoped", "registeredIn": router,
                    "location": location(scope.module, decorator),
                })

    def result(self) -> dict | None:
        if not self.dependencies:
            return None
        registrations = []
        for service, registration in self.providers.items():
            lifetime = registration.get("lifetime")
            if lifetime is None:
                lifetime = "transient" if not any(self.uses.get(service, [True])) else "scoped"
            entry = {"service": service}
            if registration.get("external"):
                entry["external"] = True
            entry.update({"lifetime": lifetime, "kind": registration["kind"], "framework": "fastapi"})
            if registration.get("registeredIn"):
                entry["registeredIn"] = registration["registeredIn"]
            if registration.get("location"):
                entry["location"] = registration["location"]
            registrations.append(entry)
        registrations.sort(key=lambda r: (r["kind"] != "controller", r["service"]))
        dependencies = sorted(self.dependencies, key=lambda d: (d["consumer"], d["service"]))
        return {"registrations": registrations, "dependencies": dependencies}
