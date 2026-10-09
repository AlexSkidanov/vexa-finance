import { getAddressEncoder, type Address } from '@solana/kit';
import {
  closeContextStateInstruction,
  SYSTEM_PROGRAM,
  ZK_ELGAMAL_PROOF_PROGRAM,
} from '@vexa/core/solana';
import type { Logger } from '../logger.js';
import type { Chain } from './chain.js';
import { ChainError } from './chain.js';
import type { CheckedTransaction } from './sponsor.js';

export class PlanFailed extends Error {
  constructor(
    message: string,
    readonly signatures: string[],
    readonly logs: string[],
  ) {
    super(message);
    this.name = 'PlanFailed';
  }
}

/**
 * Sends a checked plan: stages in order, transactions within a stage in
 * parallel. Returns every signature in order.
 *
 * If any transaction fails, proof context accounts the plan created are
 * closed by the fee payer (it's their authority), so their rent is always
 * recovered, even when a client abandons a transfer halfway.
 */
export async function executePlan(
  chain: Chain,
  stages: CheckedTransaction[][],
  logger: Logger,
): Promise<string[]> {
  const signatures: string[] = [];
  for (const stage of stages) {
    const results = await Promise.allSettled(stage.map((t) => chain.signAndSend(t.transaction)));
    for (const r of results) if (r.status === 'fulfilled') signatures.push(r.value);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) {
      await reclaimContexts(chain, stages, logger);
      const err = failed.reason;
      throw new PlanFailed(
        err instanceof Error ? err.message : String(err),
        signatures,
        err instanceof ChainError ? err.logs : [],
      );
    }
  }
  return signatures;
}

async function reclaimContexts(chain: Chain, stages: CheckedTransaction[][], logger: Logger) {
  const contexts: Address[] = [];
  for (const stage of stages) {
    for (const tx of stage) {
      for (const ix of tx.instructions) {
        // CreateAccount (tag 0) owned by the proof program: the new account is index 1.
        const isCreate = ix.program === SYSTEM_PROGRAM && ix.data[0] === 0;
        if (
          isCreate &&
          ix.accounts[1] &&
          sameBytes(ix.data.subarray(20, 52), PROOF_PROGRAM_BYTES)
        ) {
          contexts.push(ix.accounts[1]);
        }
      }
    }
  }
  const open: Address[] = [];
  for (const c of contexts) {
    const data = await chain.getAccountData(c).catch(() => null);
    if (data) open.push(c);
  }
  if (open.length === 0) return;
  try {
    await chain.sendAsFeePayer(
      open.map((c) => closeContextStateInstruction(c, chain.feePayer, chain.feePayer)),
    );
    logger.info({ reclaimed: open.length }, 'closed proof contexts of a failed plan');
  } catch (err) {
    // Not fatal: contexts stay closable by the fee payer and a sweep can retry.
    logger.warn({ err, contexts: open }, 'could not reclaim proof contexts');
  }
}

const PROOF_PROGRAM_BYTES = getAddressEncoder().encode(ZK_ELGAMAL_PROOF_PROGRAM);

function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
