import { describe, expect, it } from 'vitest';
import { formatUsdc, parseUsdc } from '../src/usdc.js';

describe('usdc', () => {
  it('round-trips', () => {
    for (const s of ['0', '1', '12.5', '0.000001', '1000000.123456']) {
      expect(formatUsdc(parseUsdc(s))).toBe(s);
    }
  });
  it('refuses to silently round', () => {
    expect(() => parseUsdc('1.0000001')).toThrow();
    expect(() => parseUsdc('-1')).toThrow();
  });
});
