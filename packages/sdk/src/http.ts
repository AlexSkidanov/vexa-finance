import { IDEMPOTENCY_HEADER, IDEMPOTENCY_REPLAY_HEADER, type ApiErrorBody } from '@vexa/core';

/** Thrown for any non-2xx response. `code` is stable and safe to branch on. */
export class VexaError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'VexaError';
  }
}

export interface HttpOptions {
  baseUrl: string;
  getToken: () => string | undefined;
  fetch: typeof fetch;
  maxRetries: number;
}

export interface RequestOptions {
  body?: unknown;
  /**
   * Set on create calls. If omitted there, one is generated, and it's reused
   * for every retry of this call, so a retry can never create a duplicate.
   */
  idempotencyKey?: string | true;
  auth?: boolean;
}

export interface Response<T> {
  data: T;
  requestId: string | undefined;
  replayed: boolean;
}

/** Retries network failures, 5xx and 409 in-flight idempotency conflicts. */
const RETRYABLE_STATUS = new Set([409, 429, 500, 502, 503, 504]);

export async function request<T>(
  http: HttpOptions,
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<Response<T>> {
  const idempotencyKey = opts.idempotencyKey === true ? crypto.randomUUID() : opts.idempotencyKey;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (idempotencyKey) headers[IDEMPOTENCY_HEADER] = idempotencyKey;
  if (opts.auth !== false) {
    const token = http.getToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }

  let attempt = 0;
  for (;;) {
    let res: globalThis.Response;
    try {
      res = await http.fetch(`${http.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (err) {
      // Only retry a non-idempotent request if the server can dedupe it.
      if (attempt < http.maxRetries && (method === 'GET' || idempotencyKey)) {
        await backoff(attempt++);
        continue;
      }
      throw err;
    }

    const requestId = res.headers.get('x-request-id') ?? undefined;
    const body = res.status === 204 ? undefined : await res.json().catch(() => undefined);

    if (res.ok) {
      return {
        data: body as T,
        requestId,
        replayed: res.headers.get(IDEMPOTENCY_REPLAY_HEADER) === 'true',
      };
    }

    const error = (body as ApiErrorBody | undefined)?.error;
    const retryable =
      RETRYABLE_STATUS.has(res.status) &&
      (res.status !== 409 || error?.code === 'idempotency_request_in_progress') &&
      (method === 'GET' || idempotencyKey !== undefined);
    if (retryable && attempt < http.maxRetries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await backoff(attempt++, Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined);
      continue;
    }

    throw new VexaError(
      res.status,
      error?.code ?? 'http_error',
      error?.message ?? `HTTP ${res.status}`,
      error?.requestId ?? requestId,
      error?.details,
    );
  }
}

function backoff(attempt: number, minMs = 0): Promise<void> {
  const ms = Math.max(minMs, Math.min(4000, 250 * 2 ** attempt) * (0.5 + Math.random() / 2));
  return new Promise((r) => setTimeout(r, ms));
}
