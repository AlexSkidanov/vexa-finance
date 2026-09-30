/**
 * Public proof of reserves: USDC held by the vault's reserve and the cUSDC
 * supply, read from Solana. Both are public on-chain; this saves a browser
 * from needing its own RPC. Cached briefly so the website can poll it.
 */
import { Hono } from 'hono';
import { decodeConfidentialMint } from '@vexa/core/solana';
import type { AppBindings, Deps } from '../context.js';

const CACHE_MS = 15_000;
let cached: { at: number; body: Record<string, unknown> } | null = null;

async function read(deps: Pick<Deps, 'chain' | 'vault'>) {
  const [reserve, mint] = await Promise.all([
    deps.chain.getAccountData(deps.vault.usdcReserve),
    deps.chain.getAccountData(deps.vault.cusdcMint),
  ]);
  if (!reserve || !mint) throw new Error('reserve or mint missing');
  const reserveAmount = new DataView(reserve.buffer, reserve.byteOffset).getBigUint64(64, true);
  const supply = new DataView(mint.buffer, mint.byteOffset).getBigUint64(36, true);
  return {
    reserve: reserveAmount.toString(),
    supply: supply.toString(),
    // The vault's invariant: the reserve always covers the supply.
    match: reserveAmount >= supply,
    auditor: decodeConfidentialMint(mint)?.auditorElgamalPubkey ? 'set' : 'none',
    reserveAccount: deps.vault.usdcReserve,
    cusdcMint: deps.vault.cusdcMint,
    updatedAt: new Date().toISOString(),
  };
}

export const transparency = new Hono<AppBindings>().get('/', async (c) => {
  if (!cached || Date.now() - cached.at > CACHE_MS) {
    cached = { at: Date.now(), body: await read(c.get('deps')) };
  }
  c.header('cache-control', 'public, max-age=15');
  return c.json(cached.body);
});

/** For tests. */
export function resetTransparencyCache() {
  cached = null;
}
