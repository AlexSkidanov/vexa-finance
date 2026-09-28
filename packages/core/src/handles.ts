/**
 * Handles are the human-readable names people pay each other with: `@alex.vexa`.
 *
 * Users and agents share one namespace, so a handle resolves to exactly one
 * Solana account no matter who owns it. The canonical form stored everywhere is
 * the bare, lowercase name (`alex`); the `@` prefix and `.vexa` suffix are
 * presentation only.
 */

export const HANDLE_SUFFIX = '.vexa';
export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 20;

/**
 * Lowercase letters, digits, `-` and `_`. Must start and end with a letter or
 * digit, which rules out `-alex`, `alex_` and lookalikes built from separators.
 */
const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const REPEATED_SEPARATORS = /[-_]{2,}/;

/**
 * Names we hold back because they would let someone impersonate the product,
 * support staff or a system account, or because routes and docs already use them.
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  // Product and company
  'vexa',
  'vexafinance',
  'vexa-finance',
  'vexapay',
  'vexa-pay',
  'vexabank',
  'official',
  // Staff and trust
  'admin',
  'administrator',
  'root',
  'sudo',
  'system',
  'staff',
  'team',
  'support',
  'help',
  'helpdesk',
  'security',
  'trust',
  'safety',
  'abuse',
  'fraud',
  'compliance',
  'legal',
  'privacy',
  'kyc',
  'aml',
  'verify',
  'verified',
  'verification',
  'moderator',
  'mod',
  // Money movement that could be mistaken for a system account
  'treasury',
  'fees',
  'fee',
  'vault',
  'reserve',
  'escrow',
  'settlement',
  'payments',
  'payment',
  'pay',
  'billing',
  'refund',
  'refunds',
  'withdraw',
  'withdrawal',
  'deposit',
  'deposits',
  'bank',
  'wallet',
  'stealth',
  'shielded',
  'faucet',
  'airdrop',
  // Protocol and ecosystem names
  'solana',
  'sol',
  'usdc',
  'cusdc',
  'usdt',
  'circle',
  'near',
  'zcash',
  'zec',
  'intents',
  'token',
  'tokens',
  'mint',
  'program',
  'contract',
  'agent',
  'agents',
  'bot',
  'bots',
  // Routes, docs and infrastructure
  'api',
  'app',
  'www',
  'web',
  'docs',
  'dev',
  'developer',
  'developers',
  'status',
  'blog',
  'mail',
  'email',
  'noreply',
  'no-reply',
  'webhook',
  'webhooks',
  'auth',
  'login',
  'logout',
  'signup',
  'signin',
  'register',
  'account',
  'accounts',
  'settings',
  'me',
  'you',
  'user',
  'users',
  'handle',
  'handles',
  'null',
  'undefined',
  'test',
  'demo',
  'example',
  'sandbox',
]);

export type HandleValidation =
  | { ok: true; handle: string }
  | {
      ok: false;
      reason: 'too_short' | 'too_long' | 'invalid_characters' | 'repeated_separators' | 'reserved';
    };

/**
 * Accepts `alex`, `@alex`, `alex.vexa` or `@alex.vexa` (any case) and returns
 * the canonical bare name. Does not validate.
 */
export function normalizeHandle(input: string): string {
  let h = input.trim().toLowerCase();
  if (h.startsWith('@')) h = h.slice(1);
  if (h.endsWith(HANDLE_SUFFIX)) h = h.slice(0, -HANDLE_SUFFIX.length);
  return h;
}

export function validateHandle(input: string): HandleValidation {
  const handle = normalizeHandle(input);
  if (handle.length < HANDLE_MIN_LENGTH) return { ok: false, reason: 'too_short' };
  if (handle.length > HANDLE_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  if (!HANDLE_PATTERN.test(handle)) return { ok: false, reason: 'invalid_characters' };
  if (REPEATED_SEPARATORS.test(handle)) return { ok: false, reason: 'repeated_separators' };
  if (isReservedHandle(handle)) return { ok: false, reason: 'reserved' };
  return { ok: true, handle };
}

/**
 * Reserved if the name is on the list, or if it only differs from a reserved
 * name by separators (`vexa_support`, `sup-port`), which is how most
 * impersonation attempts start.
 */
export function isReservedHandle(handle: string): boolean {
  if (RESERVED_HANDLES.has(handle)) return true;
  const squashed = handle.replace(/[-_]/g, '');
  if (RESERVED_HANDLES.has(squashed)) return true;
  return /^vexa[-_]?/.test(handle) || /[-_]?vexa$/.test(handle);
}

/** `alex` → `@alex.vexa` */
export function formatHandle(handle: string): string {
  return `@${normalizeHandle(handle)}${HANDLE_SUFFIX}`;
}

/**
 * The message a user signs with their Solana key when claiming a handle. It
 * proves they hold the key the handle will point to, so nobody can bind a name
 * to someone else's wallet. It binds the handle, the Vexa user id and the keys
 * being registered, so a signature can't be replayed for a different claim.
 */
export function handleClaimMessage(params: {
  handle: string;
  userId: string;
  solanaPubkey: string;
  elgamalPubkey: string;
}): Uint8Array {
  const text = [
    'Vexa handle claim',
    `handle: ${formatHandle(params.handle)}`,
    `user: ${params.userId}`,
    `solana: ${params.solanaPubkey}`,
    `elgamal: ${params.elgamalPubkey}`,
  ].join('\n');
  return new TextEncoder().encode(text);
}
