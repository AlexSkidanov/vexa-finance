import { describe, expect, it } from 'vitest';
import type { Address } from '@solana/kit';
import {
  decodeFeeSchedule,
  encodeFeeTerms,
  quoteFee,
  type FeeSchedule,
} from '../src/solana/index.js';

const USDC = 1_000_000n;
const TREASURY = '8eeishQYvtHwwM8QRN9629zzU9hBn18dGFW5T75ytqz6' as Address;
const VEXA = '4STXpFN2mQSt12XG4os7ftLXHbBq5PVWYCAahToRt6QQ' as Address;
const U64_MAX = (1n << 64n) - 1n;

function schedule(feeBps: number, feeCap: bigint, tiers: [bigint, number][] = []): FeeSchedule {
  return {
    feeBps,
    feeCap,
    treasury: TREASURY,
    vexaMint: tiers.length ? VEXA : null,
    tiers: tiers.map(([minBalance, discountBps]) => ({ minBalance, discountBps })),
  };
}

// The same cases as programs/vault/src/fees.rs: the device's quote must match
// what the program takes to the base unit.
describe('quoteFee', () => {
  it('charges 10 bps, capped at 5 USDC, rounding up', () => {
    const s = schedule(10, 5n * USDC);
    expect(quoteFee(s, 100n * USDC)).toBe(100_000n);
    expect(quoteFee(s, 5_000n * USDC)).toBe(5n * USDC);
    expect(quoteFee(s, 1_000_000n * USDC)).toBe(5n * USDC);
    expect(quoteFee(s, 1n)).toBe(1n);
    expect(quoteFee(s, U64_MAX)).toBe(5n * USDC);
    expect(quoteFee(schedule(0, 5n * USDC), 100n * USDC)).toBe(0n);
  });

  it('applies the best $VEXA tier met, rounding the discount down', () => {
    const s = schedule(10, 5n * USDC, [
      [1_000n, 2_500],
      [10_000n, 5_000],
      [100_000n, 10_000],
    ]);
    expect(quoteFee(s, 100n * USDC, { vexaBalance: 999n })).toBe(100_000n);
    expect(quoteFee(s, 100n * USDC, { vexaBalance: 1_000n })).toBe(75_000n);
    expect(quoteFee(s, 100n * USDC, { vexaBalance: 50_000n })).toBe(50_000n);
    expect(quoteFee(s, 100n * USDC, { vexaBalance: 100_000n })).toBe(0n);
    expect(quoteFee(s, 100n * USDC, { discountBps: 5_000 })).toBe(50_000n);
    expect(quoteFee(schedule(10, 3n, [[1n, 2_500]]), U64_MAX, { vexaBalance: 1n })).toBe(3n);
    expect(quoteFee(schedule(10, U64_MAX, [[1n, 5_000]]), U64_MAX, { vexaBalance: 1n })).toBe(
      U64_MAX - U64_MAX / 2n,
    );
  });
});

describe('fee schedule account', () => {
  it('decodes what SetFees writes', () => {
    const s = schedule(10, 5n * USDC, [[1_000n, 2_500]]);
    const data = new Uint8Array(117);
    data[0] = 2;
    data[1] = 254;
    data.set(new Uint8Array(32), 2);
    data.set(encodeFeeTerms(s), 34);
    const decoded = decodeFeeSchedule(data)!;
    expect({ ...decoded, treasury: TREASURY }).toEqual(s);
    expect(decodeFeeSchedule(new Uint8Array(117))).toBeNull();
    expect(decodeFeeSchedule(data.subarray(0, 116))).toBeNull();
  });

  it('reads an all-zero $VEXA mint as no discounts', () => {
    const data = new Uint8Array(117);
    data[0] = 2;
    data.set(encodeFeeTerms(schedule(10, 5n * USDC)), 34);
    expect(decodeFeeSchedule(data)!.vexaMint).toBeNull();
  });
});
