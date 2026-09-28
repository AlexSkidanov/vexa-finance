/**
 * Error codes returned by the API in `{ error: { code, message, requestId } }`.
 * Codes are stable and safe to branch on; messages are for humans and may change.
 */
export const ErrorCode = {
  // 400
  InvalidRequest: 'invalid_request',
  InvalidHandle: 'invalid_handle',
  HandleReserved: 'handle_reserved',
  InvalidSignature: 'invalid_signature',
  IdempotencyKeyMissing: 'idempotency_key_missing',
  IdempotencyKeyInvalid: 'idempotency_key_invalid',
  // 401 / 403
  Unauthenticated: 'unauthenticated',
  InvalidApiKey: 'invalid_api_key',
  WrongEnvironment: 'wrong_environment',
  Forbidden: 'forbidden',
  // 404
  NotFound: 'not_found',
  // 409
  HandleTaken: 'handle_taken',
  HandleAlreadyClaimed: 'handle_already_claimed',
  PubkeyInUse: 'pubkey_in_use',
  IdempotencyRequestInProgress: 'idempotency_request_in_progress',
  // 422
  IdempotencyKeyReused: 'idempotency_key_reused',
  // 429 / 5xx
  RateLimited: 'rate_limited',
  Internal: 'internal_error',
  UpstreamUnavailable: 'upstream_unavailable',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}
