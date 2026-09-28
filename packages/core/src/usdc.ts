/**
 * USDC and cUSDC both use 6 decimals, and the vault wraps them 1:1.
 *
 * These helpers exist for clients: formatting a balance the user just
 * decrypted, or parsing what they typed into the amount field. The API never
 * calls them on a transfer amount, because it never sees one.
 */
export const USDC_DECIMALS = 6;
const UNIT = 10n ** BigInt(USDC_DECIMALS);

/**
 * Confidential transfers split the amount into a 16-bit low part and a 32-bit
 * high part, so the largest single transfer is 2^48 - 1 base units
 * (~281.5M USDC). Larger amounts have to be split.
 */
export const MAX_CONFIDENTIAL_TRANSFER_AMOUNT = (1n << 48n) - 1n;

/** "12.5" → 12_500_000n. Rejects more than 6 decimal places rather than rounding. */
export function parseUsdc(input: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(input.trim());
  if (!m) throw new Error(`invalid USDC amount: ${input}`);
  const whole = BigInt(m[1]!);
  const frac = BigInt((m[2] ?? '').padEnd(USDC_DECIMALS, '0'));
  return whole * UNIT + frac;
}

/** 12_500_000n → "12.5" */
export function formatUsdc(baseUnits: bigint): string {
  const negative = baseUnits < 0n;
  const abs = negative ? -baseUnits : baseUnits;
  const whole = abs / UNIT;
  const frac = (abs % UNIT).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
