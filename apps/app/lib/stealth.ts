/**
 * The stealth route's states, as GET /v1/transfers/:id reports them, turned
 * into what the tracker shows.
 */
export type StealthStatus =
  | 'awaiting_funds'
  | 'routing'
  | 'shielded'
  | 'returning'
  | 'settling'
  | 'settled'
  | 'refunding'
  | 'refunded'
  | 'failed';

export const STEALTH_STEPS: { status: StealthStatus; label: string; detail: string }[] = [
  {
    status: 'awaiting_funds',
    label: 'Leaving your balance',
    detail: 'Your withdrawal to a one-time entry address is landing.',
  },
  { status: 'routing', label: 'Into Zcash', detail: 'USDC is being swapped to ZEC.' },
  {
    status: 'shielded',
    label: 'Shielded',
    detail: 'In the Zcash shielded pool, waiting out a random delay.',
  },
  { status: 'returning', label: 'Back to USDC', detail: 'ZEC is being swapped back to USDC.' },
  { status: 'settling', label: 'Paying the recipient', detail: 'Depositing and paying privately.' },
  { status: 'settled', label: 'Delivered', detail: 'The recipient has it.' },
];

export type StealthPhase = 'active' | 'done' | 'refunding' | 'refunded' | 'failed';

export interface StealthView {
  phase: StealthPhase;
  /** Index into STEALTH_STEPS of the step in progress (or last reached). */
  step: number;
  title: string;
  message: string;
  terminal: boolean;
}

export function stealthView(status: string | undefined | null): StealthView {
  const i = STEALTH_STEPS.findIndex((s) => s.status === status);
  switch (status) {
    case 'settled':
      return {
        phase: 'done',
        step: STEALTH_STEPS.length - 1,
        title: 'Delivered',
        message: 'The payment reached the recipient with no on-chain link to you.',
        terminal: true,
      };
    case 'refunding':
      return {
        phase: 'refunding',
        step: 1,
        title: 'Refunding',
        message: 'The route couldn’t complete, so the money is on its way back to you.',
        terminal: false,
      };
    case 'refunded':
      return {
        phase: 'refunded',
        step: 1,
        title: 'Refunded',
        message: 'The money is back in your balance, less network fees.',
        terminal: true,
      };
    case 'failed':
      return {
        phase: 'failed',
        step: 1,
        title: 'Needs attention',
        message:
          'The route stopped and Vexa’s operators have been alerted. Your funds are accounted for; we’ll sort it out.',
        terminal: true,
      };
    default: {
      const step = i < 0 ? 0 : i;
      return {
        phase: 'active',
        step,
        title: STEALTH_STEPS[step]!.label,
        message: STEALTH_STEPS[step]!.detail,
        terminal: false,
      };
    }
  }
}

/** Poll quickly while funds land, then back off: routes take 10 to 30 minutes. */
export function stealthPollDelay(status: string | undefined | null, attempt: number): number {
  const base = status === 'awaiting_funds' || !status ? 4000 : 10_000;
  return Math.min(base * 2 ** Math.floor(attempt / 10), 30_000);
}

/**
 * What a stealth transfer is likely to cost, for the confirm screen: the
 * vault fee on the way out and again on the way back in, about 0.6 USDC of
 * 1Click withdrawal fees and about 0.2% in swap fees. The real figure is only
 * known once the route settles.
 */
export function stealthFeeEstimate(amount: bigint, vaultFee: bigint): bigint {
  return 2n * vaultFee + 600_000n + (amount * 20n) / 10_000n;
}

export const STEALTH_MINIMUM = 5_000_000n;
