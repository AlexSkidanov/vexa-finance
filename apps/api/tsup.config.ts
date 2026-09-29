import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // Nothing from node_modules is bundled: some packages load WebAssembly
  // relative to their own files. The Docker image ships them with `pnpm deploy`.
  skipNodeModulesBundle: true,
});
