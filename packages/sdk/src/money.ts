/**
 * Money: deposits, confidential transfers, withdrawals, balances and
 * activity. Everything that involves an amount or a key happens here, on the
 * device: proofs are generated with the user's keys, transactions are signed
 * with their Solana key, and balances are decrypted locally. The API only
 * ever sees ciphertexts, proofs and signatures.
 *
 * Every method takes the user's keys, as returned by `deriveUserKeys()` from
 * their passkey's PRF output.
 */
import { address, createKeyPairSignerFromPrivateKeyBytes, type Address } from '@solana/kit';
import { AeCiphertext } from '@solana/zk-sdk';
import { base64Decode, base64Encode, type ChainContext } from '@vexa/core';
import {
  buildTransferProofs,
  buildWithdrawProofs,
  decryptableZeroBalance,
  decryptMemo,
  decryptPendingBalance,
  decryptTransferAmount,
  encryptMemo,
  pubkeyValidityProof,
  type UserKeys,
} from '@vexa/core/crypto';
import {
  applyPendingPlan,
  compilePlan,
  configurePlan,
  depositPlan,
  findAta,
  TOKEN_PROGRAM,
  transferPlan,
  withdrawPlan,
  type Plan,
  type RentTable,
} from '@vexa/core/solana';
import type { RequestOptions } from './http.js';

type Call = <T>(method: string, path: string, opts?: RequestOptions) => Promise<T>;

interface BalanceResponse {
  cusdcAccount: string;
  usdcAccount: string;
  configured: boolean;
  confidential: {
    pendingBalanceLo: string;
    pendingBalanceHi: string;
    availableBalance: string;
    decryptableAvailableBalance: string;
    pendingBalanceCreditCounter: string;
  } | null;
}

export interface Balance {
  /** Spendable now, in USDC base units (6 decimals). */
  available: bigint;
  /** Received but not yet applied; `applyPending()` makes it spendable. */
  pending: bigint;
  configured: boolean;
  cusdcAccount: string;
  usdcAccount: string;
}

export interface ActivityTransfer {
  kind: 'transfer';
  id: string;
  direction: 'sent' | 'received';
  /** Decrypted on this device. */
  amount: bigint;
  memo: string | null;
  to: string;
  txSig: string | null;
  createdAt: string;
}

export interface ActivityMovement {
  kind: 'deposit' | 'withdrawal';
  id: string;
  status: string;
  txSig: string | null;
  destination?: string;
  createdAt: string;
}

const b64 = (s: string) => {
  const bytes = base64Decode(s);
  if (!bytes) throw new Error('malformed base64 from the API');
  return bytes;
};

function rentTable(ctx: ChainContext): RentTable {
  return {
    confidentialAccount: BigInt(ctx.rent.confidentialAccount),
    equalityContext: BigInt(ctx.rent.equalityContext),
    validityContext: BigInt(ctx.rent.validityContext),
    rangeU128Context: BigInt(ctx.rent.rangeU128Context),
    rangeU64Context: BigInt(ctx.rent.rangeU64Context),
  };
}

export class Money {
  constructor(private readonly call: Call) {}

  private chain() {
    return this.call<ChainContext>('GET', '/v1/chain');
  }

  private async compile(plan: Plan, ctx: ChainContext) {
    return compilePlan(plan, {
      feePayer: address(ctx.feePayer),
      blockhash: ctx.blockhash as Parameters<typeof compilePlan>[1]['blockhash'],
      lastValidBlockHeight: BigInt(ctx.lastValidBlockHeight),
    });
  }

  private vault(ctx: ChainContext) {
    return {
      program: address(ctx.vault.program),
      config: address(ctx.vault.config),
      usdcMint: address(ctx.vault.usdcMint),
      cusdcMint: address(ctx.vault.cusdcMint),
      usdcReserve: address(ctx.vault.usdcReserve),
    };
  }

  private async raw(): Promise<BalanceResponse> {
    return this.call<BalanceResponse>('GET', '/v1/balance');
  }

  private decrypt(raw: BalanceResponse, keys: UserKeys): Balance {
    const base = {
      configured: raw.configured,
      cusdcAccount: raw.cusdcAccount,
      usdcAccount: raw.usdcAccount,
    };
    if (!raw.confidential) return { ...base, available: 0n, pending: 0n };
    const ae = AeCiphertext.fromBytes(b64(raw.confidential.decryptableAvailableBalance));
    const available = ae?.decrypt(keys.ae) ?? 0n;
    ae?.free();
    const pending = decryptPendingBalance(
      keys.elgamal.secret(),
      b64(raw.confidential.pendingBalanceLo),
      b64(raw.confidential.pendingBalanceHi),
    );
    return { ...base, available, pending };
  }

