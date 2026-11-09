# What CodeMap reads and computes

The short version is in the [README](../README.md). This page has the details: what each language maps to, the
relationships, metrics and findings, and how the analysis works.

## Languages

### C#

Built in, with Roslyn.

* **What you can open:** a solution (`.sln`, `.slnx`, `.slnf`), a project (`.csproj`), a `.cs` file or a folder.
* **Projects:** .NET Framework, .NET Standard and .NET (Core, 5 and newer). They are read the way MSBuild reads them
  (imports, `Directory.Build.props` / `.targets`, central package versions), without building.
* **Recognised:**
  * ASP.NET Core controllers, Razor Pages, Blazor components, SignalR hubs and middleware;
  * dependency injection with `Microsoft.Extensions.DependencyInjection`, including keyed services, factories,
    typed `HttpClient`s and Aspire's `Add…DbContext`;
  * EF Core `DbContext`s, hosted services, and MediatR and message handlers;
  * test projects: xUnit, NUnit, MSTest and TUnit.

Projects **don't need to be built**. CodeMap reads `.csproj` files directly and takes framework types from the
installed .NET. If `dotnet restore` has run, types from NuGet packages are recognised too (through
`obj/project.assets.json`).

The ready-made program has .NET built in. If the .NET SDK is installed, `codemap` still finds it and uses its libraries
(the newest version) to resolve framework types. `codemap --version` shows where it takes them from.

### TypeScript and JavaScript

A plugin (`analyzers/typescript`, included in the releases) that needs **Node.js 18+**. The VS Code extension runs it on
the Node.js built into VS Code.

* **Files:** `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` (CommonJS too).
* **What you can open:** a folder, a `package.json`, a `tsconfig.json` / `jsconfig.json`, or a single file.
* **Monorepos:** npm, pnpm and yarn workspaces and tsconfig `paths`, without `npm install`.

The unit of the map is the **file**: packages (`package.json`) → folders → files → declarations (classes, interfaces,
functions, types, constants) and class members.

* **Edges:**
  * `imports` between files;
  * calls (in order, also through `index.ts` barrel files and through interfaces);
  * `new` and JSX;
  * inheritance and implementations;
  * types in signatures and annotations (also the constraints and defaults of type parameters);
  * decorators (also of parameters);
  * CommonJS `require()`;
  * npm packages and dependencies between monorepo packages (workspaces).
* **Top-level code** (`module.exports = {…}`, assignments, `export default {…}`) is a member of its own, so what it uses
  is not "unused".
* **Single-file components** (`.vue`, `.svelte`, `.astro`) are files on the map with the imports of their scripts.
* **Entry points** come from:
  * `package.json` (`main`, `module`, `bin`, `exports`, also when built to `build/<format>/`);
  * files that run code;
  * file-based routing (Next.js, SvelteKit, SolidStart, Astro, Nuxt). SvelteKit's `$lib` is `src/lib`.
* **Workspaces** (`pnpm-workspace.yaml`, `workspaces`): a package the workspace excludes gets its dependencies on
  workspace names from npm.

Frameworks recognised from the imports:

* **Express:**
  * every `app.get('/orders/:id', …)` / `router.post(…)` / `router.route(…).put(…)` is its own route node
    (`GET /orders/:id`);
  * the prefix comes from `app.use('/catalog', router)`, also through chains such as
    `Router().use('/api', Router().use(articles))`;
  * the code of inline handlers belongs to the route; named handlers and middleware are called by it;
  * the Flow view starts from the routes.
* **NestJS:**
  * entry points: controllers (routes with their full path, including `app.setGlobalPrefix(…)`), providers, guards,
    interceptors, modules, GraphQL resolvers, gateways, `@Cron` / `@MessagePattern`…;
  * the DI view shows Nest's container: module providers (`useClass`, `useValue`, `useFactory`, `useExisting`,
    tokens), `Scope.REQUEST` / `TRANSIENT` scopes, `@Inject`, `@InjectRepository`, `@Optional`;
  * CodeMap shows where the request scope "spreads" to dependent services (a note, not an error), and where an
    interface is injected without a token.
* **Angular:**
  * components, directives, pipes, modules and services;
  * `providedIn: 'root'`, module and component providers;
  * standalone applications (`bootstrapApplication(App, { providers })`, `ApplicationConfig`,
    `provideX(new T())`), `inject()`;
  * an error when a root service needs something only components provide.

```bash
codemap path/to/app                 # a folder with package.json / tsconfig.json
codemap path/to/repo                # C# and TypeScript in one repo: one map of both languages
codemap path/to/repo --lang csharp  # one language only
codemap --version                   # which languages are available (and whether Node.js is there)
```

### Both languages, and the samples

