import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Everything (JS, CSS) is inlined into dist/index.html so the CLI can embed graph data
// into a single file that opens offline with a double click.
export default defineConfig({
  plugins: [viteSingleFile()],
  // `npm run dev` + `codemap ui --no-open`: run with CODEMAP_DEV=1 and open the "Dev viewer" URL it prints.
  server: {
    proxy: { '/api': 'http://127.0.0.1:5180' },
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 2000,
    reportCompressedSize: false,
  },
});