  /** The user's confidential balance, decrypted on this device. */
  async balance(keys: UserKeys): Promise<Balance> {
    return this.decrypt(await this.raw(), keys);
  }

  /**
   * Opens the user's confidential cUSDC account. Needed once, before the
   * first deposit or incoming transfer. Vexa sponsors the account's rent.
   */
  async openAccount(keys: UserKeys): Promise<{ signatures: string[] }> {
    const [ctx, raw] = await Promise.all([this.chain(), this.raw()]);
    if (raw.configured) return { signatures: [] };
    const owner = await createKeyPairSignerFromPrivateKeyBytes(keys.solanaSeed);
    const plan = configurePlan({
      vault: this.vault(ctx),
      feePayer: address(ctx.feePayer),
      owner,
      tokenAccount: address(raw.cusdcAccount),
      pubkeyValidityProof: pubkeyValidityProof(keys.elgamal),
      decryptableZeroBalance: decryptableZeroBalance(keys.ae),
      rent: rentTable(ctx),
    });
    return this.call('POST', '/v1/accounts/confidential', {
      body: { plan: await this.compile(plan, ctx) },
      idempotencyKey: true,
    });
  }

  /**
   * Moves `amount` USDC (base units) from the user's wallet into their
   * confidential balance. Deposits are public on-chain, like any USDC
   * transfer; from here on the balance is encrypted.
   */
  async deposit(amount: bigint, keys: UserKeys): Promise<{ id: string; txSig: string | null }> {
    const [ctx, raw] = await Promise.all([this.chain(), this.raw()]);
    if (!raw.configured || !raw.confidential)
      throw new Error('open the account first: money.openAccount()');
    const { available, pending } = this.decrypt(raw, keys);
    const owner = await createKeyPairSignerFromPrivateKeyBytes(keys.solanaSeed);
    const plan = depositPlan({
      vault: this.vault(ctx),
      owner,
      ownerUsdc: address(raw.usdcAccount),
      ownerCusdc: address(raw.cusdcAccount),
      amount,
      expectedPendingBalanceCreditCounter:
        BigInt(raw.confidential.pendingBalanceCreditCounter) + 1n,
      // Deposit and apply in one go: available + everything pending + this deposit.
      newDecryptableAvailableBalance: keys.ae.encrypt(available + pending + amount).toBytes(),
    });
    return this.call('POST', '/v1/deposits', {
      body: { plan: await this.compile(plan, ctx) },
      idempotencyKey: true,
    });
  }

  /** Makes received funds spendable. Does nothing when nothing is pending. */
  async applyPending(keys: UserKeys): Promise<{ signatures: string[] }> {
    const [ctx, raw] = await Promise.all([this.chain(), this.raw()]);
    if (!raw.confidential) throw new Error('open the account first: money.openAccount()');
    if (raw.confidential.pendingBalanceCreditCounter === '0') return { signatures: [] };
    const { available, pending } = this.decrypt(raw, keys);
    const owner = await createKeyPairSignerFromPrivateKeyBytes(keys.solanaSeed);
    const plan = applyPendingPlan({
      owner,
      ownerCusdc: address(raw.cusdcAccount),
      expectedPendingBalanceCreditCounter: BigInt(raw.confidential.pendingBalanceCreditCounter),
      newDecryptableAvailableBalance: keys.ae.encrypt(available + pending).toBytes(),
    });
    return this.call('POST', '/v1/balance/apply', {
      body: { plan: await this.compile(plan, ctx) },
      idempotencyKey: true,
    });
  }

