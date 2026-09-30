import { describe, expect, it } from 'vitest';
import { STEALTH_STEPS, stealthFeeEstimate, stealthPollDelay, stealthView } from './stealth';

describe('stealthView', () => {
  it('walks the happy path in order', () => {
    const order = ['awaiting_funds', 'routing', 'shielded', 'returning', 'settling'];
    order.forEach((s, i) => {
      expect(stealthView(s)).toMatchObject({ phase: 'active', step: i, terminal: false });
    });
    expect(stealthView('settled')).toMatchObject({
      phase: 'done',
      step: STEALTH_STEPS.length - 1,
      terminal: true,
    });
  });
  it('treats refunds and failures separately', () => {
    expect(stealthView('refunding')).toMatchObject({ phase: 'refunding', terminal: false });
    expect(stealthView('refunded')).toMatchObject({ phase: 'refunded', terminal: true });
    expect(stealthView('failed')).toMatchObject({ phase: 'failed', terminal: true });
  });
  it('starts at the first step when the status is unknown', () => {
    expect(stealthView(undefined)).toMatchObject({ phase: 'active', step: 0 });
    expect(stealthView('something_new')).toMatchObject({ phase: 'active', step: 0 });
  });
});

describe('stealthPollDelay', () => {
  it('polls faster while funds land and backs off over time', () => {
    expect(stealthPollDelay('awaiting_funds', 0)).toBe(4000);
    expect(stealthPollDelay('shielded', 0)).toBe(10_000);
    expect(stealthPollDelay('shielded', 25)).toBe(30_000);
  });
});

describe('stealthFeeEstimate', () => {
  it('adds both vault fees, the bridge fee and the swap spread', () => {
    // 100 USDC: vault fee 0.1 each way, 0.6 bridge, 0.2 swap.
    expect(stealthFeeEstimate(100_000_000n, 100_000n)).toBe(1_000_000n);
  });
});
