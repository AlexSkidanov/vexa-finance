/**
 * Money in the app is always bigint base units (6 decimals, for both USDC and
 * $VEXA). These helpers turn what people type into base units and back, and
 * never go through a float.
 */

export const DECIMALS = 6;
const UNIT = 10n ** BigInt(DECIMALS);

export type AmountParse =
  | { ok: true; value: bigint }
  | { ok: false; reason: 'empty' | 'invalid' | 'too_many_decimals' | 'zero' };

/** "1,234.5" → 1_234_500_000n. Thousands separators and spaces are ignored. */
export function parseAmount(input: string): AmountParse {
  const s = input.replace(/[\s,_]/g, '');
  if (s === '') return { ok: false, reason: 'empty' };
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === '' && !m[2])) return { ok: false, reason: 'invalid' };
  const frac = m[2] ?? '';
  if (frac.length > DECIMALS) return { ok: false, reason: 'too_many_decimals' };
  const value = BigInt(m[1] || '0') * UNIT + BigInt(frac.padEnd(DECIMALS, '0') || '0');
  if (value === 0n) return { ok: false, reason: 'zero' };
  return { ok: true, value };
}

export const AMOUNT_PROBLEMS: Record<Exclude<AmountParse, { ok: true }>['reason'], string> = {
  empty: 'Enter an amount.',
  invalid: 'That isn’t a number.',
  too_many_decimals: 'Up to 6 decimal places.',
  zero: 'Enter more than zero.',
};

/**
 * Keeps an amount field sane while typing: digits and one decimal point.
 * Returns null when the keystroke should be rejected. Too many decimals are
 * let through so parseAmount can say so, rather than a paste vanishing.
 */
export function cleanAmountInput(raw: string): string | null {
  const s = raw.replace(/[\s,]/g, '');
  if (!/^\d*(?:\.\d*)?$/.test(s)) return null;
  // No leading zeros on the whole part ("007" → "7"), but keep "0.5".
  return s.replace(/^0+(?=\d)/, '');
}

/** 1_234_500_000n → "1,234.50". At least `minDecimals`, trailing zeros trimmed beyond. */
export function formatAmount(units: bigint, opts: { minDecimals?: number } = {}): string {
  const min = opts.minDecimals ?? 2;
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const whole = (abs / UNIT).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let frac = (abs % UNIT).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  if (frac.length < min) frac = frac.padEnd(min, '0');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** For putting an amount back into an input: 1_234_500_000n → "1234.5". */
export function amountToInput(units: bigint): string {
  const whole = units / UNIT;
  const frac = (units % UNIT).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Basis points as a percentage: 1000 → "10%", 25 → "0.25%". */
export function formatBps(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const rest = (bps % 100).toString().padStart(2, '0').replace(/0+$/, '');
  return `${whole}${rest ? `.${rest}` : ''}%`;
}

/** `part / whole` as an integer percentage for progress bars, clamped to 0..100. */
export function percentOf(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  const p = (part * 100n) / whole;
  return Number(p > 100n ? 100n : p < 0n ? 0n : p);
}
