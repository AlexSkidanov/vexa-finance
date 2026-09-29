/**
 * Money endpoints. Every movement is a plan of transactions the user's device
 * built and signed (see @vexa/core/solana): the API checks it against the
 * sponsorship policy, co-signs as fee payer, sends it and records the result.
 *
 * No endpoint here accepts, stores or returns a plaintext amount. Balances go
 * out as ciphertexts; transfers are recorded as the ciphertexts from their
 * validity proof.
 */
import { Hono, type Context } from 'hono';
import { address, getAddressEncoder, type Address } from '@solana/kit';
import {
  base64Decode,
  base64Encode,
  ErrorCode,
  formatHandle,
  PrepareTransferRequest,
  SubmitPlanRequest,
  SubmitTransferRequest,
  tierFor,
  validateHandle,
  vexaWeight,
  WithdrawRequest,
  type ChainContext,
} from '@vexa/core';
import {
  decodeConfidentialAccount,
  decodeConfidentialMint,
  decodeFeeSchedule,
  decodeStakeRecord,
  feeDiscountBps,
  findAta,
  findStakeRecord,
  ProofType,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  ZK_ELGAMAL_PROOF_PROGRAM,
  type PlanKind,
} from '@vexa/core/solana';
import { ApiError, notFound } from '../errors.js';
import type { AppBindings } from '../context.js';
import type { TransferRow } from '../store/types.js';
import { authenticate, principalOf } from '../middleware/auth.js';
import { idempotent } from '../middleware/idempotency.js';
import { parseBody } from '../lib/validate.js';
import { executePlan, PlanFailed } from '../chain/execute.js';
import {
  checkPlan,
  SponsorshipRefused,
  type CheckedTransaction,
  type SponsorContext,
} from '../chain/sponsor.js';

type C = Context<AppBindings>;

/** The signed-in user's keys and accounts, or 400 if they haven't claimed a handle yet. */
async function owner(c: C) {
  const { store, vault } = c.get('deps');
  const { userId } = principalOf(c);
  const profile = await store.profiles.get(userId);
  if (!profile?.solanaPubkey || !profile.elgamalPubkey) {
    throw new ApiError(400, ErrorCode.ProfileIncomplete, 'Claim a handle before moving money');
  }
  const wallet = address(profile.solanaPubkey);
  return {
    userId,
    profile,
    wallet,
    cusdc: await findAta(wallet, vault.cusdcMint, TOKEN_2022_PROGRAM),
    usdc: await findAta(wallet, vault.usdcMint, TOKEN_PROGRAM),
  };
}

async function feeSchedule(c: C) {
  const { chain, vault } = c.get('deps');
  const data = await chain.getAccountData(vault.fees);
  return data ? decodeFeeSchedule(data) : null;
}

/**
 * A user's $VEXA position: what's staked in the vault and what sits in their
 * wallet, and the weight and tier they add up to. $VEXA balances are public
 * token balances, not money movements, so returning them is fine.
 */
async function vexaPosition(c: C, wallet: Address, fees: Awaited<ReturnType<typeof feeSchedule>>) {
  if (!fees?.vexaMint) return null;
  const { chain, vault } = c.get('deps');
  const [walletAccount, stakeRecord] = await Promise.all([
    findAta(wallet, fees.vexaMint, TOKEN_PROGRAM),
    findStakeRecord(wallet, vault.program),
  ]);
  const [walletData, stakeData] = await Promise.all([
    chain.getAccountData(walletAccount),
    chain.getAccountData(stakeRecord),
  ]);
  const held =
    walletData && walletData.length >= 72
      ? new DataView(walletData.buffer, walletData.byteOffset).getBigUint64(64, true)
      : 0n;
  const stake = stakeData ? decodeStakeRecord(stakeData) : null;
  const staked = stake && stake.vexaMint === fees.vexaMint ? stake.amount : 0n;
  const weight = vexaWeight(staked, held);
  return {
    vexaMint: fees.vexaMint,
    walletAccount: walletData ? walletAccount : null,
    stakeRecord: stake ? stakeRecord : null,
    held,
    staked,
    unlockAt: stake?.unlockAt ?? null,
    weight,
    discountBps: feeDiscountBps(fees, weight),
  };
}

