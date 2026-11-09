"""Work started from outside a request: background tasks and command lines.

- Celery (`@app.task`, `@shared_task`, Task subclasses), Dramatiq (`@actor`), RQ (`@job`), Huey (`@huey.task`):
  handlers and entry points; `task.delay(…)` / `apply_async` / `s` / `send` are calls of the task (the resolver
  follows them), and the module that creates the Celery app is where the worker starts.
- click (`@click.command`, `@click.group`, `@group.command`) and typer (`@app.command`, `@app.callback`,
  `typer.run(main)`): entry points.
"""
from __future__ import annotations

import ast

from ..resolve import FuncVal
from ..symbols import ClassDecl, FuncDecl
from . import Part
from .common import argument, external_name, short, tag

CLICK = {"command", "group"}
TYPER = {"command", "callback"}


class Jobs(Part):
    def declare(self, module, owners: list) -> None:
        for decl in owners:
            if isinstance(decl, FuncDecl):
                self._function(decl)
            elif isinstance(decl, ClassDecl):
                bases = self.resolver.external_bases(decl)
                if any(n.startswith("celery.") and short(n) == "Task" for n in bases):
                    tag(self.node(decl.id), "handler", "entrypoint")

    def _function(self, decl: FuncDecl) -> None:
        scope = self.resolver.definition_scope(decl)
        for decorator in decl.decorators:
            target = decorator.func if isinstance(decorator, ast.Call) else decorator
            name = external_name(self.resolver, target, scope)
            if self._is_task(name):
                tag(self.node(decl.id), "handler", "entrypoint")
            elif self._is_command(name) or self._is_subcommand(target, scope):
                tag(self.node(decl.id), "entrypoint")

    @staticmethod
    def _is_task(name: str) -> bool:
        if not name:
            return False
        package, last = name.split(".", 1)[0], short(name)
        return (
            (package == "celery" and last in ("task", "shared_task", "periodic_task"))
            or name in ("dramatiq.actor", "rq.decorators.job", "rq.job", "huey.api.Huey.task")
            or (package in ("huey", "dramatiq") and last in ("task", "periodic_task", "actor"))
        )

    @staticmethod
    def _is_command(name: str) -> bool:
        if not name:
            return False
        package, last = name.split(".", 1)[0], short(name)
        return (package in ("click", "asyncclick", "rich_click") and last in CLICK) or (package == "typer" and last in TYPER)

    def _is_subcommand(self, target, scope) -> bool:
        """@cli.command() where cli is a click group of the analysis (a function decorated with @click.group)."""
        if not isinstance(target, ast.Attribute) or target.attr not in CLICK:
            return False
        group = self.resolver.infer(target.value, scope)
        if not isinstance(group, FuncVal):
            return False
        group_scope = self.resolver.definition_scope(group.func)
        return any(self._is_command(external_name(self.resolver, d.func if isinstance(d, ast.Call) else d, group_scope)) for d in group.func.decorators)

    def on_call(self, walker, node, name: str, scope) -> None:
        if name in ("celery.Celery", "celery.app.base.Celery", "dramatiq.set_broker", "huey.RedisHuey", "huey.SqliteHuey"):
            tag(self.node(scope.module.id), "entrypoint")
        elif name in ("typer.run", "typer.main.run"):
            target = argument(node, 0, "function")
            value = self.resolver.infer(target, scope) if target is not None else None
            if isinstance(value, FuncVal):
                tag(self.node(value.func.id), "entrypoint")
