"""Test helpers: projects written to a temporary folder, analyzed in-process, and lookups on the result."""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "src")
sys.path.insert(0, SRC)

from codemap_python.analyze import analyze  # noqa: E402

CLI = os.path.join(SRC, "cli.py")
FIXTURES = os.path.join(HERE, "fixtures")


class Workspace:
    """Files of a project, written to a temporary folder: {"pkg/mod.py": "code"} (dedented)."""

    def __init__(self, files: dict[str, str]) -> None:
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="codemap-py-"))
        for path, text in files.items():
            self.write(path, text)

    def write(self, path: str, text: str) -> str:
        full = os.path.join(self.root, *path.split("/"))
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8", newline="\n") as f:
            f.write(textwrap.dedent(text).lstrip("\n"))
        return full

    def path(self, relative: str = "") -> str:
        return os.path.join(self.root, *relative.split("/")) if relative else self.root

    def analyze(self, target: str = "", root: str | None = None, **options) -> Result:
        full = self.path(target)
        if root is None:
            root = full if os.path.isdir(full) else os.path.dirname(full)
        request = {"protocol": 1, "command": "analyze", "root": root, "target": full, "output": "", "options": options}
        return Result(analyze(request))

    def __enter__(self) -> Workspace:
        return self

    def __exit__(self, *exc) -> None:
        shutil.rmtree(self.root, ignore_errors=True)


class Result:
    def __init__(self, fragment: dict) -> None:
        self.fragment = fragment
        self.nodes = {n["id"]: n for n in fragment["nodes"]}
        self.edges = fragment["edges"]
        self.warnings = fragment["analysis"]["warnings"]

    def find(self, suffix: str) -> dict | None:
        """The node whose id ends with the suffix (an id after its project: `pkg/mod.py#Class.method`)."""
        matches = [n for i, n in self.nodes.items() if i == suffix or i.endswith(":" + suffix) or i.endswith("/" + suffix)]
        if len(matches) > 1:
            raise AssertionError(f"{suffix} names {len(matches)} nodes: {[m['id'] for m in matches]}")
        return matches[0] if matches else None

    def node(self, suffix: str) -> dict:
        found = self.find(suffix)
        if found is None:
            raise AssertionError(f"no node {suffix}; nodes: {sorted(self.nodes)}")
        return found

    def has(self, source: str, kind: str, target: str) -> bool:
        s, t = self.node(source)["id"], self.node(target)["id"]
        return any(e["source"] == s and e["target"] == t and e["kind"] == kind for e in self.edges)

    def edge(self, source: str, kind: str, target: str) -> dict:
        s, t = self.node(source)["id"], self.node(target)["id"]
        for e in self.edges:
            if e["source"] == s and e["target"] == t and e["kind"] == kind:
                return e
        raise AssertionError(f"no {kind} edge {source} → {target}; from it: {self.out(source)}")

    def out(self, source: str, kind: str | None = None) -> list[tuple[str, str]]:
        s = self.node(source)["id"]
        return sorted((e["kind"], e["target"]) for e in self.edges if e["source"] == s and (kind is None or e["kind"] == kind))

    def targets(self, source: str, kind: str) -> list[str]:
        return [t.split(":", 2)[-1] for _, t in self.out(source, kind)]
