"""The graph a run builds, and the fragment file CodeMap reads."""
from __future__ import annotations

import json


class Graph:
    """Nodes by id, and edges counted per (source, target, kind) with the first line they occur on."""

    def __init__(self) -> None:
        self.nodes: dict[str, dict] = {}
        self.edges: dict[tuple[str, str, str], dict] = {}

    def add_node(self, node: dict) -> dict:
        existing = self.nodes.get(node["id"])
        if existing is not None:
            return existing
        self.nodes[node["id"]] = node
        return node

    def has(self, node_id: str) -> bool:
        return node_id in self.nodes

    def add_edge(self, source: str | None, target: str | None, kind: str, line: int = 0) -> None:
        if not source or not target or (source == target and kind != "calls"):
            return
        key = (source, target, kind)
        edge = self.edges.get(key)
        if edge is not None:
            edge["weight"] += 1
            if line and (not edge.get("line") or line < edge["line"]):
                edge["line"] = line
        else:
            edge = {"source": source, "target": target, "kind": kind, "weight": 1}
            if line:
                edge["line"] = line
            self.edges[key] = edge

    def connected_edges(self) -> list[dict]:
        """Edges whose ends are both nodes (others point at code that was not analyzed)."""
        return [e for e in self.edges.values() if e["source"] in self.nodes and e["target"] in self.nodes]


def write_fragment(path: str, fragment: dict) -> None:
    """Writes the fragment a node at a time, so a big graph never becomes one string."""
    dumps = json.JSONEncoder(ensure_ascii=False, separators=(",", ":")).encode
    with open(path, "w", encoding="utf-8", newline="\n") as out:
        out.write('{"format":"codemap","version":"1.1","source":')
        out.write(dumps(fragment["source"]))
        for key in ("nodes", "edges"):
            out.write(f',"{key}":[')
            for i, item in enumerate(fragment[key]):
                if i:
                    out.write(",")
                out.write(dumps(item))
            out.write("]")
        out.write(',"analysis":')
        out.write(dumps(fragment["analysis"]))
        out.write("}")
