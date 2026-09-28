/**
 * Homomorphic arithmetic on twisted-ElGamal ciphertexts.
 *
 * A ciphertext is two compressed Ristretto255 points: a Pedersen commitment
 * C = amount·G + r·H and a decrypt handle D = r·P (P the recipient's public
 * key). Grouped ciphertexts share one commitment across several handles:
 * C ‖ D₀ ‖ D₁ ‖ D₂. Adding ciphertexts adds the points component-wise, which
 * adds the hidden amounts.
 *
 * @solana/zk-sdk's WASM build generates and verifies proofs but doesn't expose
 * ciphertext arithmetic, so it lives here, on @noble/curves. The byte
 * encodings are identical to curve25519-dalek's, so values move freely
 * between the two.
 */
import { ristretto255 } from '@noble/curves/ed25519.js';

const Point = ristretto255.Point;
type P = InstanceType<typeof Point>;

export const ELGAMAL_CIPHERTEXT_LEN = 64;
export const GROUPED_3_HANDLES_LEN = 128;

/** Transfer amounts are split into a 16-bit low part and a 32-bit high part. */
export const TRANSFER_AMOUNT_LO_BITS = 16;
export const TRANSFER_AMOUNT_HI_BITS = 32;

function decode(bytes: Uint8Array): P {
  // The all-zero encoding is the identity; noble rejects it as a "point" in
  // some paths, so special-case it.
  return bytes.every((b) => b === 0) ? Point.ZERO : Point.fromBytes(bytes);
}

function points(ciphertext: Uint8Array): [P, P] {
  if (ciphertext.length !== ELGAMAL_CIPHERTEXT_LEN)
    throw new Error('ElGamal ciphertext must be 64 bytes');
  return [decode(ciphertext.subarray(0, 32)), decode(ciphertext.subarray(32, 64))];
}

function encode([c, d]: [P, P]): Uint8Array {
  const out = new Uint8Array(ELGAMAL_CIPHERTEXT_LEN);
  out.set(c.toBytes(), 0);
  out.set(d.toBytes(), 32);
  return out;
}

/** a − b */
export function subtractCiphertexts(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [ac, ad] = points(a);
  const [bc, bd] = points(b);
  return encode([ac.subtract(bc), ad.subtract(bd)]);
}

/** a + b */
export function addCiphertexts(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [ac, ad] = points(a);
  const [bc, bd] = points(b);
  return encode([ac.add(bc), ad.add(bd)]);
}

/** lo + hi·2^bits: reassembles a split amount's ciphertext. */
export function combineLoHi(
  lo: Uint8Array,
  hi: Uint8Array,
  bits = TRANSFER_AMOUNT_LO_BITS,
): Uint8Array {
  const [lc, ld] = points(lo);
  const [hc, hd] = points(hi);
  const shift = 1n << BigInt(bits);
  return encode([lc.add(hc.multiply(shift)), ld.add(hd.multiply(shift))]);
}

/**
 * The plain ElGamal ciphertext for one handle of a grouped ciphertext: the
 * shared commitment plus that handle. Index 0 is the source, 1 the
 * destination, 2 the auditor in a transfer.
 */
export function extractFromGrouped(grouped: Uint8Array, index: 0 | 1 | 2): Uint8Array {
  if (grouped.length !== GROUPED_3_HANDLES_LEN)
    throw new Error('grouped ciphertext must be 128 bytes');
  const out = new Uint8Array(ELGAMAL_CIPHERTEXT_LEN);
  out.set(grouped.subarray(0, 32), 0);
  out.set(grouped.subarray(32 + index * 32, 64 + index * 32), 32);
  return out;
}

/** The Pedersen commitment of a (grouped) ciphertext: its first 32 bytes. */
export function commitmentOf(ciphertext: Uint8Array): Uint8Array {
  return ciphertext.slice(0, 32);
}

/** Splits an amount into its (lo, hi) transfer halves; throws above 48 bits. */
export function splitAmount(amount: bigint): [bigint, bigint] {
  const max = 1n << BigInt(TRANSFER_AMOUNT_LO_BITS + TRANSFER_AMOUNT_HI_BITS);
  if (amount < 0n || amount >= max)
    throw new Error('amount exceeds the 48-bit confidential transfer limit');
  const mask = (1n << BigInt(TRANSFER_AMOUNT_LO_BITS)) - 1n;
  return [amount & mask, amount >> BigInt(TRANSFER_AMOUNT_LO_BITS)];
}
