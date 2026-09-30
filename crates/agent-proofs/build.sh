#!/usr/bin/env bash
# Builds the agent proofs to WebAssembly for @vexa/core (Node).
# Needs the wasm32-unknown-unknown target and wasm-bindgen-cli 0.2.100:
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-bindgen-cli --version 0.2.100 --locked
set -euo pipefail
cd "$(dirname "$0")/../.."
cargo build -p vexa-agent-proofs --target wasm32-unknown-unknown --release
wasm-bindgen target/wasm32-unknown-unknown/release/vexa_agent_proofs.wasm \
  --target nodejs --out-dir packages/core/wasm/agent-proofs --no-typescript
# wasm-bindgen's Node output is CommonJS; @vexa/core is an ES module package.
echo '{ "type": "commonjs" }' > packages/core/wasm/agent-proofs/package.json
ls -l packages/core/wasm/agent-proofs
