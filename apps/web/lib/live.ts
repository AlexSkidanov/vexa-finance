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

/** Signature scheme of each access key, as NEAR prints it before the colon. */
export type KeyScheme = 'ed25519' | 'secp256k1' | 'ml-dsa-65';
export const POST_QUANTUM_SCHEMES: readonly KeyScheme[] = ['ml-dsa-65'];

export interface AccountKeys {
  /** Every access key on the account, by scheme. */
  schemes: KeyScheme[];
  /** True when every full-access key uses a post-quantum scheme. */
  postQuantum: boolean;
}

const NEAR_RPC_URL = 'https://rpc.mainnet.fastnear.com';
const keyLists = new Map<string, Promise<AccountKeys | null>>();

/** Reads an account's access keys straight from NEAR mainnet, not from our API. */
export function getAccountKeys(accountId: string): Promise<AccountKeys | null> {
  let p = keyLists.get(accountId);
  if (p) return p;
  p = fetch(NEAR_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'vexa',
      method: 'query',
      params: { request_type: 'view_access_key_list', finality: 'final', account_id: accountId },
    }),
    cache: 'no-store',
  })
    .then(async (res) => {
      if (!res.ok) return null;
      const body = (await res.json()) as {
        result?: { keys?: { public_key: string; access_key: { permission: unknown } }[] };
      };
      const keys = body.result?.keys;
      if (!Array.isArray(keys) || keys.length === 0) return null;
      const parsed = keys.map((k) => ({
        scheme: k.public_key.slice(0, k.public_key.indexOf(':')) as KeyScheme,
        full: k.access_key.permission === 'FullAccess',
      }));
      const full = parsed.filter((k) => k.full);
      return {
        schemes: parsed.map((k) => k.scheme),
        postQuantum: full.length > 0 && full.every((k) => POST_QUANTUM_SCHEMES.includes(k.scheme)),
      };
    })
    .catch(() => null)
    .then((v) => {
      if (!v) keyLists.delete(accountId);
      return v;
    });
  keyLists.set(accountId, p);
  return p;
}
