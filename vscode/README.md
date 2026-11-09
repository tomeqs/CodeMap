# CodeMap 3D for VS Code

An interactive 3D map of your C# solution, TypeScript / JavaScript or Python code (or all of them in one map), inside VS Code and one click away from the code.

![Call flow with its sequence diagram](https://raw.githubusercontent.com/tomeqs/CodeMap/main/docs/img/flow.png)

## What you get

- **Galaxy and City**: projects, namespaces and types (TypeScript: packages, folders and files; Python: projects, packages and modules) laid out as a force graph or a code city. Size, height and colour show any metric (lines, complexity, coupling, git churn, hotspots).
- **Layers**: architecture layers computed from the code, with dependencies that point upwards in red.
- **DI**: services on singleton / scoped / transient planes, for Microsoft DI, NestJS and Angular. Captive dependencies, request scope spreading to its consumers and missing registrations are flagged.
- **Flow**: what a controller action, an Express or Nest route, a handler or a background service calls, in source order and through interfaces to the implementation the container injects. Includes a **sequence diagram** you can copy as Mermaid.
- **Matrix**: a dependency structure matrix in 3D. Who uses whom at a glance, layers along the diagonal, cycles as framed blocks, dependencies against the layers in red; readable even where a graph turns into a hairball.
- **Auto zoom**: fly into a namespace and it opens into its types, then into their members.
- **Insights**: cycles, hotspots, possibly unused code, hidden coupling from git history.

## From the map to the code and back

| | |
|---|---|
| **CodeMap: Open Code Map** | Command palette, or right-click a `.sln` / `.slnx` / `.csproj` / `package.json` / `tsconfig.json` / folder in the Explorer |
| **Open a symbol's code** | *Open* in the details panel, or double-click a method |
| **CodeMap: Show in Code Map** (`Ctrl+Alt+M`) | Selects the method, function, class or file under the cursor on the map |
| **CodeMap: Show Call Flow** | The call flow and sequence diagram of the method or function under the cursor (editor context menu) |
| **CodeMap: Choose What to Analyze…** | Switch to another solution, project or folder of the workspace |

With only C#, CodeMap opens the solution; with only TypeScript / JavaScript or Python, the workspace folder. When the workspace has C# and another language, it asks, and the folder gives one map with the C# projects, the npm packages and the Python projects side by side.

The map updates itself when you save source or project files (`.cs`, `.csproj`, `.ts`, `.js`, `package.json`, `tsconfig.json`…); the camera and the selection stay where they were.

## For AI agents: the MCP server

The extension offers CodeMap's MCP server (`codemap mcp`) to the editor's AI agents: **Copilot's agent mode** in VS Code
(1.101 or newer) and the **Cursor** agent. Nothing to configure: in a trusted workspace the server is in the agent's tool
list, running on the same analyzer as the map. With it, the agent can:

- read the structure before changing the code: layers, coupling, what depends on what, down to `file:line`;
- find spaghetti code, layer violations, DI mistakes, dead code and mistakes inside function bodies (lost exceptions, missed `await`s, `async void`…), with the evidence;
- get concrete refactorings (break a cycle at its cheapest cut, split a god class along its groups of members, move an envious method…), try them on a copy of the map first, and after editing check that the structure really got better;
- look at the 3D map itself: `render_map` returns pictures of any view, with a cycle, a path or a finding lit up (needs Chrome, Edge or Chromium installed).

| | |
|---|---|
| **CodeMap: Copy MCP Server Configuration** | The configuration for another agent: `mcp.json` (Claude Desktop, Windsurf…), `claude mcp add` for Claude Code, or VS Code's format |
| **CodeMap: Add MCP Server to Workspace (mcp.json)** | Writes it to `.cursor/mcp.json` (Cursor) or `.vscode/mcp.json` (VS Code), e.g. to share it with the team or for an editor without the automatic registration |
| `codemap.mcpServer` | `false` stops offering the server to the editor's agents |

The tools, prompts and options are described in the [main README](https://github.com/tomeqs/CodeMap#mcp-server-for-ai-agents).

## Requirements

- **.NET SDK 8 or newer** (`dotnet` on PATH): the extension runs the CodeMap analyzer on it. You don't need to build or restore the solution, although restored projects give more complete results.
- Without .NET, set `codemap.analyzerPath` to the standalone `codemap` executable from the [releases](https://github.com/tomeqs/CodeMap/releases).
- TypeScript and JavaScript are read with the TypeScript compiler bundled with the extension, on the Node.js built into VS Code: no `npm install` of your code and no Node.js installation needed. Frameworks (Express, NestJS, Angular) are recognised from the imports.
- Python is read by the analyzer's Python plugin, on Python 3.9+ and its standard library alone: the interpreter the Python extension chose for the workspace when it is installed, else Python on the `PATH`. Nothing has to be installed into your environment. FastAPI (with `Depends` in the DI view), Flask, Django, Celery, click / typer, pytest and SQLAlchemy are recognised from the imports.

## Settings

| Setting | Default | |
|---|---|---|
| `codemap.liveUpdate` | `true` | Refresh the map when files are saved |
| `codemap.includeTests` | `true` | Include test projects and test files |
| `codemap.includeExternal` | `false` | Include framework, NuGet and npm code |
| `codemap.gitHistory` | `true` | Churn, hotspots and change coupling from git |
| `codemap.renderer` | `auto` | Graphics API of the map: WebGPU where the editor supports it, otherwise WebGL 2 (`webgpu` / `webgl` to prefer one; when it is missing, the other is used) |
| `codemap.mcpServer` | `true` | Offer the MCP server to the editor's AI agents (VS Code agent mode, Cursor) in trusted workspaces |
| `codemap.analyzerPath` | | Use another analyzer (a `codemap` executable or `codemap.dll`) |
| `codemap.dotnetPath` | `dotnet` | The dotnet that runs the bundled analyzer |
| `codemap.nodePath` | | Node.js 18+ for TypeScript / JavaScript instead of the one inside VS Code (for very large code bases: VS Code's Node.js has a lower memory limit) |
| `codemap.pythonPath` | | Python 3.9+ for Python code, instead of the Python extension's interpreter or the one on the `PATH` |

The analyzer only reads the code: it does not build it, run MSBuild or run your scripts. Nothing leaves your machine, and the map has no network access.
