import { describe, expect, it } from 'vitest';
import { isElGamalPubkey, verifySolanaSignature } from '../src/keys.js';
import {
  decryptAvailableBalance,
  decryptableZeroBalance,
  deriveUserKeys,
  pubkeyValidityProof,
  signWithSolanaSeed,
} from '../src/crypto/index.js';
import { PubkeyValidityProofData } from '@solana/zk-sdk';

const prf = (fill: number) => new Uint8Array(32).fill(fill);

describe('client-side key derivation', () => {
  it('is deterministic per passkey and distinct across passkeys', () => {
    const a = deriveUserKeys(prf(1));
    const b = deriveUserKeys(prf(1));
    const c = deriveUserKeys(prf(2));
    expect(a.solanaAddress).toBe(b.solanaAddress);
    expect(a.elgamalPubkey).toBe(b.elgamalPubkey);
    expect(a.solanaAddress).not.toBe(c.solanaAddress);
    expect(a.elgamalPubkey).not.toBe(c.elgamalPubkey);
  });

  it('produces an ElGamal key the server-side validator accepts', () => {
    expect(isElGamalPubkey(deriveUserKeys(prf(3)).elgamalPubkey)).toBe(true);
  });

  it('signs with the derived Solana key', () => {
    const keys = deriveUserKeys(prf(4));
    const msg = new TextEncoder().encode('claim');
    expect(verifySolanaSignature(msg, signWithSolanaSeed(keys.solanaSeed, msg), keys.solanaAddress)).toBe(true);
  });

  it('builds a pubkey validity proof that verifies', () => {
    const keys = deriveUserKeys(prf(5));
    const bytes = pubkeyValidityProof(keys.elgamal);
    expect(() => PubkeyValidityProofData.fromBytes(bytes).verify()).not.toThrow();
  });

  it('encrypts a zero balance the AE key can read back', () => {
    const keys = deriveUserKeys(prf(6));
    const ct = decryptableZeroBalance(keys.ae);
    expect(ct.length).toBe(36);
    expect(decryptAvailableBalance(keys.ae, ct)).toBe(0n);
  });
});
