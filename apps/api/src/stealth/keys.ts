/**
 * Route accounts: one-time Solana addresses (with confidential keys) that a
 * stealth route passes through. Derived from STEALTH_ROUTE_SEED and the route
 * id, so nothing about them is stored and a restarted worker picks up where
 * it left off.
 *
 *   entry: receives the sender's USDC, pays 1Click, and (on refund) pays the sender back
 *   exit:  receives 1Click's USDC, deposits it into the vault, pays the recipient
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { createKeyPairSignerFromPrivateKeyBytes, type KeyPairSigner } from '@solana/kit';
import { hexToBytes } from '@vexa/core';
import { deriveAgentKeys, type AgentKeys } from '@vexa/core/agent';

export type RouteRole = 'entry' | 'exit';

export interface RouteAccount {
  role: RouteRole;
  signer: KeyPairSigner;
  /** Confidential keys, for opening its cUSDC account and proving its transfer. */
  keys: AgentKeys;
}

export async function routeAccount(
  seedHex: string,
  routeId: string,
  role: RouteRole,
): Promise<RouteAccount> {
  const secret = hkdf(
    sha256,
    hexToBytes(seedHex),
    new TextEncoder().encode('vexa.finance'),
    new TextEncoder().encode(`vexa/stealth/v1/${routeId}/${role}`),
    32,
  );
  // The agent key schedule gives an ElGamal keypair, an AE key and an Ed25519
  // seed from one secret; a route account needs exactly that.
  const keys = deriveAgentKeys(`${routeId}:${role}`, secret);
  return { role, keys, signer: await createKeyPairSignerFromPrivateKeyBytes(keys.authoritySeed) };
}
