/**
 * Client-side key derivation and proof helpers, wrapping @solana/zk-sdk.
 *
 * Import this from the SDK or a browser, never from the API. It loads a WASM
 * module and handles secret key material. The server's job is to relay
 * ciphertexts and proofs, not to make them.
 *
 * ## Where a user's keys come from
 *
 * Nothing is stored. Every key a user has is re-derived on demand from their
 * passkey's WebAuthn PRF output: a 32-byte secret the authenticator computes
 * from a fixed input and never reveals otherwise.
 *
 *   PRF output ─┬─ ConfidentialKeys.fromPrf ─┬─ ElGamal keypair   (decrypts balances, proves transfers)
 *               │                            └─ AE key            (fast local decryption of the available balance)
 *               └─ HKDF("vexa/solana-wallet/v1") ─ ed25519 seed    (signs Solana transactions)
 *
 * Losing the passkey means losing the keys, so users should register more than
 * one passkey. They sync across devices through iCloud Keychain or Google
 * Password Manager.
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  AeCiphertext,
  AeKey,
  ConfidentialKeys,
  ElGamalCiphertext,
  ElGamalKeypair,
  PubkeyValidityProofData,
} from '@solana/zk-sdk';
import { base58Encode, base64Encode } from '../encoding.js';

const SOLANA_WALLET_INFO = new TextEncoder().encode('vexa/solana-wallet/v1');
const SOLANA_WALLET_SALT = new TextEncoder().encode('vexa.finance');

export interface UserKeys {
  /** 32-byte ed25519 seed for the user's Solana wallet. Keep in memory only. */
  solanaSeed: Uint8Array;
  /** Base58 Solana address derived from `solanaSeed`. */
  solanaAddress: string;
  elgamal: ElGamalKeypair;
  ae: AeKey;
  /** Base64 ElGamal public key, the form the API and handle resolver use. */
  elgamalPubkey: string;
}

/**
 * The PRF input to pass to `navigator.credentials.get({ publicKey: { extensions:
 * { prf: { eval: { first } } } } })`. Using the zk-sdk's standard input means
 * other wallets that follow the same convention derive identical confidential
 * keys from the same passkey.
 */
export function passkeyPrfInput(): Uint8Array {
  return ConfidentialKeys.prfInput();
}

/** Derives every key a user needs from their passkey's PRF output. */
export function deriveUserKeys(prfOutput: Uint8Array): UserKeys {
  if (prfOutput.length !== 32) throw new Error('PRF output must be 32 bytes');
  const confidential = ConfidentialKeys.fromPrf(prfOutput);
  const solanaSeed = hkdf(sha256, prfOutput, SOLANA_WALLET_SALT, SOLANA_WALLET_INFO, 32);
  const elgamal = confidential.elgamal();
  return {
    solanaSeed,
    solanaAddress: base58Encode(ed25519.getPublicKey(solanaSeed)),
    elgamal,
    ae: confidential.ae(),
    elgamalPubkey: base64Encode(elgamal.pubkey().toBytes()),
  };
}

/** Detached ed25519 signature (base58) by the user's Solana key. */
export function signWithSolanaSeed(seed: Uint8Array, message: Uint8Array): string {
  return base58Encode(ed25519.sign(message, seed));
}

/**
 * The proof Token-2022 requires before an account can hold a confidential
 * balance: evidence that the ElGamal public key is well-formed and that the
 * account owner knows its secret key. Returns the serialized proof data for a
 * VerifyPubkeyValidity instruction.
 */
export function pubkeyValidityProof(elgamal: ElGamalKeypair): Uint8Array {
  const proof = new PubkeyValidityProofData(elgamal);
  try {
    return proof.toBytes();
  } finally {
    proof.free();
  }
}

/**
 * The AE-encrypted zero balance that ConfigureAccount stores as the account's
 * starting "decryptable available balance". 36 bytes.
 */
export function decryptableZeroBalance(ae: AeKey): Uint8Array {
  const ct = ae.encrypt(0n);
  try {
    return ct.toBytes();
  } finally {
    ct.free();
  }
}

/** Decrypts an account's AE-encrypted available balance. Fast; no discrete log. */
export function decryptAvailableBalance(ae: AeKey, ciphertext: Uint8Array): bigint {
  const ct = AeCiphertext.fromBytes(ciphertext);
  if (!ct) throw new Error('malformed AE ciphertext');
  try {
    const amount = ct.decrypt(ae);
    if (amount === undefined) throw new Error('ciphertext was not encrypted under this key');
    return amount;
  } finally {
    ct.free();
  }
}

/**
 * Checks that a 64-byte ElGamal ciphertext is well formed. Actual decryption of
 * pending balances and transfer amounts (a bounded discrete log) lands with
 * confidential transfers in Phase 2.
 */
export function isElGamalCiphertext(bytes: Uint8Array): boolean {
  const ct = ElGamalCiphertext.fromBytes(bytes);
  ct?.free();
  return ct !== undefined;
}

export { AeKey, ElGamalKeypair };
export * from './proofs.js';
export * from './ristretto.js';
export * from './memo.js';
