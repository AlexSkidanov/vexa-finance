/**
 * End-to-end encrypted transfer memos, using the ElGamal keys users already
 * have, so no extra key has to be registered.
 *
 * Solana's twisted-ElGamal public keys are P = s⁻¹·H, where H is the Pedersen
 * blinding generator and s the secret scalar. That makes Diffie-Hellman
 * straightforward:
 *
 *   sender:  pick r, publish R = r·H, shared = r·P      (= r·s⁻¹·H)
 *   reader:  shared = s⁻¹·R                            (= s⁻¹·r·H)
 *
 * One ephemeral R serves both the recipient and the sender (so memos show up
 * in the sender's history too). The memo is sealed with a random content key
 * under XChaCha20-Poly1305, and that key is wrapped once per reader.
 *
 * Wire format (version 1):
 *   0x01 | R (32) | key for recipient (48) | key for sender (48) | nonce (24) | ciphertext
 */
import { xchacha20poly1305, chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { sha3_512 } from '@noble/hashes/sha3.js';
import type { ElGamalSecretKey } from '@solana/zk-sdk';

const Point = ristretto255.Point;
const Fn = Point.Fn;
const VERSION = 1;
const INFO = new TextEncoder().encode('vexa/memo/v1');
export const MAX_MEMO_BYTES = 256;

/** H, derived exactly as curve25519-dalek's Pedersen generator. */
const H = (() => {
  const derive = ristretto255_hasher.deriveToCurve;
  if (!derive) throw new Error('@noble/curves is missing ristretto255 deriveToCurve');
  return derive(sha3_512(Point.BASE.toBytes()));
})();

const scalarFromLe = (bytes: Uint8Array) => {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) + BigInt(bytes[i]!);
  return Fn.create(n);
};

function wrapKey(shared: Uint8Array, R: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, R, INFO, 32);
}

function randomScalar(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  return Fn.create(scalarFromLe(bytes) || 1n);
}

export function encryptMemo(input: {
  text: string;
  recipientElgamalPubkey: Uint8Array;
  senderElgamalPubkey: Uint8Array;
}): Uint8Array {
  const plaintext = new TextEncoder().encode(input.text);
  if (plaintext.length > MAX_MEMO_BYTES)
    throw new Error(`memo is longer than ${MAX_MEMO_BYTES} bytes`);

  const r = randomScalar();
  const R = H.multiply(r).toBytes();
  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  // Each wrap key is unique to (reader, R), so a fixed nonce is safe here.
  const zeroNonce = new Uint8Array(12);
  const wrapFor = (pubkey: Uint8Array) => {
    const shared = Point.fromBytes(pubkey).multiply(r).toBytes();
    return chacha20poly1305(wrapKey(shared, R), zeroNonce).encrypt(contentKey);
  };

  const sealed = xchacha20poly1305(contentKey, nonce, R).encrypt(plaintext);
  const out = new Uint8Array(1 + 32 + 48 + 48 + 24 + sealed.length);
  out[0] = VERSION;
  out.set(R, 1);
  out.set(wrapFor(input.recipientElgamalPubkey), 33);
  out.set(wrapFor(input.senderElgamalPubkey), 81);
  out.set(nonce, 129);
  out.set(sealed, 153);
  return out;
}

/** Decrypts a memo as its recipient or its sender. Returns null if it isn't readable with this key. */
export function decryptMemo(
  memo: Uint8Array,
  secret: ElGamalSecretKey,
  as: 'recipient' | 'sender',
): string | null {
  if (memo.length < 153 + 16 || memo[0] !== VERSION) return null;
  const R = memo.subarray(1, 33);
  const wrapped = as === 'recipient' ? memo.subarray(33, 81) : memo.subarray(81, 129);
  const nonce = memo.subarray(129, 153);
  try {
    const s = scalarFromLe(secret.toBytes());
    const shared = Point.fromBytes(R).multiply(Fn.inv(s)).toBytes();
    const contentKey = chacha20poly1305(wrapKey(shared, R), new Uint8Array(12)).decrypt(wrapped);
    return new TextDecoder().decode(
      xchacha20poly1305(contentKey, nonce, R).decrypt(memo.subarray(153)),
    );
  } catch {
    return null;
  }
}
