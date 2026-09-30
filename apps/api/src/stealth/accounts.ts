/**
 * What a route account does on Solana, signed by its own key and the fee
 * payer: move USDC, open a confidential account, deposit into the vault,
 * pay confidentially, and close everything afterwards so the rent comes back.
 *
 * Unlike user plans these are built here: the route accounts are Vexa's,
 * their keys are Vexa's, and amounts are held in memory only.
 */
import {
  getBase64Encoder,
  getTransactionDecoder,
  type Address,
  type Instruction,
} from '@solana/kit';
import {
  getCloseAccountInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getEmptyConfidentialTransferAccountInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token-2022';
import { AeCiphertext, ElGamalCiphertext, ZeroCiphertextProofData } from '@solana/zk-sdk';
import {
  buildTransferProofs,
  decryptableZeroBalance,
  pubkeyValidityProof,
} from '@vexa/core/crypto';
import {
  compilePlan,
  configurePlan,
  decodeConfidentialAccount,
  depositPlan,
  findAta,
  INSTRUCTIONS_SYSVAR,
  ProofType,
  quoteFee,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  transferPlan,
  verifyProofInstruction,
  type FeeSchedule,
  type Plan,
  type VaultAccounts,
} from '@vexa/core/solana';
import type { Chain } from '../chain/chain.js';
import type { RouteAccount } from './keys.js';

export interface RouteContext {
  chain: Chain;
  vault: VaultAccounts & { program: Address };
  fees: FeeSchedule;
}

async function sendPlan(ctx: RouteContext, plan: Plan): Promise<string[]> {
  const latest = await ctx.chain.getLatestBlockhash();
  const compiled = await compilePlan(plan, {
    feePayer: ctx.chain.feePayer,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });
  const signatures: string[] = [];
  for (const stage of compiled.stages) {
    for (const { transaction } of stage) {
      const tx = getTransactionDecoder().decode(getBase64Encoder().encode(transaction));
      signatures.push(await ctx.chain.signAndSend(tx));
    }
  }
  return signatures;
}

const sendIxs = (ctx: RouteContext, label: 'withdraw', instructions: Instruction[]) =>
  sendPlan(ctx, { kind: 'withdraw', stages: [[{ label, instructions }]] });

type UsdcContext = { chain: Chain; vault: { usdcMint: Address } };

export async function usdcAccount(
  ctx: Pick<UsdcContext, 'vault'>,
  owner: Address,
): Promise<Address> {
  return findAta(owner, ctx.vault.usdcMint, TOKEN_PROGRAM);
}

/** A token account's balance, or 0 if it doesn't exist. */
export async function tokenBalance(ctx: RouteContext, account: Address): Promise<bigint> {
  const data = await ctx.chain.getAccountData(account);
  return data && data.length >= 72
    ? new DataView(data.buffer, data.byteOffset).getBigUint64(64, true)
    : 0n;
}

/** Creates the route account's USDC account (so it can receive), paid by the fee payer. */
export async function ensureUsdcAccount(ctx: UsdcContext, owner: Address): Promise<Address> {
  const ata = await usdcAccount(ctx, owner);
  if (!(await ctx.chain.getAccountData(ata))) {
    await ctx.chain.sendAsFeePayer([
      getCreateAssociatedTokenIdempotentInstruction({
        payer: ctx.chain.feePayerSigner,
        ata,
        owner,
        mint: ctx.vault.usdcMint,
        tokenProgram: TOKEN_PROGRAM,
      }),
    ]);
  }
  return ata;
}

/** Sends `amount` USDC to `recipient`'s USDC account (created first if needed, by the fee payer). */
export async function sendUsdc(
  ctx: RouteContext,
  from: RouteAccount,
  recipient: Address,
  amount: bigint,
) {
  const [source, destination] = await Promise.all([
    usdcAccount(ctx, from.signer.address),
    ensureUsdcAccount(ctx, recipient),
  ]);
  const [signature] = await sendIxs(ctx, 'withdraw', [
    getTransferCheckedInstruction(
      {
        source,
        mint: ctx.vault.usdcMint,
        destination,
        authority: from.signer,
        amount,
        decimals: 6,
      },
      { programAddress: TOKEN_PROGRAM },
    ),
  ]);
  return signature!;
}

/**
 * Deposits everything in the route account's USDC account into its
 * confidential balance (opening that first), then pays `recipient`
 * confidentially. Returns what the recipient received and the grouped
 * ciphertexts of the payment, for the transfer record.
 */
export async function depositAndPay(
  ctx: RouteContext,
  account: RouteAccount,
  recipient: { cusdc: Address; elgamalPubkey: Uint8Array },
  auditor: Uint8Array | null,
) {
  const owner = account.signer;
  const [usdc, cusdc] = await Promise.all([
    usdcAccount(ctx, owner.address),
    findAta(owner.address, ctx.vault.cusdcMint, TOKEN_2022_PROGRAM),
  ]);
  const rent = await ctx.chain.getRentTable();
  const signatures: string[] = [];

  if (!(await ctx.chain.getAccountData(cusdc))) {
    signatures.push(
      ...(await sendPlan(
        ctx,
        configurePlan({
          vault: ctx.vault,
          feePayer: ctx.chain.feePayer,
          owner,
          tokenAccount: cusdc,
          pubkeyValidityProof: pubkeyValidityProof(account.keys.elgamal),
          decryptableZeroBalance: decryptableZeroBalance(account.keys.ae),
          rent,
        }),
      )),
    );
  }

  const amount = await tokenBalance(ctx, usdc);
  if (amount > 0n) {
    const fee = quoteFee(ctx.fees, amount);
    const state = decodeConfidentialAccount((await ctx.chain.getAccountData(cusdc))!)!;
    signatures.push(
      ...(await sendPlan(
        ctx,
        depositPlan({
          vault: ctx.vault,
          owner,
          ownerUsdc: usdc,
          ownerCusdc: cusdc,
          amount,
          expectedPendingBalanceCreditCounter: state.pendingBalanceCreditCounter + 1n,
          // A route account only ever holds this one deposit.
          newDecryptableAvailableBalance: account.keys.ae.encrypt(amount - fee).toBytes(),
        }),
      )),
    );
  }

  const state = decodeConfidentialAccount((await ctx.chain.getAccountData(cusdc))!)!;
  const available = decryptAvailable(account, state.decryptableAvailableBalance);
  if (available === 0n) return { received: 0n, signatures, grouped: null };
  const proofs = buildTransferProofs({
    elgamal: account.keys.elgamal,
    ae: account.keys.ae,
    availableBalance: state.availableBalance,
    decryptableAvailableBalance: state.decryptableAvailableBalance,
    amount: available,
    destinationElgamalPubkey: recipient.elgamalPubkey,
    auditorElgamalPubkey: auditor,
  });
  signatures.push(
    ...(await sendPlan(
      ctx,
      await transferPlan({
        feePayer: ctx.chain.feePayer,
        owner,
        mint: ctx.vault.cusdcMint,
        sourceToken: cusdc,
        destinationToken: recipient.cusdc,
        proofs,
        rent,
      }),
    )),
  );
  return {
    received: available,
    signatures,
    grouped: { lo: proofs.groupedCiphertextLo, hi: proofs.groupedCiphertextHi },
  };
}

function decryptAvailable(account: RouteAccount, decryptable: Uint8Array): bigint {
  const ct = AeCiphertext.fromBytes(decryptable);
  const value = ct?.decrypt(account.keys.ae) ?? 0n;
  ct?.free();
  return value;
}

/**
 * Closes the route account's token accounts once they're empty, returning
 * their rent to the fee payer. The confidential account is emptied with a
 * zero-balance proof first. Best effort: an account that isn't empty stays.
 */
export async function closeRouteAccounts(ctx: RouteContext, account: RouteAccount) {
  const owner = account.signer;
  const [usdc, cusdc] = await Promise.all([
    usdcAccount(ctx, owner.address),
    findAta(owner.address, ctx.vault.cusdcMint, TOKEN_2022_PROGRAM),
  ]);
  const instructions: Instruction[] = [];
  const usdcData = await ctx.chain.getAccountData(usdc);
  if (usdcData && (await tokenBalance(ctx, usdc)) === 0n) {
    instructions.push(
      getCloseAccountInstruction(
        { account: usdc, destination: ctx.chain.feePayer, owner },
        { programAddress: TOKEN_PROGRAM },
      ),
    );
  }
  const cusdcData = await ctx.chain.getAccountData(cusdc);
  const state = cusdcData ? decodeConfidentialAccount(cusdcData) : null;
  if (state && state.pendingBalanceCreditCounter === 0n) {
    const ciphertext = ElGamalCiphertext.fromBytes(state.availableBalance)!;
    const proof = new ZeroCiphertextProofData(account.keys.elgamal, ciphertext);
    instructions.push(
      verifyProofInstruction(ProofType.VerifyZeroCiphertext, proof.toBytes()),
      getEmptyConfidentialTransferAccountInstruction({
        token: cusdc,
        instructionsSysvarOrContextState: INSTRUCTIONS_SYSVAR,
        authority: owner,
        proofInstructionOffset: -1,
      }),
      getCloseAccountInstruction({ account: cusdc, destination: ctx.chain.feePayer, owner }),
    );
    proof.free();
    ciphertext.free();
  }
  if (instructions.length) await sendIxs(ctx, 'withdraw', instructions);
}
