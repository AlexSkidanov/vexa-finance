import type { ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { ErrorCode, type ApiErrorBody } from '@vexa/core';
import { ApiError } from '../errors.js';
import type { AppBindings } from '../context.js';

/**
 * Every error leaves the API in one shape: `{ error: { code, message, requestId } }`.
 * Unexpected errors are logged in full and returned as a bland 500. Stack traces
 * and upstream messages stay in the logs.
 */
export const onError: ErrorHandler<AppBindings> = (err, c) => {
  const requestId = c.get('requestId');
  const body = (
    code: ApiErrorBody['error']['code'],
    message: string,
    details?: unknown,
  ): ApiErrorBody => ({
    error: { code, message, requestId, ...(details === undefined ? {} : { details }) },
  });

  if (err instanceof ApiError) {
    return c.json(body(err.code, err.message, err.details), err.status);
  }
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return c.json(body(ErrorCode.InvalidRequest, 'Request validation failed', details), 400);
  }
  if (err instanceof HTTPException && err.status < 500) {
    return c.json(body(ErrorCode.InvalidRequest, err.message || 'Bad request'), err.status);
  }

  (c.get('logger') ?? console).error({ err }, 'unhandled error');
  return c.json(body(ErrorCode.Internal, 'Something went wrong on our side'), 500);
};

export const onNotFound: NotFoundHandler<AppBindings> = (c) =>
  c.json(
    {
      error: {
        code: ErrorCode.NotFound,
        message: `No route for ${c.req.method} ${c.req.path}`,
        requestId: c.get('requestId'),
      },
    },
    404,
  );
