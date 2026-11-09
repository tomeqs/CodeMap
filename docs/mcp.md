# MCP server for AI agents: reference

`codemap mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server on stdio. An AI agent (Claude Code,
Cursor, Copilot in VS Code…) uses it to:

* read the structure of an application before changing it;
* find spaghetti code, layer violations, DI mistakes and dead code, with evidence down to `file:line`;
* get refactorings, try them on a copy of the map, and check after the edit that the structure got better.

The server only reads; it never edits files. The short version is in the [README](../README.md#mcp-server-for-ai-agents).

## Connect it

Run it in the project's folder, or pass `--root <folder>`. Without `--root`, the server takes the client's first root,
else the current folder.

* **VS Code (agent mode, 1.101+) and Cursor:** the extension offers the server to the editor's agent by itself, in
  trusted workspaces. `codemap.mcpServer: false` turns that off.
  * *CodeMap: Copy MCP Server Configuration* gives the configuration for other agents.
  * *CodeMap: Add MCP Server to Workspace* writes it to `.cursor/mcp.json` or `.vscode/mcp.json`.
* **Claude Code:** `claude mcp add codemap -- codemap mcp`
* **Cursor without the extension**, in `.cursor/mcp.json`:
  ```json
  { "mcpServers": { "codemap": { "command": "codemap", "args": ["mcp", "--root", "${workspaceFolder}"] } } }
  ```
* **VS Code without the extension**, in `.vscode/mcp.json`:
  ```json
  { "servers": { "codemap": { "type": "stdio", "command": "codemap", "args": ["mcp", "--root", "${workspaceFolder}"] } } }
  ```

`codemap` is the ready-made program from the releases or the .NET tool (`dotnet tool install -g CodeMap.Tool`).
TypeScript and JavaScript need Node.js 18+; `CODEMAP_NODE` points at a `node` that is not on `PATH`. Python needs
Python 3.9+; `CODEMAP_PYTHON` points at one that is not on `PATH` (or at a project's virtual environment).

Options: `codemap mcp [path] [--root <dir>] [--no-watch] [--no-checks] [--no-git] [--lang <list>] [--plugins <dir>]
[--browser <path>] [--max-output <n>]`.

## Tools

| Tool | What it gives the agent |
|---|---|
| `analyze` | Maps a folder, solution or project, or loads a `.codemap.json`. Returns the size of the map, the health score and the worst findings. Long analyses go on in the background; `refresh: true` after code changes. |
| `overview` | Projects or namespaces with size, coupling (Ca, Ce), instability, abstractness, distance and layer. Also the layers with their upward dependencies, the score, hotspots, DI, and an optional Mermaid diagram. |
| `list_findings` | The [findings](analysis.md#findings-and-the-health-score), worst first: by category, rule, severity or part of the code; brief or with all the evidence; paged. |
| `describe_node` | One node: its declaration, metrics, members, what it uses and what uses it, calls and callers, DI, cycles and findings. |
| `explain_dependency` | Why A depends on B: the references behind it (`file:line`), whether it points up or is in a cycle. Without a direct dependency, the shortest chains. |
| `search_nodes` | Nodes by name, kind, level, tags and metric range, sorted by a metric (e.g. the most complex methods). |
| `call_flow` | The entry points (controllers, handlers, background services, routes…), or what one does: the call tree through interfaces to the implementation DI injects, and a sequence diagram. |
| `diagram` | Mermaid: dependencies, layers, one cycle with its cheapest cut, a class with its neighbours, DI wiring, a sequence. |
| `propose_refactorings` | Turns findings into concrete refactorings, worst problems first: break a cycle at its cheapest cut, invert a layer violation, move an envious method, split a god class along its groups of members (modularity clustering), merge a tiny namespace, delete dead code, fix a DI lifetime. Each comes with steps in the code (`file:line`), its cost, and the `simulate` operations. A simulation then shows what it really fixes, and candidates that would add a cycle are dropped. |
| `simulate` | Tries refactorings on a copy of the map, without touching the code: move types, members or namespaces, merge namespaces, remove or invert dependencies (an interface where the user is), extract interfaces, split types, remove dead code, change DI lifetimes. Shows what each would change: the score, findings, cycles, layers. The result (`sim-N`) is a graph every tool reads. |
| `compare` | What changed between two maps (a baseline and the current map after edits): the score and each part, findings resolved and new, cycles and upward dependencies, dependencies, moved and renamed types and namespaces, metrics. |
| `snapshots` | Saves the current map as a named baseline before refactoring; every tool takes `graph: "<name>"`. |
| `render_map` | A PNG of the 3D map with a caption of what it shows (view, level, units, the HUD and the legend). Any view (galaxy, city, layers, DI, flow, matrix) at any level, with a node and its neighbours, dependencies or dependents lit up, a path between two nodes, a cycle, a DI issue, a call flow, or any nodes highlighted (e.g. those of a finding). |

A typical session: `analyze` → `overview` → `list_findings` → `propose_refactorings` → `simulate` → (the agent edits
the code) → `analyze {refresh: true}` → `compare`.

## Prompts and resources

* **Prompts:** `review_architecture`, `plan_refactoring` and `check_changes` start the usual tasks. In Claude Code they
  are `/mcp__codemap__review_architecture` and so on.
* **Resources:**
  * `codemap://rules` describes every finding rule (what it finds, its thresholds, why it matters);
  * `codemap://operations` describes the operations `simulate` takes.

## Checks inside function bodies

`analyze` also checks the code inside function bodies; `checks: false`, or `codemap mcp --no-checks`, turns that off.
Its problems are findings of the `code` category ([the rules](analysis.md#checks-inside-function-bodies)).

## Pictures

* `render_map` draws in a headless Chrome, Edge or Chromium, found where each system installs them or in Playwright's
  cache. `codemap mcp --browser <path>` or `CODEMAP_BROWSER` points at another one.
* No GPU is needed: the map is drawn with WebGL 2 on SwiftShader. `CODEMAP_RENDERER=webgpu` tries WebGPU.
* A map with over 3,000 types is drawn by namespace unless a level is asked for.
* Without a browser, `diagram` draws the same structure in Mermaid.
* The browser is closed after 10 minutes without a picture, and with the server: when the client closes it, stops it
  with SIGTERM or Ctrl+C, or (on Windows) kills it. Only a hard kill (SIGKILL) on Linux or macOS leaves it running.

## Answers

* Every answer is JSON, with a `meta` block.
* `meta.stale` says the sources changed since the analysis.
* Answers over 30,000 characters (`--max-output`) have their longest lists shortened, and `meta.truncated` says so.
* Names can be ids, full names, names or the end of a full name (`Orders.OrderService`); an ambiguous one returns the
  candidates.
