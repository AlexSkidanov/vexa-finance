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
