# Changelog

## Unreleased

- **Opening the map no longer leaves the camera inside it.** The map shows the last graph at once and the fresh analysis a moment later; when that second load came before the first layout had settled, the camera stayed in the small starting ball, with oversized, washed-out planets. The same happened when a file was saved during the first layout.
- **A save that changes nothing leaves the map alone.** The same graph is not loaded again (also right after opening, when nothing changed since the last time), and a graph with the same units and links takes its new numbers in place: no new layout, no unfolding, the selection stays. Only a change of structure lays the map out again.
- **Shortcuts are plain keys.** Ctrl/Cmd+C (copying a name from the details) switched to the City, Ctrl+1 changed the level, Cmd+Z toggled the semantic zoom; typing in a text area did the same.
- **One analysis at a time.** A save or Refresh while the Python interpreter was still being looked up started a second analyzer next to the first, and the older result could win.
- **Folders and renames refresh the map**: creating, deleting, moving or renaming a folder of sources, renaming a file, and a save during the first analysis (it was dropped). *Show in Code Map* and *Show Call Flow* asked while the map was starting are no longer lost when the fresh analysis arrives first.
- **Lighter at rest and on hover.** Labels are laid out when the camera, the units or the selection change instead of on every frame; hovering reads the unit's own links, builds the tooltip once per unit, and the quiet flow of particles no longer jumps when the pointer leaves a unit.
- In the browser app, a live update of one project no longer replaces another project that was opened meanwhile.

## 0.4.1

- **Switching views no longer stalls.** Each view brought lights of its own, and the lights are part of the shaders, so every switch (also back to a view seen before, and between Types and Auto) compiled the shaders of the whole map again: up to a second or more without a frame, longer on Windows. One set of lights now serves every view, and the city, the matrix and the layers keep their meshes and materials from one build to the next. The first click on a planet no longer compiles the selection's halo either.
- **A level switch frames the new level** (e.g. Folders → Files), also after the map was turned or zoomed. The camera used to stay where it was, so the files spread out of the screen and the planets looked oversized and washed out.

## 0.4.0

- **Python**, as a third language next to C# and TypeScript / JavaScript, with nothing to install: the analyzer reads it with Python's own parser (Python 3.9 or newer, the standard library alone), on the interpreter the Python extension chose for the workspace (`codemap.pythonPath` sets another one). Projects (`pyproject.toml`, `setup.py`, requirements files) or folders of scripts, packages and modules, with calls, inheritance, Protocols, imports and re-exports resolved from the code itself, and the metrics, cycles, layers and dead code of the other languages.
  - **Frameworks**: FastAPI, Flask, Django and Django REST framework routes with their full paths start the call flows; FastAPI's `Depends` is in the DI view, with its lifetimes and captive dependencies; SQLAlchemy and Django models, Celery tasks, click and typer commands, pytest fixtures.
  - **Checks inside functions** (and in the MCP server): forgotten `await`s, blocking calls in `async def`, bare or swallowed `except`s, `return` in `finally`, mutable default arguments, `== None`, `is` with literals, unused imports and variables…
  - *Show in Code Map* and *Show Call Flow* work in `.py` files, and the map follows changes to Python files.
  - Tested on real repositories (requests, httpx, Flask, microblog, the full-stack FastAPI template, djangoproject.com, Celery, Saleor): pytest fixtures give test parameters their types, SQLAlchemy 2.0's `select()` gives its model, a framework is recognised in its own repository, an example folder named like a package (`examples/pydantic/`) no longer hides it, pytest's `testpaths` are test code, configuration modules and what they name by dotted path (Sphinx extensions, Celery and Django settings) are used, scripts nothing imports are entry points, and private members that code without types may reach are not reported as unused. Saleor's 2,600 modules map in about half a minute.

## 0.3.0

