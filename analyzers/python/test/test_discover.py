from __future__ import annotations

import os
import sys
import unittest

from helpers import Workspace


class ProjectsTest(unittest.TestCase):
    def test_a_pyproject_names_the_project_and_its_modules_have_dotted_names(self):
        with Workspace({
            "pyproject.toml": '[project]\nname = "shop-api"\nversion = "2.1.0"\nrequires-python = ">=3.10"\n',
            "src/shop/__init__.py": "VERSION = 1\n",
            "src/shop/orders/service.py": "def place(): pass\n",
        }) as ws:
            result = ws.analyze()
            project = result.node("py:project:shop-api")
            self.assertEqual(project["fullName"], "pyproject.toml")
            self.assertEqual(project["signature"], "2.1.0 · Python >=3.10")
            self.assertEqual(project["location"], {"file": "pyproject.toml", "line": 1, "endLine": 1})
            service = result.node("py:shop-api:src/shop/orders/service.py")
            self.assertEqual(service["fullName"], "shop.orders.service")
            self.assertEqual(service["name"], "service.py")
            self.assertEqual(service["parent"], "py:ns:shop-api/shop.orders")
            self.assertEqual(service["level"], "type")
            namespace = result.node("py:ns:shop-api/shop.orders")
            self.assertEqual((namespace["kind"], namespace["name"], namespace["parent"]), ("namespace", "shop.orders", "py:project:shop-api"))
            self.assertEqual(result.node("src/shop/orders/service.py#place")["fullName"], "shop.orders.service.place")

    def test_names_come_from_setup_cfg_setup_py_or_the_folder(self):
        with Workspace({
            "a/setup.cfg": "[metadata]\nname = alpha\nversion = 0.3\n",
            "a/alpha.py": "x = 1\n",
            "b/setup.py": "from setuptools import setup\nNAME = 'beta'\nsetup(name=NAME, version='1.0', install_requires=['click>=8'])\n",
            "b/beta.py": "x = 1\n",
            "c/requirements.txt": "requests\n",
            "c/tool.py": "x = 1\n",
        }) as ws:
            result = ws.analyze()
            self.assertEqual(result.node("py:project:alpha")["signature"], "0.3")
            self.assertEqual(result.node("py:project:beta")["signature"], "1.0")
            self.assertIsNotNone(result.find("py:project:c"))
            self.assertTrue(result.has("py:project:beta", "packageReference", "py:pypi:click"))

    def test_loose_scripts_form_a_project_named_after_the_folder(self):
        with Workspace({"tools/report.py": "import helper\nhelper.run()\n", "tools/helper.py": "def run(): pass\n"}) as ws:
            result = ws.analyze("tools")
            project = result.node("py:project:tools")
            self.assertEqual(project["signature"], "no project file")
            self.assertEqual(project["fullName"], ".")
            # A script's folder is on sys.path when it runs: `import helper` is the file next to it.
            self.assertTrue(result.has("py:tools:report.py", "imports", "py:tools:helper.py"))
            self.assertTrue(result.has("py:tools:report.py#(top-level)", "calls", "py:tools:helper.py#run"))

    def test_every_file_belongs_to_the_nearest_project_above_it(self):
        with Workspace({
            "pyproject.toml": '[project]\nname = "root"\n',
            "app.py": "x = 1\n",
            "libs/core/pyproject.toml": '[project]\nname = "core"\n',
            "libs/core/core/__init__.py": "def f(): pass\n",
        }) as ws:
            result = ws.analyze()
            self.assertEqual(result.node("py:root:app.py")["project"], "py:project:root")
            self.assertEqual(result.node("py:core:core/__init__.py")["project"], "py:project:core")
            self.assertEqual(result.node("py:project:core")["fullName"], "libs/core/pyproject.toml")

    def test_two_projects_with_one_name_stay_apart(self):
        with Workspace({
            "a/pyproject.toml": '[project]\nname = "app"\n', "a/x.py": "x = 1\n",
            "b/pyproject.toml": '[project]\nname = "app"\n', "b/y.py": "y = 1\n",
        }) as ws:
            result = ws.analyze()
            self.assertIsNotNone(result.find("py:project:app"))
            self.assertIsNotNone(result.find("py:project:app~2"))

    def test_a_folder_inside_a_project_keeps_the_project_and_its_ids(self):
        files = {
            "pyproject.toml": '[project]\nname = "shop"\n',
            "shop/__init__.py": "",
            "shop/model.py": "class Order: pass\n",
            "shop/api/__init__.py": "",
            "shop/api/views.py": "from shop.model import Order\n\ndef show():\n    return Order()\n",
        }
        with Workspace(files) as ws:
            whole = ws.analyze()
            part = ws.analyze("shop/api")
            self.assertIn("py:shop:shop/api/views.py#show", part.nodes)
            self.assertNotIn("py:shop:shop/model.py", part.nodes)  # outside the folder: not on the map
            self.assertEqual(part.node("shop/api/views.py")["location"]["file"], "views.py")
            self.assertEqual(whole.node("shop/api/views.py#show")["id"], part.node("shop/api/views.py#show")["id"])
            # The model is outside the folder; the edge to it is left out, not guessed.
            self.assertEqual(part.out("shop/api/views.py#show"), [])
            self.assertTrue(whole.has("shop/api/views.py#show", "instantiates", "shop/model.py#Order"))

    def test_package_names_go_up_through_packages_past_the_project_and_the_folder(self):
        files = {
            "pkg/__init__.py": "",
            "pkg/util.py": "def f(): pass\n",
            "pkg/tool/__init__.py": "",
            "pkg/tool/setup.py": "",
            "pkg/tool/run.py": "from pkg.util import f\nfrom pkg.tool import helpers\nf()\nhelpers.g()\n",
            "pkg/tool/helpers.py": "def g(): pass\n",
        }
        with Workspace(files) as ws:
            result = ws.analyze()
            self.assertEqual(result.node("py:tool:run.py")["fullName"], "pkg.tool.run")  # a project of its own, inside a package
            self.assertTrue(result.has("py:tool:run.py#(top-level)", "calls", "pkg/util.py#f"))
            inner = ws.analyze("pkg/tool")
            self.assertEqual(inner.node("py:tool:run.py")["fullName"], "pkg.tool.run")
            self.assertTrue(inner.has("py:tool:run.py#(top-level)", "calls", "py:tool:helpers.py#g"))
            self.assertIsNone(inner.find("py:pypi:pkg"))  # the package above the folder is not a PyPI package

    def test_one_file(self):
        with Workspace({"pyproject.toml": '[project]\nname = "p"\n', "p/a.py": "from p.b import f\nf()\n", "p/b.py": "def f(): pass\n"}) as ws:
            result = ws.analyze("p/a.py")
            self.assertEqual(result.fragment["source"]["kind"], "file")
            self.assertIn("py:p:p/a.py", result.nodes)
            self.assertNotIn("py:p:p/b.py", result.nodes)

    def test_a_project_file_as_target_analyzes_its_project(self):
        with Workspace({"pyproject.toml": '[project]\nname = "p"\n', "p/a.py": "x = 1\n"}) as ws:
            result = ws.analyze("pyproject.toml", root=ws.root)
            self.assertEqual(result.fragment["source"]["kind"], "project")
            self.assertEqual(result.fragment["source"]["name"], "p")
            self.assertIn("py:p:p/a.py", result.nodes)


