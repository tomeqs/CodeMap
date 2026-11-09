"""CodeMap language plugin for Python, protocol 1 (see docs/plugins.md).

Reads the request (JSON) on stdin, writes the raw graph to request["output"] and reports progress on stderr.
Runs on the standard library alone, Python 3.9 or newer.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from codemap_python.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