/** The accounts to present to the vault for a fee discount, if any is earned. */
async function vexaDiscount(
  c: C,
  wallet: Address,
  fees: Awaited<ReturnType<typeof feeSchedule>>,
): Promise<{ accounts: Address[]; discountBps: number } | null> {
  const position = await vexaPosition(c, wallet, fees);
  if (!position || position.discountBps === 0) return null;
  const accounts = [position.stakeRecord, position.walletAccount].filter(
    (a): a is Address => a !== null,
  );
  return { accounts, discountBps: position.discountBps };
}

async function sponsorContext(
  c: C,
  kind: PlanKind,
  me: Awaited<ReturnType<typeof owner>>,
  extra: Partial<SponsorContext> = {},
): Promise<SponsorContext> {
  const { chain, vault } = c.get('deps');
  return {
    kind,
    feePayer: chain.feePayer,
    owner: me.wallet,
    ownerCusdc: me.cusdc,
    cusdcMint: vault.cusdcMint,
    usdcMint: vault.usdcMint,
    vaultConfig: vault.config,
    rent: await chain.getRentTable(),
    ...extra,
  };
}

function check(
  stages: SubmitPlanRequest['plan']['stages'],
  ctx: SponsorContext,
): CheckedTransaction[][] {
  try {
    return checkPlan(stages, ctx);
  } catch (e) {
    if (e instanceof SponsorshipRefused) {
      throw new ApiError(400, ErrorCode.PlanRefused, e.message, {
        stage: e.stage === undefined ? undefined : e.stage + 1,
        transaction: e.index,
      });
    }
    throw e;
  }
}

async function run(c: C, stages: CheckedTransaction[][]): Promise<string[]> {
  const { chain } = c.get('deps');
  try {
    return await executePlan(chain, stages, c.get('logger'));
  } catch (e) {
    if (e instanceof PlanFailed) {
      c.get('logger').warn(
        { err: e.message, logs: e.logs, signatures: e.signatures },
        'plan failed',
      );
      throw new ApiError(502, ErrorCode.ChainFailure, 'A transaction failed on-chain', {
        signatures: e.signatures,
      });
    }
    throw e;
  }
}

/** Plans the API takes as-is, with no bookkeeping beyond the signatures. */
function planRoute(kind: 'configure' | 'apply-pending' | 'stake' | 'unstake') {
  return async (c: C) => {
    const { plan } = await parseBody(c, SubmitPlanRequest);
    if (plan.kind !== kind)
      throw new ApiError(400, ErrorCode.PlanRefused, `expected a ${kind} plan`);
    const me = await owner(c);
    const extra: Partial<SponsorContext> = {};
    if (kind === 'configure') {
      // Rent is only sponsored for an account that doesn't exist yet.
      extra.sponsorAccountRent = (await c.get('deps').chain.getAccountData(me.cusdc)) === null;
    }
    if (kind === 'stake' || kind === 'unstake') {
      extra.stakeRecord = await findStakeRecord(me.wallet, c.get('deps').vault.program);
    }
    const signatures = await run(c, check(plan.stages, await sponsorContext(c, kind, me, extra)));
    return c.json({ signatures }, 201);
  };
}

/**
 * The grouped ciphertexts in a transfer's validity proof context:
 * source (32) | destination (32) | auditor (32) | grouped lo (128) | grouped hi (128)
 */
