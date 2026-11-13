import unittest

from helpers import Workspace


def analyze(files, **options):
    with Workspace(files) as ws:
        return ws.analyze(**options)


class ImportsTest(unittest.TestCase):
    def test_re_exports_lead_to_the_declaration_and_the_import_edge_to_the_package(self):
        result = analyze({
            "shop/__init__.py": "from .orders import place\n__all__ = ['place']\n",
            "shop/orders/__init__.py": "from .service import place\n",
            "shop/orders/service.py": "def place(): pass\n",
            "app.py": "from shop import place\nimport shop\n\ndef run():\n    place()\n    shop.place()\n",
        })
        self.assertTrue(result.has("app.py#run", "calls", "shop/orders/service.py#place"))
        self.assertEqual(result.edge("app.py#run", "calls", "shop/orders/service.py#place")["weight"], 2)
        self.assertTrue(result.has("app.py", "imports", "shop/__init__.py"))
        self.assertTrue(result.has("shop/__init__.py", "imports", "shop/orders/__init__.py"))
        self.assertTrue(result.has("shop/orders/__init__.py", "imports", "shop/orders/service.py"))

    def test_relative_imports_aliases_and_submodules(self):
        result = analyze({
            "pkg/__init__.py": "",
            "pkg/a.py": "from . import b\nfrom .b import f as g\nfrom .sub import c\nimport pkg.sub.c as cm\n\ndef run():\n    b.f()\n    g()\n    c.h()\n    cm.h()\n",
            "pkg/b.py": "def f(): pass\n",
            "pkg/sub/__init__.py": "",
            "pkg/sub/c.py": "from ..b import f\n\ndef h():\n    f()\n",
        })
        self.assertEqual(result.targets("pkg/a.py#run", "calls"), ["pkg/b.py#f", "pkg/sub/c.py#h"])
        self.assertEqual(result.edge("pkg/a.py#run", "calls", "pkg/b.py#f")["weight"], 2)
        self.assertEqual(result.targets("pkg/a.py", "imports"), ["pkg/b.py", "pkg/sub/c.py"])
        self.assertTrue(result.has("pkg/sub/c.py#h", "calls", "pkg/b.py#f"))

    def test_star_imports_follow_all(self):
        result = analyze({
            "lib/__init__.py": "from .api import *\nfrom .hidden import *\n",
            "lib/api.py": "__all__ = ['public']\n\ndef public(): pass\n\ndef other(): pass\n",
            "lib/hidden.py": "def visible(): pass\n\ndef _private(): pass\n",
            "main.py": "import lib\n\ndef run():\n    lib.public()\n    lib.other()\n    lib.visible()\n    lib._private()\n",
        })
        self.assertEqual(result.targets("main.py#run", "calls"), ["lib/api.py#public", "lib/hidden.py#visible"])

    def test_type_checking_imports_are_uses(self):
        result = analyze({
            "a.py": "from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from b import B\n\ndef f(x: 'B') -> None:\n    pass\n",
            "b.py": "class B: pass\n",
        })
        self.assertTrue(result.has("a.py", "uses", "b.py"))
        self.assertFalse(result.has("a.py", "imports", "b.py"))
        self.assertTrue(result.has("a.py#f", "accepts", "b.py#B"))

    def test_pypi_packages_and_the_standard_library(self):
        result = analyze({
            "requirements.txt": "requests>=2.31\nPyYAML==6.0\n",
            "app.py": "import os, json\nimport requests\nimport yaml\nfrom bs4 import BeautifulSoup\nimport numpy.linalg\nfrom __future__ import annotations\n",
        })
        project = [n for n in result.nodes.values() if n["kind"] == "project"][0]["id"]
        packages = sorted(t for k, t in result.out(project) if k == "packageReference")
        self.assertEqual(packages, ["py:pypi:beautifulsoup4", "py:pypi:numpy", "py:pypi:pyyaml", "py:pypi:requests"])
        self.assertEqual(result.node("py:pypi:requests")["signature"], ">=2.31")
        self.assertEqual(result.node("py:pypi:pyyaml")["name"], "PyYAML")
        self.assertTrue(result.node("py:pypi:numpy")["external"])

    def test_imports_of_missing_own_modules_are_reported(self):
        result = analyze({"pkg/__init__.py": "", "pkg/a.py": "from .missing import x\nfrom pkg.gone import y\nfrom ...far import z\n"})
        warning = [w for w in result.warnings if "could not be resolved" in w]
        self.assertTrue(warning and warning[0].startswith("3 import(s)"), result.warnings)
        self.assertFalse(any(n["kind"] == "package" for n in result.nodes.values()))

    def test_src_layout_and_namespace_packages(self):
        result = analyze({
            "pyproject.toml": '[project]\nname = "p"\n',
            "src/corp/billing/invoice.py": "class Invoice: pass\n",
            "src/corp/api.py": "from corp.billing.invoice import Invoice\n\ndef make():\n    return Invoice()\n",
        })
        self.assertTrue(result.has("src/corp/api.py#make", "instantiates", "src/corp/billing/invoice.py#Invoice"))
        self.assertEqual(result.node("src/corp/billing/invoice.py")["fullName"], "corp.billing.invoice")

    def test_imports_between_projects_reference_the_project(self):
        result = analyze({
            "core/pyproject.toml": '[project]\nname = "core"\n',
            "core/core/__init__.py": "def f(): pass\n",
            "app/pyproject.toml": '[project]\nname = "app"\ndependencies = ["core"]\n',
            "app/app/main.py": "from core import f\n\ndef run():\n    f()\n",
        })
        self.assertTrue(result.has("py:project:app", "projectReference", "py:project:core"))
        self.assertTrue(result.has("app/main.py#run", "calls", "core/__init__.py#f"))
        self.assertIsNone(result.find("py:pypi:core"))


    def test_a_relative_import_above_the_top_package_is_not_followed(self):
        # pkg is the top package: `from ... import utils` in pkg/sub/mod.py leaves it, which Python refuses.
        result = analyze({
            "utils.py": "def helper(): ...\n",
            "pkg/__init__.py": "",
            "pkg/top.py": "def f(): ...\n",
            "pkg/sub/__init__.py": "",
            "pkg/sub/mod.py": "from .. import top\nfrom ... import utils\n\n\ndef run():\n    top.f()\n    utils.helper()\n",
        })
        self.assertEqual(result.targets("pkg/sub/mod.py", "imports"), ["pkg/top.py"])
        self.assertEqual(result.targets("pkg/sub/mod.py#run", "calls"), ["pkg/top.py#f"])
        self.assertTrue(any("pkg/sub/mod.py:2" in w for w in result.warnings), result.warnings)

    def test_projects_with_a_folder_of_the_same_name_keep_their_own_modules(self):
        # app/ has no __init__.py in either project: `app.models` is the importing project's.
        files = {}
        for project, how in (("svc1", "from app import models\n\n\ndef run():\n    models.helper()\n"), ("svc2", "import app.models\n\n\ndef run():\n    app.models.helper()\n")):
            files[f"{project}/pyproject.toml"] = f'[project]\nname = "{project}"\n'
            files[f"{project}/app/models.py"] = "def helper(): ...\n"
            files[f"{project}/app/main.py"] = how
        result = analyze(files)
        for project in ("svc1", "svc2"):
            self.assertEqual(result.out(f"py:{project}:app/main.py#run", "calls"), [("calls", f"py:{project}:app/models.py#helper")])


