import { ed25519, ristretto255 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { base58Encode, base64Encode } from '../src/encoding.js';
import { isElGamalPubkey, isSolanaAddress, verifySolanaSignature } from '../src/keys.js';

describe('key validation', () => {
  it('accepts a 32-byte base58 address', () => {
    expect(isSolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(true);
    expect(isSolanaAddress('not-base58!')).toBe(false);
    expect(isSolanaAddress(base58Encode(new Uint8Array(31).fill(7)))).toBe(false);
  });

  it('accepts only valid, non-identity Ristretto points as ElGamal keys', () => {
    const valid = base64Encode(ristretto255.Point.BASE.multiply(42n).toBytes());
    expect(isElGamalPubkey(valid)).toBe(true);
    expect(isElGamalPubkey(base64Encode(ristretto255.Point.ZERO.toBytes()))).toBe(false);
    // 0xff…ff is not a canonical Ristretto encoding.
    expect(isElGamalPubkey(base64Encode(new Uint8Array(32).fill(0xff)))).toBe(false);
    expect(isElGamalPubkey('short')).toBe(false);
  });

  it('verifies ed25519 signatures from Solana keys', () => {
    const seed = ed25519.utils.randomSecretKey();
    const address = base58Encode(ed25519.getPublicKey(seed));
    const msg = new TextEncoder().encode('hello');
    const sig = base58Encode(ed25519.sign(msg, seed));
    expect(verifySolanaSignature(msg, sig, address)).toBe(true);
    expect(verifySolanaSignature(new TextEncoder().encode('hellO'), sig, address)).toBe(false);
  });
});
