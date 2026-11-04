import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Edge case: `~/` is an alias only Vite knows. TypeScript cannot follow it, and CodeMap must not take it for an npm package.
export default defineConfig({
  resolve: { alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) } },
});
