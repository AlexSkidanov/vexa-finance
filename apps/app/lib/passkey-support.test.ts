import { describe, expect, it } from 'vitest';
import { passkeyVerdict } from './passkey-support';

describe('passkeyVerdict', () => {
  it('needs WebAuthn at all', () => {
    expect(passkeyVerdict({ webauthn: false, platform: null, prf: null })).toBe('unsupported');
  });
  it('trusts an explicit PRF answer', () => {
    expect(passkeyVerdict({ webauthn: true, platform: true, prf: true })).toBe('supported');
    expect(passkeyVerdict({ webauthn: true, platform: true, prf: false })).toBe('unsupported');
  });
  it('is hopeful when the browser can’t say', () => {
    expect(passkeyVerdict({ webauthn: true, platform: true, prf: null })).toBe('likely');
  });
});
