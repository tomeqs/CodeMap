from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest

from helpers import CLI, Workspace


def run(request: dict, stdin: str | None = None):
    process = subprocess.run(
        [sys.executable, "-B", "-X", "utf8", CLI],
        input=(stdin if stdin is not None else json.dumps(request)).encode("utf-8"),
        capture_output=True,
        timeout=120,
    )
    return process.returncode, process.stderr.decode("utf-8", "replace")


class CliTest(unittest.TestCase):
    def request(self, ws, **options):
        output = os.path.join(tempfile.mkdtemp(prefix="codemap-py-out-"), "fragment.json")
        return {"protocol": 1, "command": "analyze", "root": ws.root, "target": ws.root, "output": output, "codemapVersion": "0.4.0", "options": options}

    def test_writes_the_fragment_and_reports_on_stderr(self):
        with Workspace({"app.py": "def main():\n    pass\n\nif __name__ == '__main__':\n    main()\n"}) as ws:
            request = self.request(ws, checks=True)
            code, stderr = run(request)
            self.assertEqual(code, 0, stderr)
            self.assertRegex(stderr, r"^Python 3\.\d+")
            self.assertRegex(stderr, r"\d+ nodes, \d+ edges in")
            with open(request["output"], encoding="utf-8") as f:
                fragment = json.load(f)
            self.assertEqual((fragment["format"], fragment["version"]), ("codemap", "1.1"))
            self.assertEqual(fragment["source"]["kind"], "directory")
            self.assertEqual(fragment["analysis"]["diagnostics"], [])
            ids = {n["id"] for n in fragment["nodes"]}
            self.assertTrue(all(i.startswith("py:") for i in ids))
            self.assertTrue(all(e["source"] in ids and e["target"] in ids for e in fragment["edges"]))

    def test_the_same_code_gives_the_same_bytes(self):
        files = {f"pkg/m{i}.py": f"from pkg import m{(i + 1) % 5}\n\ndef f{i}():\n    return m{(i + 1) % 5}.f{(i + 1) % 5}()\n" for i in range(5)}
        files["pkg/__init__.py"] = ""
        with Workspace(files) as ws:
            outputs = []
            for _ in range(2):
                request = self.request(ws)
                self.assertEqual(run(request)[0], 0)
                with open(request["output"], "rb") as f:
                    outputs.append(f.read())
            self.assertEqual(outputs[0], outputs[1])
            nodes = json.loads(outputs[0])["nodes"]
            ranks = [{"project": 0, "namespace": 1, "module": 2}.get(n["kind"], 3) for n in nodes]
            self.assertEqual(ranks, sorted(ranks))

    def test_bad_requests_fail_with_the_reason(self):
        code, stderr = run({}, stdin="not json")
        self.assertEqual(code, 1)
        self.assertIn("JSONDecodeError", stderr)
        code, stderr = run({"protocol": 2, "command": "analyze", "target": "x", "output": "y"})
        self.assertEqual(code, 1)
        self.assertIn("Protocol 2 is not supported", stderr)
        code, stderr = run({"protocol": 1, "command": "explain", "target": "x", "output": "y"})
        self.assertIn("Unknown command 'explain'", stderr)

    def test_a_failure_inside_is_the_trace_and_exit_code_1(self):
        code, stderr = run({"protocol": 1, "command": "analyze", "target": "/nonexistent/folder/x", "root": "/nonexistent", "output": "/nonexistent/out.json"})
        self.assertEqual(code, 1)
        self.assertIn("Traceback", stderr)


class EntryPointsTest(unittest.TestCase):
    def test_where_code_starts(self):
        with Workspace({
            "pyproject.toml": '[project]\nname = "tool"\n[project.scripts]\ntool = "tool.cli:main"\n',
            "tool/__init__.py": "",
            "tool/cli.py": "def main():\n    pass\n\ndef other():\n    pass\n",
            "tool/__main__.py": "from tool.cli import main\nmain()\n",
            "scripts/run": "",
            "scripts/deploy.py": "#!/usr/bin/env python3\nprint('x')\n",
            "scripts/guarded.py": "def go():\n    pass\n\nif __name__ == '__main__':\n    go()\n",
            "tool/lib.py": "def helper():\n    pass\n",
        }) as ws:
            result = ws.analyze()
            for name in ("tool/cli.py", "tool/cli.py#main", "tool/__main__.py", "tool/__main__.py#(top-level)", "scripts/deploy.py", "scripts/guarded.py", "scripts/guarded.py#(top-level)"):
                self.assertIn("entrypoint", result.node(name).get("tags", []), name)
            for name in ("tool/cli.py#other", "tool/lib.py", "scripts/guarded.py#go"):
                self.assertNotIn("entrypoint", result.node(name).get("tags", []), name)
            self.assertIn("entrypoint", result.node("py:project:tool")["tags"])


if __name__ == "__main__":
    unittest.main()
