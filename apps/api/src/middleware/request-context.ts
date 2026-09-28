import type { MiddlewareHandler } from 'hono';
import type { AppBindings, Deps } from '../context.js';

const INCOMING_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Attaches dependencies, a request id and a child logger to every request,
 * and writes one access-log line when the response goes out.
 *
 * The request id is echoed in `x-request-id` and in every error body, so a
 * user's bug report can be matched to our logs. Callers may pass their own id
 * for tracing across services; anything malformed is replaced.
 *
 * The access log records method, path, status and timing only. Request and
 * response bodies are never logged.
 */
export function requestContext(deps: Deps): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const requestId =
      incoming && INCOMING_ID.test(incoming) ? incoming : `req_${crypto.randomUUID()}`;
    const logger = deps.logger.child({ requestId });

    c.set('deps', deps);
    c.set('requestId', requestId);
    c.set('logger', logger);
    c.header('x-request-id', requestId);

    const started = performance.now();
    await next();
    const principal = c.get('principal');
    logger.info(
      {
        method: c.req.method,
        path: c.req.routePath === '/*' ? c.req.path : c.req.routePath,
        status: c.res.status,
        durationMs: Math.round(performance.now() - started),
        userId: principal?.userId,
        via: principal?.via,
      },
      'request',
    );
  };
}
