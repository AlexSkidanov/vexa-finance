import { ErrorCode } from '@vexa/core';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** An error that's safe to show the client as-is. Anything else becomes a 500. */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const unauthenticated = (message = 'Authentication required') =>
  new ApiError(401, ErrorCode.Unauthenticated, message);

export const notFound = (what: string) =>
  new ApiError(404, ErrorCode.NotFound, `${what} not found`);

export const invalidRequest = (message: string, details?: unknown) =>
  new ApiError(400, ErrorCode.InvalidRequest, message, details);
