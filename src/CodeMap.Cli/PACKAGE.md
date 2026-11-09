# CodeMap

An interactive **3D map of your code**: C# solutions, TypeScript / JavaScript (with Node.js 18+) and Python (with Python 3.9+), or all of them in one map.
CodeMap turns the code into a graph of its relationships (types, members, calls, imports, inheritance, dependency
injection…) and opens it in the browser: Galaxy, City, Layers, DI and Flow views, with call flows and sequence diagrams.

```bash
dotnet tool install -g CodeMap.Tool

codemap                              # the app in your browser: pick a solution, package or folder
codemap ui path/to/MySolution.sln    # analyze it right away
codemap path/to/repo -o out          # files: out/<name>.codemap.json, .html (offline 3D map), .md (report)
codemap --version                    # which languages are available here
```

- **C#**: solutions, projects or folders; no build needed (Roslyn).
- **TypeScript / JavaScript**: npm packages and monorepos, without `npm install`; Express routes, NestJS and Angular
  DI containers recognised from the imports. Needs Node.js 18 or newer.
- **Python**: projects (pyproject.toml, setup.py, requirements.txt) or folders of scripts, without a virtual environment;
  imports, re-exports, classes and calls resolved from the code itself. Needs Python 3.9 or newer.
- **Insights**: architecture layers and upward dependencies, DI lifetime problems (captive dependencies, request scope,
  unreachable providers), cycles, hotspots from git history, possibly unused code.

## For AI agents: `codemap mcp`

An MCP server on stdio, so that an AI agent (Claude Code, Cursor, VS Code's agent mode…) can understand the structure of
the code and improve it. It:
- reads the map;
- finds spaghetti code, layer violations, DI mistakes, dead code and mistakes inside function bodies, with evidence down
  to `file:line`;
- proposes concrete refactorings and simulates them on a copy of the map;
- compares the map before and after;
- returns PNG pictures of the 3D map (with Chrome, Edge or Chromium installed).

It only reads; it never edits files.

```bash
claude mcp add codemap -- codemap mcp                 # Claude Code, in the project's folder
```

```json
{ "mcpServers": { "codemap": { "command": "codemap", "args": ["mcp", "--root", "${workspaceFolder}"] } } }
```

The JSON is for `.cursor/mcp.json` (Cursor) and most agents' `mcp.json`. The VS Code extension offers the server to
VS Code and Cursor by itself.

Standalone executables (no .NET needed), the VS Code extension and the documentation:
https://github.com/tomeqs/CodeMap
