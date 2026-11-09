"""Roles of classes, as C# and TypeScript tag them.

- SQLAlchemy (declarative classes with a table, Flask-SQLAlchemy's db.Model, SQLModel with table=True) and Django
  models are entities. relationship("Order") / Relationship() and ForeignKey("orders.id") (also SQLModel's
  Field(foreign_key="orders.id")) make the field hold the entity they point at.
- Pydantic models, SQLModel models without a table, marshmallow schemas: DTOs; pydantic-settings: options.
- Otherwise the names C# goes by: …Repository, …Service, …Factory, …Settings, …Request / …Response / …Dto,
  …Validator, …Handler.
"""
from __future__ import annotations

import ast
import re

from ..resolve import ClassVal
from ..symbols import ClassDecl, VarDecl
from . import Part
from .common import argument, external_name, keyword, short, string_of, tag

DECLARATIVE = ("sqlalchemy.orm.DeclarativeBase", "sqlalchemy.orm.decl_api.DeclarativeBase", "sqlalchemy.orm.DeclarativeBaseNoMeta",
               "sqlalchemy.orm.declarative_base", "sqlalchemy.ext.declarative.declarative_base", "sqlalchemy.orm.decl_api.declarative_base")
PYDANTIC = ("pydantic.BaseModel", "pydantic.main.BaseModel", "pydantic.v1.BaseModel", "pydantic.RootModel")
SETTINGS = ("pydantic_settings.BaseSettings", "pydantic_settings.main.BaseSettings", "pydantic.BaseSettings", "pydantic.v1.BaseSettings")
ROLE_TAGS = {"entity", "dto", "options", "controller", "test", "exception", "config", "handler", "middleware"}
NAMING = [
    ("Repository", "repository"), ("Repo", "repository"), ("Service", "service"), ("Factory", "factory"),
    ("Options", "options"), ("Settings", "options"), ("Configuration", "options"), ("Config", "options"),
    ("Dto", "dto"), ("DTO", "dto"), ("Request", "dto"), ("Response", "dto"), ("Schema", "dto"), ("ViewModel", "dto"),
    ("Validator", "validator"), ("Handler", "handler"),
]


class Roles(Part):
    def __init__(self, frameworks) -> None:
        super().__init__(frameworks)
        self.entities: list[ClassDecl] = []
        self.links: list[tuple[VarDecl, str, object]] = []  # (field, "relationship" / "table", target)
        self.classes: list[ClassDecl] = []

    def declare(self, module, owners: list) -> None:
        for decl in owners:
            if not isinstance(decl, ClassDecl):
                continue
            self.classes.append(decl)
            bases = self.resolver.external_bases(decl)
            node = self.node(decl.id)
            if self._is_entity(decl, bases):
                tag(node, "entity")
                self.entities.append(decl)
                self._fields(decl)
            elif any(n in SETTINGS for n in bases):
                tag(node, "options")
            elif any(n in PYDANTIC or n.startswith("marshmallow.") or n == "sqlmodel.SQLModel" or n == "sqlmodel.main.SQLModel" for n in bases):
                tag(node, "dto")

    def _is_entity(self, decl: ClassDecl, bases: set[str]) -> bool:
        if self.resolver.is_flask_model(decl) and not self._abstract(decl):
            return True
        if any(n in ("sqlmodel.SQLModel", "sqlmodel.main.SQLModel") for n in bases):
            return any(self._table_keyword(c) for c in self.resolver.mro(decl))
        if any(n in DECLARATIVE or n.endswith(".DeclarativeBase") for n in bases):
            return any(self._member(c, ("__tablename__", "__table__")) for c in self.resolver.mro(decl))
        return False

    @staticmethod
    def _table_keyword(cls: ClassDecl) -> bool:
        return any(k.arg == "table" and isinstance(k.value, ast.Constant) and k.value.value is True for k in cls.node.keywords)

    @staticmethod
    def _member(cls: ClassDecl, names) -> bool:
        return any(isinstance(cls.members.get(n), VarDecl) for n in names)

    def _abstract(self, decl: ClassDecl) -> bool:
        member = decl.members.get("__abstract__")
        return isinstance(member, VarDecl) and any(isinstance(v, ast.Constant) and v.value is True for v, _ in member.values)

    def _fields(self, decl: ClassDecl) -> None:
        scope = self.resolver.scope_of(decl)
        for member in decl.members.values():
            if not isinstance(member, VarDecl) or not member.values:
                continue
            for call in (n for n in ast.walk(member.values[0][0]) if isinstance(n, ast.Call)):
                name = short(external_name(self.resolver, call.func, scope))
                if name in ("relationship", "Relationship", "relation"):
                    target = argument(call, 0, "argument")
                    if target is not None:
                        self.links.append((member, "class", (target, scope)))
                elif name == "ForeignKey":
                    text = string_of(argument(call, 0, "column"))
                    if text:
                        self.links.append((member, "table", text.split(".")[0]))
                elif name == "Field" and string_of(keyword(call, "foreign_key")):
                    self.links.append((member, "table", string_of(keyword(call, "foreign_key")).split(".")[0]))

    def finish(self) -> None:
        tables: dict[str, ClassDecl] = {}
        by_name: dict[str, ClassDecl] = {}
        for entity in self.entities:
            by_name.setdefault(entity.name, entity)
            table = self._table_name(entity)
            if table:
                tables.setdefault(table, entity)
        for field, kind, target in self.links:
            entity = None
            if kind == "table":
                entity = tables.get(target)
            else:
                expression, scope = target
                text = string_of(expression)
                if text is not None:
                    entity = by_name.get(text.rsplit(".", 1)[-1])
                else:
                    value = self.resolver.infer(expression, scope)
                    entity = value.cls if isinstance(value, ClassVal) else None
            if entity is not None and entity is not field.owner:
                self.graph.add_edge(field.id, entity.id, "holds")
        for decl in self.classes:
            node = self.node(decl.id)
            if node is None or ROLE_TAGS & set(node.get("tags", [])):
                continue
            for suffix, role in NAMING:
                if decl.name.endswith(suffix) and len(decl.name) > len(suffix):
                    tag(node, role)
                    break

    def _table_name(self, entity: ClassDecl) -> str:
        for cls in self.resolver.mro(entity):
            member = cls.members.get("__tablename__")
            if isinstance(member, VarDecl) and member.values:
                text = string_of(member.values[0][0])
                if text:
                    return text
        if any(self._table_keyword(c) for c in self.resolver.mro(entity)):
            return entity.name.lower()  # SQLModel's default
        if self.resolver.is_flask_model(entity):
            return re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", entity.name).lower()  # Flask-SQLAlchemy's: OrderItem → order_item
        return ""
