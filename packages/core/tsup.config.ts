import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', 'crypto/index': 'src/crypto/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['@solana/zk-sdk'],
});
