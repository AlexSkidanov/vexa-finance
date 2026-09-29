/**
 * The vault's protocol fee, mirrored from programs/vault/src/fees.rs.
 *
 * The program is the authority: it computes the fee itself and takes it
 * on-chain. This copy exists so a device can show the fee before signing and
 * re-encrypt its balance for the amount that will actually land. It must
 * agree with the program to the base unit; the tests in fees.test.ts pin
 * the same cases as the Rust tests.
 */
import {
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
} from '@solana/kit';
import { VAULT_PROGRAM } from './programs.js';

export const FEE_SCHEDULE_LEN = 117;
const FEE_SCHEDULE_ACCOUNT_TYPE = 2;
const BPS = 10_000n;
const ZERO_ADDRESS = '11111111111111111111111111111111' as Address;

export interface FeeTier {
  /** $VEXA base units the owner must hold. */
  minBalance: bigint;
  /** Discount off the fee, in basis points of the fee. */
  discountBps: number;
}

export interface FeeSchedule {
  /** Fee in basis points of the amount. 10 = 0.10%. */
  feeBps: number;
  /** Maximum fee, in USDC base units. */
  feeCap: bigint;
  /** The treasury's USDC token account. */
  treasury: Address;
  /** The $VEXA mint, or null while discounts are off. */
  vexaMint: Address | null;
  /** Lowest first; the best tier an owner meets applies. */
  tiers: FeeTier[];
}

export async function findFeeSchedule(vault: Address = VAULT_PROGRAM): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: vault, seeds: ['fees'] });
  return pda;
}

/** Decodes the `["fees"]` account. Returns null for anything else. */
export function decodeFeeSchedule(data: Uint8Array): FeeSchedule | null {
  if (data.length !== FEE_SCHEDULE_LEN || data[0] !== FEE_SCHEDULE_ACCOUNT_TYPE) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const addresses = getAddressDecoder();
  const vexaMint = addresses.decode(data.subarray(44, 76));
  const tierCount = Math.min(data[76]!, 4);
  const tiers: FeeTier[] = [];
  for (let i = 0; i < tierCount; i++) {
    const at = 77 + i * 10;
    tiers.push({
      minBalance: view.getBigUint64(at, true),
      discountBps: view.getUint16(at + 8, true),
    });
  }
  return {
    treasury: addresses.decode(data.subarray(2, 34)),
    feeBps: view.getUint16(34, true),
    feeCap: view.getBigUint64(36, true),
    vexaMint: vexaMint === ZERO_ADDRESS ? null : vexaMint,
    tiers,
  };
}

/**
 * Encodes `SetFees` arguments (everything after the tag). The layout is the
 * schedule account from offset 34.
 */
export function encodeFeeTerms(terms: Omit<FeeSchedule, 'treasury'>): Uint8Array {
  const out = new Uint8Array(43 + terms.tiers.length * 10);
  const view = new DataView(out.buffer);
  view.setUint16(0, terms.feeBps, true);
  view.setBigUint64(2, terms.feeCap, true);
  if (terms.vexaMint) out.set(getAddressEncoder().encode(terms.vexaMint), 10);
  out[42] = terms.tiers.length;
  terms.tiers.forEach((tier, i) => {
    view.setBigUint64(43 + i * 10, tier.minBalance, true);
    view.setUint16(51 + i * 10, tier.discountBps, true);
  });
  return out;
}

/** The discount, in basis points, of the best tier `vexaBalance` meets. */
export function feeDiscountBps(schedule: FeeSchedule, vexaBalance: bigint): number {
  return [...schedule.tiers].reverse().find((t) => vexaBalance >= t.minBalance)?.discountBps ?? 0;
}

/**
 * The fee the vault will take from `amount`:
 * min(⌈amount × feeBps / 10 000⌉, feeCap), less the discount (rounded down,
 * so the fee rounds up). Pass the owner's $VEXA balance, or the discount the
 * API reported for them.
 */
export function quoteFee(
  schedule: FeeSchedule,
  amount: bigint,
  discount: { vexaBalance: bigint } | { discountBps: number } = { discountBps: 0 },
): bigint {
  const U64_MAX = (1n << 64n) - 1n;
  const product = amount * BigInt(schedule.feeBps);
  // The program saturates on overflow; any such amount is far past the cap anyway.
  const raw = product > U64_MAX ? U64_MAX : (product + BPS - 1n) / BPS;
  const capped = raw < schedule.feeCap ? raw : schedule.feeCap;
  const bps = BigInt(
    'vexaBalance' in discount
      ? feeDiscountBps(schedule, discount.vexaBalance)
      : discount.discountBps,
  );
  return capped - (capped * bps) / BPS;
}
