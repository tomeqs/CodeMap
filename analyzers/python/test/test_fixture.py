"""The fixture the .NET tests and the golden map use (fixtures/mini): what each part of it is there for."""
from __future__ import annotations

import os
import unittest

from helpers import FIXTURES, Result

from codemap_python.analyze import analyze

MINI = os.path.join(FIXTURES, "mini")
S = "src/mini/orders/service.py"
M = "src/mini/orders/model.py"


class MiniFixtureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = Result(analyze({"protocol": 1, "command": "analyze", "root": MINI, "target": MINI, "output": "", "options": {}}))

    def test_calls_go_through_the_protocol_the_service_is_given(self):
        r = self.result
        self.assertTrue(r.has(f"{S}#OrderService.place", "calls", "src/mini/orders/ports.py#Repository.save"))
        self.assertTrue(r.has(f"{S}#OrderService.pay", "calls", "src/mini/orders/ports.py#Repository.get"))
        self.assertTrue(r.has(f"{S}#OrderService.pay", "calls", f"{M}#Order.pay"))  # Optional[Order] narrowed by its use
        self.assertTrue(r.has(f"{S}#MemoryRepository.save", "implements", "src/mini/orders/ports.py#Repository.save"))
        self.assertTrue(r.has(f"{S}#OrderService", "injects", "src/mini/orders/ports.py#Repository"))

    def test_the_command_line_reaches_the_service_through_the_package(self):
        r = self.result
        self.assertTrue(r.has("src/mini/cli.py", "imports", "src/mini/__init__.py"))
        self.assertTrue(r.has("src/mini/cli.py#main", "calls", f"{S}#make_service"))
        self.assertTrue(r.has("src/mini/cli.py#main", "calls", f"{S}#OrderService.place"))
        self.assertTrue(r.has("src/mini/cli.py#main", "calls", f"{M}#Status.label"))
        self.assertIn("entrypoint", r.node("src/mini/cli.py#main")["tags"])  # [project.scripts]

    def test_the_rest_of_the_story(self):
        r = self.result
        self.assertTrue(r.has("src/mini/orders/ports.py", "uses", M))  # under TYPE_CHECKING
        self.assertTrue(r.has(f"{M}#Order.pay", "throws", f"{M}#OrderError"))
        self.assertTrue(r.has(f"{S}#OrderService.pay", "catches", f"{M}#OrderError"))
        self.assertTrue(r.has("py:project:mini", "packageReference", "py:pypi:requests"))
        self.assertTrue(r.has("py:project:mini", "packageReference", "py:pypi:pytest"))
        self.assertIn("test", r.node("tests/test_service.py#test_place_counts_the_lines")["tags"])
        self.assertEqual(r.out(f"{S}#OrderService._forgotten", "calls"), [])
        self.assertFalse(any(e["target"].endswith("#OrderService._forgotten") for e in r.edges))  # the map's one dead method


if __name__ == "__main__":
    unittest.main()
