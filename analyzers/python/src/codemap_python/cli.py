from __future__ import annotations

import json
import platform
import sys
import threading
import time
import traceback

from .analyze import analyze
from .graph import write_fragment

PROTOCOL = 1


def main() -> int:
    try:
        request = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
        if request.get("protocol") != PROTOCOL:
            raise ValueError(f"Protocol {request.get('protocol')} is not supported; this plugin speaks protocol {PROTOCOL}.")
        if request.get("command") != "analyze":
            raise ValueError(f"Unknown command '{request.get('command')}'.")
        if not request.get("target") or not request.get("output"):
            raise ValueError("The request needs a target and an output.")
    except Exception as error:  # noqa: BLE001 - every problem with the request ends the run with its message
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        return 1

    log(f"Python {platform.python_version()}")
    result: dict = {}

    def run() -> None:
        try:
            started = time.monotonic()
            fragment = analyze(request, log)
            write_fragment(request["output"], fragment)
            log(f"{len(fragment['nodes'])} nodes, {len(fragment['edges'])} edges in {time.monotonic() - started:.1f}s")
            result["code"] = 0
        except BaseException:  # noqa: BLE001 - the trace is what CodeMap shows
            traceback.print_exc(file=sys.stderr)
            result["code"] = 1

    # Deeply nested code (long elif chains, big literals) needs a deeper stack than the main thread has.
    sys.setrecursionlimit(20000)
    try:
        threading.stack_size(256 * 1024 * 1024)
    except (ValueError, RuntimeError):
        sys.setrecursionlimit(3000)  # the system's own stack size: stay within it
    worker = threading.Thread(target=run, name="codemap-python")
    worker.start()
    worker.join()
    return result.get("code", 1)


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)
