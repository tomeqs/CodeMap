# Changelog

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