- **An MCP server for AI agents**, `codemap mcp`. The extension offers it to Copilot's agent mode in VS Code (1.101 or newer) and to the Cursor agent by itself, in trusted workspaces (`codemap.mcpServer` turns it off). *CodeMap: Copy MCP Server Configuration* gives the configuration for Claude Code, Claude Desktop and other agents, and *CodeMap: Add MCP Server to Workspace* writes it to `.cursor/mcp.json` or `.vscode/mcp.json`. With it, an agent can:
  - **read the structure** before changing the code: overview of the projects and namespaces with their coupling, instability and layer, any node with what it uses and what uses it, why A depends on B (the references, `file:line`), call flows from the entry points, Mermaid diagrams.
  - **find problems, with evidence**: cycles with their cheapest cut, tangles, hubs, god classes, feature envy, hidden change coupling, shotgun surgery, hotspots, layer violations (computed and by convention), SDP and main-sequence zones, oversized types and methods, DI mistakes (captive dependencies, circular registrations, over-injection), dead code. Each finding has a stable id, its nodes, locations, evidence and a suggestion. A **health score** (A–E) shows how each part counts.
  - **find mistakes inside function bodies**, C# and TypeScript / JavaScript: swallowed exceptions, `throw ex`, `async void`, `.Result` / `.Wait()`, floating promises, `forEach(async …)`, unreachable code, self-comparisons, duplicate `case`s, loose equality, and the compiler's own warnings that point at bugs (nullable warnings only where the project enables them). `codemap --checks` adds them to the map's file too.
  - **get refactorings**: break a cycle, invert a layer violation, move a type or an envious method, split a god class along its groups of members, merge a tiny namespace, delete dead code, fix a DI lifetime. Each with steps in the code, its cost, and what it would fix, checked by a simulation.
  - **try changes first**: `simulate` applies moves, merges, removed or inverted dependencies, extracted interfaces, splits and lifetime changes to a copy of the map and shows what they change.
  - **compare** two maps (a baseline and the code after the edits): score, findings, cycles, dependencies, moved and renamed types and namespaces.
  - **look at the map**: `render_map` returns PNG pictures of any view (galaxy, city, layers, DI, flow, matrix), with a node, a path, a cycle, a DI issue or a finding lit up, drawn in a headless Chrome, Edge or Chromium that closes with the server.

## 0.2.4

- The map starts in editors without WebGL 2 (Cursor or VS Code with hardware acceleration off, a machine without a GPU): it draws with WebGPU instead, whichever renderer is set, rather than failing with "Cannot read properties of null (reading 'getSupportedExtensions')". With neither WebGPU nor WebGL 2, it says so and offers *Open in Browser*.
- C# maps are more accurate:
  - Dependencies that were missing now show up: generic arguments of base types (`IRepository<Order>`), property patterns (`is { Status: … }`), and code under `#if NET6_0_OR_GREATER` or similar SDK symbols. `nameof(Method)` no longer counts as a call.
  - Project files are read the way MSBuild reads them: `Compile` `Remove`/`Include` in order, conditions on the target framework, `EnableDefaultItems=false`. An unreadable subfolder, or a build running at the same time, no longer drops a project.
  - DI: `TryAdd*` of a service that is already registered is ignored, as in the container. Keyed services match `[FromKeyedServices]`. `AddDbContext`'s lifetime argument is applied, and `AddSingleton(typeof(I), instance)` is read correctly. An override after `AddServiceDefaults()`-style extensions in another file wins. Each call of a fluent chain has its own line.
- TypeScript and JavaScript maps are more accurate:
  - A folder or a single file inside a package maps with that package (it used to come out empty or under another name). A workspace package that was built is still read from its sources, so the links between packages stay. Path aliases (`@/…`, `~/…`, tsconfig `paths`) no longer show up as npm packages.
  - Functions put into an object by shorthand (`{ list, place }`) are referenced, so they are no longer reported as unused. `super(…)` reaches the base class' constructor in another package. Overloaded functions keep their size, and Angular components and Nest modules no longer show part of their decorator as their signature.
  - Express: chained routes (`router.route('/x').get(…).post(…)`) and apps or routers typed `express.Express` / `express.Router` are found, and a handler's complexity is counted once.
