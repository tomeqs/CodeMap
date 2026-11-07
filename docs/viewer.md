# The 3D map

The short version is in the [README](../README.md#views). This page has the details: every view, the app in the
browser, the editor integrations, the GPU and the AR glasses mode.

## Views

* **Galaxy** (`G`): a 3D force-directed graph. Projects are "solar systems", namespaces clusters, types stars.
  * The shape shows the kind (● class, ◆ interface, ■ struct, ⬟ record, ▲ enum).
  * The size shows a chosen metric.
  * The colour shows the project, kind, role or any metric (*turbo* scale).
  * When an element is selected, particles flow along its edges in the direction of the dependency.
* **City** (`C`): a code city. Districts are projects, blocks namespaces, buildings types.
  * The footprint is LOC, the height complexity (or another metric), the colour e.g. hotspots.
  * Relationships are drawn as arcs over the city.
* **Layers** (`L`): nodes lie on horizontal planes of the layers computed from the visible relationships (projects are
  columns through the layers). Dependencies pointing upwards are red.
* **DI** (`D`): types built by the container, on *Singleton / Scoped / Transient / Not registered* planes.
  * A healthy dependency points down or sideways (to something that lives at least as long).
  * A captive dependency is red, a missing registration orange.
* **Flow** (`E`): what happens when you call a controller action, a handler, a route or a background service's
  `ExecuteAsync`.
  * Calls are followed in source order, through interfaces down to the implementation the DI container injects
    (`IEnumerable<T>` → all of them).
  * The top plane is the entry point, and each lower one is one call deeper.
  * The **sequence diagram** shows the same flow as participants (types) and messages (`alt` for several possible
    implementations, `loop` for `IEnumerable<T>`).
  * It can be copied as **Mermaid** (paste it into GitHub, GitLab, Notion or docs) or downloaded as `.mmd` / `.svg`.
  * You choose the entry point in Insights (*Entry points*), in the list in the view, or with the *Call flow ↘* button
    on any method.
* **Matrix** (`M`): a dependency structure matrix (DSM) in 3D.
  * The projects, namespaces or types (TypeScript: packages, folders, files) are on both axes in the same order, with
    one tile each on the diagonal.
  * A column stands in cell (row, column) when the row uses the column: the taller and brighter, the more references.
  * The order puts every cycle in one framed block on the diagonal and the blocks in layers (bands along the diagonal,
    the bottom layer first). So every dependency that follows the layers is below the diagonal; the ones against them
    stand above it, in red.
  * Click a tile to light up its row (what it uses) and column (who uses it). Click a column to select that dependency
    (the HUD lists what it is made of: calls, injects…). Double-click a tile to go into it.
  * Unlike a graph, it stays readable when there are many links. Up to 400 rows; beyond that, drill into a project or
    namespace.
* **Auto** (`Z`, semantic zoom): instead of switching levels, you just fly the camera.
  * From afar a namespace is one star in the middle of its types.
  * As you get closer it unfolds into its types, and the nearest types into their members (methods, properties,
    fields). Moving away folds everything back.
  * The layout is computed once, so the map doesn't rearrange, and search flies to a member hidden in a folded type by
    itself.

## Working with the map

* **Levels of detail:** Projects / Namespaces / Types / Members (`1`–`4`; TypeScript: Packages / Folders / Files /
  Declarations). Double-click to drill down (project → namespaces → types → members), with "ghosts" of neighbours
  outside the scope.
* **Details panel:** signature, XML documentation, metrics, tags, an *Open in VS Code* link, outgoing and incoming
  relationships grouped by kind, list of members.
* **Neighbours / Dependencies ↓ / Impact ↑ / Path to…** (or Shift+click on a second element).
* **Insights tab:** entry points (controllers, handlers, routes, background services, `Main`), DI problems, upward
  dependencies, hidden coupling from git, cycles, hotspots, most complex types, most used types, possible dead code.
  A click takes you to the right view.
* **DI lifetime colour** in every view (namespaces and projects get the dominant lifetime of their types), and
  *Dependency injection* and *Changes together with* sections in the details panel.
* **Filters:** relationship kinds, projects, tests, external types, minimum link strength.
* **Keys:** `/` search, `1`–`4` level, `Z` semantic zoom, `G` / `C` / `L` / `D` / `E` / `M` view, `F` fit, `Esc` back.
* **Without data:** drop any `*.codemap.json` file on the viewer, or use the `?data=url.json` parameter.

## The app in the browser

`codemap` without arguments starts a local server (`127.0.0.1` only) and opens the browser with the project picker.

* **Folder browser:** you see right away where solutions (◆), projects and packages (●) are, with their language
  (C#, TS); double-click analyzes. A folder with a solution and TypeScript code next to it is analyzed as one map.
* **Clone from Git:** paste a repository URL; CodeMap clones it to `~/.codemap/repos` and finds the solution itself.
* **Recent projects:** saved maps open instantly from the cache (`~/.codemap/cache`).
* **Live analysis progress**, which you can cancel.
* **↻** on the map: analyze again without losing the camera, filters and selection.
* **Live:** the map refreshes itself when you save a `.cs` / `.csproj`, `.ts` / `.js`, `package.json` or
  `tsconfig.json` file, and a toast shows how many types were added or removed (`node_modules` and build output are
  ignored).

```bash
codemap                                   # project picker
codemap ui path/to/MySolution.sln         # analyzes the given solution right away
codemap ui . --watch                      # current folder + live refresh
codemap ui --port 6000 --no-open          # another port, without opening the browser
```

Security: the server only accepts connections from `127.0.0.1` and rejects foreign `Host` headers (DNS rebinding).
Every API call needs a session token that is injected only into the page served by `codemap`, so other pages open in
the browser cannot use it.

## VS Code and Cursor

The **CodeMap 3D** extension (`tomeqs.codemap-3d`, on the VS Code Marketplace and Open VSX) opens the map in an editor
tab:

* **CodeMap: Open Code Map** from the command palette, or right-click a `.sln` / `.slnx` / `.csproj` / `package.json` /
  `tsconfig.json` / folder in the Explorer. When the workspace has both C# and TypeScript / JavaScript, the extension
  asks; the folder gives one map with both.
* **Open** in the details panel (or double-click a method) opens the code next to the map.
* **Show in Code Map** (`Ctrl+Alt+M`) selects the method, function, class or file under the cursor.
* **Show Call Flow** (editor context menu) shows the call flow and sequence diagram of the method under the cursor.
* After saving a source or project file, the map refreshes itself and keeps the camera and selection.
* Mermaid and JSON are saved through VS Code's save dialog.

Install it from the Extensions view (search for **CodeMap 3D**). Or take `codemap-<version>.vsix` from the
[releases](https://github.com/tomeqs/CodeMap/releases) and install it with *Extensions → … → Install from VSIX…* or
`code --install-extension codemap-<version>.vsix`.

The extension contains the analyzer, which needs the .NET SDK 8+. Without .NET, set `codemap.analyzerPath` to the
standalone `codemap` executable. TypeScript and JavaScript run on the Node.js built into the editor (another one:
`codemap.nodePath`). It also offers the [MCP server](mcp.md) to the editor's agent. Its code is in
[`vscode/`](../vscode/), and its settings are listed in [vscode/README.md](../vscode/README.md).

## Other IDEs

* **Visual Studio:** *Tools → External Tools… → Add*.
  * Command: `%USERPROFILE%\.dotnet\tools\codemap.exe` (or the path to the downloaded `codemap.exe`).
  * Arguments: `ui "$(SolutionDir)$(SolutionFileName)" --watch`.
* **JetBrains Rider:** *Settings → Tools → External Tools*, Program `codemap`, Arguments `ui "$SolutionPath$" --watch`.
* **VS Code without the extension:** `.vscode/tasks.json`:
  ```json
  {
    "version": "2.0.0",
    "tasks": [{ "label": "CodeMap", "type": "shell", "command": "codemap ui \"${workspaceFolder}\" --watch", "isBackground": true, "problemMatcher": [] }]
  }
  ```

## GPU

* **Renderer:**
  * The map draws with **WebGPU**: Metal on macOS, Direct3D 12 on Windows, Vulkan on Linux.
  * When the browser (or VS Code) has no WebGPU, it falls back to **WebGL 2**.
  * Without a GPU, recent Chromium (and editors built on it, such as VS Code and Cursor with hardware acceleration off)
    may have no WebGL 2 but a software WebGPU: the map then draws with that. With neither, it says so and the editor
    offers *Open in Browser*.
  * The preferred backend can be set in the *Data* tab (*Graphics → Renderer*), with `?renderer=webgpu|webgl`, or with
    the `codemap.renderer` setting in VS Code; when it is missing, the other one is used.
* **Layout on the GPU** (WebGPU compute shaders): all nodes in parallel.
  * Positions go straight into a texture the shaders draw from, and only come back to the CPU about every 200 ms
    (labels, picking, camera).
  * Repulsion between up to 12,000 elements is computed exactly, in tiles in the workgroup's shared memory.
  * Above that it is computed on a grid: nodes are sorted into cells every step, near neighbours in pairs, farther
    ones through the cells' centres of charge on several levels. The result is within 1% of the exact one.
  * `?layoutMode=grid|exact` forces the mode. Up to 100,000 elements per level.
* **Without WebGPU** the layout runs in a **Web Worker**, so the map and the UI stay smooth (up to 15,000 elements).
  Without a worker (e.g. when a CSP blocks it), the main thread computes it, with a limit of 7,000. Small graphs (up to
  300 elements) are laid out right away on the main thread. `?layout=gpu|worker|main` forces the choice.
* **Positions in a texture:** nodes, links (soft-edged ribbons, arcs in City) and flowing particles read them in
  shaders, so moving the graph is one texture upload per frame instead of rewriting matrices and vertices. At 20,000
  elements the CPU cost of a frame dropped from 5 ms to 0.25 ms.
* **Effects** computed in shaders, with no CPU cost per frame:
  * **Glow:** bloom over the whole scene, and a soft, breathing corona around every node.
  * **Sky:** thousands of stars twinkling each in its own rhythm, a few brighter ones with a sparkle, coloured nebulae
    in the background.
  * **Comets:** particles with a tail flow along relationships towards the dependency. On a living map they also flow
    without a selection, along the strongest relationships. Set the density in *Particles* (Off / Few / Normal / Many).
  * **Dashes:** selected and highlighted relationships, problems (e.g. upward dependencies) and *Flow particles on all
    links* have flowing dashes, so the direction is visible even without particles.
  * **Unfolding:** a new graph bursts out of a tight ball, and nodes after a drill-down come out of their parent.
    In City, the buildings rise from the ground.
  * **Wave:** after a click, a wave of light runs out from the node along its relationships, node by node, with a
    shock ring.
* **Large solutions:** the model, link aggregation, semantic zoom and automatic layers work on numeric indices. Layers
  for 20,000 types take 0.13 s (previously 37 s), and for 100,000 types about 0.9 s.
* **Motion** (*Appearance → Motion*):
  * **Living** (default): the map lives at the screen's full fps and only pauses on a hidden tab.
  * **Calm (battery):** decorations run at 30 fps and stop 20 s after the last mouse movement, and a still map uses no
    GPU. This is the default without a GPU and with the system's *reduce motion*.
  * **Off:** nothing moves by itself.

  The choice is kept in the browser; `?motion=living|calm|off` forces the mode.
* Native renderers (Metal / Direct3D 12 outside the browser) are a separate topic:
  [tomeqs/CodeMap#6](https://github.com/tomeqs/CodeMap/issues/6).

## AR glasses (XREAL 1S / One / One Pro)

The map can float in your room in AR glasses that take side-by-side 3D over USB-C. It works in the browser
(`codemap ui`, an HTML file from `codemap -f html`, `npm run dev`), not in the VS Code panel.

1. Connect the glasses to the computer (e.g. a Mac) as an extended display.
2. Turn on 3D in the glasses: double-press the X button → *Spatial Screen* → *3D Mode* → *Full SBS*. The glasses'
   screen is then 3840×1080: the left half goes to the left eye, the right half to the right eye. If *3D Mode* is
   greyed out, first switch the screen to 16:9 (not ultra-wide).
3. Optionally set the screen to *Anchor*, so the map stays in place when you turn your head (the glasses do the 3DoF
   tracking themselves).
4. In the map, click **AR** (or *Data → Graphics → View in AR glasses…*).
5. In Chrome or Edge, the *Find the glasses screen* button finds the glasses, and Start opens the map full screen right
   there. In other browsers, drag the window onto the glasses first.

Each eye gets its own camera. The black background is transparent in the glasses, and the map has a real size (by
default 1.2 m, 1.8 m in front of you). Labels and a small HUD are drawn separately for each eye. The mouse cursor
(visible in one eye only) is replaced by a ring in the middle of the view:

| Key | Action |
|---|---|
| click / Space / Enter | selects what the ring points at |
| drag, arrow keys | rotate the map |
| wheel, `+` / `−` | closer / farther |
| `[` / `]` | smaller / bigger map |
| `R` | re-centre |
| `G` `C` `L` `D` `E` `M`, `1`–`4`, `Z` | views and levels as usual |
| `Esc` | clears the selection, a second time leaves AR |

The start dialog has:
* the glasses profile (field of view: 1S 52° on a 16:10 screen, where a 16:9 picture has a band at the top and bottom;
  One Pro 57°; One 50°);
* Full or Half SBS;
* eye distance (IPD);
* the map's distance and size;
* the glasses' screen plane, where both eyes see the same thing (reduce it when the map looks doubled).

Settings are kept in the browser. `?ar=full` or `?ar=half` starts the mode right away. Full 6DoF (walking around the
map) needs the XREAL Eye camera and XREAL's native Android SDK, so it isn't available here.

## Developing the viewer

```bash
cd viewer && npm install && npm run dev            # hot reload: http://localhost:5173/?data=sample.codemap.json
npm run build                                      # builds dist/index.html and copies it to src/CodeMap.Cli/Assets/viewer.html
npm run test:smoke -- --renderers webgpu,webgl     # smoke tests of the built viewer in headless Chromium (no GPU)
npm run test:smoke -- --samples <folder>           # …also on the maps of samples/shop-ts and samples/ (shop-ts.codemap.json, samples.codemap.json)
npm run bench -- --sizes 1k,7k,20k                 # benchmark on generated graphs, compared with bench/baseline.json
```

* **Dev data:** put any generated graph into `viewer/public/sample.codemap.json`.
* **The project picker:** run `CODEMAP_DEV=1 codemap ui --no-open` and open the printed "Dev viewer" address (Vite
  proxies `/api` to the server).
* **The built viewer is committed:** `src/CodeMap.Cli/Assets/viewer.html` is in the repository so that a plain
  `dotnet run` generates HTML without Node.js. After changes in `viewer/`, run `npm run build`.
* **Benchmarks:** the benchmark generates synthetic solutions (`node bench/generate.mjs --types 100k`) and measures
  loading, the model, layout time, orbit smoothness, frames while idle, picking and graph traversals. Without
  `--headed` Chromium has no GPU (SwiftShader), so GPU-dependent numbers only make sense with `--headed` on a real
  computer.
