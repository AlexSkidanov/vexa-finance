import { describe, expect, it } from 'vitest';
import { describeError } from './errors';

class VexaError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'VexaError';
  }
}

describe('describeError', () => {
  it('maps API codes to plain language and keeps the request id', () => {
    const p = describeError(
      new VexaError(409, 'handle_taken', 'That handle is already taken', 'req_1'),
    );
    expect(p).toEqual({
      message: 'That handle is already taken.',
      requestId: 'req_1',
      retryable: false,
    });
  });

  it('flags a dead session', () => {
    expect(describeError(new VexaError(401, 'unauthenticated', 'nope'))).toMatchObject({
      signedOut: true,
    });
  });

  it('marks server and chain failures as retryable', () => {
    expect(describeError(new VexaError(502, 'chain_error', 'x')).retryable).toBe(true);
    expect(describeError(new VexaError(429, 'rate_limited', 'x')).retryable).toBe(true);
    expect(describeError(new VexaError(400, 'plan_refused', 'x')).retryable).toBe(false);
  });

  it('strips the rule name from a policy refusal', () => {
    const p = describeError(
      new VexaError(403, 'policy_refused', 'daily_limit: payment exceeds the daily limit'),
    );
    expect(p.message).toBe('The agent’s policy refused this: payment exceeds the daily limit');
  });

  it('explains a withdrawal to a wallet with no USDC account', () => {
    const p = describeError(
      new VexaError(
        400,
        'invalid_request',
        'destinationAccount must be an existing USDC token account',
      ),
    );
    expect(p.message).toMatch(/no USDC account yet/);
  });

  it('falls back to the server message for unknown codes', () => {
    expect(describeError(new VexaError(418, 'teapot', 'I am a teapot')).message).toBe(
      'I am a teapot',
    );
  });

  it('recognises the SDK’s own checks', () => {
    expect(describeError(new Error('insufficient confidential balance'))).toMatchObject({
      message: 'That’s more than your available balance.',
      retryable: false,
    });
    expect(describeError(new Error('stealth transfers start at 5 USDC')).message).toBe(
      'Stealth transfers start at 5 USDC.',
    );
    expect(describeError(new TypeError('Failed to fetch')).message).toMatch(/Can’t reach Vexa/);
  });

  it('handles passkey prompt errors', () => {
    expect(describeError(new DOMException('x', 'NotAllowedError')).message).toMatch(/closed/);
  });

  it('never returns an empty message', () => {
    expect(describeError(undefined).message).toBe('Something went wrong.');
  });
});

describe('passkey problems', () => {
  it('explains a passkey without PRF and a wrong passkey', () => {
    expect(describeError(new Error('no PRF output from this passkey')).message).toMatch(/PRF/);
    expect(describeError(new Error('passkey keys mismatch')).message).toMatch(/original passkey/);
  });
});
