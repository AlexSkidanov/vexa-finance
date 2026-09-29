/**
 * The whole money flow through the SDK and the API's HTTP routes, with the
 * API co-signing onto LiteSVM running the real Token-2022, ZK proof program
 * and vault binary. Also the attacks the sponsorship policy must stop.
 *
 * Needs target/deploy/vault.so (`pnpm build:vault`); skipped without it.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { address, createNoopSigner, generateKeyPairSigner, type Address } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token-2022';
import { Vexa } from '@vexa/sdk';
import { decryptableZeroBalance, pubkeyValidityProof } from '@vexa/core/crypto';
import {
  compilePlan,
  configurePlan,
  findAta,
  TOKEN_PROGRAM,
  findStakeRecord,
  stakePlan,
  type RentTable,
} from '@vexa/core/solana';
import {
  createTestbed,
  vaultBinaryExists,
  type Testbed,
  type Wallet,
} from '../../../packages/core/test/support/testbed.js';
import { ChainError, type Chain } from '../src/chain/chain.js';
import { sessionToken, testApp } from './helpers.js';

const USDC = 1_000_000n;

function litesvmChain(bed: Testbed): Chain {
  return {
    feePayer: bed.feePayer.address,
    feePayerSigner: bed.feePayer,
    async getAccountData(a) {
      return bed.account(a);
    },
    async getRentTable() {
      return bed.rent;
    },
    async getMinimumBalance(space) {
      return bed.svm.minimumBalanceForRentExemption(space);
    },
    async getLatestBlockhash() {
      bed.svm.expireBlockhash();
      return bed.blockhash() as never;
    },
    async signAndSend(tx) {
      try {
        return await bed.sendAsFeePayer(tx);
      } catch (e) {
        throw new ChainError((e as Error).message, (e as { logs?: string[] }).logs ?? []);
      }
    },
    async sendAsFeePayer(instructions) {
      await bed.sendDirect(bed.feePayer, instructions);
      return '';
    },
  };
}

// Proof generation is CPU-bound; shared CI runners need more than the 5 s default.
describe.skipIf(!vaultBinaryExists())('money over HTTP, on LiteSVM', { timeout: 30_000 }, () => {
  let bed: Testbed;
  let api: ReturnType<typeof testApp>;

  interface Person {
    userId: string;
    wallet: Wallet;
    vexa: Vexa;
  }

  const client = (userId: string) =>
    new Vexa({
      accessToken: sessionToken(userId),
      baseUrl: 'http://api.test',
      maxRetries: 0,
      fetch: ((url: string, init: RequestInit) =>
        api.app.request(url.replace('http://api.test', ''), init)) as typeof fetch,
    });

  async function person(handle: string, usdc: bigint, open = true): Promise<Person> {
    const userId = randomUUID();
    const wallet = await bed.newWallet(usdc);
    const vexa = client(userId);
    await vexa.handles.claim(handle, {
      solanaAddress: wallet.signer.address,
      elgamalPubkey: wallet.keys.elgamalPubkey,
      sign: async (m) => {
        const { signWithSolanaSeed } = await import('@vexa/core/crypto');
        return signWithSolanaSeed(wallet.keys.solanaSeed, m);
      },
    });
    if (open) await vexa.money.openAccount(wallet.keys);
    return { userId, wallet, vexa };
  }

  beforeAll(async () => {
    bed = await createTestbed();
    api = testApp({ chain: litesvmChain(bed), vault: bed.vault as never });
  });

  it('opens, deposits, transfers with a memo, withdraws and reads activity', async () => {
    const alice = await person('alice', 100n * USDC);
    const bob = await person('bob', 0n);
    const feePayerStart = bed.svm.getBalance(bed.feePayer.address)!;

    // The SDK quotes the vault's fee up front and books what actually lands.
    expect(await alice.vexa.money.quote(50n * USDC)).toEqual({
      fee: 50_000n,
      net: 49_950_000n,
      discountBps: 0,
    });
    const deposit = await alice.vexa.money.deposit(50n * USDC, alice.wallet.keys);
    expect(deposit.fee).toBe(50_000n);
    expect((await alice.vexa.money.balance(alice.wallet.keys)).available).toBe(49_950_000n);
    expect(bed.tokenAmount(bed.vault.treasury)).toBe(50_000n);

    await alice.vexa.money.transfer(
      { to: '@bob.vexa', amount: 12_500_000n, memo: 'dinner 🍜' },
      alice.wallet.keys,
    );
    expect((await alice.vexa.money.balance(alice.wallet.keys)).available).toBe(37_450_000n);
    expect((await bob.vexa.money.balance(bob.wallet.keys)).pending).toBe(12_500_000n);

    // Both sides see the amount and memo, decrypted on their own device.
    const [received] = await bob.vexa.money.activity(bob.wallet.keys);
    expect(received).toMatchObject({
      kind: 'transfer',
      direction: 'received',
      amount: 12_500_000n,
      memo: 'dinner 🍜',
    });
    const [sent] = await alice.vexa.money.activity(alice.wallet.keys);
    expect(sent).toMatchObject({
      kind: 'transfer',
      direction: 'sent',
      amount: 12_500_000n,
      memo: 'dinner 🍜',
    });

    // Bob's funds are pending; sending applies them first.
    await bob.vexa.money.transfer({ to: '@alice', amount: 2_500_000n }, bob.wallet.keys);
    expect(await bob.vexa.money.balance(bob.wallet.keys)).toMatchObject({
      available: 10n * USDC,
      pending: 0n,
    });

    // A wallet without a USDC account can't receive: creating one isn't sponsored.
    const outside = await generateKeyPairSigner();
    await expect(
      alice.vexa.money.withdraw({ amount: 10n * USDC, to: outside.address }, alice.wallet.keys),
    ).rejects.toMatchObject({ status: 400 });
    // Once it has one (as any wallet that ever held USDC does), it can.
    const destination = await findAta(outside.address, bed.vault.usdcMint, TOKEN_PROGRAM);
    await bed.sendDirect(bed.admin, [
      getCreateAssociatedTokenIdempotentInstruction({
        payer: bed.admin,
        ata: destination,
        owner: outside.address,
        mint: bed.vault.usdcMint,
        tokenProgram: TOKEN_PROGRAM,
      }),
    ]);
    await alice.vexa.money.withdraw({ amount: 10n * USDC, to: outside.address }, alice.wallet.keys);
    expect(bed.tokenAmount(destination)).toBe(9_990_000n);
    expect(bed.tokenAmount(bed.vault.treasury)).toBe(60_000n);

    // Reserve covers supply exactly.
    const mint = bed.account(bed.vault.cusdcMint)!;
    expect(new DataView(mint.buffer).getBigUint64(36, true)).toBe(
      bed.tokenAmount(bed.vault.usdcReserve),
    );

    // After onboarding, sponsorship costs only transaction fees: every proof
    // context's rent came back. (Deposit, two transfers, a withdrawal.)
    const spent = feePayerStart - bed.svm.getBalance(bed.feePayer.address)!;
    expect(spent).toBeLessThan(200_000n);

    const kinds = (await alice.vexa.money.activity(alice.wallet.keys)).map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(['transfer', 'deposit', 'withdrawal']));
  });

  it('refuses a plan that pays anyone but the account owner', async () => {
    const mallory = await person('mallory', 0n, false);
    const attacker = await generateKeyPairSigner();
    const plan = configurePlan({
      vault: bed.vault,
      feePayer: bed.feePayer.address,
      owner: mallory.wallet.signer,
      tokenAccount: mallory.wallet.cusdc,
      pubkeyValidityProof: pubkeyValidityProof(mallory.wallet.keys.elgamal),
      decryptableZeroBalance: decryptableZeroBalance(mallory.wallet.keys.ae),
      rent: bed.rent as RentTable,
    });
    // Sneak a second SOL transfer from the fee payer to the attacker.
    plan.stages[0]![0]!.instructions.unshift(
      getTransferSolInstruction({
        source: createNoopSigner(bed.feePayer.address),
        destination: attacker.address,
        amount: 1_000_000_000n,
      }),
    );
    const compiled = await compilePlan(plan, {
      feePayer: bed.feePayer.address,
      ...bed.blockhash(),
    });
    const res = await api.request('POST', '/v1/accounts/confidential', {
      token: sessionToken(mallory.userId),
      idempotencyKey: randomUUID(),
      body: { plan: compiled },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('plan_refused');
    expect(bed.svm.getBalance(attacker.address) ?? 0n).toBe(0n);
  });

  it('refuses a transfer plan that pays someone other than the prepared recipient', async () => {
    const carol = await person('carol', 20n * USDC);
    await carol.vexa.money.deposit(20n * USDC, carol.wallet.keys);
    await person('dave', 0n);
    const eve = await person('eve', 0n);

    // Prepare to dave, then try to submit a plan that pays eve.
    const prepared = await (
      await api.request('POST', '/v1/transfers/prepare', {
        token: sessionToken(carol.userId),
        idempotencyKey: randomUUID(),
        body: { to: '@dave' },
      })
    ).json();
    const evePlan = await captureTransferPlan(
      carol,
      eve.wallet.cusdc,
      eve.wallet.keys.elgamal.pubkey().toBytes(),
    );
    const res = await api.request('POST', '/v1/transfers/submit', {
      token: sessionToken(carol.userId),
      idempotencyKey: randomUUID(),
      body: { transferId: prepared.transferId, plan: evePlan },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('plan_refused');
    expect((await carol.vexa.money.balance(carol.wallet.keys)).available).toBe(19_980_000n);
  });

  it('won’t submit the same transfer twice', async () => {
    const frank = await person('frank', 5n * USDC);
    await frank.vexa.money.deposit(5n * USDC, frank.wallet.keys);
    await person('grace', 0n);
    const first = await frank.vexa.money.transfer(
      { to: '@grace', amount: USDC },
      frank.wallet.keys,
    );
    const again = await api.request('POST', '/v1/transfers/submit', {
      token: sessionToken(frank.userId),
      idempotencyKey: randomUUID(),
      body: {
        transferId: first.id,
        plan: { kind: 'transfer', stages: [[{ label: 'x', transaction: 'AA==' }]] },
      },
    });
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe('transfer_already_submitted');
  });

  it('won’t send to someone who can’t receive yet, or to yourself', async () => {
    const heidi = await person('heidi', 0n);
    await person('ivan', 0n, false);
    const notReady = await heidi.vexa.money
      .transfer({ to: '@ivan', amount: 1n }, heidi.wallet.keys)
      .catch((e: unknown) => e);
    // Heidi has no balance, so the SDK stops before asking the API.
    expect((notReady as Error).message).toMatch(/insufficient/);

    const res = await api.request('POST', '/v1/transfers/prepare', {
      token: sessionToken(heidi.userId),
      idempotencyKey: randomUUID(),
      body: { to: '@ivan' },
    });
    expect((await res.json()).error.code).toBe('recipient_not_ready');
    const self = await api.request('POST', '/v1/transfers/prepare', {
      token: sessionToken(heidi.userId),
      idempotencyKey: randomUUID(),
      body: { to: '@heidi' },
    });
    expect(self.status).toBe(400);
  });

  /** Builds (but doesn't submit) a transfer plan from `from` to an arbitrary account. */
  async function captureTransferPlan(from: Person, to: Address, recipientKey: Uint8Array) {
    const { buildTransferProofs } = await import('@vexa/core/crypto');
    const { decodeConfidentialAccount, transferPlan } = await import('@vexa/core/solana');
    const s = decodeConfidentialAccount(bed.account(from.wallet.cusdc)!)!;
    const plan = await transferPlan({
      feePayer: bed.feePayer.address,
      owner: from.wallet.signer,
      mint: bed.vault.cusdcMint,
      sourceToken: from.wallet.cusdc,
      destinationToken: address(to),
      proofs: buildTransferProofs({
        elgamal: from.wallet.keys.elgamal,
        ae: from.wallet.keys.ae,
        availableBalance: s.availableBalance,
        decryptableAvailableBalance: s.decryptableAvailableBalance,
        amount: USDC,
        destinationElgamalPubkey: recipientKey,
        auditorElgamalPubkey: null,
      }),
      rent: bed.rent,
    });
    return compilePlan(plan, { feePayer: bed.feePayer.address, ...bed.blockhash() });
  }

  it('stakes $VEXA for a user with no SOL and reports their tier', async () => {
    const vexaMint = await bed.launchVexa();
    const olivia = await person('olivia', 100n * USDC);
    await bed.giveVexa(olivia.wallet, 2_000n * USDC);

    await olivia.vexa.money.stake(1_000n * USDC, olivia.wallet.keys);
    const info = await olivia.vexa.money.tier();
    expect(info).toMatchObject({ vexaMint, staked: 1_000n * USDC, held: 1_000n * USDC });
    // 1,000 staked + 1,000 held at half = 1,500: tier 1, 10% off.
    expect(info.tier).toMatchObject({ level: 1, discountBps: 1_000, maxAgents: 5 });
    expect(bed.svm.getBalance(olivia.wallet.signer.address) ?? 0n).toBe(0n);

    // The SDK presents the stake to the vault: 10% off 0.10 USDC.
    const deposit = await olivia.vexa.money.deposit(100n * USDC, olivia.wallet.keys);
    expect(deposit).toMatchObject({ fee: 90_000n, discountBps: 1_000 });
    expect((await olivia.vexa.money.balance(olivia.wallet.keys)).available).toBe(99_910_000n);

    // Locked for a week.
    await expect(olivia.vexa.money.unstake(USDC, olivia.wallet.keys)).rejects.toMatchObject({
      status: 502,
    });
  });

  it('refuses a stake plan aimed at someone else’s stake record', async () => {
    const vexaMint = bed.feeSchedule.vexaMint ?? (await bed.launchVexa());
    const peggy = await person('peggy', 0n, false);
    const victim = await person('victor', 0n, false);
    const plan = await stakePlan({
      vault: bed.vault,
      feePayer: bed.feePayer.address,
      owner: peggy.wallet.signer,
      vexaMint,
      amount: USDC,
    });
    const ix = plan.stages[0]![0]!.instructions[0]! as unknown as {
      accounts: { address: string }[];
    };
    ix.accounts[7]!.address = await findStakeRecord(victim.wallet.signer.address);
    const compiled = await compilePlan(plan, {
      feePayer: bed.feePayer.address,
      ...bed.blockhash(),
    });
    const res = await api.request('POST', '/v1/stake', {
      token: sessionToken(peggy.userId),
      idempotencyKey: randomUUID(),
      body: { plan: compiled },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('plan_refused');
  });
});
