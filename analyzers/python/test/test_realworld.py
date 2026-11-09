"""Cases found by mapping real repositories (requests, httpx, Flask, microblog, the FastAPI template, djangoproject.com,
Celery, Saleor), each in the smallest form that shows it."""
from __future__ import annotations

import unittest

from helpers import Workspace


def tags(result, name):
    return result.node(name).get("tags", [])


class RealWorldTest(unittest.TestCase):
    def test_an_example_folder_named_like_a_package_does_not_hide_it(self):
        # Celery's examples/pydantic/ is a package; inside it, `from pydantic import BaseModel` is the real pydantic.
        with Workspace({
            "pyproject.toml": '[project]\nname = "lib"\n',
            "requirements/extras/pydantic.txt": "pydantic>=2\n",
            "lib/__init__.py": "def helper(): pass\n",
            "examples/pydantic/__init__.py": "",
            "examples/pydantic/tasks.py": "from pydantic import BaseModel\n\n\nclass ArgModel(BaseModel):\n    value: int\n",
        }) as ws:
            result = ws.analyze()
            self.assertIn("dto", tags(result, "examples/pydantic/tasks.py#ArgModel"))
            self.assertTrue(result.has("py:project:lib", "packageReference", "py:pypi:pydantic"))  # declared in requirements/extras/

    def test_pytest_testpaths_are_test_code(self):
        # Celery keeps its tests in t/, which pyproject's [tool.pytest.ini_options] names.
        with Workspace({
            "pyproject.toml": '[project]\nname = "p"\n[tool.pytest.ini_options]\ntestpaths = ["t/unit"]\n',
            "p/core.py": "def f(): pass\n",
            "t/unit/app.py": "from p.core import f\n\ndef check(): f()\n",
        }) as ws:
            self.assertIn("test", tags(ws.analyze(), "t/unit/app.py"))

    def test_configuration_names_what_the_tool_loads(self):
        # Sphinx's extensions, a Celery config module: loaded by name, so used, and entry points.
        with Workspace({
            "docs/conf.py": "extensions = ['sphinx.ext.autodoc', 'ext.links']\n",
            "ext/__init__.py": "",
            "ext/links.py": "def setup(app): pass\n",
            "celeryconfig.py": "broker_url = 'redis://'\n",
        }) as ws:
            result = ws.analyze()
            self.assertIn("config", tags(result, "celeryconfig.py"))
            self.assertTrue(result.has("docs/conf.py#extensions", "uses", "ext/links.py"))
            self.assertIn("entrypoint", tags(result, "ext/links.py"))

    def test_a_module_nothing_imports_that_runs_code_is_a_script(self):
        # Celery's examples/eventlet/bulk_task_producer.py; a package's __init__.py runs on import, it is no script.
        with Workspace({
            "pkg/__init__.py": "import logging\nlogging.basicConfig()\n",
            "pkg/run.py": "from pkg import util\nutil.main()\n",
            "pkg/util.py": "def main(): pass\n",
            "pkg/quiet.py": "LIMIT = 3\n",
        }) as ws:
            result = ws.analyze()
            self.assertIn("entrypoint", tags(result, "pkg/run.py"))
            self.assertNotIn("entrypoint", tags(result, "pkg/__init__.py"))
            self.assertNotIn("entrypoint", tags(result, "pkg/util.py"))  # imported
            self.assertNotIn("entrypoint", tags(result, "pkg/quiet.py"))  # runs nothing

    def test_private_members_code_may_reach_without_types_are_maybe_used(self):
        # Celery: self.tasks._freeze() on an untyped value; AsynPool._setup_queues, a hook billiard's Pool calls.
        with Workspace({
            "m.py": '''
                import threading
                from billiard.pool import Pool


                class Group:
                    def _freeze(self):
                        pass

                    def _dead(self):
                        pass


                def run(tasks):
                    tasks._freeze()
                    getattr(tasks, "_named")()


                class AsynPool(Pool):
                    def _setup_queues(self):
                        pass


                class Worker(threading.Thread):
                    def _helper(self):
                        pass


                class Plain:
                    def _named(self):
                        pass
            ''',
        }) as ws:
            result = ws.analyze()
            for name in ("m.py#Group._freeze", "m.py#AsynPool._setup_queues", "m.py#Worker._helper", "m.py#Plain._named"):
                self.assertIn("maybe-used", tags(result, name), name)
            self.assertNotIn("maybe-used", tags(result, "m.py#Group._dead"))

    def test_test_parameters_are_what_their_fixtures_return(self):
        # Flask's tests: app and client are fixtures.
        with Workspace({
            "app.py": "class App:\n    def test_client(self) -> 'Client':\n        return Client()\n\n\nclass Client:\n    def get(self, url): ...\n",
            "tests/conftest.py": "import pytest\nfrom app import App\n\n\n@pytest.fixture\ndef app():\n    yield App()\n\n\n@pytest.fixture\ndef client(app):\n    return app.test_client()\n",
            "tests/test_app.py": "def test_index(client, app):\n    client.get('/')\n    app.test_client()\n",
        }) as ws:
            result = ws.analyze()
            self.assertTrue(result.has("tests/test_app.py#test_index", "calls", "app.py#Client.get"))
            self.assertTrue(result.has("tests/test_app.py#test_index", "calls", "app.py#App.test_client"))

    def test_sqlalchemy_2_select_gives_its_model(self):
        # microblog: db.session.scalar(sa.select(User).where(…)).check_password(…)
        with Workspace({
            "app/__init__.py": "from flask_sqlalchemy import SQLAlchemy\n\ndb = SQLAlchemy()\n",
            "app/models.py": "from app import db\n\n\nclass User(db.Model):\n    def check_password(self, password): ...\n",
            "app/auth.py": '''
                import sqlalchemy as sa

                from app import db
                from app.models import User


                def login(name, password):
                    user = db.session.scalar(sa.select(User).where(User.username == name))
                    user.check_password(password)
                    for other in db.session.scalars(sa.select(User).order_by(User.id)):
                        other.check_password(password)
            ''',
        }) as ws:
            result = ws.analyze()
            self.assertEqual(result.edge("app/auth.py#login", "calls", "app/models.py#User.check_password")["weight"], 2)

    def test_a_framework_is_recognised_in_its_own_repository(self):
        # Celery's own examples import celery from the repository itself.
        with Workspace({
            "pyproject.toml": '[project]\nname = "celery"\n',
            "celery/__init__.py": "from celery.app.base import Celery\n",
            "celery/app/__init__.py": "",
            "celery/app/base.py": "class Celery:\n    def task(self, *args, **kwargs):\n        return lambda f: f\n",
            "examples/app.py": "from celery import Celery\n\napp = Celery('x')\n\n\n@app.task\ndef add(x, y):\n    return x + y\n",
        }) as ws:
            result = ws.analyze()
            self.assertIn("handler", tags(result, "examples/app.py#add"))
            self.assertIn("entrypoint", tags(result, "examples/app.py"))

    def test_names_other_modules_import_are_no_unused_imports(self):
        # requests' compat.py imports for the other modules to import from it.
        with Workspace({
            "pkg/__init__.py": "",
            "pkg/compat.py": "from urllib.parse import quote, urlparse\nimport json\n\nstr = str\n",
            "pkg/api.py": "from .compat import quote\n\ndef f(x):\n    return quote(x)\n",
        }) as ws:
            diagnostics = ws.analyze(checks=True).fragment["analysis"]["diagnostics"]
            found = sorted((d["rule"], d["message"].split("'")[1]) for d in diagnostics if d["location"]["file"] == "pkg/compat.py")
            self.assertEqual(found, [("unused-import", "json"), ("unused-import", "urlparse")])


if __name__ == "__main__":
    unittest.main()