  /**
   * Sends `amount` (base units) to a handle, confidentially. The amount and
   * memo are encrypted on this device; Vexa never learns either.
   */
  async transfer(
    input: { to: string; amount: bigint; memo?: string; idempotencyKey?: string },
    keys: UserKeys,
  ): Promise<{ id: string; txSig: string | null }> {
    let raw = await this.raw();
    if (!raw.confidential) throw new Error('open the account first: money.openAccount()');
    let balance = this.decrypt(raw, keys);
    if (balance.available < input.amount && balance.available + balance.pending >= input.amount) {
      // Received funds count once applied; do it now rather than fail.
      await this.applyPending(keys);
      raw = await this.raw();
      balance = this.decrypt(raw, keys);
    }
    if (balance.available < input.amount) throw new Error('insufficient confidential balance');

    const prepared = await this.call<{
      transferId: string;
      recipient: { handle: string; elgamalPubkey: string; cusdcAccount: string };
    }>('POST', '/v1/transfers/prepare', {
      body: { to: input.to },
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:prepare` : true,
    });
    const ctx = await this.chain();
    const recipientKey = b64(prepared.recipient.elgamalPubkey);
    const proofs = buildTransferProofs({
      elgamal: keys.elgamal,
      ae: keys.ae,
      availableBalance: b64(raw.confidential!.availableBalance),
      decryptableAvailableBalance: b64(raw.confidential!.decryptableAvailableBalance),
      amount: input.amount,
      destinationElgamalPubkey: recipientKey,
      auditorElgamalPubkey: ctx.auditorElgamalPubkey ? b64(ctx.auditorElgamalPubkey) : null,
    });
    const plan = await transferPlan({
      feePayer: address(ctx.feePayer),
      owner: await createKeyPairSignerFromPrivateKeyBytes(keys.solanaSeed),
      mint: address(ctx.vault.cusdcMint),
      sourceToken: address(raw.cusdcAccount),
      destinationToken: address(prepared.recipient.cusdcAccount),
      proofs,
      rent: rentTable(ctx),
    });
    const memoCiphertext = input.memo
      ? base64Encode(
          encryptMemo({
            text: input.memo,
            recipientElgamalPubkey: recipientKey,
            senderElgamalPubkey: keys.elgamal.pubkey().toBytes(),
          }),
        )
      : undefined;
    return this.call('POST', '/v1/transfers/submit', {
      body: {
        transferId: prepared.transferId,
        plan: await this.compile(plan, ctx),
        ...(memoCiphertext ? { memoCiphertext } : {}),
      },
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:submit` : true,
    });
  }

  /**
   * Withdraws `amount` (base units) as plain USDC to a Solana wallet that
   * already has a USDC account (your own wallet, an exchange deposit
   * address). Withdrawals are public on-chain, like any USDC transfer.
   */
  async withdraw(
    input: { amount: bigint; to: string },
    keys: UserKeys,
  ): Promise<{ id: string; txSig: string | null }> {
    const [ctx, raw] = await Promise.all([this.chain(), this.raw()]);
    if (!raw.confidential) throw new Error('open the account first: money.openAccount()');
    const { available } = this.decrypt(raw, keys);
    if (available < input.amount) throw new Error('insufficient confidential balance');

    const wallet: Address = address(input.to);
    const destination = await findAta(wallet, address(ctx.vault.usdcMint), TOKEN_PROGRAM);
    const plan = await withdrawPlan({
      vault: this.vault(ctx),
      feePayer: address(ctx.feePayer),
      owner: await createKeyPairSignerFromPrivateKeyBytes(keys.solanaSeed),
      ownerCusdc: address(raw.cusdcAccount),
      destination,
      amount: input.amount,
      decimals: 6,
      proofs: buildWithdrawProofs({
        elgamal: keys.elgamal,
        ae: keys.ae,
        availableBalance: b64(raw.confidential.availableBalance),
        decryptableAvailableBalance: b64(raw.confidential.decryptableAvailableBalance),
        amount: input.amount,
      }),
      rent: rentTable(ctx),
    });
    return this.call('POST', '/v1/withdrawals', {
      body: { plan: await this.compile(plan, ctx), destinationAccount: destination },
      idempotencyKey: true,
    });
  }

  /** Activity with transfer amounts and memos decrypted on this device. */
  async activity(
    keys: UserKeys,
    opts: { limit?: number } = {},
  ): Promise<(ActivityTransfer | ActivityMovement)[]> {
    const { data } = await this.call<{ data: Record<string, unknown>[] }>(
      'GET',
      `/v1/activity?limit=${opts.limit ?? 50}`,
    );
    const secret = keys.elgamal.secret();
    return data.map((item) => {
      if (item.kind !== 'transfer') return item as unknown as ActivityMovement;
      const t = item as {
        id: string;
        direction: 'sent' | 'received';
        to: string;
        txSig: string | null;
        createdAt: string;
        ciphertext: { groupedLo: string; groupedHi: string };
        memoCiphertext: string | null;
      };
      const role = t.direction === 'sent' ? 0 : 1;
      return {
        kind: 'transfer',
        id: t.id,
        direction: t.direction,
        amount: decryptTransferAmount(
          secret,
          b64(t.ciphertext.groupedLo),
          b64(t.ciphertext.groupedHi),
          role,
        ),
        memo: t.memoCiphertext
          ? decryptMemo(
              b64(t.memoCiphertext),
              secret,
              t.direction === 'sent' ? 'sender' : 'recipient',
            )
          : null,
        to: t.to,
        txSig: t.txSig,
        createdAt: t.createdAt,
      } satisfies ActivityTransfer;
    });
  }
}
