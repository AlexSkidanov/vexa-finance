import type { MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  ErrorCode,
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_REPLAY_HEADER,
  isIdempotencyKey,
  requestFingerprint,
} from '@vexa/core';
import { ApiError } from '../errors.js';
import type { AppBindings } from '../context.js';
import { principalOf } from './auth.js';

/**
 * Makes a create endpoint safe to retry. Mount after authenticate().
 *
 *   first request            → runs the handler, stores the response
 *   same key, same body      → replays the stored response (Idempotent-Replayed: true)
 *   same key, still running  → 409, retry shortly
 *   same key, different body → 422, the client reused a key by mistake
 *
 * Responses with 5xx status are not stored, so a transient failure can be
 * retried with the same key. 4xx responses are stored: a request that was
 * invalid once is still invalid on retry.
 *
 * `redact` lists top-level response fields that must never be persisted, like
 * a freshly minted API key. They're dropped from the stored copy, so a replay
 * returns the rest of the response without them.
 */
export function idempotent(opts: { redact?: string[] } = {}): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const key = c.req.header(IDEMPOTENCY_HEADER);
    if (!key) {
      throw new ApiError(
        400,
        ErrorCode.IdempotencyKeyMissing,
        `${IDEMPOTENCY_HEADER} header is required`,
      );
    }
    if (!isIdempotencyKey(key)) {
      throw new ApiError(
        400,
        ErrorCode.IdempotencyKeyInvalid,
        `${IDEMPOTENCY_HEADER} must be 8-255 printable ASCII characters`,
      );
    }

    const { userId } = principalOf(c);
    const { store } = c.get('deps');
    const body = await c.req.json().catch(() => undefined);
    const method = c.req.method;
    const path = c.req.path;

    const begin = await store.idempotency.begin({
      principal: userId,
      key,
      method,
      path,
      requestHash: requestFingerprint(method, path, body),
    });

    switch (begin.kind) {
      case 'replay':
        c.header(IDEMPOTENCY_REPLAY_HEADER, 'true');
        return c.json(begin.body as object, begin.status as ContentfulStatusCode);
      case 'in_progress':
        throw new ApiError(
          409,
          ErrorCode.IdempotencyRequestInProgress,
          'A request with this idempotency key is still being processed',
        );
      case 'mismatch':
        throw new ApiError(
          422,
          ErrorCode.IdempotencyKeyReused,
          'This idempotency key was already used for a different request',
        );
    }

    try {
      await next();
    } catch (err) {
      // Let the error handler render it, but remember 4xx outcomes.
      if (err instanceof ApiError && err.status < 500) {
        const errorBody = {
          error: { code: err.code, message: err.message, requestId: c.get('requestId') },
        };
        await store.idempotency.complete(userId, key, err.status, errorBody);
      } else {
        await store.idempotency.release(userId, key);
      }
      throw err;
    }

    if (c.res.status >= 500) {
      await store.idempotency.release(userId, key);
      return;
    }
    const responseBody = await c.res
      .clone()
      .json()
      .catch(() => null);
    await store.idempotency.complete(
      userId,
      key,
      c.res.status,
      redactFields(responseBody, opts.redact),
    );
  };
}

function redactFields(body: unknown, fields: string[] | undefined): unknown {
  if (!fields?.length || !body || typeof body !== 'object' || Array.isArray(body)) return body;
  const copy: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const f of fields) delete copy[f];
  return copy;
}
