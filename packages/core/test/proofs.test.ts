import { describe, expect, it } from 'vitest';
import {
  AeKey,
  BatchedGroupedCiphertext3HandlesValidityProofData,
  BatchedRangeProofU128Data,
  BatchedRangeProofU64Data,
  CiphertextCommitmentEqualityProofData,
  ElGamalKeypair,
  PedersenOpening,
} from '@solana/zk-sdk';
import {
  buildTransferProofs,
  buildWithdrawProofs,
  decryptPendingBalance,
  decryptTransferAmount,
} from '../src/crypto/proofs.js';
import {
  addCiphertexts,
  combineLoHi,
  splitAmount,
  subtractCiphertexts,
} from '../src/crypto/ristretto.js';

/** An account holding `balance` in its available balance, as Token-2022 would store it. */
function account(balance: bigint) {
  const elgamal = new ElGamalKeypair();
  const ae = new AeKey();
  return {
    elgamal,
    ae,
    availableBalance: elgamal.pubkey().encryptWith(balance, new PedersenOpening()).toBytes(),
    decryptableAvailableBalance: ae.encrypt(balance).toBytes(),
  };
}

describe('ciphertext arithmetic', () => {
  it('adds and subtracts hidden amounts', () => {
    const kp = new ElGamalKeypair();
    const enc = (n: bigint) => kp.pubkey().encryptWith(n, new PedersenOpening()).toBytes();
    const dec = (b: Uint8Array) => decryptPendingBalance(kp.secret(), b, enc(0n));
    expect(dec(addCiphertexts(enc(40n), enc(2n)))).toBe(42n);
    expect(dec(subtractCiphertexts(enc(50n), enc(8n)))).toBe(42n);
    expect(dec(combineLoHi(enc(2n), enc(1n)))).toBe(2n + (1n << 16n));
  });

  it('splits amounts into 16/32-bit halves and refuses anything larger', () => {
    expect(splitAmount(1_234_567n)).toEqual([1_234_567n & 0xffffn, 1_234_567n >> 16n]);
    expect(() => splitAmount(1n << 48n)).toThrow();
  });
});

describe('transfer proofs', () => {
  it('produce proofs that verify, and ciphertexts only the right parties can read', () => {
    const alice = account(100_000_000n);
    const bob = new ElGamalKeypair();
    const auditor = new ElGamalKeypair();
    const amount = 12_345_678n;

    const proofs = buildTransferProofs({
      ...alice,
      amount,
      destinationElgamalPubkey: bob.pubkey().toBytes(),
      auditorElgamalPubkey: auditor.pubkey().toBytes(),
    });

    expect(() =>
      CiphertextCommitmentEqualityProofData.fromBytes(proofs.equalityProof).verify(),
    ).not.toThrow();
    expect(() =>
      BatchedGroupedCiphertext3HandlesValidityProofData.fromBytes(
        proofs.ciphertextValidityProof,
      ).verify(),
    ).not.toThrow();
    expect(() => BatchedRangeProofU128Data.fromBytes(proofs.rangeProof).verify()).not.toThrow();

    const { groupedCiphertextLo: lo, groupedCiphertextHi: hi } = proofs;
    expect(decryptTransferAmount(alice.elgamal.secret(), lo, hi, 0)).toBe(amount);
    expect(decryptTransferAmount(bob.secret(), lo, hi, 1)).toBe(amount);
    expect(decryptTransferAmount(auditor.secret(), lo, hi, 2)).toBe(amount);
  });

  it('works without an auditor', () => {
    const alice = account(10n);
    const proofs = buildTransferProofs({
      ...alice,
      amount: 10n,
      destinationElgamalPubkey: new ElGamalKeypair().pubkey().toBytes(),
      auditorElgamalPubkey: null,
    });
    expect(() => BatchedRangeProofU128Data.fromBytes(proofs.rangeProof).verify()).not.toThrow();
  });

  it('refuses to overdraw', () => {
    const alice = account(5n);
    expect(() =>
      buildTransferProofs({
        ...alice,
        amount: 6n,
        destinationElgamalPubkey: new ElGamalKeypair().pubkey().toBytes(),
        auditorElgamalPubkey: null,
      }),
    ).toThrow(/insufficient/);
  });
});

describe('withdraw proofs', () => {
  it('produce an equality and a 64-bit range proof that verify', () => {
    const alice = account(50_000_000n);
    const proofs = buildWithdrawProofs({ ...alice, amount: 20_000_000n });
    expect(() =>
      CiphertextCommitmentEqualityProofData.fromBytes(proofs.equalityProof).verify(),
    ).not.toThrow();
    expect(() => BatchedRangeProofU64Data.fromBytes(proofs.rangeProof).verify()).not.toThrow();
  });
});
