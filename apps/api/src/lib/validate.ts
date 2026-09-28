import type { Context } from 'hono';
import type { z } from 'zod';
import { invalidRequest } from '../errors.js';

/** Parses a JSON body with a zod schema, turning failures into a 400 with field-level details. */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  const raw = await c.req.json().catch(() => {
    throw invalidRequest('Request body must be valid JSON');
  });
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw invalidRequest(
      'Request validation failed',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}
