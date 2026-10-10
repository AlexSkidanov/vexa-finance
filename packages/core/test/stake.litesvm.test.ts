/**
 * $VEXA staking on LiteSVM: a user with no SOL stakes (the fee payer funds
 * the stake record), and the stake then discounts their deposits.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { getBase64Encoder, getTransactionDecoder } from '@solana/kit';
import { decryptableZeroBalance, pubkeyValidityProof } from '../src/crypto/index.js';
import {
  compilePlan,
  configurePlan,
  decodeConfidentialAccount,
  decodeStakeRecord,
  depositPlan,
  findStakeRecord,
  quoteFee,
  stakePlan,
  unstakePlan,
  type Plan,
} from '../src/solana/index.js';
import { tierFor, vexaWeight } from '../src/tiers.js';
import { createTestbed, vaultBinaryExists, type Testbed, type Wallet } from './support/testbed.js';

const USDC = 1_000_000n;
const VEXA = 1_000_000n;

describe.skipIf(!vaultBinaryExists())('$VEXA staking on LiteSVM', { timeout: 30_000 }, () => {
  let bed: Testbed;
  let vexaMint: Awaited<ReturnType<Testbed['launchVexa']>>;

  beforeAll(async () => {
    bed = await createTestbed();
    vexaMint = await bed.launchVexa();
  });

  async function send(plan: Plan) {
    const compiled = await compilePlan(plan, {
      feePayer: bed.feePayer.address,
      ...bed.blockhash(),
    });
    for (const stage of compiled.stages) {
      for (const { transaction } of stage) {
        await bed.sendAsFeePayer(
          getTransactionDecoder().decode(getBase64Encoder().encode(transaction)),
        );
      }
    }
    bed.svm.expireBlockhash();
  }

  async function onboard(): Promise<Wallet> {
    const w = await bed.newWallet(1_000n * USDC);
    await send(
      configurePlan({
        vault: bed.vault,
        feePayer: bed.feePayer.address,
        owner: w.signer,
        tokenAccount: w.cusdc,
        pubkeyValidityProof: pubkeyValidityProof(w.keys.elgamal),
        decryptableZeroBalance: decryptableZeroBalance(w.keys.ae),
        rent: bed.rent,
      }),
    );
    return w;
  }

  it('stakes without SOL and earns the discount on deposits', async () => {
    const alice = await onboard();
    const wallet = await bed.giveVexa(alice, 20_000n * VEXA);
    await send(
      await stakePlan({
        vault: bed.vault,
        feePayer: bed.feePayer.address,
        owner: alice.signer,
        vexaMint,
        amount: 10_000n * VEXA,
      }),
    );
    const record = await findStakeRecord(alice.signer.address);
    const stake = decodeStakeRecord(bed.account(record)!)!;
    expect(stake.amount).toBe(10_000n * VEXA);
    expect(bed.svm.getBalance(alice.signer.address) ?? 0n).toBe(0n);

    // 10k staked + 10k held at half = 15k: tier 2, 25% off.
    const weight = vexaWeight(stake.amount, bed.tokenAmount(wallet));
    expect(tierFor(weight).level).toBe(2);
    const fee = quoteFee(bed.feeSchedule, 100n * USDC, { vexaBalance: weight });
    expect(fee).toBe(75_000n);

    const treasuryBefore = bed.tokenAmount(bed.vault.treasury);
    const state = decodeConfidentialAccount(bed.account(alice.cusdc)!)!;
    await send(
      depositPlan({
        vault: bed.vault,
        owner: alice.signer,
        ownerUsdc: alice.usdc,
        ownerCusdc: alice.cusdc,
        amount: 100n * USDC,
        discountAccounts: [record, wallet],
        expectedPendingBalanceCreditCounter: state.pendingBalanceCreditCounter + 1n,
        newDecryptableAvailableBalance: alice.keys.ae.encrypt(100n * USDC - fee).toBytes(),
      }),
    );
    expect(bed.tokenAmount(bed.vault.treasury) - treasuryBefore).toBe(fee);
  });

  it('keeps the stake locked for a week', async () => {
    const bob = await onboard();
    await bed.giveVexa(bob, 5n * VEXA);
    await send(
      await stakePlan({
        vault: bed.vault,
        feePayer: bed.feePayer.address,
        owner: bob.signer,
        vexaMint,
        amount: 5n * VEXA,
      }),
    );
    await expect(
      send(await unstakePlan({ vault: bed.vault, owner: bob.signer, vexaMint, amount: VEXA })),
    ).rejects.toThrow();
  });
});

describe('stake plans for a Token-2022 $VEXA', () => {
  it('derive accounts under the mint’s own token program', async () => {
    const { address, generateKeyPairSigner } = await import('@solana/kit');
    const { findAta, TOKEN_2022_PROGRAM } = await import('../src/solana/index.js');
    const owner = await generateKeyPairSigner();
    const vault = {
      program: address('3g2JPX4roASUJVacf68sBSpARk5m9B3hu9xeaE6mTjPR'),
      config: address('7Q3LNA4P3J7H4zNdHJEephe2XEvBPKPUJsqGifexRopw'),
      usdcMint: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
      cusdcMint: address('4STXpFN2mQSt12XG4os7ftLXHbBq5PVWYCAahToRt6QQ'),
      usdcReserve: address('8eeishQYvtHwwM8QRN9629zzU9hBn18dGFW5T75ytqz6'),
      fees: address('4PAtQdQRVfozc2F8x4eJF1oHhAQ6EMfX5EqBgPGnj29u'),
      treasury: address('713NQALYzFN2zVSJ1ERqhSFiQTMqVnFyCVybYdn3r9Gj'),
    };
    const vexaMint = address('71ur38S2zxj1DaA2Untd8VYmAEkvyeXWkw3gycPDpump');
    const plan = await stakePlan({
      vault,
      feePayer: owner.address,
      owner,
      vexaMint,
      amount: 5n,
      tokenProgram: TOKEN_2022_PROGRAM,
    });
    const ix = plan.stages[0]![0]!.instructions[0]!;
    const accounts = ix.accounts!.map((a) => a.address);
    expect(accounts[5]).toBe(await findAta(owner.address, vexaMint, TOKEN_2022_PROGRAM));
    expect(accounts[6]).toBe(await findAta(vault.config, vexaMint, TOKEN_2022_PROGRAM));
    expect(accounts[8]).toBe(TOKEN_2022_PROGRAM);

    const out = await unstakePlan({
      vault,
      owner,
      vexaMint,
      amount: 5n,
      tokenProgram: TOKEN_2022_PROGRAM,
    });
    expect(out.stages[0]![0]!.instructions[0]!.accounts!.at(-1)!.address).toBe(TOKEN_2022_PROGRAM);
  });
});
