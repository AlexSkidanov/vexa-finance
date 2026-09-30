/** Formats USDC base units (6 decimals) as en-US with at least 2 decimals. */
export function formatUsdc(units: bigint, maxDecimals = 6): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const whole = abs / 1_000_000n;
  let frac = (abs % 1_000_000n).toString().padStart(6, '0').slice(0, maxDecimals);
  frac = frac.replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  const int = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${int}.${frac}`;
}

/** Exactly two decimals, rounded down; for the public reserve figures. */
export function formatUsdc2(units: bigint): string {
  return formatUsdc(units - (units % 10_000n), 2);
}

/** "5Kq…e2a" */
export function shortSig(s: string, head = 3, tail = 3): string {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "1 Jan 2026", in UTC. */
export function formatDay(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "2026-06-28", in UTC. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
