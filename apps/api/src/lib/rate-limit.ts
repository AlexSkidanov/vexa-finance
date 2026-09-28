import type { MiddlewareHandler } from 'hono';
import { ErrorCode } from '@vexa/core';
import { ApiError } from '../errors.js';
import type { AppBindings } from '../context.js';

/**
 * A fixed-window limiter kept in process memory. It's good enough to blunt
 * OTP spam and handle enumeration on a single instance. Scaling out to several
 * instances means moving the counters to Postgres or Redis.
 */
export function rateLimit(opts: {
  windowMs: number;
  max: number;
  key: (c: Parameters<MiddlewareHandler<AppBindings>>[0]) => string;
}): MiddlewareHandler<AppBindings> {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return async (c, next) => {
    const now = Date.now();
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    const k = opts.key(c);
    const entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      hits.set(k, { count: 1, resetAt: now + opts.windowMs });
    } else if (++entry.count > opts.max) {
      c.header('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      throw new ApiError(429, ErrorCode.RateLimited, 'Too many requests, slow down');
    }
    await next();
  };
}

/** Client IP, honoring the proxy header Railway sets. */
export function clientIp(c: Parameters<MiddlewareHandler<AppBindings>>[0]): string {
  const forwarded = c.req.header('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown';
}
