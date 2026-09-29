import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'crypto/index': 'src/crypto/index.ts',
    'solana/index': 'src/solana/index.ts',
    'agent/index': 'src/agent/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['@solana/zk-sdk'],
  // The agent proofs' WASM loads through createRequire(import.meta.url).
  shims: true,
});
