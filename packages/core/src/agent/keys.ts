/**
 * Agent keys.
 *
 * An agent runs somewhere else (a server, an AI agent's sandbox) and needs to
 * make confidential payments, so it needs its own ElGamal and AE keys and a
 * key to authorize its requests to the policy contract. It never gets a
 * Solana signing key: that's an MPC key only the policy contract can use.
 *
 * All of an agent's keys come from one 32-byte **agent secret**, itself
 * derived from the owner's passkey and the agent id. The owner hands the
 * secret to the agent once (as a `vxagent_…` string) and can re-derive it at
 * any time, for example to sweep the agent's funds back after revoking it.
 *
 *   owner agentRoot ── HKDF("vexa/agent/v1/{id}") ── agent secret ─┬─ ElGamal secret (mod ℓ)
 *                                                                  ├─ AE key
 *                                                                  ├─ opening seed   (payment openings)
 *                                                                  └─ authority seed (signs policy requests)
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { AeKey, ElGamalKeypair, ElGamalSecretKey } from '@solana/zk-sdk';
import { base58DecodeStrict, base58Encode, base64Encode } from '../encoding.js';

const SALT = new TextEncoder().encode('vexa.finance');
const info = (s: string) => new TextEncoder().encode(s);

export interface AgentKeys {
  agentId: string;
  /** The 32-byte agent secret everything below derives from. */
  secret: Uint8Array;
  elgamal: ElGamalKeypair;
  elgamalSecret: Uint8Array;
  /** Base64, as the API and handle resolver use it. */
  elgamalPubkey: string;
  ae: AeKey;
  aeBytes: Uint8Array;
  /** Seeds the Pedersen openings of the agent's payments. */
  openingSeed: Uint8Array;
  /** Ed25519 seed that authorizes the agent's requests to the policy contract. */
  authoritySeed: Uint8Array;
  /** Base58 public key of `authoritySeed`. */
  authority: string;
}

/** The agent secret for `agentId`, from the owner's `UserKeys.agentRoot`. */
export function agentSecret(agentRoot: Uint8Array, agentId: string): Uint8Array {
  return hkdf(sha256, agentRoot, SALT, info(`vexa/agent/v1/${agentId}`), 32);
}

/** A 64-byte hash reduced to a canonical scalar, little-endian. */
function scalar(bytes: Uint8Array): Uint8Array {
  const n = ed25519.Point.Fn.ORDER;
  let x = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(bytes[i]!);
  x %= n;
  if (x === 0n) x = 1n;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++, x >>= 8n) out[i] = Number(x & 0xffn);
  return out;
}

export function deriveAgentKeys(agentId: string, secret: Uint8Array): AgentKeys {
  if (secret.length !== 32) throw new Error('agent secrets are 32 bytes');
  const elgamalSecret = scalar(hkdf(sha256, secret, SALT, info('vexa/agent/elgamal'), 64));
  const elgamal = ElGamalKeypair.fromSecretKey(ElGamalSecretKey.fromBytes(elgamalSecret));
  const aeBytes = hkdf(sha256, secret, SALT, info('vexa/agent/ae'), 16);
  const authoritySeed = hkdf(sha256, secret, SALT, info('vexa/agent/authority'), 32);
  return {
    agentId,
    secret,
    elgamal,
    elgamalSecret,
    elgamalPubkey: base64Encode(elgamal.pubkey().toBytes()),
    ae: AeKey.fromBytes(aeBytes),
    aeBytes,
    openingSeed: hkdf(sha256, secret, SALT, info('vexa/agent/openings'), 32),
    authoritySeed,
    authority: base58Encode(ed25519.getPublicKey(authoritySeed)),
  };
}

const PREFIX = 'vxagent_';

/** The string an owner gives their agent software: `vxagent_<id>.<base58 secret>`. */
export function encodeAgentCredential(agentId: string, secret: Uint8Array): string {
  return `${PREFIX}${agentId}.${base58Encode(secret)}`;
}

export function decodeAgentCredential(credential: string): AgentKeys {
  if (!credential.startsWith(PREFIX)) throw new Error('not a Vexa agent credential');
  const [agentId, secret] = credential.slice(PREFIX.length).split('.');
  if (!agentId || !secret) throw new Error('malformed agent credential');
  return deriveAgentKeys(agentId, base58DecodeStrict(secret, 'agent secret'));
}