class FoldersTest(unittest.TestCase):
    def test_virtual_environments_build_output_and_caches_are_skipped(self):
        with Workspace({
            "app.py": "x = 1\n",
            "env/pyvenv.cfg": "home = /usr/bin\n",
            "env/lib/site.py": "x = 1\n",
            "build/lib/app.py": "x = 1\n",
            "dist/app.py": "x = 1\n",
            "__pycache__/app.py": "x = 1\n",
            "pkg.egg-info/x.py": "x = 1\n",
            ".tox/x.py": "x = 1\n",
            "node_modules/x.py": "x = 1\n",
        }) as ws:
            result = ws.analyze()
            modules = sorted(n["location"]["file"] for n in result.nodes.values() if n["kind"] == "module")
            self.assertEqual(modules, ["app.py"])

    def test_a_package_named_build_is_code(self):
        with Workspace({"pyproject.toml": '[project]\nname = "build"\n', "src/build/__init__.py": "def main(): pass\n"}) as ws:
            self.assertIsNotNone(ws.analyze().find("src/build/__init__.py#main"))

    def test_tests_are_tagged_and_left_out_on_request(self):
        files = {
            "pkg/core.py": "def f(): pass\n",
            "tests/test_core.py": "from pkg.core import f\n\ndef test_f():\n    f()\n",
            "pkg/core_test.py": "def test_x(): pass\n",
            "conftest.py": "x = 1\n",
        }
        with Workspace(files) as ws:
            result = ws.analyze()
            self.assertIn("test", result.node("tests/test_core.py")["tags"])
            self.assertIn("test", result.node("tests/test_core.py#test_f")["tags"])
            self.assertIn("test", result.node("pkg/core_test.py")["tags"])
            self.assertIn("test", result.node("conftest.py")["tags"])
            self.assertNotIn("tags", result.node("pkg/core.py"))
            without = ws.analyze(includeTests=False)
            self.assertIsNone(without.find("tests/test_core.py"))
            self.assertIn("3 test file(s) were left out.", without.warnings)

    def test_a_folder_of_tests_alone_is_a_test_project(self):
        with Workspace({"tests/test_a.py": "def test_a(): pass\n"}) as ws:
            self.assertIn("test-project", ws.analyze().node("py:project:" + os.path.basename(ws.root))["tags"])

    def test_generated_code_is_skipped_unless_asked_for(self):
        files = {
            "app/models.py": "class Order: pass\n",
            "app/migrations/__init__.py": "",
            "app/migrations/0001_initial.py": "# Generated by Django 4.2\nfrom django.db import migrations\n",
            "api/orders_pb2.py": "# -*- coding: utf-8 -*-\nx = 1\n",
            "api/client.py": "# Code generated by a tool. DO NOT EDIT.\nx = 1\n",
        }
        with Workspace(files) as ws:
            result = ws.analyze()
            self.assertIsNone(result.find("app/migrations/0001_initial.py"))
            self.assertIsNone(result.find("api/orders_pb2.py"))
            self.assertIsNone(result.find("api/client.py"))
            self.assertIn("3 generated file(s) were skipped.", result.warnings)
            included = ws.analyze(includeGenerated=True)
            self.assertIn("generated", included.node("api/orders_pb2.py")["tags"])

    def test_an_import_of_a_skipped_module_is_no_pypi_package(self):
        with Workspace({"api/orders_pb2.py": "x = 1\n", "api/server.py": "import orders_pb2\nfrom api import orders_pb2 as pb\n"}) as ws:
            result = ws.analyze()
            self.assertFalse(any(n["kind"] == "package" for n in result.nodes.values()))

    def test_empty_init_files_are_not_on_the_map(self):
        with Workspace({"pkg/__init__.py": '"""Docs only."""\n', "pkg/a.py": "x = 1\n"}) as ws:
            result = ws.analyze()
            self.assertIsNone(result.find("pkg/__init__.py"))
            self.assertIsNotNone(result.find("pkg/a.py"))

    def test_a_file_python_cannot_parse_is_a_module_with_a_warning(self):
        with Workspace({"old.py": "print 'python 2'\n", "ok.py": "x = 1\n"}) as ws:
            result = ws.analyze()
            self.assertEqual(result.node("old.py")["kind"], "module")
            self.assertTrue(any("1 file(s) could not be parsed" in w and "old.py" in w for w in result.warnings), result.warnings)

    def test_python_3_14_excepts_without_parentheses_parse_on_older_pythons(self):
        groups = "    try:\n        g()\n    except* OSError, TimeoutError:\n        pass\n" if sys.version_info >= (3, 11) else "    pass\n    pass\n    pass\n    pass\n"
        code = "def f():\n    try:\n        g()\n    except ValueError, KeyError as error:\n        raise\n" + groups + "\ndef g(): pass\n"
        with Workspace({"m.py": code}) as ws:
            result = ws.analyze()
            self.assertEqual(result.warnings, [])
            self.assertTrue(result.has("m.py#f", "calls", "m.py#g"))
            self.assertEqual(result.node("m.py#g")["location"]["line"], 11)  # the lines stay where they are

    def test_alembic_migrations_are_generated(self):
        with Workspace({"alembic/versions/1a2b_add_orders.py": 'revision = "1a2b"\ndown_revision = None\nimport sqlmodel\n', "alembic/env.py": "x = 1\n"}) as ws:
            result = ws.analyze()
            self.assertIsNone(result.find("alembic/versions/1a2b_add_orders.py"))
            self.assertIsNotNone(result.find("alembic/env.py"))

    def test_encodings_and_byte_order_marks(self):
        with Workspace({}) as ws:
            with open(ws.path("latin.py"), "wb") as f:
                f.write("# -*- coding: latin-1 -*-\nNAME = 'caf\xe9'\n".encode("latin-1"))
            with open(ws.path("bom.py"), "wb") as f:
                f.write(b"\xef\xbb\xbfdef f():\n    pass\n")
            result = ws.analyze()
            self.assertEqual(result.node("latin.py#NAME")["signature"], "NAME = 'caf\xe9'")
            self.assertEqual(result.node("bom.py#f")["location"]["line"], 1)


if __name__ == "__main__":
    unittest.main()
