"""The checks inside function bodies: each rule on code it must find, and on code it must leave alone."""
from __future__ import annotations

import textwrap
import unittest

from helpers import Workspace


def check(code: str, path: str = "m.py", extra: dict | None = None) -> list[tuple[str, int]]:
    """The rules found and their lines; line 1 is the line the code starts after (the snippets begin with a newline)."""
    files = {path: "# 1\n" + textwrap.dedent(code).lstrip("\n"), **(extra or {})}
    with Workspace(files) as ws:
        result = ws.analyze(checks=True)
    return [(d["rule"], d["location"]["line"]) for d in result.fragment["analysis"]["diagnostics"] if d["location"]["file"] == path]


def rules(code: str, **kwargs) -> list[str]:
    return [rule for rule, _ in check(code, **kwargs)]


class ExceptionsTest(unittest.TestCase):
    def test_bare_empty_and_swallowed_excepts(self):
        found = check('''
            import logging

            def a():
                try:
                    run()
                except:
                    pass

            def b():
                try:
                    run()
                except Exception:
                    count = 0
                    print_nothing = 1

            def c():
                try:
                    run()
                except Exception:
                    other()

            def ok():
                try:
                    run()
                except KeyError:
                    pass
                except Exception:  # best effort: the cache is optional
                    pass
                except BaseException as error:
                    logging.exception("failed")
                    raise

            def run(): ...
            def other(): ...
        ''')
        exceptions = [f for f in found if f[0] in ("bare-except", "empty-catch", "swallowed-exception")]
        # a: bare and empty; b chose a fallback value (not swallowed); c drops it; ok() is fine throughout.
        self.assertEqual(exceptions, [("bare-except", 7), ("empty-catch", 7), ("swallowed-exception", 20)])

    def test_return_break_and_continue_in_finally(self):
        found = check('''
            def a():
                try:
                    return 1
                finally:
                    return 2

            def b(items):
                for item in items:
                    try:
                        pass
                    finally:
                        break

            def ok(items):
                try:
                    pass
                finally:
                    for item in items:
                        if item:
                            break
                    cleanup = lambda: 1
        ''')
        self.assertEqual([f for f in found if f[0] == "return-in-finally"], [("return-in-finally", 6), ("return-in-finally", 13)])
        # A try inside a finally: its own finally's return leaves both, and is reported once.
        nested = check('''
            def c():
                try:
                    pass
                finally:
                    try:
                        pass
                    finally:
                        return 1
        ''')
        self.assertEqual(nested, [("return-in-finally", 9)])

    def test_raise_not_implemented_and_exceptions_not_raised(self):
        found = check('''
            class Failed(Exception):
                pass

            def a():
                raise NotImplemented

            def b(x):
                if x:
                    ValueError("bad x")
                Failed("nope")
                raise NotImplementedError
        ''')
        self.assertEqual(found, [("raise-not-implemented", 6), ("exception-not-raised", 10), ("exception-not-raised", 11)])


class CorrectnessTest(unittest.TestCase):
    def test_mutable_defaults(self):
        found = check('''
            def a(items=[], seen={}, more=set(), names=list(), ok=None, also=(), text="x"):
                pass
        ''')
        self.assertEqual(found, [("mutable-default", 2)] * 4)

    def test_comparisons(self):
        found = check('''
            def a(x, query, Model):
                if x == None:
                    pass
                if x is "a" or x is not 1:
                    pass
                if x == x or x.y <= x.y:
                    pass
                if x != x or x() == x() or x is None or x is True:
                    pass
                query.filter(Model.deleted == None)
                query.filter((Model.a == None) | (Model.b == 1))
        ''')
        self.assertEqual(found, [("none-comparison", 3), ("is-literal", 5), ("is-literal", 5), ("self-comparison", 7), ("self-comparison", 7)])

    def test_asserts_dict_keys_f_strings_and_self_assignment(self):
        found = check('''
            NAME = "x"

            class Config:
                NAME = NAME

            str = str

            def a(x):
                assert (x, "x must be set")
                assert x, "fine"
                d = {"a": 1, "b": 2, "a": 3, 1: 0, 1.0: 2}
                print(f"no placeholders", f"{x}", f"{x!r:>{10}}", "plain")
                x = x
                x.y = x.y
                return d
        ''')
        # NAME = NAME in the class and str = str in the module copy a name in; x = x in a function does nothing
        self.assertEqual(found, [("assert-tuple", 10), ("duplicate-dict-key", 12), ("fstring-without-placeholders", 13), ("self-assignment", 14), ("self-assignment", 15)])

    def test_redefined_functions_and_constant_conditions(self):
        found = check('''
            def f():
                pass

            def f():
                pass

            class C:
                @property
                def x(self):
                    return 1

                @x.setter
                def x(self, value):
                    pass

            def g(flag):
                if True:
                    pass
                while False:
                    pass
                while True:
                    break
                if 0:
                    pass
        ''')
        self.assertEqual(found, [("redefined-function", 5), ("constant-condition", 18), ("constant-condition", 20), ("constant-condition", 24)])

    def test_shadowed_builtins_but_not_parameters_or_class_attributes(self):
        found = check('''
            list = [1]

            class Order:
                id = 0
                type = "order"

            def f(id, type=None):
                max = 3
                return max
        ''')
        self.assertEqual(found, [("shadowed-builtin", 2), ("shadowed-builtin", 9)])


