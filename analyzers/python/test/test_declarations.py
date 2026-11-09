import unittest

from helpers import Workspace

MODEL = '''
"""Orders and what they hold."""
from __future__ import annotations

import abc
from dataclasses import dataclass
from enum import Enum
from functools import cached_property
from typing import ClassVar, Final, Protocol, TypeAlias, overload

MAX_LINES = 50
LIMIT: Final = 3
OrderId: TypeAlias = int
_cache = {}
default_status = None


class Status(Enum):
    NEW = "new"
    PAID = "paid"

    def label(self) -> str:
        return self.value


class Repository(Protocol):
    def get(self, order_id: OrderId) -> "Order | None": ...


class Base(abc.ABC):
    @abc.abstractmethod
    def total(self) -> int: ...

    def describe(self) -> str:
        return "order"


class Port(abc.ABC):
    @abc.abstractmethod
    def send(self, text: str) -> None: ...


@dataclass(frozen=True)
class Order(Base):
    """An order. It has lines."""

    id: int
    kind: ClassVar[str] = "order"
    note: str = ""
    """What the customer wrote."""

    def __init__(self, id: int, *lines: str, notify=None, **extra) -> None:
        self.id = id
        self._lines = list(lines)

    @property
    def total(self) -> int:
        return len(self._lines)

    @total.setter
    def total(self, value: int) -> None:
        self._count = value

    @cached_property
    def size(self) -> int:
        return 1

    @staticmethod
    def parse(text: str) -> "Order":
        return Order(int(text))

    @classmethod
    def empty(cls) -> "Order":
        return cls(0)

    async def save(self) -> None:
        pass

    def lines(self):
        yield from self._lines

    @overload
    def find(self, key: int) -> str: ...
    @overload
    def find(self, key: str) -> str: ...
    def find(self, key):
        return str(key)

    def __repr__(self) -> str:
        return "Order"

    class Meta:
        ordering = ["id"]

    class Line:
        def price(self) -> int:
            return 1


def _helper(x, y=2):
    if x and y or x:
        return [i for i in range(x) if i]
    elif y:
        return None
    return x if y else y


class OrderError(ValueError):
    pass
'''


class DeclarationsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ws = Workspace({"shop/__init__.py": "from .model import Order\n__all__ = ['Order']\n", "shop/model.py": MODEL})
        cls.result = cls.ws.analyze()

    @classmethod
    def tearDownClass(cls):
        cls.ws.__exit__()

    def node(self, name):
        return self.result.node(f"shop/model.py#{name}")

    def test_kinds(self):
        kinds = {name: self.node(name)["kind"] for name in [
            "MAX_LINES", "OrderId", "Status", "Status.label", "Repository", "Repository.get", "Base", "Port", "Order",
            "Order.id", "Order.kind", "Order.__init__", "Order._lines", "Order.total", "Order.size", "Order.parse",
            "Order.save", "Order.Line", "Order.Line.price", "_helper", "OrderError",
        ]}
        self.assertEqual(kinds, {
            "MAX_LINES": "variable", "OrderId": "typeAlias", "Status": "enum", "Status.label": "method",
            "Repository": "interface", "Repository.get": "method", "Base": "class", "Port": "interface", "Order": "class",
            "Order.id": "field", "Order.kind": "field", "Order.__init__": "constructor", "Order._lines": "field",
            "Order.total": "property", "Order.size": "property", "Order.parse": "method", "Order.save": "method",
            "Order.Line": "class", "Order.Line.price": "method", "_helper": "function", "OrderError": "class",
        })

    def test_levels_and_parents(self):
        self.assertEqual(self.result.node("shop/model.py")["kind"], "module")
        self.assertEqual(self.node("Order")["parent"], "py:" + self.result.node("shop/model.py")["id"].split(":", 1)[1])
        self.assertEqual(self.node("Order.total")["parent"], self.node("Order")["id"])
        self.assertEqual(self.node("Order.Line.price")["parent"], self.node("Order.Line")["id"])
        self.assertTrue(all(n.get("level") == "member" for n in self.result.nodes.values() if "#" in n["id"]))

    def test_enum_members_are_the_enums(self):
        self.assertIsNone(self.result.find("shop/model.py#Status.NEW"))

    def test_nested_classes_without_methods_are_their_outer_class(self):
        self.assertIsNone(self.result.find("shop/model.py#Order.Meta"))
        self.assertIsNone(self.result.find("shop/model.py#Order.ordering"))

    def test_modifiers(self):
        self.assertEqual(self.node("Order.parse")["modifiers"], ["static"])
        self.assertEqual(self.node("Order.empty")["modifiers"], ["classmethod"])
        self.assertEqual(self.node("Order.save")["modifiers"], ["async"])
        self.assertEqual(self.node("Order.lines")["modifiers"], ["generator"])
        self.assertEqual(self.node("Base")["modifiers"], ["abstract"])
        self.assertEqual(self.node("Base.total")["modifiers"], ["abstract"])
        self.assertEqual(self.node("MAX_LINES")["modifiers"], ["const"])
        self.assertEqual(self.node("LIMIT")["modifiers"], ["const"])
        self.assertEqual(self.node("Order.kind")["modifiers"], ["static"])
        self.assertNotIn("modifiers", self.node("default_status"))

    def test_accessibility(self):
        self.assertEqual(self.node("_helper")["accessibility"], "private")
        self.assertEqual(self.node("_cache")["accessibility"], "private")
        self.assertEqual(self.node("Order._lines")["accessibility"], "private")
        self.assertEqual(self.node("Order.__repr__")["accessibility"], "public")
        self.assertEqual(self.node("Order")["accessibility"], "public")

    def test_signatures_docs_and_attributes(self):
        order = self.node("Order")
        self.assertEqual(order["signature"], "class Order(Base)")
        self.assertEqual(order["doc"], "An order.")
        self.assertEqual(order["attributes"], ["dataclass"])
        self.assertEqual(order["baseType"], "shop.model.Base")
        self.assertEqual(self.node("Order.__init__")["signature"], "def __init__(self, id: int, *lines: str, notify=None, **extra) -> None")
        self.assertEqual(self.node("Order.save")["signature"], "async def save(self) -> None")
        self.assertEqual(self.node("Order.note")["doc"], "What the customer wrote.")
        self.assertEqual(self.node("LIMIT")["signature"], "LIMIT: Final = 3")
        self.assertEqual(self.node("Order._lines")["signature"], "self._lines = list(lines)")
        self.assertNotIn("attributes", self.node("Order.total"))  # property, setter: what the kind says
        self.assertNotIn("attributes", self.node("Order.parse"))
        self.assertEqual(self.result.node("shop/model.py")["doc"], "Orders and what they hold.")
        self.assertEqual(self.node("OrderError")["baseType"], "ValueError")
        self.assertIn("exception", self.node("OrderError")["tags"])

    def test_locations_metrics_and_merged_definitions(self):
        total = self.node("Order.total")
        self.assertEqual(len(total["extraLocations"]), 1)  # the setter
        find = self.node("Order.find")
        self.assertEqual(len(find["extraLocations"]), 2)  # the @overload stubs
        self.assertEqual(find["location"]["line"], find["location"]["endLine"] - 1)  # the definition with code
        order = self.node("Order")
        self.assertEqual(order["location"]["line"], MODEL.lstrip("\n").splitlines().index("@dataclass(frozen=True)") + 1)
        self.assertEqual(self.node("Order.__init__")["metrics"]["parameters"], 4)
        self.assertEqual(self.node("_helper")["metrics"]["parameters"], 2)
        # if + elif + and/or (2) + comprehension for and if (2) + conditional expression = 7 decisions
        self.assertEqual(self.node("_helper")["metrics"]["complexity"], 8)
        self.assertEqual(self.node("Order.Line")["metrics"]["loc"], 3)

    def test_fields_set_in_methods(self):
        self.assertEqual(self.node("Order._lines")["location"]["line"], self.node("Order.__init__")["location"]["line"] + 2)
        self.assertIsNotNone(self.result.find("shop/model.py#Order._count"))  # set in the setter
        self.assertEqual(self.node("Order.id")["signature"], "id: int")  # declared in the class body first

    def test_a_package_that_re_exports_is_a_barrel(self):
        self.assertEqual(self.result.node("shop/__init__.py")["tags"], ["barrel"])

    def test_top_level_code(self):
        with Workspace({
            "app.py": "import logging\nlogging.basicConfig()\nif DEBUG := False:\n    print(1)\nfor x in range(3):\n    pass\n",
            "pkg/__init__.py": "import logging\nlogging.getLogger().addHandler(logging.NullHandler())\n",
            "plain.py": "X = 1\n\ndef f(): pass\n",
        }) as ws:
            result = ws.analyze()
            top = result.node("app.py#(top-level)")
            self.assertEqual((top["kind"], top["accessibility"]), ("function", "private"))
            self.assertEqual(top["location"], {"file": "app.py", "line": 2, "endLine": 6})
            self.assertEqual(top["metrics"]["complexity"], 3)  # the if and the loop
            self.assertEqual(result.node("pkg/__init__.py")["tags"], ["init"])  # runs code when imported
            self.assertIsNone(result.find("plain.py#(top-level)"))

    def test_config_files(self):
        with Workspace({"setup.py": "from setuptools import setup\nsetup()\n", "docs/conf.py": "project = 'x'\n", "noxfile.py": "x = 1\n"}) as ws:
            result = ws.analyze()
            for name in ("setup.py", "docs/conf.py", "noxfile.py"):
                self.assertIn("config", result.node(name)["tags"], name)


if __name__ == "__main__":
    unittest.main()
