# tree-sitter-swift.wasm

The Swift grammar the plugin parses with, as WebAssembly for `web-tree-sitter` 0.25.10. No npm package ships it
as WebAssembly (`tree-sitter-swift` on npm has native add-ons only, and its last version, 0.7.1, cannot read
`#if` inside a class, enum or protocol body), so it is built here from the upstream grammar and committed.

| | |
|---|---|
| Source | [alex-pinkus/tree-sitter-swift](https://github.com/alex-pinkus/tree-sitter-swift), commit `fef1236022ccde2d2bc5c32d4db8947c87a7f848` (2026-11-10, after release 0.7.4) |
| Licence | MIT, in `LICENSE` here |
| Built with | tree-sitter-cli 0.25.10 (`generate`, grammar ABI 15; `build --wasm`), emscripten 4.0.4 |
| Patch | the scanner's out-of-memory branch, `fprintf(stderr, …); exit(1);`, becomes `__builtin_trap();`: web-tree-sitter gives a grammar neither |
| SHA-256 | `4be3a1426a2916ef602af2efff4c4cb7c774f9e2c473f69d2567c676e53070c2` |

To rebuild (git, network access, and emcc 4.0.4 on the PATH, or docker / podman):

```
npm run build-grammar
```

The build is reproducible: the script prints the SHA-256 of the file before and after. To move to a newer grammar,
change `COMMIT` in `scripts/build-grammar.mjs`, rebuild, run the tests and update this file.

What the grammar does not read yet (rare; the declarations around them are still found): `#if` between the `case`
clauses of a `switch` or between attributes and their declaration, freestanding macros at declaration level
(`#warning(…)`), the `consume` operator, `$` inside identifiers (`_$id`), and `/*` right after a string
interpolation (`"\(a)/*"`), which is taken for the start of a comment.
