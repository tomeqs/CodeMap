from __future__ import annotations

import os
import unittest

from helpers import Workspace

from codemap_python import tomlmini
from codemap_python.projects import read_project


class DependenciesTest(unittest.TestCase):
    def deps(self, files):
        with Workspace(files) as ws:
            p = read_project(ws.root)
            return {d.name: (d.spec, os.path.relpath(d.path, ws.root).replace(os.sep, "/") if d.path else None) for d in p.dependencies.values()}, p

    def test_pep_621_with_optional_dependencies_and_groups(self):
        deps, p = self.deps({"pyproject.toml": '''
            [project]
            name = "api"
            dependencies = ["fastapi>=0.110", "pydantic[email]>=2; python_version>'3.8'", "uvicorn"]
            [project.optional-dependencies]
            dev = ["pytest>=8"]
            [dependency-groups]
            lint = ["ruff", {include-group = "dev"}]
            [project.scripts]
            api = "api.cli:main"
            [project.entry-points."pytest11"]
            plugin = "api.testing"
        '''})
        self.assertEqual(deps, {"fastapi": (">=0.110", None), "pydantic": (">=2", None), "uvicorn": ("", None), "pytest": (">=8", None), "ruff": ("", None)})
        self.assertEqual(p.scripts, ["api.cli:main", "api.testing"])

    def test_poetry(self):
        deps, p = self.deps({"pyproject.toml": '''
            [tool.poetry]
            name = "shop"
            version = "0.2.0"
            packages = [{ include = "shop", from = "lib" }]
            [tool.poetry.dependencies]
            python = "^3.10"
            django = { version = "^4.2", extras = ["argon2"] }
            core = { path = "../core", develop = true }
            [tool.poetry.group.dev.dependencies]
            pytest = "^8"
            [tool.poetry.scripts]
            shop = "shop.cli:run"
        ''', "lib/shop/__init__.py": "", "../core/x.py": ""})
        self.assertEqual(deps["django"], ("^4.2", None))
        self.assertEqual(deps["pytest"], ("^8", None))
        self.assertNotIn("python", deps)
        self.assertEqual((p.declared_name, p.version, p.scripts), ("shop", "0.2.0", ["shop.cli:run"]))
        self.assertEqual([os.path.basename(r) for r in p.roots][:1], ["lib"])

    def test_requirements_files_follow_includes_and_editable_paths(self):
        deps, _ = self.deps({
            "requirements.txt": "-r requirements/base.txt\n--index-url https://example.com\nDjango==4.2  # web\n-e ./libs/core\n",
            "requirements/base.txt": "celery[redis]>=5\n# comment\nrequests @ https://example.com/requests.whl\n",
            "requirements-dev.txt": "pytest\n-e git+https://github.com/x/y.git#egg=ylib\n",
            "libs/core/setup.py": "",
        })
        self.assertEqual(deps["Django"], ("==4.2", None))
        self.assertEqual(deps["celery"], (">=5", None))
        self.assertEqual(deps["requests"], ("", None))
        self.assertEqual(deps["pytest"], ("", None))
        self.assertEqual(deps["core"], ("", "libs/core"))
        self.assertIn("ylib", deps)

    def test_setup_py_literals_and_setup_cfg(self):
        deps, p = self.deps({
            "setup.py": "from setuptools import setup, find_packages\nREQS = ['click>=8']\nsetup(name='tool', install_requires=REQS + ['rich'], extras_require={'yaml': ['PyYAML']},\n      entry_points={'console_scripts': ['tool = tool.main:cli']}, package_dir={'': 'src'}, packages=find_packages('src'))\n",
            "setup.cfg": "[options]\ninstall_requires =\n    attrs>=21\n    # note\n[options.entry_points]\nconsole_scripts =\n    other = tool.other:main\n",
            "src/tool/__init__.py": "",
        })
        self.assertEqual(sorted(deps), ["PyYAML", "attrs", "click", "rich"])
        self.assertEqual(sorted(p.scripts), ["tool.main:cli", "tool.other:main"])
        self.assertEqual(os.path.basename(p.roots[0]), "src")
        self.assertEqual(p.declared_name, "tool")

    def test_pipfile_and_uv_sources(self):
        deps, _ = self.deps({"Pipfile": '[packages]\nflask = "*"\nlocal = {path = "./local", editable = true}\n[dev-packages]\nblack = ">=24"\n', "local/x.py": ""})
        self.assertEqual(deps, {"flask": ("", None), "local": ("", "local"), "black": (">=24", None)})
        with Workspace({"pyproject.toml": '[project]\nname = "a"\ndependencies = ["b"]\n[tool.uv.sources]\nb = { workspace = true }\n', "a.py": "import b\n"}) as ws:
            dependency = read_project(ws.root).dependencies["b"]
            self.assertTrue(dependency.workspace)
            self.assertIsNone(ws.analyze().find("py:pypi:b"))  # a workspace member, not a PyPI package

    def test_a_broken_project_file_is_a_problem_not_a_failure(self):
        with Workspace({"pyproject.toml": "[project\nname = 1\n", "a.py": "x = 1\n"}) as ws:
            result = ws.analyze()
            self.assertTrue(any("pyproject.toml" in w for w in result.warnings), result.warnings)
            self.assertIn("py:project:" + os.path.basename(ws.root), result.nodes)


class TomlTest(unittest.TestCase):
    TEXT = '''
# A project
[project]
name = "x"   # trailing
deps = [
  "a>=1",  # first
  'b',
]
text = """
two \\
  lines"""
raw = \'\'\'c:\\path\'\'\'
[[tool.items]]
id = 1
[[tool.items]]
id = 2
[tool.table]
"quoted key".inner = 0x1F
neg = -3_000
pi = 3.5e1
on = true
when = 1979-05-27T07:32:00Z
inline = { a = 1, b = ["x"] }
empty = {}
esc = "tab\\t\\u00e9"
'''

    def test_the_reader_reads_what_project_files_hold(self):
        data = tomlmini.Reader(self.TEXT).document()
        self.assertEqual(data["project"], {"name": "x", "deps": ["a>=1", "b"], "text": "two lines", "raw": "c:\\path"})
        self.assertEqual(data["tool"]["items"], [{"id": 1}, {"id": 2}])
        table = data["tool"]["table"]
        self.assertEqual(table["quoted key"], {"inner": 31})
        self.assertEqual((table["neg"], table["pi"], table["on"], table["when"]), (-3000, 35.0, True, "1979-05-27T07:32:00Z"))
        self.assertEqual(table["inline"], {"a": 1, "b": ["x"]})
        self.assertEqual(table["esc"], "tab\té")

    def test_the_reader_agrees_with_tomllib(self):
        try:
            import tomllib
        except ImportError:
            self.skipTest("tomllib is Python 3.11+")
        expected = tomllib.loads(self.TEXT)
        expected["tool"]["table"]["when"] = "1979-05-27T07:32:00Z"
        self.assertEqual(tomlmini.Reader(self.TEXT).document(), expected)

    def test_errors_name_the_line(self):
        with self.assertRaisesRegex(ValueError, "line 2"):
            tomlmini.Reader('a = 1\nb = \n').document()


if __name__ == "__main__":
    unittest.main()