- Plugins: a broken plugin manifest is reported instead of stopping every analysis, plugins are never loaded from a relative folder (such as the analyzed repository), and a plugin's graph with a parent cycle no longer hangs the analysis.
- Tested on real repositories (eShopOnWeb, eShop, Polly, CleanArchitecture, marten, TanStack Query, excalidraw and the NestJS, Angular and Express "RealWorld" apps), which brought these fixes:
  - C# projects follow MSBuild's imports: `<Import>`ed props files, `Directory.Build.targets` (global usings, test packages), `GetPathOfFileAbove`, `Exists()` conditions and central package versions (`Directory.Packages.props`). A net9/net10 project is mapped with its own framework version when it is installed, unrestored `Microsoft.Extensions.*` packages are backed by the installed framework, and Blazor WebAssembly apps are applications.
  - C# references: when the compiler cannot pick an overload, the one that fits the arguments is used; explicit implementations (`IDisposable.Dispose`) are never "unused". A class is a controller only with ASP.NET evidence, not because of its name. Razor pages and Blazor components (with their `[Inject]` properties) are DI consumers, and the members their markup uses are not "unused".
  - C# DI: closed generic services match their own registrations (`ILookup<Kind>` no longer gets `ILookup<Brand>`'s), factories register what they return (also a cast forward, `sp => (Custom)sp.GetRequiredService<Base>()`), and services from unrestored packages still match by name.
  - TypeScript references: variable annotations (`const Badge: Renderer<Props>`), type parameter constraints and defaults, `require()` variables, top-level code without calls, default exports, parameter decorators and default values, `.d.ts` files next to the code, and symbolic links. JSX closing tags no longer add calls; a constructor injects only its parameter's own type.
  - TypeScript packages and frameworks: entry points from `module` and `exports`, `config` and `barrel` files, `.vue` / `.svelte` / `.astro` files with the imports of their scripts, SvelteKit's `$lib`, file-based routes (Next.js, SvelteKit, SolidStart, Astro, Nuxt), workspace exclusions, more test folders, chained Express routers, Angular standalone providers, and Nest's global prefix.
  - Output: a standalone HTML map opens even when the code holds `<!--<script`; a shallow git clone is reported (its history metrics see only a few commits) and a type over several files counts each commit once; `--types-only` keeps DI references and stats consistent; the warning about unresolved imports says which ones.

## 0.2.3

- New **Matrix** view (`M`): a dependency structure matrix in 3D. Who uses whom, layers along the diagonal, cycles as framed blocks, and the dependencies against the layers in red above the diagonal.

## 0.2.2

- First version on the VS Code Marketplace and Open VSX, as **CodeMap 3D** (`tomeqs.codemap-3d`): the name `codemap` is taken there.
  If you installed an earlier `.vsix`, uninstall *CodeMap* first: both register the same commands. Settings (`codemap.*`) stay as they are.

## 0.2.1

- CodeMap is open source under the MIT license.
- The analyzer is on NuGet: `dotnet tool install -g CodeMap.Tool`.

## 0.2.0

- TypeScript and JavaScript: packages, folders, files and their declarations on the map, with imports, calls, routes (Express, NestJS) and the NestJS / Angular DI containers. Runs on the Node.js inside VS Code; setting `codemap.nodePath` for another one.
- A workspace with C# and TypeScript / JavaScript can be mapped as a whole: one map with both. *CodeMap: Choose What to Analyze…* (was *Choose Solution…*).
- *Show in Code Map*, *Show Call Flow* and `Ctrl+Alt+M` work in TypeScript and JavaScript files; `package.json` and `tsconfig.json` open a map from the Explorer; saving them or a source file refreshes the map.
- The map draws with WebGPU (Metal, Direct3D 12, Vulkan) where VS Code supports it and WebGL 2 otherwise; setting `codemap.renderer`.
- The force layout runs in a worker: large solutions lay out much faster and the editor stays responsive.
- The map draws nothing while nothing moves (less CPU, GPU and battery).
- With WebGPU the force layout runs in compute shaders, on a grid for big maps: up to 100,000 units per level.
- Much faster on big solutions: link aggregation, semantic zoom and automatic layers (20,000 types: 37 s → 0.13 s).
- Living map: glowing, breathing node coronas; a twinkling sky with nebulae; comets flowing along links (also at rest); new graphs burst out of their centre and city buildings rise; a wave of light runs out from a selected node. Appearance → Motion: Living / Calm (battery) / Off.
- Links in focus show moving dashes; a particle density setting.
- Fixed: in the Auto (semantic zoom) view, opened clusters drew all their units at one point.
- The browser viewer has an AR glasses mode (side-by-side 3D for XREAL 1S / One / One Pro); it is not available inside VS Code, where the map cannot go full screen on the glasses.

## 0.1.0

- Code map of the workspace's C# solution in an editor tab: Galaxy, City, Layers, DI, Flow and Auto zoom views.
- Open a symbol's code from the map; show the method or type under the cursor on the map (`Ctrl+Alt+M`); call flow and sequence diagram of the method under the cursor.
- Live refresh on save, cached map for an instant start, Mermaid and JSON saved through VS Code.