class AsyncTest(unittest.TestCase):
    def test_missing_await_and_blocking_calls(self):
        found = check('''
            import asyncio
            import subprocess
            import time

            import requests


            async def save():
                pass


            async def stream():
                yield 1


            class Service:
                async def ready(self) -> bool:
                    return True

                async def run(self):
                    save()
                    await save()
                    if self.ready():
                        pass
                    asyncio.create_task(save())
                    stream()
                    time.sleep(1)
                    requests.get("https://example.com")
                    subprocess.run(["ls"])
                    await asyncio.sleep(1)

                def sync(self):
                    save()
                    time.sleep(1)
        ''')
        self.assertEqual(found, [
            ("missing-await", 22), ("missing-await", 24), ("blocking-in-async", 28), ("blocking-in-async", 29),
            ("blocking-in-async", 30), ("missing-await", 34),
        ])


class DeadCodeTest(unittest.TestCase):
    def test_unreachable_code(self):
        found = check('''
            def a(items):
                return 1
                print("never")

            def b(items):
                for item in items:
                    if item:
                        continue
                        print(item)
                    raise ValueError()
                    x = 1
        ''')
        self.assertEqual([f for f in found if f[0] == "unreachable-code"], [("unreachable-code", 4), ("unreachable-code", 10), ("unreachable-code", 12)])

    def test_unused_imports(self):
        found = check('''
            from __future__ import annotations

            import json
            import os.path
            import typing
            from collections import OrderedDict, deque
            from typing import TYPE_CHECKING
            from .compat import helper as helper

            try:
                import ujson
            except ImportError:
                ujson = None

            if TYPE_CHECKING:
                from decimal import Decimal

            __all__ = ["deque"]


            def f(x: "typing.Optional[Decimal]") -> str:
                return os.path.join("a", "b")
        ''', path="pkg/m.py", extra={"pkg/__init__.py": "import json\n", "pkg/compat.py": "def helper(): pass\n"})
        self.assertEqual(found, [("unused-import", 4), ("unused-import", 7)])

    def test_unused_variables(self):
        found = check('''
            def f(items):
                total = 0
                unused = compute()
                _ignored = compute()
                first, second = compute()
                for item in items:
                    total += item
                try:
                    pass
                except ValueError as error:
                    pass
                counter = 0

                def inner():
                    return counter
                return inner

            def g():
                x = 1
                return locals()

            def compute(): ...
        ''')
        self.assertEqual(found, [("unused-variable", 4), ("unused-variable", 11)])


class ScopeTest(unittest.TestCase):
    def test_lines_are_counted_as_the_parser_counts_them(self):
        # A form feed (a page break in old sources) and U+2028 in a string end no line for Python: `# noqa` and the
        # comment in an except still belong to the lines they are written on.
        for mark in ("\x0c", "x = '\u2028'"):
            found = check(f"import os\n{mark}\n\ndef f(x):\n    try:\n        os.getcwd()\n    except Exception:  # we tried\n        pass\n    return x == None  # noqa\n")
            self.assertEqual(found, [], repr(mark))

    def test_noqa_tests_and_generated_code_are_left_alone(self):
        self.assertEqual(rules("import json  # noqa: F401\nimport os  # NOQA\n"), [])
        self.assertEqual(rules("def test_x(a=[]):\n    pass\n", path="tests/test_x.py"), [])
        with Workspace({"m.py": "# Generated by protoc. DO NOT EDIT.\ndef f(a=[]):\n    pass\n"}) as ws:
            self.assertNotIn("py:" + ws.root.rsplit("/", 1)[-1] + ":m.py", ws.analyze(checks=True).nodes)  # left out, so not checked
            self.assertEqual(ws.analyze(checks=True, includeGenerated=True).fragment["analysis"]["diagnostics"], [])

    def test_diagnostics_have_the_format_codemap_reads(self):
        with Workspace({"m.py": "def f(a=[]):\n    pass\n"}) as ws:
            diagnostic = ws.analyze(checks=True).fragment["analysis"]["diagnostics"][0]
        self.assertEqual(diagnostic, {
            "rule": "mutable-default", "source": "codemap", "severity": "warning", "category": "correctness",
            "message": "The default [] is made once and shared by every call: default to None and create it inside.",
            "location": {"file": "m.py", "line": 1, "endLine": 1}, "column": 9,
        })
        with Workspace({"m.py": "def f(a=[]):\n    pass\n"}) as ws:
            self.assertNotIn("diagnostics", ws.analyze().fragment["analysis"])


if __name__ == "__main__":
    unittest.main()
