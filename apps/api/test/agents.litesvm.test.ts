/**
 * Agents end to end, over HTTP through the SDK, on LiteSVM: an owner creates
 * and funds an agent, the agent pays within its limits and pays for an x402
 * resource, the owner pauses, revokes and sweeps it. NEAR is played by
 * support/fake-policy.ts; the proofs, RequireContexts and durable nonce are real.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { Vexa, VexaAgent } from '@vexa/sdk';
import { signWithSolanaSeed } from '@vexa/core/crypto';
import {
  createTestbed,
  vaultBinaryExists,
  type Testbed,
  type Wallet,
} from '../../../packages/core/test/support/testbed.js';
import { litesvmChain } from './support/litesvm.js';
import { fakePolicyContract } from './support/fake-policy.js';
import { sessionToken, testApp } from './helpers.js';

const USDC = 1_000_000n;

describe.skipIf(!vaultBinaryExists())('agents over HTTP, on LiteSVM', { timeout: 120_000 }, () => {
  let bed: Testbed;
  let api: ReturnType<typeof testApp>;

  // One fetch for everything: the API, and a merchant selling a resource for 5 USDC over x402.
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    if (url.host === 'api.test') return api.app.request(url.pathname + url.search, init);
    if (url.host === 'weather.example') {
      const payment = new Headers(init?.headers).get('X-PAYMENT');
      if (!payment)
        return Response.json(
          {
            x402Version: 1,
            accepts: [
              {
                scheme: 'vexa',
                network: 'solana',
                maxAmountRequired: (5n * USDC).toString(),
                resource: url.toString(),
                payTo: '@shop',
                asset: bed.vault.cusdcMint,
              },
            ],
          },
          { status: 402 },
        );
      return Response.json({ forecast: 'sunny' });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof globalThis.fetch;

  async function person(
    handle: string,
    usdc: bigint,
  ): Promise<{ userId: string; wallet: Wallet; vexa: Vexa }> {
    const userId = randomUUID();
    const wallet = await bed.newWallet(usdc);
    const vexa = new Vexa({
      accessToken: sessionToken(userId),
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
    return { userId, wallet, vexa };
  }

  beforeAll(async () => {
    bed = await createTestbed();
    api = testApp({
      chain: litesvmChain(bed),
      vault: bed.vault as never,
      policy: fakePolicyContract(),
    });
  });

  it('creates, funds and runs an agent within its limits, then takes the funds back', async () => {
    const owner = await person('olive', 100n * USDC);
    const shop = await person('shop', 0n);
    await owner.vexa.money.deposit(100n * USDC, owner.wallet.keys);

    const { agent, credential } = await owner.vexa.agents.create(
      { name: 'shopper', policy: { maxPerRequest: 10n * USDC, dailyLimit: 25n * USDC } },
      owner.wallet.keys,
    );
    expect(agent).toMatchObject({ name: 'shopper', status: 'active', policy: { version: 1 } });
    expect(credential).toMatch(/^vxagent_/);
    expect(owner.vexa.agents.credentialFor(agent.id, owner.wallet.keys)).toBe(credential);

    // Fund it from the owner's confidential balance.
    await owner.vexa.money.transfer(
      { to: `agent:${agent.id}`, amount: 30n * USDC },
      owner.wallet.keys,
    );
    const bot = new VexaAgent({
      accessToken: sessionToken(owner.userId),
      credential,
      baseUrl: 'http://api.test',
      maxRetries: 0,
      fetch,
    });
    expect(await bot.balance()).toEqual({ available: 0n, pending: 30n * USDC });

    // Two payments; the second's limit proof covers the first.
    await bot.pay({ to: '@shop', amount: 9n * USDC, memo: 'api credits' });
    await bot.pay({ to: '@shop', amount: 7n * USDC });
    expect((await shop.vexa.money.balance(shop.wallet.keys)).pending).toBe(16n * USDC);
    expect((await bot.balance()).available).toBe(14n * USDC);
    const [received] = await shop.vexa.money.activity(shop.wallet.keys);
    expect(received).toMatchObject({ kind: 'transfer', direction: 'received', amount: 7n * USDC });

    // Over the per-payment limit: refused before anything is proven or sent.
    await expect(bot.pay({ to: '@shop', amount: 11n * USDC })).rejects.toThrow(/LIMIT_EXCEEDED/);

    // x402: 402, pay 5 USDC to @shop, retry with X-PAYMENT.
    const res = await bot.fetch('https://weather.example/today');
    expect(await res.json()).toEqual({ forecast: 'sunny' });
    const steps = (await owner.vexa.agents.traces(agent.id)).map(
      (t) => (t as { step: string }).step,
    );
    expect(steps.reverse()).toEqual(
      expect.arrayContaining([
        'request',
        'payment_required',
        'quote',
        'policy_check',
        'paid',
        'retried',
        'completed',
      ]),
    );
    // 9 + 7 + 5 = 21 of 25 today: another 5 would break the daily limit.
    await expect(bot.pay({ to: '@shop', amount: 5n * USDC })).rejects.toThrow(/LIMIT_EXCEEDED/);

    // Paused: refused by the policy contract.
    await owner.vexa.agents.pause(agent.id, owner.wallet.keys);
    await expect(bot.pay({ to: '@shop', amount: USDC })).rejects.toThrow(/paused/);
    await owner.vexa.agents.resume(agent.id, owner.wallet.keys);

    // Revoked, then swept back to the owner.
    await owner.vexa.agents.revoke(agent.id, owner.wallet.keys);
    const before = (await owner.vexa.money.balance(owner.wallet.keys)).pending;
    const swept = await owner.vexa.agents.sweep(agent.id, owner.wallet.keys);
    expect(swept.amount).toBe(9n * USDC);
    expect((await owner.vexa.money.balance(owner.wallet.keys)).pending - before).toBe(9n * USDC);
    expect((await bot.balance()).available).toBe(0n);
  });

  it('keeps an agent within its owner’s tier', async () => {
    const owner = await person('tiny', 0n);
    await expect(
      owner.vexa.agents.create(
        { policy: { maxPerRequest: 10n * USDC, dailyLimit: 1_000n * USDC } },
        owner.wallet.keys,
      ),
    ).rejects.toMatchObject({ status: 403, code: 'agent_limit_reached' });
  });
});
