import {
  formatHandle,
  HANDLE_MAX_LENGTH,
  HANDLE_MIN_LENGTH,
  isSolanaAddress,
  normalizeHandle,
  validateHandle,
  type HandleValidation,
} from '@vexa/core';

type Reason = Extract<HandleValidation, { ok: false }>['reason'];

const PROBLEMS: Record<Reason, string> = {
  too_short: `At least ${HANDLE_MIN_LENGTH} characters.`,
  too_long: `At most ${HANDLE_MAX_LENGTH} characters.`,
  invalid_characters:
    'Lowercase letters, numbers, - and _ only, starting and ending with a letter or number.',
  repeated_separators: 'No two - or _ in a row.',
  reserved: 'That name is reserved.',
};

/** What's wrong with a handle, in words, or null if it's valid. Same rules as the API. */
export function handleProblem(input: string): string | null {
  const v = validateHandle(input);
  return v.ok ? null : PROBLEMS[v.reason];
}

export type Recipient =
  | { kind: 'handle'; handle: string; display: string }
  | { kind: 'address'; address: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'empty' };

/**
 * Sorts out what someone typed in the "to" field. Transfers go to handles; a
 * Solana address means they want a withdrawal instead.
 */
export function classifyRecipient(input: string): Recipient {
  const s = input.trim();
  if (!s) return { kind: 'empty' };
  if (!s.startsWith('@') && s.length >= 32 && isSolanaAddress(s)) {
    return { kind: 'address', address: s };
  }
  const problem = handleProblem(s);
  if (problem) return { kind: 'invalid', message: problem };
  const handle = normalizeHandle(s);
  return { kind: 'handle', handle, display: formatHandle(handle) };
}

export { formatHandle, normalizeHandle };
