/** The public fee calculator. Mirrors the vault's fee schedule. */

export const TIER_DISCOUNTS = [0, 0.1, 0.25, 0.5, 0.75] as const;
export type CalcMode = 'deposit' | 'stealth';

export interface CalcLine {
  k: string;
  v: string;
}
export interface CalcResult {
  lines: CalcLine[];
  totalLabel: string;
  total: string;
}

/** Parses a typed amount, ignoring anything that isn't a digit or a dot. */
export function parseAmount(input: string): number {
  const n = parseFloat(input.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 0.10%, capped at 5 USDC, discounted by tier, rounded up to the smallest unit. */
export function vaultFee(amount: number, discount: number): number {
  const raw = Math.min(amount * 0.001, 5) * (1 - discount);
  return Math.ceil(raw * 1e6) / 1e6;
}

export function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

export function calculate(mode: CalcMode, amountInput: string, tier: number): CalcResult {
  const amount = parseAmount(amountInput);
  const discount = TIER_DISCOUNTS[tier] ?? 0;
  const fee = vaultFee(amount, discount);
  if (mode === 'deposit') {
    const lines: CalcLine[] = [{ k: 'Vault fee 0.10%, capped at 5', v: `${fmt(fee)} USDC` }];
    if (discount) lines.push({ k: `Tier ${tier} discount`, v: `−${Math.round(discount * 100)}%` });
    return {
      lines,
      totalLabel: 'Lands privately',
      total: `${fmt(Math.max(0, amount - fee))} USDC`,
    };
  }
  const bridge = 0.6 + amount * 0.002;
  const lines: CalcLine[] = [
    { k: 'Bridge (about $0.60 + ~0.2%)', v: `${fmt(bridge)} USDC` },
    { k: 'Vault fee out and back in', v: `${fmt(fee * 2)} USDC` },
  ];
  if (amount < 5) lines.push({ k: 'Minimum for stealth', v: '5 USDC' });
  return {
    lines,
    totalLabel: 'Recipient receives',
    total: `${fmt(Math.max(0, amount - bridge - fee * 2))} USDC`,
  };
}