function validityContext(stages: CheckedTransaction[][]) {
  for (const stage of stages) {
    for (const tx of stage) {
      for (const ix of tx.instructions) {
        if (
          ix.program === ZK_ELGAMAL_PROOF_PROGRAM &&
          ix.data[0] === ProofType.VerifyBatchedGroupedCiphertext3HandlesValidity
        ) {
          const ctx = ix.data.subarray(1, 1 + 352);
          return {
            source: ctx.slice(0, 32),
            destination: ctx.slice(32, 64),
            auditor: ctx.slice(64, 96),
            groupedLo: ctx.slice(96, 224),
            groupedHi: ctx.slice(224, 352),
          };
        }
      }
    }
  }
  throw new ApiError(400, ErrorCode.PlanRefused, 'transfer plan has no validity proof');
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export const money = new Hono<AppBindings>()
  /** Everything a device needs to build plans: fee payer, vault accounts, rent, a blockhash. */
  .get('/chain', authenticate(), async (c) => {
    const { chain, vault, env } = c.get('deps');
    const [rent, latest, mint, fees] = await Promise.all([
      chain.getRentTable(),
      chain.getLatestBlockhash(),
      chain.getAccountData(vault.cusdcMint),
      feeSchedule(c),
    ]);
    const auditor = mint ? decodeConfidentialMint(mint)?.auditorElgamalPubkey : null;
    return c.json({
      cluster: env.SOLANA_CLUSTER,
      feePayer: chain.feePayer,
      vault: {
        program: vault.program,
        config: vault.config,
        usdcMint: vault.usdcMint,
        cusdcMint: vault.cusdcMint,
        usdcReserve: vault.usdcReserve,
        fees: vault.fees,
      },
      feeSchedule: fees && {
        feeBps: fees.feeBps,
        feeCap: fees.feeCap.toString(),
        treasury: fees.treasury,
        vexaMint: fees.vexaMint,
        tiers: fees.tiers.map((t) => ({
          minBalance: t.minBalance.toString(),
          discountBps: t.discountBps,
        })),
      },
      auditorElgamalPubkey: auditor ? base64Encode(auditor) : null,
      rent: Object.fromEntries(
        Object.entries(rent).map(([k, v]) => [k, v.toString()]),
      ) as ChainContext['rent'],
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight.toString(),
    } satisfies ChainContext);
  })

  /**
   * The user's cUSDC balance as ciphertexts. Decrypt on the device with
   * @vexa/core/crypto: `decryptPendingBalance` for pending, the AE key for
   * available. Also the fee discount their $VEXA earns, if any: the account
   * to present to the vault and the tier's discount, never the balance.
   */
  .get('/balance', authenticate(), async (c) => {
    const me = await owner(c);
    const { chain } = c.get('deps');
    const [data, fees] = await Promise.all([chain.getAccountData(me.cusdc), feeSchedule(c)]);
    const state = data ? decodeConfidentialAccount(data) : null;
    return c.json({
      cusdcAccount: me.cusdc,
      usdcAccount: me.usdc,
      feeDiscount: await vexaDiscount(c, me.wallet, fees),
      configured: state !== null,
      confidential: state && {
        pendingBalanceLo: base64Encode(state.pendingBalanceLo),
        pendingBalanceHi: base64Encode(state.pendingBalanceHi),
        availableBalance: base64Encode(state.availableBalance),
        decryptableAvailableBalance: base64Encode(state.decryptableAvailableBalance),
        pendingBalanceCreditCounter: state.pendingBalanceCreditCounter.toString(),
        maximumPendingBalanceCreditCounter: state.maximumPendingBalanceCreditCounter.toString(),
      },
    });
  })

  .post('/accounts/confidential', authenticate(), idempotent(), planRoute('configure'))
  .post('/balance/apply', authenticate(), idempotent(), planRoute('apply-pending'))

  /**
   * The user's $VEXA tier: staked and wallet $VEXA, the weight they add up to
   * (staked in full, wallet at half), and what that tier unlocks.
   */
  .get('/tier', authenticate(), async (c) => {
    const me = await owner(c);
    const position = await vexaPosition(c, me.wallet, await feeSchedule(c));
    const tier = tierFor(position?.weight ?? 0n);
    return c.json({
      vexaMint: position?.vexaMint ?? null,
      staked: (position?.staked ?? 0n).toString(),
      held: (position?.held ?? 0n).toString(),
      weight: (position?.weight ?? 0n).toString(),
      unlockAt: position?.unlockAt ? new Date(position.unlockAt * 1000).toISOString() : null,
      tier: {
        level: tier.level,
        discountBps: tier.discountBps,
        maxAgents: tier.maxAgents,
        agentDailyLimit: tier.agentDailyLimit.toString(),
      },
    });
  })
  .post('/stake', authenticate(), idempotent(), planRoute('stake'))
  .post('/unstake', authenticate(), idempotent(), planRoute('unstake'))

  .post('/deposits', authenticate(), idempotent(), async (c) => {
    const { store } = c.get('deps');
    const { plan } = await parseBody(c, SubmitPlanRequest);
    if (plan.kind !== 'deposit')
      throw new ApiError(400, ErrorCode.PlanRefused, 'expected a deposit plan');
    const me = await owner(c);
    const [signature] = await run(c, check(plan.stages, await sponsorContext(c, 'deposit', me)));
    const deposit = await store.money.recordDeposit({
      ownerId: me.userId,
      txSig: signature ?? null,
      status: 'confirmed',
    });
    await store.events.emit(me.userId, 'deposit.confirmed', {
      depositId: deposit.id,
      txSig: deposit.txSig,
    });
    return c.json({ id: deposit.id, status: deposit.status, txSig: deposit.txSig }, 201);
  })

  .post('/withdrawals', authenticate(), idempotent(), async (c) => {
    const { store, chain, vault } = c.get('deps');
    const body = await parseBody(c, WithdrawRequest);
    if (body.plan.kind !== 'withdraw')
      throw new ApiError(400, ErrorCode.PlanRefused, 'expected a withdraw plan');
    const me = await owner(c);
    const destination = address(body.destinationAccount);
    // Withdrawals go to an existing USDC token account (a wallet's USDC
    // account, an exchange deposit address). Creating one would cost Vexa
    // permanent rent, so it isn't sponsored.
    const account = await chain.getAccountData(destination);
    const isUsdcAccount =
      account !== null &&
      account.length >= 165 &&
      sameBytes(account.subarray(0, 32), getAddressEncoder().encode(vault.usdcMint) as Uint8Array);
    if (!isUsdcAccount) {
      throw new ApiError(
        400,
        ErrorCode.InvalidRequest,
        'destinationAccount must be an existing USDC token account',
      );
    }
    const signatures = await run(
      c,
      check(
        body.plan.stages,
        await sponsorContext(c, 'withdraw', me, { counterparty: destination }),
      ),
    );
    const withdrawal = await store.money.recordWithdrawal({
      ownerId: me.userId,
      destination,
      txSig: signatures.at(-1) ?? null,
      status: 'confirmed',
    });
    await store.events.emit(me.userId, 'withdrawal.sent', {
      withdrawalId: withdrawal.id,
      destination,
      txSig: withdrawal.txSig,
    });
    return c.json(
      { id: withdrawal.id, status: withdrawal.status, txSig: withdrawal.txSig, signatures },
      201,
    );
  })

  /**
   * Step 1 of a transfer: resolve the recipient. Returns the keys the device
   * encrypts to. No amount is sent, now or later.
   */
  .post('/transfers/prepare', authenticate(), idempotent(), async (c) => {
    const { store, chain, vault } = c.get('deps');
    const body = await parseBody(c, PrepareTransferRequest);
    if (body.mode === 'stealth') {
      throw new ApiError(
        400,
        ErrorCode.InvalidRequest,
        'Stealth transfers arrive with agents in the next release',
      );
    }
    const me = await owner(c);
    const parsed = validateHandle(body.to);
    const recipient = parsed.ok ? await store.handles.resolve(parsed.handle) : null;
    if (!recipient) throw notFound('Recipient');
    const recipientCusdc = await findAta(
      address(recipient.solanaPubkey),
      vault.cusdcMint,
      TOKEN_2022_PROGRAM,
    );
    if (recipientCusdc === me.cusdc)
      throw new ApiError(400, ErrorCode.InvalidRequest, 'Cannot send to yourself');

    const data = await chain.getAccountData(recipientCusdc);
    if (!data || !decodeConfidentialAccount(data)?.allowConfidentialCredits) {
      throw new ApiError(
        409,
        ErrorCode.RecipientNotReady,
        `${formatHandle(recipient.handle)} can’t receive yet`,
      );
    }
    const recipientProfileId = await recipientOwnerId(c, recipient.handle);
    const transfer = await store.money.createTransfer({
      fromOwnerId: me.userId,
      fromPubkey: me.cusdc,
      toOwnerId: recipientProfileId,
      toHandle: recipient.handle,
      toPubkey: recipientCusdc,
      mode: 'standard',
    });
    return c.json(
      {
        transferId: transfer.id,
        recipient: {
          handle: formatHandle(recipient.handle),
          solanaPubkey: recipient.solanaPubkey,
          elgamalPubkey: recipient.elgamalPubkey,
          cusdcAccount: recipientCusdc,
        },
      },
      201,
    );
  })

  /** Step 2: the signed plan. Checked, co-signed, sent; recorded as ciphertexts. */
  .post('/transfers/submit', authenticate(), idempotent(), async (c) => {
    const { store, chain, vault } = c.get('deps');
    const body = await parseBody(c, SubmitTransferRequest);
    if (body.plan.kind !== 'transfer')
      throw new ApiError(400, ErrorCode.PlanRefused, 'expected a transfer plan');
    const me = await owner(c);
    const transfer = await store.money.getTransfer(body.transferId, me.userId);
    if (!transfer) throw notFound('Transfer');
    if (transfer.status !== 'pending') {
      throw new ApiError(
        409,
        ErrorCode.TransferAlreadySubmitted,
        'This transfer was already submitted',
      );
    }

    const checked = check(
      body.plan.stages,
      await sponsorContext(c, 'transfer', me, { counterparty: address(transfer.toPubkey) }),
    );

    // Bind the ciphertexts we'll store to the real parties before sending.
    const proof = validityContext(checked);
    const recipient = transfer.toHandle ? await store.handles.resolve(transfer.toHandle) : null;
    const mint = await chain.getAccountData(vault.cusdcMint);
    const auditor =
      (mint && decodeConfidentialMint(mint)?.auditorElgamalPubkey) ?? new Uint8Array(32);
    if (
      !recipient ||
      !sameBytes(proof.source, base64Decode(me.profile.elgamalPubkey!)!) ||
      !sameBytes(proof.destination, base64Decode(recipient.elgamalPubkey)!) ||
      !sameBytes(proof.auditor, auditor)
    ) {
      throw new ApiError(
        400,
        ErrorCode.PlanRefused,
        'transfer is not encrypted to the prepared sender, recipient and auditor',
      );
    }

    await store.money.markTransferSubmitted(transfer.id);
    let signatures: string[];
    try {
      signatures = await run(c, checked);
    } catch (e) {
      const sigs =
        e instanceof ApiError ? ((e.details as { signatures?: string[] })?.signatures ?? []) : [];
      await store.money.failTransfer(transfer.id, e instanceof Error ? e.message : 'failed', sigs);
      throw e;
    }

    const settled = await store.money.settleTransfer(transfer.id, {
      ciphertext: {
        groupedLo: base64Encode(proof.groupedLo),
        groupedHi: base64Encode(proof.groupedHi),
      },
      txSig: signatures.at(-1)!,
      signatures,
      memoCiphertext: body.memoCiphertext ? base64Decode(body.memoCiphertext) : null,
    });
    const event = { transferId: settled.id, txSig: settled.txSig, ciphertext: settled.ciphertext };
    await store.events.emit(me.userId, 'transfer.settled', { ...event, direction: 'sent' });
    if (settled.toOwnerId) {
      await store.events.emit(settled.toOwnerId, 'transfer.settled', {
        ...event,
        direction: 'received',
      });
    }
    return c.json(transferJson(settled, 'sent'), 201);
  })

  /**
   * Transfers sent and received, deposits and withdrawals, newest first.
   * Transfer amounts come as grouped ciphertexts: the sender decrypts with
   * handle 0, the recipient with handle 1 (`decryptTransferAmount`).
   */
  .get('/activity', authenticate(), async (c) => {
    const { userId } = principalOf(c);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 100);
    const beforeParam = c.req.query('before');
    const before = beforeParam ? new Date(beforeParam) : undefined;
    if (before && Number.isNaN(before.getTime()))
      throw new ApiError(400, ErrorCode.InvalidRequest, 'bad `before`');
    const items = await c
      .get('deps')
      .store.money.activity(userId, { limit, ...(before ? { before } : {}) });
    return c.json({
      data: items.map((i) =>
        i.kind === 'transfer'
          ? { kind: 'transfer', ...transferJson(i.transfer, i.direction) }
          : {
              kind: i.kind,
              id: i.movement.id,
              status: i.movement.status,
              txSig: i.movement.txSig,
              ...(i.movement.destination ? { destination: i.movement.destination } : {}),
              createdAt: i.movement.createdAt.toISOString(),
            },
      ),
    });
  });

function transferJson(t: TransferRow, direction: 'sent' | 'received') {
  return {
    id: t.id,
    direction,
    mode: t.mode,
    status: t.status,
    to: t.toHandle ? formatHandle(t.toHandle) : t.toPubkey,
    fromAccount: t.fromPubkey,
    toAccount: t.toPubkey,
    ciphertext: t.ciphertext,
    memoCiphertext: t.memoCiphertext ? base64Encode(t.memoCiphertext) : null,
    txSig: t.txSig,
    createdAt: t.createdAt.toISOString(),
  };
}

async function recipientOwnerId(c: C, handle: string): Promise<string | null> {
  return c
    .get('deps')
    .store.profiles.findByHandle(handle)
    .then((p) => p?.userId ?? null);
}
