/**
 * Agent addresses, derived the way NEAR's MPC signer (`v1.signer`) derives
 * Ed25519 keys (near/mpc, crates/contract/src/crypto_shared/kdf.rs):
 *
 *   tweak   = SHA3-256("near-mpc-recovery v0.1.0 epsilon derivation:" ‖ predecessor ‖ "," ‖ path)
 *   derived = root + (tweak mod ℓ)·G
 *
 * The predecessor is the policy contract (it's the one that calls `sign`),
 * and the path is `vexa-agent-{id}`.
 */
import { sha3_256 } from '@noble/hashes/sha3.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58DecodeStrict, base58Encode } from '../encoding.js';

const PREFIX = 'near-mpc-recovery v0.1.0 epsilon derivation:';

export function agentPath(agentId: string): string {
  return `vexa-agent-${agentId}`;
}

/** A derived Ed25519 key (base58) for `root` (`ed25519:<base58>` or base58). */
export function mpcDerivedKey(root: string, predecessor: string, path: string): string {
  const tweak = sha3_256(new TextEncoder().encode(`${PREFIX}${predecessor},${path}`));
  let t = 0n;
  for (let i = tweak.length - 1; i >= 0; i--) t = (t << 8n) | BigInt(tweak[i]!);
  t %= ed25519.Point.Fn.ORDER;
  const rootPoint = ed25519.Point.fromBytes(
    base58DecodeStrict(root.replace(/^ed25519:/, ''), 'MPC root key'),
  );
  const derived = t === 0n ? rootPoint : rootPoint.add(ed25519.Point.BASE.multiply(t));
  return base58Encode(derived.toBytes());
}

export function agentAddress(root: string, policyContract: string, agentId: string): string {
  return mpcDerivedKey(root, policyContract, agentPath(agentId));
}
