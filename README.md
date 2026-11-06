# CodeMap

**A code map for C# and TypeScript / JavaScript**: an analyzer (Roslyn for C#, the TypeScript compiler API in a plugin
for TypeScript and JavaScript, more languages as [plugins](docs/plugins.md)) that turns code into a graph of relationships
(classes, interfaces, methods, functions, calls, imports, inheritance, dependency injection…), and an interactive
**3D map** with six views: *Galaxy* (a force-directed graph in space), *City* (a code city where types are buildings),
*Layers* (architecture layers computed from the code), *DI* (the dependency injection container with service lifetimes),
*Flow* (the call flow from an entry point, with a sequence diagram) and *Matrix* (a dependency structure matrix in 3D).

```
codemap MySolution.sln            →  MySolution.codemap.json   (the graph: a format for further processing)
                                     MySolution.html           (interactive 3D map, works offline)
                                     MySolution.md             (report: layers, DI, cycles, hotspots, dead code…)
```

| Galaxy: types as stars, projects as solar systems | City: height = complexity, colour = hotspot |
|---|---|
| ![galaxy](docs/img/galaxy.png) | ![city](docs/img/city.png) |
| **Layers: upward dependencies (red) break the layers** | **DI: a singleton holding a scoped service (captive dependency)** |
| ![layers](docs/img/layers.png) | ![di](docs/img/di.png) |
| **Flow: the call flow from a controller action, with a sequence diagram** | **Auto: semantic zoom, a type unfolded into its members** |
| ![flow](docs/img/flow.png) | ![zoom](docs/img/zoom.png) |

## Quick start

### Ready-made program (nothing to install)

