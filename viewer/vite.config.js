import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Everything (JS, CSS) is inlined into dist/index.html so the CLI can embed graph data
// into a single file that opens offline with a double click.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 2000,
    reportCompressedSize: false,
  },
});
