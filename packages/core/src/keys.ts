/**
 * Validation for public keys and signatures. Everything here runs on the server,
 * so it deliberately avoids the WASM proof library and uses @noble/curves.
 */
import { ed25519, ristretto255 } from '@noble/curves/ed25519.js';
import { base58Decode, base64Decode } from './encoding.js';

/** A base58-encoded 32-byte Solana address. Off-curve PDAs are allowed. */
export function isSolanaAddress(value: string): boolean {
  return base58Decode(value)?.length === 32;
}

/**
 * A Token-2022 ElGamal public key: a compressed Ristretto255 point, 32 bytes,
 * base64-encoded as the spl-token CLI prints it.
 *
 * Decoding the point, not just checking the length, rejects byte strings that
 * aren't on the curve. Encrypting to one of those produces ciphertexts nobody
 * can decrypt, so the funds would be stuck.
 */
export function isElGamalPubkey(value: string): boolean {
  const bytes = base64Decode(value);
  if (bytes?.length !== 32) return false;
  try {
    const point = ristretto255.Point.fromBytes(bytes);
    // The identity point is a valid encoding but a useless key: ciphertexts
    // under it hide nothing.
    return !point.equals(ristretto255.Point.ZERO);
  } catch {
    return false;
  }
}

/** Verifies a detached ed25519 signature (base58) over `message` by a Solana address. */
export function verifySolanaSignature(
  message: Uint8Array,
  signatureBase58: string,
  address: string,
): boolean {
  const sig = base58Decode(signatureBase58);
  const pub = base58Decode(address);
  if (sig?.length !== 64 || pub?.length !== 32) return false;
  try {
    return ed25519.verify(sig, message, pub);
  } catch {
    return false;
  }
}
