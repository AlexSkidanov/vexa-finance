/**
 * Public numbers read by the browser: the reserve/supply proof and service
 * health. Each is fetched once per page load and shared between components.
 */
import { API_URL } from './site';

export interface Transparency {
  reserve: bigint;
  supply: bigint;
  match: boolean;
  updatedAt: string | null;
}

let transparency: Promise<Transparency | null> | null = null;

export function getTransparency(): Promise<Transparency | null> {
  transparency ??= fetch(`${API_URL}/v1/transparency`, { cache: 'no-store' })
    .then(async (res) => {
      if (!res.ok) return null;
      const body = (await res.json()) as Record<string, unknown>;
      if (typeof body.reserve !== 'string' || typeof body.supply !== 'string') return null;
      if (!/^\d+$/.test(body.reserve) || !/^\d+$/.test(body.supply)) return null;
      return {
        reserve: BigInt(body.reserve),
        supply: BigInt(body.supply),
        match: body.match === true,
        updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : null,
      };
    })
    .catch(() => null)
    .then((v) => {
      // Let a later page try again after a failure.
      if (!v) transparency = null;
      return v;
    });
  return transparency;
}

export type Health = 'ok' | 'degraded' | 'unreachable';
let health: Promise<Health> | null = null;

export function getHealth(): Promise<Health> {
  health ??= fetch(`${API_URL}/health`, { cache: 'no-store' })
    .then(async (res) => {
      if (!res.ok) return 'degraded' as const;
      const body = (await res.json()) as { status?: unknown };
      return body.status === 'ok' ? ('ok' as const) : ('degraded' as const);
    })
    .catch(() => 'unreachable' as const);
  return health;
}
