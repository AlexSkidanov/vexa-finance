/**
 * The stealth router. Drives each route through
 *
 *   awaiting_funds → routing → shielded → returning → settling → settled
 *                       ↘ refunding → refunded          ↘ (retry) shielded
 *
 * one step per tick, resumable at every point: addresses and 1Click deposit
 * addresses are stored before any money moves, route keys are derived, and
 * amounts are always re-read from chain or from 1Click, held in memory only
 * for the step at hand. The API never stores or logs an amount.
 */
import { address, type Address } from '@solana/kit';
import { base64Decode, base64Encode } from '@vexa/core';
import { decodeConfidentialMint } from '@vexa/core/solana';
import type { Logger } from '../logger.js';
import type { Store, StealthRouteRow, StealthStatus } from '../store/types.js';
import type { Chain } from '../chain/chain.js';
import type { VaultAddresses } from '../context.js';
import { readFeeSchedule } from '../lib/tier.js';
import {
  closeRouteAccounts,
  depositAndPay,
  ensureUsdcAccount,
  sendUsdc,
  tokenBalance,
  usdcAccount,
  type RouteContext,
} from './accounts.js';
import { routeAccount } from './keys.js';
import { ASSET_USDC_SOLANA, ASSET_ZEC, OneClickError, type OneClick } from './oneclick.js';
import type { ZcashWallet } from './zcash.js';

export interface StealthRouter {
  seed: string;
  oneClick: OneClick;
  zcash: ZcashWallet;
}

export interface StealthDeps {
  store: Store;
  chain: Chain;
  vault: VaultAddresses;
  logger: Logger;
  router: StealthRouter;
}

/** ZEC kept back for the ZIP-317 fee of the send back to 1Click. */
const ZCASH_FEE_BUFFER = 25_000n;
const MAX_LEG2_ATTEMPTS = 3;
const MAX_STEP_ATTEMPTS = 20;
/** How long a sender has to fund a route before it's abandoned. */
const FUNDING_WINDOW_MS = 60 * 60 * 1000;
/** A leg that hasn't finished after this is treated as failed. */
const LEG_TIMEOUT_MS = 24 * 60 * 60 * 1000;

const minutes = (n: number) => new Date(Date.now() + n * 60_000);
const seconds = (n: number) => new Date(Date.now() + n * 1000);

class Wait extends Error {
  constructor(readonly until: Date) {
    super('waiting');
  }
}

async function context(deps: StealthDeps): Promise<RouteContext> {
  const fees = await readFeeSchedule(deps);
  if (!fees) throw new Error('the vault has no fee schedule');
  return {
    chain: deps.chain,
    vault: { ...deps.vault, treasury: fees.treasury },
    fees,
  };
}

async function moveTo(
  deps: StealthDeps,
  route: StealthRouteRow,
  status: StealthStatus,
  patch: Parameters<Store['stealth']['update']>[1] = {},
) {
  await deps.store.stealth.update(route.transferId, {
    ...patch,
    status,
    attempts: 0,
    lastError: null,
    nextAttemptAt: patch.nextAttemptAt ?? new Date(),
  });
  const transferStatus =
    status === 'routing' || status === 'shielded' || status === 'returning'
      ? status
      : status === 'refunded'
        ? 'refunded'
        : status === 'failed'
          ? 'failed'
          : null;
  if (transferStatus) await deps.store.money.setTransferStatus(route.transferId, transferStatus);
  if (status === 'routing' || status === 'shielded' || status === 'returning') {
    await deps.store.events.emit(route.senderId, 'transfer.stealth_updated', {
      transferId: route.transferId,
      status,
    });
  }
  deps.logger.info({ route: route.transferId, status }, 'stealth route moved on');
}

async function recipientKey(
  deps: StealthDeps,
  route: StealthRouteRow,
  refund: boolean,
): Promise<{ cusdc: Address; elgamalPubkey: Uint8Array; ownerId: string | null }> {
  const transfer = (await deps.store.money.transferById(route.transferId))!;
  if (refund) {
    const sender = await deps.store.profiles.get(route.senderId);
    return {
      cusdc: address(route.senderCusdc),
      elgamalPubkey: base64Decode(sender!.elgamalPubkey!)!,
      ownerId: route.senderId,
    };
  }
  const handle = transfer.toHandle ? await deps.store.handles.resolve(transfer.toHandle) : null;
  if (!handle) throw new Error('the recipient no longer resolves');
  return {
    cusdc: address(route.recipientCusdc),
    elgamalPubkey: base64Decode(handle.elgamalPubkey)!,
    ownerId: transfer.toOwnerId,
  };
}

