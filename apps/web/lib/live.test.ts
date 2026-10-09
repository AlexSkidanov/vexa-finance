import { describe, expect, it } from 'vitest';
import { keyScheme } from './live';

describe('keyScheme', () => {
  it('reads the scheme NEAR prints before the colon', () => {
    expect(keyScheme('ed25519:Ghpm6k9cREU78JkizYoYH2ipBsdCpN7UovGu4wtjCbjK')).toBe('ed25519');
    expect(keyScheme('secp256k1:abc')).toBe('secp256k1');
  });

  it('treats the on-trie ML-DSA-65 hash form as ML-DSA-65', () => {
    expect(keyScheme('ml-dsa-65-hash:Hj4tSfmzG7ctHewaVq1xZwMTBqzsTEUNcDsZRBFFRUDW')).toBe(
      'ml-dsa-65',
    );
    expect(keyScheme('ml-dsa-65:4zRQ8J9cuu2Y')).toBe('ml-dsa-65');
  });
});
