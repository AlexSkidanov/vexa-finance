import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'crypto/index': 'src/crypto/index.ts',
    'solana/index': 'src/solana/index.ts',
    'agent/index': 'src/agent/index.ts',
    // View keys alone: no WebAssembly, for browsers that only read audit exports.
    'view-keys/index': 'src/crypto/view-keys.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['@solana/zk-sdk'],
  // The agent proofs' WASM loads through createRequire(import.meta.url).
  shims: true,
});