* A repository with C# and TypeScript gives one map with both side by side. The levels are then called
  "Projects / Packages", "Types / Files"… Maps of different languages have no edges between them yet (e.g. HTTP calls
  from TypeScript to C# controllers).
* [`samples/Shop`](../samples/Shop): a C# solution (DDD, DI, events, a deliberate cycle and dead code).
* [`samples/shop-ts`](../samples/shop-ts): the same shop in TypeScript (a NestJS API, an Express gateway, an Angular
  front end on a shared domain library), with a deliberate cycle, dead code and DI container problems.
  `codemap samples` gives one map of it and the C# solution.
* [`samples/Booking`](../samples/Booking): an ASP.NET Core API and a TypeScript client in one folder. It is a test bed
  that contains the edge cases of C# and TypeScript mapping, each listed with what its map must show.

Other languages can be added as [plugins](plugins.md).

## Relationships: 19 kinds of edges, weighted (number of occurrences)

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

## Metrics

At every level: project → namespace → type → member.

* **Size:** LOC, number of members, methods, fields…
* **Cyclomatic complexity** of every method, and the sum per type (WMC).
* **Coupling:** `Ca` (how many types use me), `Ce` (how many types I use), **instability** `Ce/(Ca+Ce)`.
* **Abstractness** and **distance from the main sequence** (Robert C. Martin) for namespaces and projects. They show
  the "zone of pain" (concrete and heavily used) and the "zone of uselessness".
* **DIT / NOC:** depth of inheritance and number of subclasses.
* **Fan-in / fan-out** of methods.

## Insights

* **Hotspots** = complexity × change frequency from git. Code that is complicated *and* constantly changing is the
  best candidate for refactoring (Adam Tornhill's approach, "Your Code as a Crime Scene").
* **Dependency cycles** (Tarjan SCC) between types, namespaces and projects.
* **Architecture layers** computed from the code alone: every namespace and project gets a layer number (dependencies
  should point down). **Upward dependencies** are the minimal set of edges whose removal breaks all the cycles, i.e.
  the best places to cut.
* **Hidden coupling from git** (change coupling): types that keep changing together (shared commits / average number
  of changes) but have no dependency on each other in the code. Usually duplicated logic, a hidden contract (e.g. a
  JSON format, a queue name) or a client–server pair.
* **DI map:**
  * registrations from `IServiceCollection` (`AddSingleton/Scoped/Transient`, `TryAdd*`, `Keyed*`,
    `AddHostedService`, `AddDbContext`, `AddHttpClient<T>`, factories and forwardings);
  * the lifetime of every service;
  * from those, **captive dependencies** (a singleton holding a scoped or transient service) and **missing
    registrations** (a constructor needs something nobody registers).

  Controllers, hubs and middleware activated by the framework are taken into account. For TypeScript the same view
  shows the NestJS and Angular containers.
* **Dead code candidates:** non-public symbols nothing refers to.
* **Roles** recognised heuristically: controller, DbContext, repository, handler (MediatR/CQRS), hosted service,
  middleware, test, options, DTO, extensions…
* **Impact analysis** (in the viewer): what breaks if I change this type (transitive reverse dependencies), and the
  **path** between any two elements ("how does the controller reach the database?").

## Findings and the health score

33 rules read the map for problems. They are in the `.md` report and in the MCP server. Each finding comes with its
evidence: the nodes, the `file:line` places, the numbers against their thresholds, and what usually fixes it.

* **Spaghetti:**
  * cycles at every level, each with the cheapest cut;
  * tangles of 8+ types, and hubs;
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

## Checks inside function bodies

`--checks` (on by default for `codemap mcp`). The problems are `code.*` findings with `file:line`.

* **C#:**
  * a short list of compiler warnings that hold up without restored packages: unreachable code, a task that is not
    awaited, unused variables, comparisons and assignments to the same variable, `Equals` without `GetHashCode`, and
    null dereferences when the project enables `<Nullable>`;
  * CodeMap's own rules: empty or swallowing `catch`, `throw ex;`, `throw` in `finally`, `async void`, `.Result` /
    `.Wait()` / `.GetAwaiter().GetResult()`, `lock (this)`, `==` on floating-point numbers, a property that calls
    itself, a `new` disposable that is never disposed.
* **TypeScript / JavaScript:**
  * compiler checks: impossible comparisons, a forgotten `await` in a condition, use before assignment, and null and
    unused checks when `strict` / `noUnused*` are on;
  * CodeMap's own rules: empty or swallowing `catch`, floating promises, a promise used as a condition, `forEach` with
    an `async` callback, an `async` Promise executor, unreachable code, `x = x`, `x === x`, duplicate `case`, constant
    conditions, and loose `==` between different types.
* **Python** (CodeMap's own rules, no linter needed; a line with `# noqa` is left alone):
  * exceptions: bare `except:`, an `except` of everything that is empty or drops the error, `return` / `break` /
    `continue` in `finally`, `raise NotImplemented`, an exception created without `raise`;
  * async: an `async def` called without `await` (also as a condition), blocking calls in `async def` (`time.sleep`,
    `requests`, `subprocess`, `os.system`, `urlopen`, `input`);
  * correctness: mutable default arguments, `== None`, `is` with a literal, `assert (x, "msg")`, duplicate dict keys,
    a function defined twice, f-strings without placeholders, `x = x`, `x == x`, constant conditions;
  * dead code: unreachable code, unused imports and variables; and, as information, variables named like built-ins.

Test code and generated code are not checked. The checks do not change the health score, which measures structure.

## The graph (data format)

The main format is **CodeMap JSON** (`*.codemap.json`): readable for people, easy to load in any language and for
LLMs. Nodes form a containment tree (`parent`); edges describe the other relationships.

C# identifiers are the standard C# *documentation comment IDs* (`T:Shop.Domain.Orders.Order`,
`M:Shop.Domain.Orders.Order.AddLine(Shop.Domain.Catalog.Product,System.Int32)`), so they are stable between runs and
match what XML docs and Roslyn use. Other languages use their own prefix (TypeScript: `ts:<package>:<file>#<name>`).

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

Full specification: [format.md](format.md). JSON Schema: [codemap.schema.json](codemap.schema.json).

The other formats:

* **DGML:** opens natively in Visual Studio (Code Map / DGML editor), grouped project → namespace → type.
* **GraphML:** Gephi, yEd, Cytoscape, NetworkX.
* **Cypher:** import into Neo4j / Memgraph, then queries such as
  `MATCH p=(c:Class {name:'OrdersController'})-[:CALLS|INJECTS*1..6]->(r:Interface) RETURN p`.
* **Markdown:** an architecture report you can paste into a PR, a wiki or a prompt.

## How it works

1. `ProjectLoader` reads the solution and the `.csproj` files (with `Directory.Build.props`, `Compile Remove`,
   `ImplicitUsings`, `<Using>`, project and package references).
2. `CompilationFactory` builds a Roslyn compilation for each project in topological order:
   * framework references from the running runtime or, in the standalone executable, from the installed .NET or the
     runtime built into the program (`FrameworkLocator`), plus ASP.NET Core / WindowsDesktop when needed;
   * packages from `project.assets.json`;
   * projects as `CompilationReference`.
3. `TypeAnalyzer` + `ReferenceWalker` walk the syntax trees in parallel. They declare nodes and resolve every reference
   in the code through the semantic model into an edge of the right kind.
4. The derived steps:
   * `GraphMetrics` computes metrics, cycles and dead code candidates;
   * `Layering` computes the layers and upward dependencies;
   * `DependencyInjectionAnalysis` connects registrations with constructors;
   * `GitHistory` and `ChangeCouplingAnalysis` add churn, hotspots and hidden coupling.

   These steps can run again. `GraphPipeline.BuildRaw` keeps the raw graph (and the git history, read once), and
   `GraphPipeline.Derive` makes a finished map from it, or from a changed copy of it, as often as needed.
   `RawGraph.FromDerived` takes a saved `.codemap.json` back to its raw graph.
5. Exporters write the result; the HTML is the viewer with the JSON embedded.

Other languages plug in at step 3: a plugin returns the raw graph, and steps 4–5 are shared ([plugins.md](plugins.md)).

The analysis is "best effort": code that doesn't compile in isolation (e.g. packages not restored) is still mapped, and
unresolved symbols are simply skipped.

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
src/CodeMap.Mcp       the MCP server for AI agents (`codemap mcp`): session, tools, prompts, resources, rendering
src/CodeMap.Cli       the `codemap` tool (dotnet tool or standalone executable), embeds the built viewer
analyzers/typescript  TypeScript / JavaScript plugin (Node.js + TypeScript compiler API), copied to plugins/typescript
vscode/               VS Code extension: the map in a webview, code ↔ map navigation, live refresh, MCP for the editor's agent
viewer/               3D map: Vite + three.js + d3-force-3d + d3-hierarchy, built into a single HTML file
tests/CodeMap.Tests   xUnit tests of the analyzer, exporters and MCP server; Golden/ holds saved maps of the samples,
                      the Shop findings and diagrams, and the viewer's call flows the C# port must match
tests/mcp-smoke.mjs   `codemap mcp` as an agent uses it (CI and every release)
samples/              Shop (C#), shop-ts (TypeScript), Booking (both: the mapping edge cases)
docs/                 format specification, JSON Schema, the plugin protocol, these pages
```

## Ideas for the future

* Architecture rules (e.g. "Domain must not depend on Infrastructure") with violations marked on the map. The
  automatically computed layers are a good starting point.
* An architecture diff between commits in the app, and as a comment on a PR. The MCP server's `compare` already does it
  for two maps.
* A VR/WebXR mode for the City view.
* Code ownership (authors from git) as the colour of districts.
* A Visual Studio extension with the map in an editor panel (VS Code already has one).
* Edges between languages: HTTP calls from TypeScript (`fetch`, `HttpClient`) to C# controller routes.
* More languages as plugins (Python, Java, Go): the protocol is in [plugins.md](plugins.md).
