# CodeMap 3D for VS Code

An interactive 3D map of your C# solution or TypeScript / JavaScript code (or both in one map), inside VS Code and one click away from the code.

![Call flow with its sequence diagram](https://raw.githubusercontent.com/tomeqs/CodeMap/main/docs/img/flow.png)

## What you get

- **Galaxy and City**: projects, namespaces and types (TypeScript: packages, folders and files) laid out as a force graph or a code city. Size, height and colour show any metric (lines, complexity, coupling, git churn, hotspots).
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

With only C#, CodeMap opens the solution; with only TypeScript / JavaScript, the workspace folder. When the workspace has both, it asks, and the folder gives one map with the C# projects and the npm packages side by side.

The map updates itself when you save source or project files (`.cs`, `.csproj`, `.ts`, `.js`, `package.json`, `tsconfig.json`…); the camera and the selection stay where they were.

## Requirements

- **.NET SDK 8 or newer** (`dotnet` on PATH): the extension runs the CodeMap analyzer on it. You don't need to build or restore the solution, although restored projects give more complete results.
- Without .NET, set `codemap.analyzerPath` to the standalone `codemap` executable from the [releases](https://github.com/tomeqs/CodeMap/releases).
- TypeScript and JavaScript are read with the TypeScript compiler bundled with the extension, on the Node.js built into VS Code: no `npm install` of your code and no Node.js installation needed. Frameworks (Express, NestJS, Angular) are recognised from the imports.

## Settings

| Setting | Default | |
|---|---|---|
| `codemap.liveUpdate` | `true` | Refresh the map when files are saved |
| `codemap.includeTests` | `true` | Include test projects and test files |
| `codemap.includeExternal` | `false` | Include framework, NuGet and npm code |
| `codemap.gitHistory` | `true` | Churn, hotspots and change coupling from git |
| `codemap.renderer` | `auto` | Graphics API of the map: WebGPU where the editor supports it, otherwise WebGL 2 (`webgpu` / `webgl` to prefer one; when it is missing, the other is used) |
| `codemap.analyzerPath` | | Use another analyzer (a `codemap` executable or `codemap.dll`) |
| `codemap.dotnetPath` | `dotnet` | The dotnet that runs the bundled analyzer |
| `codemap.nodePath` | | Node.js 18+ for TypeScript / JavaScript instead of the one inside VS Code (for very large code bases: VS Code's Node.js has a lower memory limit) |

The analyzer only reads the code: it does not build it, run MSBuild or run your scripts. Nothing leaves your machine, and the map has no network access.