class CallsTest(unittest.TestCase):
    def test_a_cycle_gives_the_same_edges_wherever_it_is_entered(self):
        # f returns g(), g returns f(): whichever is asked first, both give an Order.
        code = "class Order:\n    def pay(self): ...\n\n\ndef f(x):\n    return Order() if x else g(x)\n\n\ndef g(x):\n    return f(x)\n\n\n"
        users = {"f": "def use_f():\n    f(1).pay()\n", "g": "def use_g():\n    g(1).pay()\n"}
        for order in ("fg", "gf"):
            result = analyze({"m.py": code + "\n\n".join(users[name] for name in order)})
            for name in order:
                self.assertTrue(result.has(f"m.py#use_{name}", "calls", "m.py#Order.pay"), f"use_{name}, asked in the order {order}")
        # Star imports in a circle: a takes b's and c's names, b takes a's.
        files = {"a.py": "from b import *\nfrom c import *\n", "b.py": "from a import *\n\n\ndef use_b():\n    helper()\n", "c.py": "def helper(): ...\n"}
        for first in ("a.py", "b.py"):
            ordered = dict(sorted(files.items(), key=lambda item: item[0] != first))
            self.assertTrue(analyze(ordered).has("b.py#use_b", "calls", "c.py#helper"), f"with {first} first")

    def test_an_attribute_set_in_a_method_is_no_name_of_the_class_body(self):
        # self.list = … makes no `list` in the class body: the annotations still mean the built-in.
        result = analyze({"m.py": '''
            class Line:
                def total(self): ...


            class Invoice:
                def __init__(self, lines: list[Line]):
                    self.list = lines

                def lines(self) -> list[Line]:
                    return self.list


            def use(invoice: Invoice):
                for line in invoice.lines():
                    line.total()
        '''})
        self.assertEqual(result.targets("m.py#Invoice.__init__", "accepts"), ["m.py#Line"])
        self.assertEqual(result.targets("m.py#Invoice.lines", "returns"), ["m.py#Line"])
        self.assertTrue(result.has("m.py#Invoice.list", "holds", "m.py#Line"))
        self.assertTrue(result.has("m.py#use", "calls", "m.py#Line.total"))

    def test_a_call_unpacked_into_several_names_is_a_call(self):
        result = analyze({"m.py": "def create():\n    return 1, 2\n\n\nclass Config:\n    host, port = create()\n\n\napp, worker = create()\nfirst, second = 1, create()\n"})
        self.assertTrue(result.has("m.py#(top-level)", "calls", "m.py#create"))  # app, worker = create()
        self.assertTrue(result.has("m.py#Config", "calls", "m.py#create"))
        self.assertTrue(result.has("m.py#second", "calls", "m.py#create"))  # paired values stay with their names
        for name in ("app", "worker", "Config.host", "Config.port", "first"):
            self.assertIsNotNone(result.find(f"m.py#{name}"), name)

    def test_self_cls_super_and_the_method_resolution_order(self):
        result = analyze({"m.py": '''
            class Base:
                def run(self):
                    self.step()

                def step(self):
                    pass

                @classmethod
                def make(cls):
                    return cls()


            class Mixin:
                def step(self):
                    pass


            class Child(Mixin, Base):
                def run(self):
                    super().run()
                    self.step()
                    Base.step(self)

                @staticmethod
                def build():
                    return Child.make()
        '''})
        self.assertTrue(result.has("m.py#Base.run", "calls", "m.py#Base.step"))
        self.assertTrue(result.has("m.py#Child.run", "calls", "m.py#Base.run"))
        self.assertTrue(result.has("m.py#Child.run", "calls", "m.py#Mixin.step"))  # Mixin comes first in the MRO
        self.assertTrue(result.has("m.py#Child.run", "calls", "m.py#Base.step"))
        self.assertTrue(result.has("m.py#Base.make", "instantiates", "m.py#Base"))
        self.assertTrue(result.has("m.py#Child.build", "calls", "m.py#Base.make"))
        self.assertTrue(result.has("m.py#Child.run", "overrides", "m.py#Base.run"))
        self.assertTrue(result.has("m.py#Mixin.step", "overrides", "m.py#Base.step") is False)
        self.assertTrue(result.has("m.py#Child", "inherits", "m.py#Mixin"))
        self.assertTrue(result.has("m.py#Child", "inherits", "m.py#Base"))

    def test_types_from_annotations_constructors_and_return_values(self):
        result = analyze({"m.py": '''
            from __future__ import annotations
            from typing import Optional, Union, List


            class Repo:
                def save(self, item): ...
                def find(self) -> Optional["Item"]: ...


            class Item:
                def touch(self): ...


            def make_repo():
                return Repo()


            def a(repo: Repo, maybe: Optional[Repo], union: Union[Repo, None], new: Repo | None, items: List[Item], many: "list[Item]"):
                repo.save(1)
                maybe.save(2)
                union.save(3)
                new.save(4)
                for item in items:
                    item.touch()
                [i.touch() for i in many]
                made = make_repo()
                made.save(5)
                found = repo.find()
                found.touch()
                items[0].touch()
        '''})
        self.assertEqual(result.edge("m.py#a", "calls", "m.py#Repo.save")["weight"], 5)
        self.assertEqual(result.edge("m.py#a", "calls", "m.py#Item.touch")["weight"], 4)
        self.assertTrue(result.has("m.py#a", "calls", "m.py#make_repo"))
        self.assertEqual(sorted(result.targets("m.py#a", "accepts")), ["m.py#Item", "m.py#Repo"])

    def test_fields_get_their_type_from_the_constructor(self):
        result = analyze({"m.py": '''
            class Mailer:
                def send(self): ...


            class Service:
                def __init__(self, mailer: Mailer, other=None):
                    self.mailer = mailer
                    self.backup = Mailer()
                    self.other = other

                def notify(self):
                    self.mailer.send()
                    self.backup.send()
                    self.other.send()
        '''})
        self.assertEqual(result.edge("m.py#Service.notify", "calls", "m.py#Mailer.send")["weight"], 2)
        self.assertTrue(result.has("m.py#Service", "injects", "m.py#Mailer"))
        self.assertTrue(result.has("m.py#Service.mailer", "holds", "m.py#Mailer"))
        self.assertTrue(result.has("m.py#Service.backup", "holds", "m.py#Mailer"))
        self.assertTrue(result.has("m.py#Service.notify", "accesses", "m.py#Service.mailer"))

    def test_unknown_receivers_make_no_edge(self):
        result = analyze({"m.py": '''
            class A:
                def save(self): ...


            class B:
                def save(self): ...


            def f(x, flag):
                x.save()
                y = A() if flag else B()
                y.save()
                import json
                json.dumps(x).save()
        '''})
        self.assertEqual(result.out("m.py#f", "calls"), [])
        self.assertEqual(sorted(result.targets("m.py#f", "instantiates")), ["m.py#A", "m.py#B"])

    def test_calls_have_the_line_of_their_first_call(self):
        result = analyze({"m.py": "def g(): pass\n\ndef f():\n    x = 1\n    g()\n    g()\n"})
        edge = result.edge("m.py#f", "calls", "m.py#g")
        self.assertEqual((edge["line"], edge["weight"]), (5, 2))

    def test_with_statements_and_context_managers(self):
        result = analyze({"m.py": '''
            from contextlib import contextmanager
            from typing import Iterator


            class Tx:
                def commit(self): ...
                def __enter__(self) -> "Tx":
                    return self
                def __exit__(self, *args): ...


            class Db:
                @contextmanager
                def transaction(self) -> Iterator[Tx]:
                    yield Tx()


            def f(db: Db):
                with Tx() as tx:
                    tx.commit()
                with db.transaction() as other:
                    other.commit()
        '''})
        self.assertEqual(result.edge("m.py#f", "calls", "m.py#Tx.commit")["weight"], 2)

    def test_properties_fields_and_module_variables_are_accesses(self):
        result = analyze({"m.py": '''
            LIMIT = 3
            registry = {}


            class C:
                size = 1

                @property
                def total(self):
                    return self.size

                def f(self):
                    global registry
                    registry = {}
                    return self.total + LIMIT
        '''})
        self.assertEqual(sorted(result.targets("m.py#C.f", "accesses")), ["m.py#C.total", "m.py#LIMIT", "m.py#registry"])
        self.assertTrue(result.has("m.py#C.total", "accesses", "m.py#C.size"))

    def test_raise_except_isinstance_and_decorators(self):
        result = analyze({"m.py": '''
            import functools


            class Failed(Exception):
                pass


            def logged(fn):
                @functools.wraps(fn)
                def wrapper(*args):
                    return fn(*args)
                return wrapper


            @logged
            def f(x):
                if isinstance(x, Failed):
                    raise Failed("no")
                try:
                    g()
                except (Failed, KeyError):
                    raise


            @logged
            def g():
                pass
        '''})
        self.assertTrue(result.has("m.py#f", "throws", "m.py#Failed"))
        self.assertTrue(result.has("m.py#f", "instantiates", "m.py#Failed"))
        self.assertTrue(result.has("m.py#f", "catches", "m.py#Failed"))
        self.assertTrue(result.has("m.py#f", "uses", "m.py#Failed"))
        self.assertTrue(result.has("m.py#f", "decoratedWith", "m.py#logged"))
        self.assertTrue(result.has("m.py#f", "calls", "m.py#g"))  # the decorator keeps it the function
        self.assertEqual(result.node("m.py#f")["attributes"], ["logged"])

    def test_protocols_and_abstract_methods_are_implemented(self):
        result = analyze({"m.py": '''
            import abc
            from typing import Protocol


            class Store(Protocol):
                def put(self, key: str) -> None: ...


            class Shape(abc.ABC):
                @abc.abstractmethod
                def area(self) -> float: ...


            class Memory(Store):
                def put(self, key: str) -> None:
                    pass


            class Square(Shape):
                def area(self) -> float:
                    return 1.0
        '''})
        self.assertTrue(result.has("m.py#Memory", "implements", "m.py#Store"))
        self.assertTrue(result.has("m.py#Memory.put", "implements", "m.py#Store.put"))
        self.assertTrue(result.has("m.py#Square", "implements", "m.py#Shape"))
        self.assertTrue(result.has("m.py#Square.area", "implements", "m.py#Shape.area"))

    def test_nested_functions_and_lambdas_belong_to_their_function(self):
        result = analyze({"m.py": '''
            class Item:
                def price(self) -> int:
                    return 1


            def total(items: "list[Item]"):
                def one(item: Item):
                    return item.price()
                key = lambda i: i.price()
                return sum(one(i) for i in items), sorted(items, key=key)
        '''})
        # The nested function's annotated item; the lambda's parameter could be anything.
        self.assertEqual(result.edge("m.py#total", "calls", "m.py#Item.price")["weight"], 1)
        self.assertEqual(result.node("m.py#total")["metrics"]["complexity"], 2)

    def test_enum_members_and_class_attributes(self):
        result = analyze({"m.py": '''
            from enum import Enum


            class Color(Enum):
                RED = 1

                def hex(self) -> str:
                    return "#f00"


            def f():
                return Color.RED.hex()
        '''})
        self.assertTrue(result.has("m.py#f", "uses", "m.py#Color"))
        self.assertTrue(result.has("m.py#f", "calls", "m.py#Color.hex"))

    def test_a_method_naming_its_own_class_is_no_edge(self):
        result = analyze({"m.py": "class A:\n    def copy(self) -> 'A':\n        return A()\n    def same(self, other):\n        return isinstance(other, A)\n"})
        self.assertEqual(result.out("m.py#A.same"), [])
        self.assertTrue(result.has("m.py#A.copy", "instantiates", "m.py#A"))

    def test_class_level_code_and_nested_meta_classes(self):
        result = analyze({"m.py": '''
            class Order:
                pass


            def default_name():
                return "x"


            class Serializer:
                name = default_name()

                class Meta:
                    model = Order
        '''})
        self.assertTrue(result.has("m.py#Serializer.name", "calls", "m.py#default_name"))
        self.assertTrue(result.has("m.py#Serializer", "uses", "m.py#Order"))


if __name__ == "__main__":
    unittest.main()
