/**
 * $VEXA tiers. A holder's weight is their staked $VEXA plus half of what sits
 * in their wallet (staking is the stronger commitment). The weight picks a
 * tier; the tier sets the fee discount the vault applies and how many agents
 * and how much agent spend per day the API allows.
 *
 * The discounts here must match the tiers in the vault's fee schedule
 * (`pnpm vault:set-fees`), which is what the program actually charges.
 */

/** $VEXA has 6 decimals, like USDC. */
export const VEXA_DECIMALS = 6;
const VEXA = 10n ** BigInt(VEXA_DECIMALS);
const USDC = 1_000_000n;

export interface Tier {
  level: number;
  /** Minimum weight, in $VEXA base units. */
  minWeight: bigint;
  /** Fee discount, in basis points of the fee. */
  discountBps: number;
  maxAgents: number;
  /** Most an owner's agents may spend per rolling 24 hours each, in USDC base units. */
  agentDailyLimit: bigint;
}

export const TIERS: readonly Tier[] = [
  { level: 0, minWeight: 0n, discountBps: 0, maxAgents: 3, agentDailyLimit: 500n * USDC },
  {
    level: 1,
    minWeight: 1_000n * VEXA,
    discountBps: 1_000,
    maxAgents: 5,
    agentDailyLimit: 2_500n * USDC,
  },
  {
    level: 2,
    minWeight: 10_000n * VEXA,
    discountBps: 2_500,
    maxAgents: 10,
    agentDailyLimit: 10_000n * USDC,
  },
  {
    level: 3,
    minWeight: 100_000n * VEXA,
    discountBps: 5_000,
    maxAgents: 25,
    agentDailyLimit: 25_000n * USDC,
  },
  {
    level: 4,
    minWeight: 1_000_000n * VEXA,
    discountBps: 7_500,
    maxAgents: 50,
    agentDailyLimit: 50_000n * USDC,
  },
];

/** Staked $VEXA in full, wallet $VEXA at half. Mirrors the vault's `vexa_weight`. */
export function vexaWeight(staked: bigint, held: bigint): bigint {
  return staked + held / 2n;
}

export function tierFor(weight: bigint): Tier {
  return [...TIERS].reverse().find((t) => weight >= t.minWeight) ?? TIERS[0]!;
}

/** The fee-schedule tiers (for `vault:set-fees`) derived from this table. */
export function feeScheduleTiers() {
  return TIERS.filter((t) => t.discountBps > 0).map((t) => ({
    minBalance: t.minWeight,
    discountBps: t.discountBps,
  }));
}
