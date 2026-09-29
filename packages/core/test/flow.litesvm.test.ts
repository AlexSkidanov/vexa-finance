/**
 * End-to-end money flow on LiteSVM (see support/testbed.ts). Users hold USDC
 * but no SOL. Every transaction is compiled from a plan on the "device" and
 * co-signed by the fee payer, the way the API does it. Needs the vault binary:
 * run `pnpm build:vault` first; the suite is skipped without it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  generateKeyPairSigner,
  getBase64Encoder,
  getTransactionDecoder,
  type Transaction,
} from '@solana/kit';
import { AeCiphertext } from '@solana/zk-sdk';
import {
  buildTransferProofs,
  buildWithdrawProofs,
  decryptableZeroBalance,
  decryptPendingBalance,
  decryptTransferAmount,
  pubkeyValidityProof,
} from '../src/crypto/index.js';
import {
  applyPendingPlan,
  compilePlan,
  configurePlan,
  decodeConfidentialAccount,
  depositPlan,
  findAta,
  TOKEN_PROGRAM,
  transferPlan,
  withdrawPlan,
  type CompiledPlan,
} from '../src/solana/index.js';
import { createTestbed, vaultBinaryExists, type Testbed, type Wallet } from './support/testbed.js';

const USDC = 1_000_000n;

describe.skipIf(!vaultBinaryExists())('money flow on LiteSVM', () => {
  let bed: Testbed;

  beforeAll(async () => {
    bed = await createTestbed();
  });

  async function run(plan: CompiledPlan): Promise<Transaction[]> {
    const sent: Transaction[] = [];
    for (const stage of plan.stages) {
      for (const { transaction } of stage) {
        const tx = getTransactionDecoder().decode(getBase64Encoder().encode(transaction));
        const size = tx.messageBytes.length + 1 + 64 * Object.keys(tx.signatures).length;
        expect(size).toBeLessThanOrEqual(1232);
        await bed.sendAsFeePayer(tx);
        sent.push(tx);
      }
    }
    bed.svm.expireBlockhash();
    return sent;
  }

  const compile = async (plan: Parameters<typeof compilePlan>[0]) =>
    run(await compilePlan(plan, { feePayer: bed.feePayer.address, ...bed.blockhash() }));

  const state = (w: Wallet) => decodeConfidentialAccount(bed.account(w.cusdc)!)!;
  const available = (w: Wallet) =>
    AeCiphertext.fromBytes(state(w).decryptableAvailableBalance)!.decrypt(w.keys.ae)!;
  const pending = (w: Wallet) =>
    decryptPendingBalance(
      w.keys.elgamal.secret(),
      state(w).pendingBalanceLo,
      state(w).pendingBalanceHi,
    );

  async function onboard(usdc: bigint): Promise<Wallet> {
    const w = await bed.newWallet(usdc);
    await compile(
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

  async function deposit(w: Wallet, amount: bigint) {
    await compile(
      depositPlan({
        vault: bed.vault,
        owner: w.signer,
        ownerUsdc: w.usdc,
        ownerCusdc: w.cusdc,
        amount,
        expectedPendingBalanceCreditCounter: state(w).pendingBalanceCreditCounter + 1n,
        newDecryptableAvailableBalance: w.keys.ae
          .encrypt(available(w) + pending(w) + amount)
          .toBytes(),
      }),
    );
  }

  async function applyPending(w: Wallet) {
    await compile(
      applyPendingPlan({
        owner: w.signer,
        ownerCusdc: w.cusdc,
        expectedPendingBalanceCreditCounter: state(w).pendingBalanceCreditCounter,
        newDecryptableAvailableBalance: w.keys.ae.encrypt(available(w) + pending(w)).toBytes(),
      }),
    );
  }

  async function transfer(from: Wallet, to: Wallet, amount: bigint) {
    const s = state(from);
    const proofs = buildTransferProofs({
      elgamal: from.keys.elgamal,
      ae: from.keys.ae,
      availableBalance: s.availableBalance,
      decryptableAvailableBalance: s.decryptableAvailableBalance,
      amount,
      destinationElgamalPubkey: to.keys.elgamal.pubkey().toBytes(),
      auditorElgamalPubkey: null,
    });
    const plan = await transferPlan({
      feePayer: bed.feePayer.address,
      owner: from.signer,
      mint: bed.vault.cusdcMint,
      sourceToken: from.cusdc,
      destinationToken: to.cusdc,
      proofs,
      rent: bed.rent,
    });
    return { proofs, sent: await compile(plan) };
  }

  it('configures a confidential account for a user with no SOL', async () => {
    const carol = await onboard(0n);
    expect(state(carol).approved).toBe(true);
    expect([...state(carol).elgamalPubkey]).toEqual([...carol.keys.elgamal.pubkey().toBytes()]);
    expect(bed.svm.getBalance(carol.signer.address) ?? 0n).toBe(0n);
  });

  it('deposits, transfers confidentially and withdraws, with no amount on the wire', async () => {
    const alice = await onboard(100n * USDC);
    const bob = await onboard(0n);

    await deposit(alice, 50n * USDC);
    expect(available(alice)).toBe(50n * USDC);
    expect(bed.tokenAmount(bed.vault.usdcReserve)).toBe(50n * USDC);

    const amount = 12_500_000n;
    const feePayerBefore = bed.svm.getBalance(bed.feePayer.address)!;
    const { proofs, sent } = await transfer(alice, bob, amount);

    // No encoding of the amount (whole, or either half) appears in any transaction.
    const needles = [amount, amount & 0xffffn, amount >> 16n].map((n) => {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setBigUint64(0, n, true);
      return b;
    });
    for (const tx of sent) {
      for (const needle of needles) expect(indexOf(tx.messageBytes, needle)).toBe(-1);
    }

    expect(available(alice)).toBe(50n * USDC - amount);
    expect(pending(bob)).toBe(amount);
    expect(
      decryptTransferAmount(
        bob.keys.elgamal.secret(),
        proofs.groupedCiphertextLo,
        proofs.groupedCiphertextHi,
        1,
      ),
    ).toBe(amount);
    // Context accounts were closed: the fee payer only paid transaction fees.
    expect(feePayerBefore - bed.svm.getBalance(bed.feePayer.address)!).toBeLessThan(50_000n);

    // Withdraw to an outside wallet that has never seen Vexa.
    const outside = await generateKeyPairSigner();
    const destination = await findAta(outside.address, bed.vault.usdcMint, TOKEN_PROGRAM);
    const s = state(alice);
    await compile(
      await withdrawPlan({
        vault: bed.vault,
        feePayer: bed.feePayer.address,
        owner: alice.signer,
        ownerCusdc: alice.cusdc,
        destination,
        createDestinationFor: outside.address,
        amount: 10n * USDC,
        decimals: 6,
        proofs: buildWithdrawProofs({
          elgamal: alice.keys.elgamal,
          ae: alice.keys.ae,
          availableBalance: s.availableBalance,
          decryptableAvailableBalance: s.decryptableAvailableBalance,
          amount: 10n * USDC,
        }),
        rent: bed.rent,
      }),
    );
    expect(bed.tokenAmount(destination)).toBe(10n * USDC);
    expect(available(alice)).toBe(50n * USDC - amount - 10n * USDC);
    expect(bed.tokenAmount(bed.vault.usdcReserve)).toBe(40n * USDC);

    // Bob makes the received funds spendable, then sends some back.
    await applyPending(bob);
    expect(available(bob)).toBe(amount);
    await transfer(bob, alice, 2_500_000n);
    expect(available(bob)).toBe(10n * USDC);
    await applyPending(alice);
    expect(available(alice)).toBe(50n * USDC - amount - 10n * USDC + 2_500_000n);

    // Everything in cUSDC is backed: supply equals the reserve.
    const mint = bed.account(bed.vault.cusdcMint)!;
    expect(new DataView(mint.buffer).getBigUint64(36, true)).toBe(
      bed.tokenAmount(bed.vault.usdcReserve),
    );
  });

  it('refuses to let a transfer overdraw, before anything is sent', async () => {
    const dave = await onboard(5n * USDC);
    await deposit(dave, 5n * USDC);
    const eve = await onboard(0n);
    await expect(transfer(dave, eve, 6n * USDC)).rejects.toThrow(/insufficient/);
  });
});

function indexOf(haystack: ArrayLike<number>, needle: ArrayLike<number>): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
