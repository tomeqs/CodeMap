# Changelog

## Unreleased

- The map draws with WebGPU (Metal, Direct3D 12, Vulkan) where VS Code supports it and WebGL 2 otherwise; setting `codemap.renderer`.
- The force layout runs in a worker: large solutions lay out much faster and the editor stays responsive.
- The map draws nothing while nothing moves (less CPU, GPU and battery).

## 0.1.0

- Code map of the workspace's C# solution in an editor tab: Galaxy, City, Layers, DI, Flow and Auto zoom views.
- Open a symbol's code from the map; show the method or type under the cursor on the map (`Ctrl+Alt+M`); call flow and sequence diagram of the method under the cursor.
- Live refresh on save, cached map for an instant start, Mermaid and JSON saved through VS Code.
