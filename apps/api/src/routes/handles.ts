import { Hono } from 'hono';
import {
  ClaimHandleRequest,
  ErrorCode,
  formatHandle,
  handleClaimMessage,
  validateHandle,
  verifySolanaSignature,
  type HandleResolution,
} from '@vexa/core';
import { ApiError, notFound } from '../errors.js';
import type { AppBindings } from '../context.js';
import { authenticate, principalOf } from '../middleware/auth.js';
import { idempotent } from '../middleware/idempotency.js';
import { clientIp, rateLimit } from '../lib/rate-limit.js';
import { parseBody } from '../lib/validate.js';
import { HandleConflict } from '../store/types.js';
import { profileJson } from './me.js';

const CONFLICT_MESSAGES: Record<HandleConflict['reason'], string> = {
  handle_taken: 'That handle is already taken',
  handle_already_claimed: 'You already have a handle',
  pubkey_in_use: 'That Solana key is already linked to another account',
};

export const handles = new Hono<AppBindings>()
  /**
   * Claims a handle and binds it to the caller's public keys. Both keys are
   * generated on the user's device. The signature proves the caller holds the
   * Solana key, so nobody can point a name at a wallet they don't control.
   */
  .post('/claim', authenticate(), idempotent(), async (c) => {
    const { store } = c.get('deps');
    const principal = principalOf(c);
    const req = await parseBody(c, ClaimHandleRequest);

    const message = handleClaimMessage({
      handle: req.handle,
      userId: principal.userId,
      solanaPubkey: req.solanaPubkey,
      elgamalPubkey: req.elgamalPubkey,
    });
    if (!verifySolanaSignature(message, req.signature, req.solanaPubkey)) {
      throw new ApiError(
        400,
        ErrorCode.InvalidSignature,
        'Signature does not match the claim message for this Solana key',
      );
    }

    try {
      const profile = await store.profiles.claimHandle({
        userId: principal.userId,
        handle: req.handle,
        solanaPubkey: req.solanaPubkey,
        elgamalPubkey: req.elgamalPubkey,
      });
      c.get('logger').info({ handle: req.handle }, 'handle claimed');
      return c.json(profileJson(profile, principal.email), 201);
    } catch (err) {
      if (err instanceof HandleConflict) {
        throw new ApiError(409, err.reason as ErrorCode, CONFLICT_MESSAGES[err.reason]);
      }
      throw err;
    }
  })

  /**
   * Public lookup: the keys a sender needs to pay `@handle.vexa`. The ElGamal
   * key is what their SDK encrypts the amount to. Rate-limited to make bulk
   * enumeration of the namespace tedious.
   */
  .get(
    '/:handle/resolve',
    rateLimit({ windowMs: 60_000, max: 120, key: (c) => `resolve:${clientIp(c)}` }),
    async (c) => {
      const parsed = validateHandle(c.req.param('handle'));
      // Reserved and malformed names can't exist, so answer the same as "not found".
      if (!parsed.ok) throw notFound('Handle');
      const record = await c.get('deps').store.handles.resolve(parsed.handle);
      if (!record) throw notFound('Handle');
      c.header('Cache-Control', 'public, max-age=30');
      return c.json({
        handle: record.handle,
        display: formatHandle(record.handle),
        kind: record.kind,
        solanaPubkey: record.solanaPubkey,
        elgamalPubkey: record.elgamalPubkey,
      } satisfies HandleResolution);
    },
  );
