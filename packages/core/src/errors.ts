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
  /** A submitted transaction plan broke the sponsorship policy. */
  PlanRefused: 'plan_refused',
  /** The user hasn't claimed a handle and registered keys yet. */
  ProfileIncomplete: 'profile_incomplete',
  // 401 / 403
  Unauthenticated: 'unauthenticated',
  InvalidApiKey: 'invalid_api_key',
  WrongEnvironment: 'wrong_environment',
  Forbidden: 'forbidden',
  /** The NEAR policy contract refused an agent's request (the message says which rule). */
  PolicyRefused: 'policy_refused',
  /** The owner's $VEXA tier doesn't allow another agent, or a limit this high. */
  AgentLimitReached: 'agent_limit_reached',
  // 404
  NotFound: 'not_found',
  // 409
  HandleTaken: 'handle_taken',
  RecipientNotReady: 'recipient_not_ready',
  TransferAlreadySubmitted: 'transfer_already_submitted',
  HandleAlreadyClaimed: 'handle_already_claimed',
  PubkeyInUse: 'pubkey_in_use',
  IdempotencyRequestInProgress: 'idempotency_request_in_progress',
  // 422
  IdempotencyKeyReused: 'idempotency_key_reused',
  // 429 / 5xx
  RateLimited: 'rate_limited',
  Internal: 'internal_error',
  UpstreamUnavailable: 'upstream_unavailable',
  /** A transaction failed on-chain or in simulation. */
  ChainFailure: 'chain_error',
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
