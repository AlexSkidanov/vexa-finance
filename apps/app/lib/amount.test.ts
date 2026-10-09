import { describe, expect, it } from 'vitest';
import {
  amountToInput,
  cleanAmountInput,
  formatAmount,
  formatBps,
  parseAmount,
  percentOf,
} from './amount';

describe('parseAmount', () => {
  it('parses whole and fractional amounts to base units', () => {
    expect(parseAmount('12.5')).toEqual({ ok: true, value: 12_500_000n });
    expect(parseAmount('0.000001')).toEqual({ ok: true, value: 1n });
    expect(parseAmount('.5')).toEqual({ ok: true, value: 500_000n });
    expect(parseAmount('7.')).toEqual({ ok: true, value: 7_000_000n });
    expect(parseAmount(' 1,234,567.89 ')).toEqual({ ok: true, value: 1_234_567_890_000n });
  });

  it('keeps precision a float would lose', () => {
    expect(parseAmount('9007199254.740993')).toEqual({ ok: true, value: 9_007_199_254_740_993n });
    expect(parseAmount('0.1')).toEqual({ ok: true, value: 100_000n });
  });

  it('rejects rather than rounds', () => {
    expect(parseAmount('1.0000001')).toEqual({ ok: false, reason: 'too_many_decimals' });
    expect(parseAmount('')).toEqual({ ok: false, reason: 'empty' });
    expect(parseAmount('.')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseAmount('-1')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseAmount('1e6')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseAmount('1.2.3')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseAmount('0.000')).toEqual({ ok: false, reason: 'zero' });
  });
});

describe('cleanAmountInput', () => {
  it('allows partial input while typing', () => {
    expect(cleanAmountInput('')).toBe('');
    expect(cleanAmountInput('12.')).toBe('12.');
    expect(cleanAmountInput('0.5')).toBe('0.5');
    expect(cleanAmountInput('007')).toBe('7');
    expect(cleanAmountInput('1,000')).toBe('1000');
  });
  it('rejects stray characters but leaves extra decimals for parseAmount to flag', () => {
    expect(cleanAmountInput('1.1234567')).toBe('1.1234567');
    expect(cleanAmountInput('1a')).toBeNull();
    expect(cleanAmountInput('1..2')).toBeNull();
  });
});

describe('formatAmount', () => {
  it('groups thousands and keeps at least two decimals', () => {
    expect(formatAmount(0n)).toBe('0.00');
    expect(formatAmount(1_234_500_000n)).toBe('1,234.50');
    expect(formatAmount(1n)).toBe('0.000001');
    expect(formatAmount(-2_500_000n)).toBe('-2.50');
    expect(formatAmount(5_000_000n, { minDecimals: 0 })).toBe('5');
  });
  it('round-trips through the input form', () => {
    for (const v of [1n, 10n, 1_000_000n, 1_234_567_891n, 999_999_999_999n]) {
      const back = parseAmount(amountToInput(v));
      expect(back).toEqual({ ok: true, value: v });
    }
  });
});

describe('formatBps and percentOf', () => {
  it('formats basis points', () => {
    expect(formatBps(1000)).toBe('10%');
    expect(formatBps(7500)).toBe('75%');
    expect(formatBps(10)).toBe('0.1%');
    expect(formatBps(0)).toBe('0%');
  });
  it('clamps percentages', () => {
    expect(percentOf(5n, 20n)).toBe(25);
    expect(percentOf(30n, 20n)).toBe(100);
    expect(percentOf(1n, 0n)).toBe(0);
  });
});
