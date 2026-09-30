import { describe, expect, it } from 'vitest';
import { formatUsdc, formatUsdc2, shortSig } from './format';

describe('formatUsdc', () => {
  it('groups and keeps two decimals minimum', () => {
    expect(formatUsdc(4_182_660_120_000n)).toBe('4,182,660.12');
    expect(formatUsdc(12_500_000n)).toBe('12.50');
    expect(formatUsdc(0n)).toBe('0.00');
    expect(formatUsdc(1_000_001n)).toBe('1.000001');
  });
  it('truncates to two decimals for the reserve strip', () => {
    expect(formatUsdc2(4_182_660_129_999n)).toBe('4,182,660.12');
  });
});

describe('shortSig', () => {
  it('keeps the ends', () => {
    expect(shortSig('5KqAbcdefe2a')).toBe('5Kq…e2a');
  });
});
