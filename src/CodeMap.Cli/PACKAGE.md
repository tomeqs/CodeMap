# CodeMap

An interactive **3D map of your code**: C# solutions, and TypeScript / JavaScript (with Node.js 18+), or both in one map.
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
- **Insights**: architecture layers and upward dependencies, DI lifetime problems (captive dependencies, request scope,
  unreachable providers), cycles, hotspots from git history, possibly unused code.

Standalone executables (no .NET needed), the VS Code extension and the documentation:
https://github.com/tomeqs/CodeMap
