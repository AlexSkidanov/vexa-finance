/**
 * The indexer: turns queued chain notifications into records and events.
 *
 * Vexa's deposits are signed by users, not by Vexa, so most arrive through
 * POST /v1/deposits and are already recorded. The indexer is the safety net:
 * it sees every vault deposit that touches the reserve, including ones sent
 * straight to the chain, and records and announces any the API didn't.
 *
 * Failed events are retried with exponential backoff (10 s, doubling) and
 * parked as dead after 8 attempts, where they stay visible for inspection.
 */
import type { Address } from '@solana/kit';
import type { Logger } from '../logger.js';
import type { Store } from '../store/types.js';
import { parseTransaction } from './alchemy.js';

export const MAX_INDEXER_ATTEMPTS = 8;
const VAULT_DEPOSIT = 2;

export interface IndexerDeps {
  store: Store;
  logger: Logger;
  vaultProgram: Address;
  /** Accounts that are never a depositor (fee payer, programs, the reserve). */
  ignore: Set<string>;
}

export function indexerBackoff(attempts: number, now = Date.now()): Date | null {
  if (attempts >= MAX_INDEXER_ATTEMPTS) return null;
  return new Date(now + 10_000 * 2 ** (attempts - 1));
}

export async function processDue(deps: IndexerDeps, limit = 20): Promise<number> {
  const due = await deps.store.chainEvents.claimDue(limit, 60);
  for (const event of due) {
    try {
      await reconcile(deps, event.payload);
      await deps.store.chainEvents.markDone(event.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const next = indexerBackoff(event.attempts);
      await deps.store.chainEvents.markFailed(event.id, message, next);
      deps.logger.warn(
        { eventId: event.id, attempts: event.attempts, dead: next === null, err: message },
        'indexing failed',
      );
    }
  }
  return due.length;
}

async function reconcile(deps: IndexerDeps, payload: unknown): Promise<void> {
  const tx = parseTransaction(payload);
  if (!tx || tx.failed) return;

  const deposits = tx.instructions.filter(
    (ix) => ix.program === deps.vaultProgram && ix.data[0] === VAULT_DEPOSIT,
  );
  if (deposits.length === 0) return;
  if (await deps.store.money.hasDeposit(tx.signature)) return;

  // The depositor is the registered wallet among the transaction's accounts.
  for (const key of tx.accountKeys) {
    if (deps.ignore.has(key)) continue;
    const profile = await deps.store.profiles.findBySolanaPubkey(key);
    if (!profile) continue;
    const deposit = await deps.store.money.recordDeposit({
      ownerId: profile.userId,
      txSig: tx.signature,
      status: 'confirmed',
    });
    await deps.store.events.emit(profile.userId, 'deposit.confirmed', {
      depositId: deposit.id,
      txSig: tx.signature,
      source: 'chain',
    });
    deps.logger.info({ txSig: tx.signature }, 'recorded a deposit made directly on-chain');
    return;
  }
}

export function startIndexer(deps: IndexerDeps, intervalMs = 3000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await processDue(deps);
    } catch (err) {
      deps.logger.error({ err }, 'indexer tick failed');
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
