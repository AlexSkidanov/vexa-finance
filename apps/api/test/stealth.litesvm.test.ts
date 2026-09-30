/**
 * Stealth transfers end to end on LiteSVM: the sender withdraws to a one-time
 * entry address, the worker swaps to ZEC and back (1Click and the Zcash wallet
 * simulated by support/fake-stealth.ts), deposits at a one-time exit address
 * and pays the recipient confidentially. Also the refund path.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { Vexa } from '@vexa/sdk';
import { signWithSolanaSeed } from '@vexa/core/crypto';
import { findAta, quoteFee, TOKEN_PROGRAM } from '@vexa/core/solana';
import {
  createTestbed,
  vaultBinaryExists,
  type Testbed,
  type Wallet,
} from '../../../packages/core/test/support/testbed.js';
import { createLogger } from '../src/logger.js';
import { createMemoryStore } from '../src/store/memory.js';
import { processDueRoutes } from '../src/stealth/worker.js';
import { routeAccount } from '../src/stealth/keys.js';
import { litesvmChain } from './support/litesvm.js';
import { fakeStealth, rates } from './support/fake-stealth.js';
import { sessionToken, testApp } from './helpers.js';

const USDC = 1_000_000n;
const SEED = '42'.repeat(32);

describe.skipIf(!vaultBinaryExists())('stealth transfers on LiteSVM', { timeout: 180_000 }, () => {
  let bed: Testbed;

  async function world(opts: { refundLeg1?: boolean } = {}) {
    const store = createMemoryStore();
    const fakes = fakeStealth(bed, opts);
    const router = { seed: SEED, oneClick: fakes.oneClick, zcash: fakes.zcash };
    const api = testApp({
      store,
      chain: litesvmChain(bed),
      vault: bed.vault as never,
      stealth: router,
    });
    const fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      return api.app.request(url.pathname + url.search, init);
    }) as typeof globalThis.fetch;
    const person = async (
      handle: string,
      usdc: bigint,
    ): Promise<{ wallet: Wallet; vexa: Vexa }> => {
      const wallet = await bed.newWallet(usdc);
      const vexa = new Vexa({
        accessToken: sessionToken(randomUUID()),
        baseUrl: 'http://api.test',
        maxRetries: 0,
        fetch,
      });
      await vexa.handles.claim(handle, {
        solanaAddress: wallet.signer.address,
        elgamalPubkey: wallet.keys.elgamalPubkey,
        sign: (m) => signWithSolanaSeed(wallet.keys.solanaSeed, m),
      });
      await vexa.money.openAccount(wallet.keys);
      return { wallet, vexa };
    };
    /** Runs the worker until the route stops moving, skipping its waits. */
    const drive = async (transferId: string) => {
      const deps = {
        store,
        chain: litesvmChain(bed),
        vault: bed.vault,
        logger: createLogger('silent'),
        router,
      };
      const senderId = (await store.money.transferById(transferId))!.fromOwnerId!;
      for (let i = 0; i < 40; i++) {
        await store.stealth.update(transferId, { nextAttemptAt: new Date(0) });
        await processDueRoutes(deps);
        const route = await store.stealth.get(transferId, senderId);
        if (['settled', 'refunded', 'failed'].includes(route!.status)) break;
      }
    };
    return { store, fakes, person, drive };
  }

  beforeAll(async () => {
    bed = await createTestbed();
  });

  it('routes a payment through the shielded pool and pays the recipient', async () => {
    const { person, drive, store } = await world();
    const alice = await person('alice', 100n * USDC);
    const bob = await person('bob', 0n);
    await alice.vexa.money.deposit(100n * USDC, alice.wallet.keys);

    await expect(
      alice.vexa.money.transfer({ to: '@bob', amount: USDC, mode: 'stealth' }, alice.wallet.keys),
    ).rejects.toThrow(/5 USDC/);
    const sent = await alice.vexa.money.transfer(
      { to: '@bob', amount: 20n * USDC, mode: 'stealth' },
      alice.wallet.keys,
    );
    expect((await alice.vexa.money.transferStatus(sent.id)).stealth?.status).toBe('awaiting_funds');

    await drive(sent.id);
    const status = await alice.vexa.money.transferStatus(sent.id);
    expect(status).toMatchObject({ status: 'settled', stealth: { status: 'settled' } });

    // What bob gets: 20 less the withdraw fee, through both swaps, less the deposit fee.
    const entered = 20n * USDC - quoteFee(bed.feeSchedule, 20n * USDC);
    const returned = rates.zecToUsdc(rates.usdcToZec(entered) - 25_000n);
    const expected = returned - quoteFee(bed.feeSchedule, returned);
    expect((await bob.vexa.money.balance(bob.wallet.keys)).pending).toBe(expected);

    // Each side reads its own amount; nothing links them on-chain but the pool.
    const [mine] = await alice.vexa.money.activity(alice.wallet.keys);
    expect(mine).toMatchObject({ kind: 'transfer', direction: 'sent', amount: 20n * USDC });
    const [theirs] = await bob.vexa.money.activity(bob.wallet.keys);
    expect(theirs).toMatchObject({ kind: 'transfer', direction: 'received', amount: expected });

    // The route's accounts were closed and their rent returned.
    const entry = await routeAccount(SEED, sent.id, 'entry');
    const exit = await routeAccount(SEED, sent.id, 'exit');
    for (const owner of [entry.signer.address, exit.signer.address])
      expect(bed.account(await findAta(owner, bed.vault.usdcMint, TOKEN_PROGRAM))).toBeNull();
    expect(
      (await store.stealth.get(sent.id, (await store.money.transferById(sent.id))!.fromOwnerId!))
        ?.status,
    ).toBe('settled');
  });

  it('refunds the sender when the first swap fails', async () => {
    const { person, drive } = await world({ refundLeg1: true });
    const carol = await person('carol', 50n * USDC);
    await person('dave', 0n);
    await carol.vexa.money.deposit(50n * USDC, carol.wallet.keys);
    const before = (await carol.vexa.money.balance(carol.wallet.keys)).available;

    const sent = await carol.vexa.money.transfer(
      { to: '@dave', amount: 10n * USDC, mode: 'stealth' },
      carol.wallet.keys,
    );
    await drive(sent.id);
    expect(await carol.vexa.money.transferStatus(sent.id)).toMatchObject({
      status: 'refunded',
      stealth: { status: 'refunded' },
    });
    // Back as pending: 10 less the withdraw fee, less the re-deposit fee.
    const back = 10n * USDC - quoteFee(bed.feeSchedule, 10n * USDC);
    const refunded = back - quoteFee(bed.feeSchedule, back);
    const after = await carol.vexa.money.balance(carol.wallet.keys);
    expect(after.available).toBe(before - 10n * USDC);
    expect(after.pending).toBe(refunded);
  });
});