Download the file for your system from [Releases](https://github.com/tomeqs/CodeMap/releases),
unpack it and run `codemap` (on Windows, double-click `codemap.exe`). A browser opens with the project picker.

| System | File |
|---|---|
| Windows (Intel/AMD, ARM) | `codemap-<version>-win-x64.zip`, `…-win-arm64.zip` |
| macOS (Apple Silicon, Intel) | `codemap-<version>-osx-arm64.tar.gz`, `…-osx-x64.tar.gz` |
| Linux | `codemap-<version>-linux-x64.tar.gz`, `…-linux-arm64.tar.gz` |

It is a single executable (about 50 MB) with .NET built in, so it runs without .NET, and next to it a `plugins/`
folder with the TypeScript / JavaScript plugin (which needs Node.js 18+; without it only C# is mapped). If the .NET SDK
is installed, `codemap` still finds it and uses its libraries (the newest version) to resolve framework types.
`codemap --version` shows where it takes them from.

* **Windows**: the file is not signed, so SmartScreen may show a warning (*More info → Run anyway*).
* **macOS**: after downloading in a browser, remove the quarantine flag: `xattr -d com.apple.quarantine ./codemap`.
* Add the program's folder to `PATH` so `codemap` works from any terminal and in IDE shortcuts.

### As a .NET tool

Requires the .NET SDK 8 or newer. Node.js 18+ is needed for TypeScript / JavaScript (and to rebuild the viewer).

```bash
dotnet tool install -g CodeMap.Tool           # from nuget.org

# or from a .nupkg from Releases, or built locally
dotnet pack src/CodeMap.Cli -o nupkg
dotnet tool install -g CodeMap.Tool --add-source nupkg

codemap            # opens the app in the browser
```

### VS Code extension

The map opens in an editor tab, and you go from the code to the map and back in one click:

* **CodeMap: Open Code Map** from the command palette, or right-click a `.sln` / `.slnx` / `.csproj` / `package.json` / `tsconfig.json` / folder in the Explorer;
  when the workspace has both C# and TypeScript / JavaScript, the extension asks, and the folder gives one map with both;
* **Open** in the details panel (or double-click a method) opens the code in the editor next to the map;
* **Show in Code Map** (`Ctrl+Alt+M`) selects the method, function, class or file under the cursor on the map (C#, TypeScript, JavaScript);
* **Show Call Flow** (editor context menu) shows the call flow and sequence diagram of the method or function under the cursor;
* after saving a `.cs`, `.ts` or `.js` file, a project or `package.json`, the map refreshes itself and keeps the camera and selection;
* Mermaid and JSON are saved through VS Code's save dialog.

Install it from the Extensions view: search for **CodeMap 3D** (`tomeqs.codemap-3d`; VS Code Marketplace, and Open VSX for Cursor, VSCodium and others), or
take `codemap-<version>.vsix` from [Releases](https://github.com/tomeqs/CodeMap/releases) and use
*Extensions → … → Install from VSIX…* or `code --install-extension codemap-<version>.vsix`. The extension contains the
analyzer (it needs the .NET SDK 8+, which you have for C# anyway). Without .NET, set `codemap.analyzerPath` to the standalone `codemap` executable.
TypeScript and JavaScript are analyzed by the plugin bundled with the extension, on the Node.js built into VS Code (another one: `codemap.nodePath`).
The extension's code is in [`vscode/`](vscode/).

### Releasing a new version

The [`.github/workflows/release.yml`](.github/workflows/release.yml) workflow runs the tests and builds the program
for 6 platforms. For each one it checks that the program starts and analyzes the sample solution, and it also packs the .NET tool
and the VS Code extension (`.vsix`).

```bash
git tag v0.3.0 && git push origin v0.3.0     # GitHub release with the files and SHA256 checksums
```

The workflow can also be run by hand (*Actions → Release → Run workflow*). Given a version (e.g. `0.3.0`), it creates the tag `v0.3.0`
and the release itself. Without a version, the files only go to the run's artifacts.
Optional repository secrets publish further: `NUGET_API_KEY` sends the tool to nuget.org
(`dotnet tool install -g CodeMap.Tool`), `VSCE_PAT` the extension to the VS Code Marketplace, and `OVSX_PAT` to Open VSX (VSCodium, Cursor). To build the program for one platform locally:

```bash
dotnet publish src/CodeMap.Cli -c Release -r win-x64 -o dist/win-x64     # or linux-x64, osx-arm64…
```

### The app in the browser (the most convenient way)

`codemap` without arguments starts a local server (`127.0.0.1` only) and opens the browser
with the project picker:

* **folder browser**: you see right away where solutions (◆), projects and packages (●) are, with their language (C#, TS); double-click analyzes;
  a folder with a solution and TypeScript code next to it is analyzed as a whole, as one map;
* **clone from Git**: paste a repository URL, and CodeMap clones it to `~/.codemap/repos` and finds the solution itself;
* **recent projects**: saved maps open instantly from the cache (`~/.codemap/cache`);
* **live analysis progress**, which you can cancel;
* **↻** on the map: analyze again without losing the camera, filters and selection;
* **Live**: the map refreshes itself when you save a `.cs`/`.csproj`, `.ts`/`.js`, `package.json` or `tsconfig.json` file,
  and a toast shows how many types were added or removed (`node_modules` and build output are ignored).

```bash
codemap                                   # project picker
codemap ui path/to/MySolution.sln         # analyzes the given solution right away
codemap ui . --watch                      # current folder + live refresh
codemap ui --port 6000 --no-open          # another port, without opening the browser
```

The server only accepts connections from `127.0.0.1`, rejects foreign `Host` headers (DNS rebinding),
and every API call needs a session token that is injected only into the page served
by `codemap`. Other pages open in the browser therefore cannot use it.

### IDE shortcut

**Visual Studio**: *Tools → External Tools… → Add*
* Command: `%USERPROFILE%\.dotnet\tools\codemap.exe` (or the path to the downloaded `codemap.exe`)
* Arguments: `ui "$(SolutionDir)$(SolutionFileName)" --watch`

**JetBrains Rider**: *Settings → Tools → External Tools*, Program `codemap`, Arguments `ui "$SolutionPath$" --watch`.

**VS Code** (without the extension): `.vscode/tasks.json`
```json
{
  "version": "2.0.0",
  "tasks": [{ "label": "CodeMap", "type": "shell", "command": "codemap ui \"${workspaceFolder}\" --watch", "isBackground": true, "problemMatcher": [] }]
}
```

### Generating files (CI, reports)

```bash
# analyze a solution (.sln / .slnx / .slnf), a project (.csproj), a .cs file or any folder
codemap path/to/MySolution.sln -o out --open
# without installing: dotnet run --project src/CodeMap.Cli -- path/to/MySolution.sln -o out
```

Open `out/MySolution.html` in a browser. The file is self-contained (viewer and data in one file),
so you can email it or attach it to CI artifacts.

Projects **don't need to be built**. CodeMap reads `.csproj` files directly and takes framework types
from the installed .NET. If `dotnet restore` has run, types from NuGet packages are recognised too
(through `obj/project.assets.json`).

### TypeScript and JavaScript

With **Node.js 18+** on the machine, CodeMap also maps TypeScript and JavaScript (the `analyzers/typescript` plugin,
included in releases; the VS Code extension uses the Node.js built into VS Code). The unit of the map is the **file**: packages (`package.json`) → folders → files → declarations
(classes, interfaces, functions, types, constants) and class members. Edges: `imports` between files, calls (in order,
also through `index.ts` barrel files and through interfaces), `new` and JSX, inheritance and implementations, types in signatures
and annotations (also the constraints and defaults of type parameters), decorators (also of parameters), CommonJS `require()`,
npm packages and dependencies between monorepo packages (workspaces), all without `npm install`. Code at the top of a file
(`module.exports = {…}`, assignments, `export default {…}`) is a member of its own, so what it uses is not "unused".

Single-file components (`.vue`, `.svelte`, `.astro`) are files on the map with the imports of their scripts. Entry points
come from `package.json` (`main`, `module`, `bin`, `exports`, also when built to `build/<format>/`), from files that run code,
and from file-based routing (Next.js, SvelteKit, SolidStart, Astro, Nuxt). SvelteKit's `$lib` is `src/lib`. In a workspace
(`pnpm-workspace.yaml`, `workspaces`), a package it excludes gets its dependencies on workspace names from npm.

Frameworks recognised from the imports:

* **Express**: every `app.get('/orders/:id', …)` / `router.post(…)` / `router.route(…).put(…)` is its own route node
  (`GET /orders/:id`, with the prefix from `app.use('/catalog', router)`, also through chains such as
  `Router().use('/api', Router().use(articles))`); the code of inline handlers belongs to the route, named handlers
  and middleware are called by it. The Flow view starts from the routes.
* **NestJS**: controllers (routes with their full path, including `app.setGlobalPrefix(…)`), providers, guards, interceptors, modules, GraphQL resolvers, gateways,
  `@Cron`/`@MessagePattern`… as entry points, and in the DI view Nest's container: module providers (`useClass`, `useValue`,
  `useFactory`, `useExisting`, tokens), `Scope.REQUEST`/`TRANSIENT` scopes, `@Inject`, `@InjectRepository`, `@Optional`.
  CodeMap shows where the request scope "spreads" to dependent services (a note, not an error) and where an interface is injected without a token.
* **Angular**: components, directives, pipes, modules and services; `providedIn: 'root'`, module and component providers,
  standalone applications (`bootstrapApplication(App, { providers })`, `ApplicationConfig`, `provideX(new T())`), `inject()`. An error when a root service needs something only components provide.

```bash
codemap path/to/app                 # a folder with package.json / tsconfig.json
codemap path/to/repo                # C# and TypeScript in one repo: one map of both languages
codemap path/to/repo --lang csharp  # one language only
codemap --version                   # which languages are available (and whether Node.js is there)
```

Example: [`samples/shop-ts`](samples/shop-ts) is a shop in TypeScript (a NestJS API, an Express gateway, an Angular front end
on a shared domain library), with a deliberate cycle, dead code and DI container problems. `codemap samples/shop-ts`
maps the TypeScript alone, and `codemap samples` gives one map of it and the C# solution [`samples/Shop`](samples/Shop) side by side
(the levels are then called "Projects / Packages", "Types / Files"…). Maps of different languages have no edges
between them yet (e.g. HTTP calls from TypeScript to C# controllers).
[`samples/Booking`](samples/Booking) has both languages in one folder (an ASP.NET Core API and a TypeScript client):
it is a test bed that contains the edge cases of C# and TypeScript mapping, each listed with what its map must show.

How to add another language: [docs/plugins.md](docs/plugins.md).

### CLI options

| Option | Meaning |
|---|---|
| `-o, --output <dir>` | output directory (default `codemap-out`) |
| `-f, --format <list>` | `json,html,md,dgml,graphml,cypher` or `all` (default `json,html,md`) |
| `--external` | include BCL / NuGet / npm types the code depends on (e.g. `DbContext`, `ILogger<T>`) |
| `--types-only` | drop member nodes (methods, fields…) and lift their relationships to the types; a much smaller file |
| `--no-tests` | skip test projects and test files |
| `--generated` | also analyze generated code (`*.g.cs`, `*.Designer.cs`, `<auto-generated>`) |
| `--lang <list>` | only these languages, e.g. `csharp`, `typescript` (default: every language found in the folder) |
| `--plugins <dir>` | an extra folder with language plugins ([docs/plugins.md](docs/plugins.md)) |
| `--no-git` / `--git-since "1 year ago"` | git history: churn, authors, hotspots |
| `--indent` | indented JSON |
| `--open` | open the map in the browser |
| `--port <n>` / `--no-open` / `--watch` | app options (`codemap` / `codemap ui`) |
| `codemap export graph.codemap.json -f dgml,cypher` | convert an existing graph to other formats |
| `codemap mcp [path]` | run as an MCP server for AI agents ([below](#mcp-server-for-ai-agents)) |

## MCP server for AI agents

`codemap mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server on stdio. With it, an AI agent (Claude Code,
Cursor, VS Code Copilot…) can:
* read the structure of an application from the map before changing it;
* find spaghetti code, layer violations, DI mistakes and dead code, with evidence down to `file:line`;
* check after a refactoring that the structure got better.

The server only reads; it never edits files.

**Add it to an agent** (run in the project's folder, or pass `--root <folder>`):

* Claude Code: `claude mcp add codemap -- codemap mcp`
* Cursor, in `.cursor/mcp.json`:
  ```json
  { "mcpServers": { "codemap": { "command": "codemap", "args": ["mcp"] } } }
  ```
* VS Code, in `.vscode/mcp.json`:
  ```json
  { "servers": { "codemap": { "type": "stdio", "command": "codemap", "args": ["mcp", "--root", "${workspaceFolder}"] } } }
  ```

`codemap` is the [ready-made program](#ready-made-program-nothing-to-install) or the [.NET tool](#as-a-net-tool). Without
`--root`, the server takes the client's first root, else the current folder. TypeScript and JavaScript need Node.js 18+;
`CODEMAP_NODE` points at a `node` that is not on `PATH`.

| Tool | What it gives the agent |
|---|---|
| `analyze` | Maps a folder, solution or project, or loads a `.codemap.json`. Returns the size of the map, the health score and the worst findings. Long analyses go on in the background; `refresh: true` after code changes. |
| `overview` | Projects or namespaces with size, coupling (Ca, Ce), instability, abstractness, distance and layer. Also the layers with their upward dependencies, the score, hotspots, DI, and an optional Mermaid diagram. |
| `list_findings` | The [findings](#3-insights-you-dont-see-in-the-ide), worst first: by category, rule, severity or part of the code; brief or with all the evidence; paged. |
| `describe_node` | One node: its declaration, metrics, members, what it uses and what uses it, calls and callers, DI, cycles and findings. |
| `explain_dependency` | Why A depends on B: the references behind it (`file:line`), whether it points up or is in a cycle. Without a direct dependency, the shortest chains. |
| `search_nodes` | Nodes by name, kind, level, tags and metric range, sorted by a metric (e.g. the most complex methods). |
| `call_flow` | The entry points (controllers, handlers, background services, routes…), or what one does: the call tree through interfaces to the implementation DI injects, and a sequence diagram. |
| `diagram` | Mermaid: dependencies, layers, one cycle with its cheapest cut, a class with its neighbours, DI wiring, a sequence. |
| `snapshots` | Saves the current map as a named baseline before refactoring; every tool takes `graph: "<name>"`. |

* **Prompts:** `review_architecture`, `plan_refactoring` and `check_changes` start the usual tasks.
* **Resources:** `codemap://rules` describes every finding rule (what it finds, its thresholds, why it matters).
* **Answers:**
  * every answer is JSON, with a `meta` block;
  * `meta.stale` says the sources changed since the analysis;
  * answers over 30,000 characters (`--max-output`) have their longest lists shortened, and `meta.truncated` says so;
  * names can be ids, full names, names or the end of a full name (`Orders.OrderService`); an ambiguous one returns the candidates.

## What makes the code map interesting

A list of classes says little. The value of the map comes from the **relationships** and from what can be computed from them.

### 1. Relationships: 19 kinds of edges, weighted (number of occurrences)

| Kind | C# example | What for |
|---|---|---|
| `inherits`, `implements` | `class Order : AggregateRoot, IAuditable` | hierarchies, contracts |
| `implements` (method → interface method) | `HandleAsync` → `ICommandHandler.HandleAsync` | navigating through abstractions |
| `overrides` | `override decimal DiscountFor(...)` | polymorphism |
| `calls` | `_repo.AddAsync(order)` | the method → method call graph |
| `instantiates` | `new OrderLine(...)` | who creates objects (factories, `new` in the wrong places) |
| `injects` | `public Handler(IOrderRepository repo)` / primary ctor | **the DI dependency graph**, the real architecture of the application |
| `holds` | `private readonly List<Order> _orders` | composition and aggregation |
| `accesses` | `order.Total`, `_clock.Now` | reads/writes of fields and properties (class cohesion) |
| `subscribes` | `bus.Published += OnPublished` | hidden flows through events |
| `throws`, `catches` | `throw new DomainException(..)` | exception flow |
| `returns`, `accepts` | method signatures | API contracts |
| `extends` | `static IServiceCollection AddShop(this IServiceCollection s)` | extension methods |
| `decoratedWith` | `[ApiController]`, `[Fact]` | attributes |
| `uses` | `typeof(X)`, static calls, `is X` | other dependencies |
| `projectReference`, `packageReference` | `.csproj` | architecture at the project level |
| `changesWith` | two files changed in the same commits | **hidden coupling** from git history (not a dependency in the code) |

TypeScript adds `imports` between files.

### 2. Metrics (at every level: project → namespace → type → member)

* **size**: LOC, number of members, methods, fields…
* **cyclomatic complexity** of every method and the sum per type (WMC)
* **coupling**: `Ca` (how many types use me), `Ce` (how many types I use), **instability** `Ce/(Ca+Ce)`
* **abstractness** and **distance from the main sequence** (Robert C. Martin) for namespaces and projects,
  which shows the "zone of pain" (concrete and heavily used) and the "zone of uselessness"
* **DIT / NOC**: depth of inheritance and number of subclasses
* **fan-in / fan-out** of methods

### 3. Insights you don't see in the IDE

* **Hotspots** = complexity × change frequency from git. Code that is complicated *and* constantly
  changing is the best candidate for refactoring (Adam Tornhill's approach, "Your Code as a Crime Scene").
* **Dependency cycles** (Tarjan SCC) between types, namespaces and projects.
* **Architecture layers** computed from the code alone: every namespace and project gets a layer number
  (dependencies should point down), and **upward dependencies** are the minimal set of edges whose
  removal breaks all the cycles, i.e. the best places to cut.
* **Hidden coupling from git** (change coupling): types that keep changing together
  (shared commits / average number of changes) but have no dependency on each other in the code.
  Usually duplicated logic, a hidden contract (e.g. a JSON format, a queue name) or a client–server pair.
* **DI map**: registrations from `IServiceCollection` (`AddSingleton/Scoped/Transient`, `TryAdd*`, `Keyed*`,
  `AddHostedService`, `AddDbContext`, `AddHttpClient<T>`, factories and forwardings), the lifetime of every service,
  and from that **captive dependencies** (a singleton holding a scoped or transient service)
  and **missing registrations** (a constructor needs something nobody registers).
  Controllers, hubs and middleware activated by the framework are taken into account too.
  For TypeScript the same view shows the NestJS and Angular containers.
* **Dead code candidates**: non-public symbols nothing refers to.
* **Roles** recognised heuristically: controller, DbContext, repository, handler (MediatR/CQRS),
  hosted service, middleware, test, options, DTO, extensions…
* **Impact analysis** (in the viewer): what breaks if I change this type (transitive reverse dependencies),
  and the **path** between any two elements ("how does the controller reach the database?").
* **Findings and a health score** (in the `.md` report): 33 rules read the map for problems. Each finding comes with
  its evidence: the nodes, `file:line` places, the numbers against their thresholds, and what usually fixes it.
  * **Spaghetti:**
    * cycles at every level, each with the cheapest cut;
    * tangles of 8+ types and hubs;
    * god classes and feature envy (Lanza–Marinescu: WMC, ATFD, TCC, LAA, FDP);
    * hidden change coupling, shotgun surgery and hotspots.
  * **Structure:**
    * inner layers depending on outer ones, by their names (Domain → Infrastructure);
    * stable modules depending on volatile ones (Martin's SDP);
    * the zones of pain and uselessness;
    * large types, and long or complex methods with long parameter lists;
    * deep inheritance and middle men;
    * one-type namespaces and tiny projects;
    * production code using test code;
    * interfaces nothing implements.
  * **DI:** the issues above, circular wiring and constructor over-injection.
  * **Dead code**, grouped by type.

  Test code, generated code and EF migrations are left out. The score is
  `100 − (25·cycles + 20·layers + 20·coupling + 20·findings + 15·size)`, graded A–E, and the report shows what each part
  costs. `FindingsAnalysis.Compute(graph)` gives the same in code.

## Data format

The main format is **CodeMap JSON** (`*.codemap.json`): readable for people, easy to load
in any language and for LLMs. Nodes form a containment tree (`parent`), edges describe the other relationships.
C# identifiers are the standard C# *documentation comment IDs* (`T:Shop.Domain.Orders.Order`,
`M:Shop.Domain.Orders.Order.AddLine(Shop.Domain.Catalog.Product,System.Int32)`), so they are stable
between runs and match what XML docs and Roslyn use. Other languages use their own prefix (TypeScript: `ts:<package>:<file>#<name>`).

```json
{
  "format": "codemap", "version": "1.1",
  "nodes": [
    { "id": "T:Shop.Domain.Orders.Order", "kind": "class", "name": "Order",
      "parent": "namespace:Shop.Domain/Shop.Domain.Orders", "project": "project:Shop.Domain",
      "signature": "public sealed class Order : AggregateRoot",
      "location": { "file": "src/Shop.Domain/Orders/Order.cs", "line": 8, "endLine": 69 },
      "tags": ["in-cycle", "hotspot"],
      "metrics": { "loc": 62, "complexity": 16, "ca": 13, "ce": 10, "instability": 0.435 } }
  ],
  "edges": [
    { "source": "M:Shop.Application.Orders.PlaceOrderHandler.HandleAsync(...)",
      "target": "M:Shop.Domain.Orders.Order.Place", "kind": "calls", "weight": 1 }
  ],
  "analysis": { "cycles": [...], "hotspots": [...], "layers": [...], "changeCoupling": [...], "di": {...} }
}
```

Full specification: [docs/format.md](docs/format.md), JSON Schema: [docs/codemap.schema.json](docs/codemap.schema.json).

Other formats:

* **DGML**: opens natively in Visual Studio (Code Map / DGML editor), grouped project → namespace → type.
* **GraphML**: Gephi, yEd, Cytoscape, NetworkX.
* **Cypher**: import into Neo4j/Memgraph, then queries such as
  `MATCH p=(c:Class {name:'OrdersController'})-[:CALLS|INJECTS*1..6]->(r:Interface) RETURN p`.
* **Markdown**: an architecture overview report you can paste into a PR, a wiki or a prompt.

## The 3D map

* **Galaxy**: a 3D force-directed graph. Projects are "solar systems", namespaces clusters, types stars.
  The shape shows the kind (● class, ◆ interface, ■ struct, ⬟ record, ▲ enum), the size a chosen metric,
  and the colour the project, kind, role or any metric (*turbo* scale). When an element is selected,
  particles flow along its edges in the direction of the dependency.
* **City**: a code city. Districts are projects, blocks namespaces, buildings types.
  The footprint is LOC, the height complexity (or another metric), and the colour e.g. hotspots.
  Relationships are drawn as arcs over the city.
* **Layers**: nodes lie on horizontal planes of the layers computed from the visible relationships
  (projects are columns through the layers). Dependencies pointing upwards are red.
* **DI**: types built by the container on *Singleton / Scoped / Transient / Not registered* planes.
  A healthy dependency points down or sideways (to something that lives at least as long),
  a captive dependency is red, and a missing registration orange.
* **Flow**: what happens when you call a controller action, a handler, a route or a background service's `ExecuteAsync`.
  Calls are followed in source order, through interfaces down to the implementation the DI container injects
  (`IEnumerable<T>` → all of them). The top plane is the entry point, and each lower one is one call deeper.
  The **sequence diagram** shows the same flow as participants (types) and messages (`alt` for several possible implementations, `loop` for `IEnumerable<T>`).
  It can be copied as **Mermaid** (paste it into GitHub, GitLab, Notion or docs) or downloaded as `.mmd` / `.svg`.
  You choose the entry point in Insights (*Entry points*), in the list in the view, or with the *Call flow ↘* button on any method.
* **Matrix**: a dependency structure matrix (DSM) in 3D. The projects, namespaces or types (TypeScript: packages,
  folders, files) are on both axes in the same order, one tile each on the diagonal, and a column stands in cell
  (row, column) when the row uses the column: the taller and brighter, the more references. The order puts every cycle
  in one framed block on the diagonal and the blocks in layers (bands along the diagonal, the bottom layer first),
  so every dependency that follows the layers is below the diagonal; the ones against them stand above it, in red.
  Click a tile to light up its row (what it uses) and column (who uses it), a column to select that dependency
  (the HUD lists what it is made of: calls, injects…); double-click a tile to go into it. Unlike a graph, it stays readable
  when there are many links. Up to 400 rows; beyond that, drill into a project or namespace.
* **Auto (semantic zoom)**: instead of switching levels, you just fly the camera. From afar a namespace is one star
  in the middle of its types. As you get closer it unfolds into its types, and the nearest types into their members (methods, properties, fields).
  Moving away folds everything back. The layout is computed once, so the map doesn't rearrange, and search flies to a member hidden in a folded type by itself.
* Levels of detail: **Projects / Namespaces / Types / Members** (TypeScript: Packages / Folders / Files / Declarations) and drill-down by double-click
  (project → namespaces → types → members, with "ghosts" of neighbours outside the scope).
* Details panel: signature, XML documentation, metrics, tags, an *Open in VS Code* link,
  outgoing and incoming relationships grouped by kind, list of members.
* **Neighbours / Dependencies ↓ / Impact ↑ / Path to…** (or Shift+click on a second element).
* **Insights** tab: entry points (controllers, handlers, routes, background services, `Main`), DI problems, upward dependencies, hidden coupling from git, cycles, hotspots,
  most complex types, most used types, possible dead code. A click takes you to the right view.
* **DI lifetime** colour in every view (namespaces and projects get the dominant lifetime of their types),
  and *Dependency injection* and *Changes together with* sections in the details panel.
* Filters for relationship kinds, projects, tests, external types, minimum link strength.
* Search (`/`), shortcuts: `1`–`4` level, `Z` semantic zoom, `G`/`C`/`L`/`D`/`E`/`M` view (Galaxy, City, Layers, DI, Flow, Matrix), `F` fit, `Esc` back.

The viewer can also be opened without data: drop any `*.codemap.json` file on it
or use the `?data=url.json` parameter.

### GPU

* The map draws with **WebGPU**: Metal on macOS, Direct3D 12 on Windows, Vulkan on Linux.
  When the browser (or VS Code) has no WebGPU, it falls back to **WebGL 2**. Without a GPU, recent Chromium
  (and editors built on it, such as VS Code and Cursor with hardware acceleration off) may have no WebGL 2 but a
  software WebGPU: the map then draws with that. With neither, it says so and the editor offers *Open in Browser*.
  The preferred backend can be set in the *Data* tab (*Graphics → Renderer*), with `?renderer=webgpu|webgl`
  or with the `codemap.renderer` setting in VS Code; when it is missing, the other one is used.
* The force layout runs on the **GPU** (WebGPU compute shaders): all nodes in parallel. Positions go straight
  into a texture the shaders draw from, and only come back to the CPU about every 200 ms (labels, picking, camera).
  Repulsion between up to 12,000 elements is computed exactly, in tiles in the workgroup's shared memory.
  Above that it is computed on a grid: nodes are sorted into cells every step, near neighbours in pairs,
  farther ones through the cells' centres of charge on several levels. The result is within 1% of the exact one.
  `?layoutMode=grid|exact` forces the mode. Up to 100,000 elements per level.
* Without WebGPU the layout runs in a **Web Worker**, so the map and the UI stay smooth (up to 15,000 elements).
  Without a worker, e.g. when a CSP blocks it, the main thread computes it with a limit of 7,000. Small graphs (up to 300 elements)
  are laid out right away on the main thread. `?layout=gpu|worker|main` forces the choice.
* Element positions live in a texture on the GPU. Nodes, links (soft-edged ribbons, arcs in City)
  and flowing particles read them in shaders, so moving the graph is one texture upload per frame
  instead of rewriting matrices and vertices. At 20,000 elements the CPU cost of a frame dropped from 5 ms to 0.25 ms.
* Effects computed in shaders, with no CPU cost per frame:
  - **Glow:** bloom over the whole scene and a soft, breathing corona around every node.
  - **Sky:** thousands of stars twinkling each in its own rhythm, a few brighter ones with a sparkle, coloured nebulae in the background.
  - **Comets:** particles with a tail flow along relationships towards the dependency. On a living map they also flow without a selection,
    along the strongest relationships. Set the density in *Particles* (Off / Few / Normal / Many).
  - **Dashes:** selected and highlighted relationships, problems (e.g. upward dependencies) and *Flow particles on all links*
    have flowing dashes, so the direction is visible even without particles.
  - **Unfolding:** a new graph bursts out of a tight ball, and nodes after a drill-down come out of their parent.
    In City, the buildings rise from the ground.
  - **Wave:** after a click, a wave of light runs out from the node along its relationships, node by node, with a shock ring.
* Large solutions: the model, link aggregation, semantic zoom and automatic layers work on numeric indices.
  Layers for 20,000 types take 0.13 s (previously 37 s), and for 100,000 types about 0.9 s.
* Set the motion in *Appearance → Motion*:
  - **Living** (default): the map lives at the screen's full fps and only pauses on a hidden tab.
  - **Calm (battery):** decorations run at 30 fps and stop 20 s after the last mouse movement, and a still map uses no GPU.
    This is the default without a GPU and with the system's *reduce motion*.
  - **Off:** nothing moves by itself.

  The choice is kept in the browser; `?motion=living|calm|off` forces the mode.
* Native renderers (Metal / Direct3D 12 outside the browser) are a separate topic: [tomeqs/CodeMap#6](https://github.com/tomeqs/CodeMap/issues/6).

### AR glasses (XREAL 1S / One / One Pro)

The map can float in your room in AR glasses that take side-by-side 3D over USB-C.
It works in the browser (`codemap ui`, an HTML file from `codemap -f html`, `npm run dev`), not in the VS Code panel.

1. Connect the glasses to the computer (e.g. a Mac) as an extended display.
2. Turn on 3D in the glasses: double-press the X button → *Spatial Screen* → *3D Mode* → *Full SBS*.
   The glasses' screen is then 3840×1080: the left half goes to the left eye, the right half to the right eye.
   If *3D Mode* is greyed out, first switch the screen to 16:9 (not ultra-wide).
3. Optionally set the screen to *Anchor*, so the map stays in place when you turn your head
   (the glasses do the 3DoF tracking themselves).
4. In the map, click **AR** (or *Data → Graphics → View in AR glasses…*).
5. In Chrome or Edge, the *Find the glasses screen* button finds the glasses, and Start opens the map full screen right there.
   In other browsers, drag the window onto the glasses first.

Each eye gets its own camera. The black background is transparent in the glasses, and the map has a real size
(by default 1.2 m, 1.8 m in front of you). Labels and a small HUD are drawn separately for each eye.
The mouse cursor (visible in one eye only) is replaced by a ring in the middle of the view:

| Key | Action |
|---|---|
| click / Space / Enter | selects what the ring points at |
| drag, arrow keys | rotate the map |
| wheel, `+` / `−` | closer / farther |
| `[` / `]` | smaller / bigger map |
| `R` | re-centre |
| `G` `C` `L` `D` `E` `M`, `1`–`4`, `Z` | views and levels as usual |
| `Esc` | clears the selection, a second time leaves AR |

The start dialog has: the glasses profile (field of view: 1S 52° on a 16:10 screen, where a 16:9 picture has a band
at the top and bottom; One Pro 57°; One 50°), Full or Half SBS,
eye distance (IPD), the map's distance and size, and the glasses' screen plane (where both eyes see the same thing;
reduce it when the map looks doubled). Settings are kept in the browser. `?ar=full` or `?ar=half` starts the mode right away.
Full 6DoF (walking around the map) needs the XREAL Eye camera and XREAL's native Android SDK, so it isn't available here.

## Repository structure

```
src/CodeMap.Core      analyzer, graph model, metrics, exporters
  Languages/          languages: ILanguageAnalyzer (every language returns a raw graph), registry, C# (Roslyn)
  Languages/External/ language plugins: manifest, discovery, running the plugin program, checking its output
  Pipeline/           the shared part of the analysis: choosing languages, merging their graphs into one map, metrics, git, stats
  Loading/            .sln/.slnx/.slnf/.csproj → Roslyn compilations (no MSBuild, no build)
  Analysis/           declarations, reference walker, metrics, cycles, layers, DI, git (churn, change coupling), tags
  Insights/           findings and the health score, class metrics, call flows, GraphIndex (look-ups for all of them)
  Export/             JSON, DGML, GraphML, Cypher, Markdown, HTML, Mermaid
src/CodeMap.Server    the local app: API (ASP.NET Core), folder browser, cloning, cache, live mode
src/CodeMap.Mcp       the MCP server for AI agents (`codemap mcp`): session, tools, prompts, resources
src/CodeMap.Cli       the `codemap` tool (dotnet tool or standalone executable), embeds the built viewer
analyzers/typescript  TypeScript / JavaScript plugin (Node.js + TypeScript compiler API), copied to plugins/typescript
vscode/               VS Code extension: the map in a webview, code ↔ map navigation, live refresh
viewer/               3D map: Vite + three.js + d3-force-3d + d3-hierarchy, built into a single HTML file
tests/CodeMap.Tests   xUnit tests of the analyzer, exporters and MCP server; Golden/ holds saved maps of samples/Shop, samples/Booking and
                      a small TS app, the Shop findings and diagrams, and the viewer's call flows (flows.mjs) the C# port must match
samples/Shop          sample solution (DDD, DI, events, a deliberate cycle and dead code)
samples/shop-ts       the same shop in TypeScript: an npm monorepo with NestJS, Express and Angular
samples/Booking       C# API and TypeScript client in one folder: a test bed of mapping edge cases (see its README)
docs/                 format specification, JSON Schema and the plugin protocol
```

## Development

```bash
dotnet test                                   # analyzer tests (the plugin tests need Node.js)
cd analyzers/typescript && npm install && npm test   # TypeScript plugin (npm install is also needed to build it into the CLI)
cd viewer && npm install && npm run dev       # viewer with hot reload: http://localhost:5173/?data=sample.codemap.json
npm run build                                 # builds dist/index.html and copies it to src/CodeMap.Cli/Assets/viewer.html
npm run test:smoke -- --renderers webgpu,webgl   # smoke tests of the built viewer in headless Chromium (no GPU)
npm run test:smoke -- --samples <folder>      # …also on the maps of samples/shop-ts and samples/ (shop-ts.codemap.json, samples.codemap.json)
npm run bench -- --sizes 1k,7k,20k            # benchmark on generated graphs, compared with bench/baseline.json
```

The benchmark generates synthetic solutions (`node bench/generate.mjs --types 100k`) and measures loading, the model,
layout time, orbit smoothness, frames while idle, picking and graph traversals.
Without `--headed` Chromium has no GPU (SwiftShader), so GPU-dependent numbers only make sense with `--headed` on a real computer.

For dev mode, put any generated graph into `viewer/public/sample.codemap.json`.
To work on the project picker, run `CODEMAP_DEV=1 codemap ui --no-open` and open
the printed "Dev viewer" address (Vite proxies `/api` to the server).
The built viewer (`src/CodeMap.Cli/Assets/viewer.html`) is in the repository so that a plain `dotnet run`
generates HTML without Node.js. After changes in `viewer/`, run `npm run build`.

### How it works

1. `ProjectLoader` reads the solution and the `.csproj` files (with `Directory.Build.props`, `Compile Remove`,
   `ImplicitUsings`, `<Using>`, project and package references).
2. `CompilationFactory` builds a Roslyn compilation for each project in topological order:
   framework references from the running runtime or, in the standalone executable, from the installed .NET
   or the runtime built into the program (`FrameworkLocator`), plus ASP.NET Core / WindowsDesktop when needed,
   packages from `project.assets.json`, and projects as `CompilationReference`.
3. `TypeAnalyzer` + `ReferenceWalker` walk the syntax trees in parallel: they declare nodes and resolve every
   reference in the code through the semantic model into an edge of the right kind.
4. `GraphMetrics` computes metrics, cycles and dead code candidates, `Layering` the layers and upward dependencies,
   `DependencyInjectionAnalysis` connects registrations with constructors, and `GitHistory` and `ChangeCouplingAnalysis`
   add churn, hotspots and hidden coupling. These steps can run again: `GraphPipeline.BuildRaw` keeps the raw graph (and
   the git history, read once), and `GraphPipeline.Derive` makes a finished map from it, or from a changed copy of it,
   as often as needed; `RawGraph.FromDerived` takes a saved `.codemap.json` back to its raw graph.
5. Exporters write the result; the HTML is the viewer with the JSON embedded.

Other languages plug in at step 3: a plugin returns the raw graph, and steps 4–5 are shared ([docs/plugins.md](docs/plugins.md)).

The analysis is "best effort": code that doesn't compile in isolation (e.g. packages not restored)
is still mapped, and unresolved symbols are simply skipped.

## Ideas for the future

* architecture rules (e.g. "Domain must not depend on Infrastructure") with violations marked on the map
  (the automatically computed layers are a good starting point)
* comparing two versions of the graph (an architecture diff between commits / in a PR)
* a VR/WebXR mode for the City view
* code ownership (authors from git) as the colour of districts
* a Visual Studio extension with the map in an editor panel (VS Code already has one)
* edges between languages: HTTP calls from TypeScript (`fetch`, `HttpClient`) to C# controller routes
* more languages as plugins (Python, Java, Go): the protocol is in [docs/plugins.md](docs/plugins.md)

## License

[MIT](LICENSE)
