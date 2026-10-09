import { API_URL, SITE_URL } from './config';

/** "5Kq3…e2a9" */
export function shortAddress(s: string, head = 4, tail = 4): string {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "3 Sep 2026", local time. */
export function formatDay(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "3 Sep, 14:05" (or with the year when it isn't this year). */
export function formatWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear()
    ? `${day}, ${hm}`
    : `${day} ${d.getFullYear()}, ${hm}`;
}

/** "in 3 days", "in 5 hours", "now" */
export function untilText(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'now';
  const h = Math.ceil(ms / 3_600_000);
  if (h < 48) return `in ${h} hour${h === 1 ? '' : 's'}`;
  const days = Math.ceil(h / 24);
  return `in ${days} days`;
}

/** yyyy-mm-dd for <input type="date">, local time. */
export function dateInputValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}`;
export const solscanAccount = (addr: string) => `https://solscan.io/account/${addr}`;

export const LEGAL = [
  { href: `${SITE_URL}/terms/`, label: 'Terms' },
  { href: `${SITE_URL}/privacy/`, label: 'Privacy' },
  { href: `${SITE_URL}/risk/`, label: 'Risk disclosure' },
  { href: `${SITE_URL}/security/`, label: 'Security' },
];

export const STATUS_URL = `${API_URL}/health`;
