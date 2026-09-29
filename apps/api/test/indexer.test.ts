import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base58Encode } from '@vexa/core';
import { createLogger } from '../src/logger.js';
import { createMemoryStore } from '../src/store/memory.js';
import { indexerBackoff, MAX_INDEXER_ATTEMPTS, processDue } from '../src/indexer/worker.js';
import { parseTransaction } from '../src/indexer/alchemy.js';
import { watchAddresses } from '../src/indexer/notify.js';
import { signedClaim, TEST_ENV, TEST_VAULT, testApp, sessionToken } from './helpers.js';

const KEY = 'whsec_alchemy_test_key';
const FEE_PAYER = 'BsaXW67grtRRHr6WpWNNw7iRJ3RETLWiMMKxVgtUzi6P';

/** A delivery in the exact shape Alchemy sends (taken from a real one), with made-up contents. */
function alchemyDelivery(
  txs: { signature: string; accountKeys: string[]; data: number[]; err?: unknown }[],
) {
  return {
    webhookId: 'wh_test',
    id: `whevt_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    type: 'ADDRESS_ACTIVITY',
    event: {
      transaction: txs.map((t) => ({
        signature: t.signature,
        transaction: [
          {
            signatures: [t.signature],
            message: [
              {
                header: [{}],
                account_keys: t.accountKeys,
                instructions: [
                  {
                    program_id_index: t.accountKeys.indexOf(TEST_VAULT.program),
                    data: base58Encode(Uint8Array.from(t.data)),
                  },
                ],
                versioned: true,
                recent_blockhash: '11111111111111111111111111111111',
              },
            ],
          },
        ],
        meta: [{ fee: 5000, ...(t.err ? { err: t.err } : {}), log_messages: [] }],
        index: 1,
        is_vote: false,
      })),
      slot: 451246490,
      network: 'SOLANA_MAINNET',
    },
  };
}

const sign = (body: string) => createHmac('sha256', KEY).update(body).digest('hex');
const sig = () => base58Encode(crypto.getRandomValues(new Uint8Array(64)));

function setup() {
  const store = createMemoryStore();
  const api = testApp({ store, env: { ...TEST_ENV, ALCHEMY_WEBHOOK_SIGNING_KEY: KEY } });
  const deps = {
    store,
    logger: createLogger('silent'),
    vaultProgram: TEST_VAULT.program,
    ignore: new Set<string>([FEE_PAYER, TEST_VAULT.program, TEST_VAULT.usdcReserve]),
  };
  const post = (payload: unknown, signature?: string) => {
    const body = JSON.stringify(payload);
    return api.app.request('/v1/hooks/alchemy', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-alchemy-signature': signature ?? sign(body),
      },
      body,
    });
  };
  return { store, api, deps, post };
}

async function registeredUser(api: ReturnType<typeof testApp>, handle: string) {
  const userId = randomUUID();
  const claim = signedClaim(userId, handle);
  await api.request('POST', '/v1/handles/claim', {
    token: sessionToken(userId),
    idempotencyKey: randomUUID(),
    body: claim,
  });
  return { userId, wallet: claim.solanaPubkey };
}

describe('alchemy receiver', () => {
  it('queues each transaction once and rejects bad signatures', async () => {
    const { post, store } = setup();
    const delivery = alchemyDelivery([
      { signature: sig(), accountKeys: [FEE_PAYER, TEST_VAULT.program], data: [2] },
    ]);

    expect((await post(delivery, 'ab'.repeat(32))).status).toBe(401);
    expect(await (await post(delivery)).json()).toEqual({ received: true, queued: 1 });
    // Alchemy retries deliveries; the same transaction isn't queued twice.
    expect(await (await post(delivery)).json()).toEqual({ received: true, queued: 0 });
    expect(await store.chainEvents.claimDue(10, 60)).toHaveLength(1);
  });

  it('is disabled without a signing key', async () => {
    const res = await testApp().app.request('/v1/hooks/alchemy', { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });
});

describe('indexer', () => {
  it('records and announces a deposit made directly on-chain', async () => {
    const { post, store, api, deps } = setup();
    const alice = await registeredUser(api, 'alice');
    const signature = sig();
    await post(
      alchemyDelivery([
        {
          signature,
          accountKeys: [FEE_PAYER, alice.wallet, TEST_VAULT.program, TEST_VAULT.usdcReserve],
          data: [2, 0, 225, 245, 5, 0, 0, 0, 0],
        },
      ]),
    );
    expect(await processDue(deps)).toBe(1);
    expect(await store.money.hasDeposit(signature)).toBe(true);
    const [item] = await store.money.activity(alice.userId, { limit: 10 });
    expect(item).toMatchObject({
      kind: 'deposit',
      movement: { txSig: signature, status: 'confirmed' },
    });
  });

  it("doesn't duplicate a deposit the API already recorded, and ignores other activity", async () => {
    const { post, store, api, deps } = setup();
    const bob = await registeredUser(api, 'bob');
    const known = sig();
    await store.money.recordDeposit({ ownerId: bob.userId, txSig: known, status: 'confirmed' });
    await post(
      alchemyDelivery([
        { signature: known, accountKeys: [FEE_PAYER, bob.wallet, TEST_VAULT.program], data: [2] },
        // A withdrawal and a failed deposit: neither creates a deposit.
        { signature: sig(), accountKeys: [FEE_PAYER, bob.wallet, TEST_VAULT.program], data: [3] },
        {
          signature: sig(),
          accountKeys: [FEE_PAYER, bob.wallet, TEST_VAULT.program],
          data: [2],
          err: { InstructionError: [0, 'Custom'] },
        },
      ]),
    );
    await processDue(deps);
    const deposits = (await store.money.activity(bob.userId, { limit: 10 })).filter(
      (i) => i.kind === 'deposit',
    );
    expect(deposits).toHaveLength(1);
  });

  it('retries failures with backoff and parks them as dead', async () => {
    const { store, deps } = setup();
    await store.chainEvents.enqueue({
      source: 'alchemy',
      externalId: 'x',
      payload: { signature: 'x' },
    });
    const broken = {
      ...deps,
      store: {
        ...store,
        money: {
          ...store.money,
          hasDeposit: async () => {
            throw new Error('db down');
          },
        },
      },
    };
    // A payload that reaches the store: a vault deposit.
    await store.chainEvents.enqueue({
      source: 'alchemy',
      externalId: 'y',
      payload: alchemyDelivery([
        { signature: 'y', accountKeys: [FEE_PAYER, TEST_VAULT.program], data: [2] },
      ]).event.transaction[0],
    });
    expect(await processDue(broken)).toBe(2);
    // 'x' had nothing to index and is done; 'y' failed and is backed off.
    expect(await store.chainEvents.claimDue(10, 60)).toHaveLength(0);
    expect(indexerBackoff(1, 0)!.getTime()).toBe(10_000);
    expect(indexerBackoff(MAX_INDEXER_ATTEMPTS)).toBeNull();
  });

  it('parses the real delivery shape', () => {
    const [tx] = alchemyDelivery([
      { signature: 's', accountKeys: [FEE_PAYER, TEST_VAULT.program], data: [2, 1] },
    ]).event.transaction;
    expect(parseTransaction(tx)).toMatchObject({
      signature: 's',
      failed: false,
      instructions: [{ program: TEST_VAULT.program }],
    });
    expect(parseTransaction({ nonsense: true })).toBeNull();
  });
});

describe('alchemy notify', () => {
  it('asks Alchemy to watch addresses, and does nothing when not configured', async () => {
    const calls: RequestInit[] = [];
    const fetch = (async (_: string, init: RequestInit) => {
      calls.push(init);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const logger = createLogger('silent');
    expect(
      await watchAddresses({ authToken: 't', webhookId: 'wh_1', addresses: ['A'], logger, fetch }),
    ).toBe(true);
    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      webhook_id: 'wh_1',
      addresses_to_add: ['A'],
      addresses_to_remove: [],
    });
    expect(
      await watchAddresses({
        authToken: undefined,
        webhookId: 'wh_1',
        addresses: ['A'],
        logger,
        fetch,
      }),
    ).toBe(false);
  });
});
