import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // Bundle workspace packages so the deploy artifact doesn't depend on the monorepo layout.
  noExternal: [/^@vexa\//],
});
