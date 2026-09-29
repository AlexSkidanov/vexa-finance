/**
 * Agent payment proofs, from the `vexa-agent-proofs` crate compiled to
 * WebAssembly (crates/agent-proofs; rebuild with crates/agent-proofs/build.sh).
 *
 * The standard transfer proofs pick random openings; an agent's are derived
 * from its opening seed and the payment index, so the daily-limit proof can
 * cover past payments without storing anything. The limit proof shows that
 * the amount fits both the per-payment limit and what's left of the daily one.
 */
import { createRequire } from 'node:module';

export interface AgentPaymentProofs {
  equality: Uint8Array;
  validity: Uint8Array;
  range: Uint8Array;
  limit: Uint8Array;
  newDecryptableBalance: Uint8Array;
  /** `proof_type ‖ context` of the validity and limit proofs, for the policy contract. */
  validityContext: Uint8Array;
  limitContext: Uint8Array;
  auditorCiphertextLo: Uint8Array;
  auditorCiphertextHi: Uint8Array;
}

interface Wasm {
  agentPaymentProofs(...args: unknown[]): AgentPaymentProofs & { free(): void };
}

let wasm: Wasm | undefined;
function load(): Wasm {
  wasm ??= createRequire(import.meta.url)('../../wasm/agent-proofs/vexa_agent_proofs.js') as Wasm;
  return wasm;
}

export function buildAgentPaymentProofs(input: {
  elgamalSecret: Uint8Array;
  aeKey: Uint8Array;
  availableBalance: Uint8Array;
  decryptableAvailableBalance: Uint8Array;
  amount: bigint;
  destinationElgamalPubkey: Uint8Array;
  auditorElgamalPubkey: Uint8Array | null;
  openingSeed: Uint8Array;
  index: bigint;
  maxPerRequest: bigint;
  dailyLimit: bigint;
  /** Indices of the payments in the last 24 hours, and their amounts summed. */
  window: { indices: bigint[]; amount: bigint };
}): AgentPaymentProofs {
  const out = load().agentPaymentProofs(
    input.elgamalSecret,
    input.aeKey,
    input.availableBalance,
    input.decryptableAvailableBalance,
    input.amount,
    input.destinationElgamalPubkey,
    input.auditorElgamalPubkey ?? new Uint8Array(32),
    input.openingSeed,
    input.index,
    input.maxPerRequest,
    input.dailyLimit,
    BigUint64Array.from(input.window.indices),
    input.window.amount,
  );
  try {
    return {
      equality: out.equality,
      validity: out.validity,
      range: out.range,
      limit: out.limit,
      newDecryptableBalance: out.newDecryptableBalance,
      validityContext: out.validityContext,
      limitContext: out.limitContext,
      auditorCiphertextLo: out.auditorCiphertextLo,
      auditorCiphertextHi: out.auditorCiphertextHi,
    };
  } finally {
    out.free();
  }
}
