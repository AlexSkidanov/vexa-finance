import { describe, expect, it } from 'vitest';
import { ElGamalKeypair } from '@solana/zk-sdk';
import { decryptMemo, encryptMemo } from '../src/crypto/memo.js';

describe('memos', () => {
  const alice = new ElGamalKeypair();
  const bob = new ElGamalKeypair();
  const mallory = new ElGamalKeypair();
  const memo = encryptMemo({
    text: 'rent for october 🏠',
    recipientElgamalPubkey: bob.pubkey().toBytes(),
    senderElgamalPubkey: alice.pubkey().toBytes(),
  });

  it('can be read by the recipient and the sender, and nobody else', () => {
    expect(decryptMemo(memo, bob.secret(), 'recipient')).toBe('rent for october 🏠');
    expect(decryptMemo(memo, alice.secret(), 'sender')).toBe('rent for october 🏠');
    expect(decryptMemo(memo, mallory.secret(), 'recipient')).toBeNull();
    expect(decryptMemo(memo, bob.secret(), 'sender')).toBeNull();
  });

  it('detects tampering', () => {
    const tampered = memo.slice();
    tampered[tampered.length - 1]! ^= 1;
    expect(decryptMemo(tampered, bob.secret(), 'recipient')).toBeNull();
  });

  it('refuses oversized memos', () => {
    expect(() =>
      encryptMemo({
        text: 'x'.repeat(300),
        recipientElgamalPubkey: bob.pubkey().toBytes(),
        senderElgamalPubkey: alice.pubkey().toBytes(),
      }),
    ).toThrow();
  });
});