async function auditorKey(deps: StealthDeps): Promise<Uint8Array | null> {
  const mint = await deps.chain.getAccountData(deps.vault.cusdcMint);
  return (mint && decodeConfidentialMint(mint)?.auditorElgamalPubkey) ?? null;
}

async function step(deps: StealthDeps, route: StealthRouteRow): Promise<void> {
  const { router, store } = deps;
  const ctx = await context(deps);
  const entry = await routeAccount(router.seed, route.transferId, 'entry');
  const exit = await routeAccount(router.seed, route.transferId, 'exit');
  const age = Date.now() - route.createdAt.getTime();

  switch (route.status) {
    case 'awaiting_funds': {
      const funds = await tokenBalance(ctx, await usdcAccount(ctx, entry.signer.address));
      if (funds === 0n) {
        if (age > FUNDING_WINDOW_MS) {
          await closeRouteAccounts(ctx, entry);
          await moveTo(deps, route, 'failed', { lastError: 'never funded' });
          await store.money.failTransfer(route.transferId, 'never funded', route.signatures);
          return;
        }
        throw new Wait(seconds(20));
      }
      // Leg 1: USDC → ZEC, into this route's shielded address.
      const zcashAddress = route.zcashAddress ?? (await router.zcash.newAddress());
      if (!route.zcashAddress) await store.stealth.update(route.transferId, { zcashAddress });
      let quote;
      try {
        quote = await router.oneClick.quote({
          originAsset: ASSET_USDC_SOLANA,
          destinationAsset: ASSET_ZEC,
          amount: funds,
          recipient: zcashAddress,
          refundTo: entry.signer.address,
        });
      } catch (e) {
        // Too small to route, or no route at all: give it back.
        if (e instanceof OneClickError && e.status >= 400 && e.status < 500) {
          await moveTo(deps, route, 'refunding', { lastError: e.message });
          return;
        }
        throw e;
      }
      // Stored before the money moves, so a crash can't lose track of it.
      await store.stealth.update(route.transferId, { leg1DepositAddress: quote.depositAddress });
      const signature = await sendUsdc(
        ctx,
        entry,
        address(quote.depositAddress),
        BigInt(quote.amountIn),
      );
      await router.oneClick.submitDeposit(quote.depositAddress, signature);
      await moveTo(deps, route, 'routing', {
        signatures: [...route.signatures, signature],
        nextAttemptAt: seconds(60),
      });
      return;
    }

    case 'routing': {
      const s = await router.oneClick.status(route.leg1DepositAddress!);
      if (s.status === 'SUCCESS') {
        // A random wait before leaving the pool, so timing doesn't pair the legs.
        await moveTo(deps, route, 'shielded', { nextAttemptAt: minutes(2 + Math.random() * 18) });
        return;
      }
      if (['REFUNDED', 'FAILED', 'INCOMPLETE_DEPOSIT'].includes(s.status) || age > LEG_TIMEOUT_MS) {
        await moveTo(deps, route, 'refunding', {
          lastError: `leg 1 ${s.status}`,
          nextAttemptAt: minutes(2),
        });
        return;
      }
      throw new Wait(seconds(45));
    }

    case 'shielded': {
      // Leg 2: ZEC → USDC, to the exit address. What arrived comes from 1Click.
      const arrived = BigInt(
        (await router.oneClick.status(route.leg1DepositAddress!)).amountOut ?? '0',
      );
      const toSend = arrived - ZCASH_FEE_BUFFER;
      if (toSend <= 0n) {
        await moveTo(deps, route, 'failed', { lastError: 'leg 1 delivered nothing to route' });
        return;
      }
      if ((await router.zcash.spendable()) < arrived) throw new Wait(minutes(2)); // confirmations
      await ensureUsdcAccount(ctx, exit.signer.address);
      const quote = await router.oneClick.quote({
        originAsset: ASSET_ZEC,
        destinationAsset: ASSET_USDC_SOLANA,
        amount: toSend,
        recipient: exit.signer.address,
        refundTo: route.zcashAddress!,
      });
      await store.stealth.update(route.transferId, { leg2DepositAddress: quote.depositAddress });
      const txid = await router.zcash.send(quote.depositAddress, BigInt(quote.amountIn));
      await router.oneClick.submitDeposit(quote.depositAddress, txid);
      await moveTo(deps, route, 'returning', { zcashTxid: txid, nextAttemptAt: minutes(3) });
      return;
    }

    case 'returning': {
      const s = await router.oneClick.status(route.leg2DepositAddress!);
      if (s.status === 'SUCCESS') {
        await moveTo(deps, route, 'settling');
        return;
      }
      if (['REFUNDED', 'FAILED', 'INCOMPLETE_DEPOSIT'].includes(s.status)) {
        // The ZEC came back to the route's shielded address: try the leg again.
        const tries = route.leg2Attempts + 1;
        if (tries > MAX_LEG2_ATTEMPTS) {
          await moveTo(deps, route, 'failed', {
            lastError: `leg 2 ${s.status} ${tries} times; the ZEC is in the wallet`,
          });
          return;
        }
        await moveTo(deps, route, 'shielded', { leg2Attempts: tries, nextAttemptAt: minutes(5) });
        return;
      }
      if (age > LEG_TIMEOUT_MS) {
        await moveTo(deps, route, 'failed', { lastError: 'leg 2 timed out; check 1Click' });
        return;
      }
      throw new Wait(minutes(1));
    }

    case 'settling': {
      if ((await tokenBalance(ctx, await usdcAccount(ctx, exit.signer.address))) === 0n)
        throw new Wait(seconds(30)); // 1Click reports success slightly before the transfer lands
      const recipient = await recipientKey(deps, route, false);
      const paid = await depositAndPay(ctx, exit, recipient, await auditorKey(deps));
      const signatures = [...route.signatures, ...paid.signatures];
      const settled = await store.money.settleTransfer(route.transferId, {
        ciphertext: {
          ...(await store.money.transferById(route.transferId))!.ciphertext,
          ...(paid.grouped
            ? { groupedLo: base64Encode(paid.grouped.lo), groupedHi: base64Encode(paid.grouped.hi) }
            : {}),
        },
        txSig: signatures[signatures.length - 1]!,
        signatures,
        memoCiphertext: null,
      });
      await closeRouteAccounts(ctx, exit).catch((err) =>
        deps.logger.warn({ err }, 'exit cleanup failed'),
      );
      await closeRouteAccounts(ctx, entry).catch((err) =>
        deps.logger.warn({ err }, 'entry cleanup failed'),
      );
      await moveTo(deps, route, 'settled', { signatures });
      const event = { transferId: settled.id, txSig: settled.txSig, mode: 'stealth' };
      await store.events.emit(route.senderId, 'transfer.settled', { ...event, direction: 'sent' });
      if (recipient.ownerId && recipient.ownerId !== route.senderId)
        await store.events.emit(recipient.ownerId, 'transfer.settled', {
          ...event,
          direction: 'received',
        });
      return;
    }

    case 'refunding': {
      // Whatever came back sits in the entry account: pay it to the sender.
      const funds = await tokenBalance(ctx, await usdcAccount(ctx, entry.signer.address));
      if (funds === 0n) {
        if (age > LEG_TIMEOUT_MS) {
          await moveTo(deps, route, 'failed', { lastError: 'refund never arrived; check 1Click' });
          return;
        }
        throw new Wait(minutes(1));
      }
      const sender = await recipientKey(deps, route, true);
      const paid = await depositAndPay(ctx, entry, sender, await auditorKey(deps));
      await closeRouteAccounts(ctx, entry).catch((err) =>
        deps.logger.warn({ err }, 'entry cleanup failed'),
      );
      await moveTo(deps, route, 'refunded', {
        signatures: [...route.signatures, ...paid.signatures],
      });
      await store.events.emit(route.senderId, 'transfer.refunded', {
        transferId: route.transferId,
      });
      return;
    }

    default:
      return;
  }
}

export async function processDueRoutes(deps: StealthDeps, limit = 5): Promise<number> {
  const due = await deps.store.stealth.claimDue(limit, 300);
  for (const route of due) {
    try {
      await step(deps, route);
    } catch (e) {
      if (e instanceof Wait) {
        await deps.store.stealth.update(route.transferId, { nextAttemptAt: e.until });
        continue;
      }
      const attempts = route.attempts + 1;
      const message = e instanceof Error ? e.message : String(e);
      deps.logger.warn(
        { route: route.transferId, status: route.status, attempts, err: message },
        'stealth step failed',
      );
      if (attempts >= MAX_STEP_ATTEMPTS) {
        await deps.store.stealth.update(route.transferId, {
          status: 'failed',
          attempts,
          lastError: message,
        });
        continue;
      }
      await deps.store.stealth.update(route.transferId, {
        attempts,
        lastError: message,
        nextAttemptAt: seconds(Math.min(30 * 2 ** attempts, 1800)),
      });
    }
  }
  return due.length;
}

export function startStealthWorker(deps: StealthDeps, intervalMs = 10_000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await processDueRoutes(deps);
    } catch (err) {
      deps.logger.error({ err }, 'stealth tick failed');
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
