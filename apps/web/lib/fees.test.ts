import { describe, expect, it } from 'vitest';
import { calculate, parseAmount, vaultFee } from './fees';

describe('vaultFee', () => {
  it('charges 0.10%', () => {
    expect(vaultFee(1000, 0)).toBe(1);
  });
  it('caps at 5 USDC', () => {
    expect(vaultFee(1_000_000, 0)).toBe(5);
  });
  it('applies the tier discount after the cap', () => {
    expect(vaultFee(1_000_000, 0.75)).toBe(1.25);
    expect(vaultFee(1000, 0.1)).toBe(0.9);
  });
  it('rounds up to the smallest unit', () => {
    expect(vaultFee(0.0015, 0)).toBe(0.000002);
  });
});

describe('parseAmount', () => {
  it('strips separators and junk', () => {
    expect(parseAmount('1,000')).toBe(1000);
    expect(parseAmount('$12.50 USDC')).toBe(12.5);
    expect(parseAmount('')).toBe(0);
  });
});

describe('calculate', () => {
  it('deposit: fee and what lands', () => {
    const r = calculate('deposit', '1,000', 0);
    expect(r.lines).toEqual([{ k: 'Vault fee 0.10%, capped at 5', v: '1.00 USDC' }]);
    expect(r.totalLabel).toBe('Lands privately');
    expect(r.total).toBe('999.00 USDC');
  });
  it('deposit: shows the tier discount line', () => {
    const r = calculate('deposit', '1000', 2);
    expect(r.lines[1]).toEqual({ k: 'Tier 2 discount', v: '−25%' });
    expect(r.total).toBe('999.25 USDC');
  });
  it('stealth: bridge plus the vault fee twice', () => {
    const r = calculate('stealth', '100', 0);
    expect(r.lines[0]?.v).toBe('0.80 USDC');
    expect(r.lines[1]?.v).toBe('0.20 USDC');
    expect(r.total).toBe('99.00 USDC');
  });
  it('stealth: flags the minimum and never goes negative', () => {
    const r = calculate('stealth', '0.5', 0);
    expect(r.lines.at(-1)).toEqual({ k: 'Minimum for stealth', v: '5 USDC' });
    expect(r.total).toBe('0.00 USDC');
  });
});
