/**
 * Turns whatever a call threw into something a person can read. API errors
 * arrive as the SDK's VexaError with a stable `code`; the SDK also throws
 * plain Errors for things it checks on the device before calling the API.
 */

export interface Problem {
  message: string;
  /** Include when someone contacts support. */
  requestId?: string;
  /** Worth trying again as is. */
  retryable: boolean;
  /** The session is gone; sign in again. */
  signedOut?: boolean;
}

interface ApiErrorLike {
  name: string;
  status: number;
  code: string;
  message: string;
  requestId?: string;
  details?: unknown;
}

const isApiError = (e: unknown): e is ApiErrorLike =>
  typeof e === 'object' &&
  e !== null &&
  (e as { name?: unknown }).name === 'VexaError' &&
  typeof (e as { code?: unknown }).code === 'string';

const BY_CODE: Record<string, string> = {
  invalid_handle: 'That handle isn’t valid.',
  handle_reserved: 'That handle is reserved.',
  handle_taken: 'That handle is already taken.',
  handle_already_claimed: 'You already have a handle.',
  pubkey_in_use: 'This passkey’s keys are already linked to another account.',
  invalid_signature: 'A signature didn’t check out. Try again.',
  profile_incomplete: 'Finish setting up your account first: claim a handle.',
  unauthenticated: 'Your session has ended. Sign in again.',
  invalid_api_key: 'Your session has ended. Sign in again.',
  forbidden: 'That isn’t allowed from here.',
  not_found: 'Not found.',
  recipient_not_ready: 'They can’t receive yet: their account isn’t open.',
  transfer_already_submitted: 'This transfer was already sent.',
  idempotency_request_in_progress: 'Still working on the last attempt. Give it a moment.',
  idempotency_key_reused: 'This request changed since the first attempt. Start it again.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  internal_error: 'Something went wrong on our side. It’s safe to try again.',
  upstream_unavailable: 'A network we depend on is slow to answer. Try again shortly.',
  chain_error: 'The transaction failed on Solana. Nothing moved; try again.',
  plan_refused: 'Vexa wouldn’t sponsor that transaction. Refresh and try again.',
};

/** Plain errors the SDK and browser throw, matched on their message. */
const BY_MESSAGE: [RegExp, string][] = [
  [
    /no PRF output/i,
    'This passkey can’t produce the secret your keys come from (the PRF extension). Use one of the password managers listed below.',
  ],
  [
    /passkey for a different account/i,
    'That passkey belongs to a different Vexa account. Choose the one you just created.',
  ],
  [
    /passkey keys mismatch/i,
    'This passkey isn’t the one your account’s keys were made with. Sign in with your original passkey.',
  ],
  [/^Locked/, 'Unlock with your passkey first.'],
  [/insufficient (confidential|agent) balance/i, 'That’s more than your available balance.'],
  [/amount does not cover the fee/i, 'That amount is smaller than the fee.'],
  [/stealth transfers start at 5 USDC/i, 'Stealth transfers start at 5 USDC.'],
  [/open the account first/i, 'Your private account isn’t open yet.'],
  [/staking is not open yet/i, '$VEXA staking isn’t open yet.'],
  [/no fee schedule/i, 'The vault isn’t accepting money right now.'],
  [/cancelled/i, 'The passkey prompt was closed.'],
  [/isn't recorded yet/i, 'The agent’s last payment is still settling. Try again shortly.'],
  [/Failed to fetch|NetworkError|Load failed/i, 'Can’t reach Vexa. Check your connection.'],
];

export function describeError(e: unknown): Problem {
  if (isApiError(e)) {
    const signedOut = e.status === 401;
    let message = BY_CODE[e.code];
    if (e.code === 'policy_refused') {
      // "rule: explanation" from the NEAR policy contract.
      message = `The agent’s policy refused this: ${e.message.replace(/^[a-z_]+:\s*/, '')}`;
    } else if (e.code === 'agent_limit_reached') {
      message = `${e.message}. A higher $VEXA tier raises it.`;
    } else if (e.code === 'invalid_request') {
      message = /existing USDC token account/.test(e.message)
        ? 'That wallet has no USDC account yet. Send it any amount of USDC first, or use an exchange deposit address.'
        : /send to yourself/i.test(e.message)
          ? 'You can’t send to yourself.'
          : `${e.message.replace(/\.$/, '')}.`;
    } else if (e.code === 'not_found' && /Recipient|Handle/.test(e.message)) {
      message = 'No one has that handle.';
    }
    return {
      message: message ?? (e.message || `Request failed (${e.status}).`),
      requestId: e.requestId,
      retryable: e.status >= 500 || e.status === 429 || e.code === 'chain_error',
      ...(signedOut ? { signedOut } : {}),
    };
  }

  if (typeof DOMException !== 'undefined' && e instanceof DOMException) {
    if (e.name === 'NotAllowedError' || e.name === 'AbortError')
      return { message: 'The passkey prompt was closed or timed out.', retryable: true };
    if (e.name === 'InvalidStateError')
      return {
        message: 'This device already has a Vexa passkey for this account.',
        retryable: false,
      };
    if (e.name === 'NotSupportedError' || e.name === 'SecurityError')
      return { message: 'This browser can’t use passkeys here.', retryable: false };
  }

  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  for (const [re, message] of BY_MESSAGE) {
    if (re.test(raw)) return { message, retryable: !/balance|fee|5 USDC/.test(message) };
  }
  return { message: raw || 'Something went wrong.', retryable: true };
}
