/**
 * Authorizations for the NEAR policy contract. Owners sign policy changes
 * with their Solana key; agents sign payment requests with their authority
 * key. The contract rebuilds the same message and checks the Ed25519
 * signature (contracts/near-policy/src/lib.rs, `auth_message`):
 *
 *   vexa-policy/v1\n{contract}\n{action}\n{agent id}\n{nonce}\n{hex(sha256(payload))}
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58DecodeStrict } from '../encoding.js';

export interface PolicyTerms {
  /** USDC base units. */
  maxPerRequest: bigint;
  /** USDC base units per rolling 24 hours. */
  dailyLimit: bigint;
  /** cUSDC accounts (base58). Empty: any recipient. */
  allowedRecipients: string[];
  /** Empty: any domain. */
  allowedDomains: string[];
}

export type PolicyAction =
  'create' | 'update_policy' | 'set_paused' | 'revoke_policy' | 'set_authority' | 'sign';

export function authorizationMessage(input: {
  contract: string;
  action: PolicyAction;
  agentId: string;
  nonce: bigint;
  payload: Uint8Array;
}): Uint8Array {
  return new TextEncoder().encode(
    [
      'vexa-policy/v1',
      input.contract,
      input.action,
      input.agentId,
      input.nonce.toString(),
      bytesToHex(sha256(input.payload)),
    ].join('\n'),
  );
}

export function signAuthorization(seed: Uint8Array, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, seed);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

function u64(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
}

function borshStrings(list: string[]): Uint8Array {
  const encoded = list.map((s) => new TextEncoder().encode(s));
  return concat(u32(list.length), ...encoded.flatMap((e) => [u32(e.length), e]));
}

/** Borsh of the contract's `Policy`. */
export function encodePolicy(p: PolicyTerms): Uint8Array {
  return concat(
    u64(p.maxPerRequest),
    u64(p.dailyLimit),
    borshStrings(p.allowedRecipients),
    borshStrings(p.allowedDomains),
  );
}

/** The payload an owner signs to create an agent. */
export function createPayload(
  policy: PolicyTerms,
  authority: string,
  nonceAccount: string,
): Uint8Array {
  return concat(
    encodePolicy(policy),
    base58DecodeStrict(authority, 'authority'),
    base58DecodeStrict(nonceAccount, 'nonce account'),
  );
}

const NONE = (1n << 64n) - 1n;

/** The payload signed to request an MPC signature on `message`. */
export function signPayload(input: {
  message: Uint8Array;
  index?: bigint;
  windowStart?: bigint;
  domain?: string;
}): Uint8Array {
  return concat(
    input.message,
    u64(input.index ?? NONE),
    u64(input.windowStart ?? NONE),
    new TextEncoder().encode(input.domain ?? ''),
  );
}
