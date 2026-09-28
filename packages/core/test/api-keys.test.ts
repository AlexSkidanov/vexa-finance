import { describe, expect, it } from 'vitest';
import { apiKeyEnvironment, generateApiKey, hashApiKey } from '../src/api-keys.js';

const PEPPER = 'ab'.repeat(32);

describe('api keys', () => {
  it('generates keys whose prefix encodes the environment', () => {
    expect(apiKeyEnvironment(generateApiKey('live'))).toBe('live');
    expect(apiKeyEnvironment(generateApiKey('test'))).toBe('test');
    expect(apiKeyEnvironment('vx_prod_abc')).toBeNull();
    expect(apiKeyEnvironment('vx_live_tooshort')).toBeNull();
  });

  it('hashes deterministically under a pepper, and differently under another', () => {
    const key = generateApiKey('live');
    expect(hashApiKey(key, PEPPER)).toBe(hashApiKey(key, PEPPER));
    expect(hashApiKey(key, PEPPER)).not.toBe(hashApiKey(key, 'cd'.repeat(32)));
    expect(hashApiKey(key, PEPPER)).toMatch(/^[0-9a-f]{64}$/);
  });
});
