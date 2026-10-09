/**
 * Agents: sub-accounts an owner hands to software, such as an AI agent paying
 * for APIs, with spend limits enforced by the NEAR policy contract.
 *
 * The API relays. Policy changes carry the owner's signature (their Solana
 * key) and payments the agent's (its authority key); the contract checks them
 * and asks NEAR's MPC network to sign the agent's Solana transaction. The API
 * co-signs as fee payer under the same sponsorship policy as any user plan,
 * with the agent's address as the owner.
 *
 * Amounts: an agent's payments are confidential transfers like any other.
 * The API sees ciphertexts, proofs and signatures; the policy contract checks
 * the limits on commitments. Limits themselves are public configuration.
 */
import { Hono, type Context } from 'hono';
import { address, type Address, type SignatureBytes } from '@solana/kit';
import type { z } from 'zod';
import {
  type AgentPolicy,
  AgentPaymentRequest,
  AgentPlanRequest,
  AgentTraceRequest,
  base64Decode,
  base64Encode,
  CreateAgentRequest,
  ErrorCode,
  RevokeAgentRequest,
  SetAgentPausedRequest,
  tierFor,
  UpdateAgentPolicyRequest,
} from '@vexa/core';
import {
  createAgentNonceInstructions,
  decodeConfidentialAccount,
  decodeNonceAccount,
  findAgentNonceAccount,
  findAta,
  NONCE_ACCOUNT_LEN,
  TOKEN_2022_PROGRAM,
  ZK_ELGAMAL_PROOF_PROGRAM,
  ProofType,
  type PlanKind,
  type StepLabel,
} from '@vexa/core/solana';
import type { PolicyTerms } from '@vexa/core/agent';
import { ApiError, notFound } from '../errors.js';
import type { AppBindings } from '../context.js';
import type { AgentRow } from '../store/types.js';
import { authenticate, principalOf } from '../middleware/auth.js';
import { idempotent } from '../middleware/idempotency.js';
import { parseBody } from '../lib/validate.js';
import { readFeeSchedule, readVexaPosition } from '../lib/tier.js';
import { checkPlan, SponsorshipRefused, type CheckedTransaction } from '../chain/sponsor.js';
import { executePlan, PlanFailed } from '../chain/execute.js';
import { PolicyRefused, type PolicyContract, type SignRequest } from '../agents/policy.js';

type C = Context<AppBindings>;

function policyContract(c: C): PolicyContract {
  const policy = c.get('deps').policy;
  if (!policy) throw notFound('Agents');
  return policy;
}

function terms(p: z.output<typeof AgentPolicy>): PolicyTerms {
  return {
    maxPerRequest: BigInt(p.maxPerRequest),
    dailyLimit: BigInt(p.dailyLimit),
    allowedRecipients: p.allowedRecipients,
    allowedDomains: p.allowedDomains,
  };
}

async function ownerOf(c: C) {
  const { store } = c.get('deps');
  const { userId } = principalOf(c);
  const profile = await store.profiles.get(userId);
  if (!profile?.solanaPubkey || !profile.elgamalPubkey)
    throw new ApiError(400, ErrorCode.ProfileIncomplete, 'Claim a handle before creating agents');
  return { userId, wallet: address(profile.solanaPubkey) };
}

async function agentOf(c: C, id: string): Promise<AgentRow> {
  const { userId } = principalOf(c);
  const agent = await c.get('deps').store.agents.get(userId, id);
  if (!agent) throw notFound('Agent');
  return agent;
}

/** The owner's $VEXA tier, which caps how many agents and how much they spend. */
async function tierOf(c: C, wallet: Address) {
  const deps = c.get('deps');
  const position = await readVexaPosition(deps, wallet, await readFeeSchedule(deps));
  return tierFor(position?.weight ?? 0n);
}

async function withinTier(c: C, wallet: Address, dailyLimit: bigint, adding: boolean) {
  const tier = await tierOf(c, wallet);
  if (dailyLimit > tier.agentDailyLimit) {
    throw new ApiError(
      403,
      ErrorCode.AgentLimitReached,
      `Your tier allows agents up to ${tier.agentDailyLimit} USDC base units a day`,
      { tier: tier.level, agentDailyLimit: tier.agentDailyLimit.toString() },
    );
  }
  if (adding) {
    const live = await c.get('deps').store.agents.countLive(principalOf(c).userId);
    if (live >= tier.maxAgents) {
      throw new ApiError(
        403,
        ErrorCode.AgentLimitReached,
        `Your tier allows ${tier.maxAgents} agents`,
        {
          tier: tier.level,
          maxAgents: tier.maxAgents,
        },
      );
    }
  }
}

function refused(e: unknown): never {
  if (e instanceof PolicyRefused)
    throw new ApiError(403, ErrorCode.PolicyRefused, `${e.code}: ${e.message}`, { rule: e.code });
  throw e;
}

function view(agent: AgentRow) {
  return {
    id: agent.id,
    name: agent.name,
    address: agent.solanaPubkey,
    cusdcAccount: agent.cusdcAccount,
    nonceAccount: agent.nonceAccount,
    authority: agent.authority,
    elgamalPubkey: agent.elgamalPubkey,
    status: agent.status,
    policy: {
      version: agent.policy.version,
      maxPerRequest: agent.policy.maxPerRequest.toString(),
      dailyLimit: agent.policy.dailyLimit.toString(),
      allowedRecipients: agent.policy.allowedRecipients,
      allowedDomains: agent.policy.allowedDomains,
    },
    createdAt: agent.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Running agent plans
// ---------------------------------------------------------------------------

/** The transaction in each agent plan that the agent itself signs. */
const AGENT_SIGNED: Partial<Record<PlanKind, StepLabel>> = {
  'agent-configure': 'fund-and-configure',
  'agent-apply-pending': 'apply-pending',
  'agent-payment': 'agent-transfer',
  'agent-sweep': 'agent-transfer',
};

async function checkAgentPlan(
  c: C,
  agent: AgentRow,
  body: { plan: { kind: string; stages: { label: string; transaction: string }[][] } },
  kind: PlanKind,
  extra: { counterparty?: Address; sponsorAccountRent?: boolean } = {},
): Promise<CheckedTransaction[][]> {
  const { chain, vault } = c.get('deps');
  if (body.plan.kind !== kind)
    throw new ApiError(400, ErrorCode.PlanRefused, `expected an ${kind} plan`);
  try {
    return checkPlan(body.plan.stages, {
      kind,
      feePayer: chain.feePayer,
      owner: address(agent.solanaPubkey),
      ownerCusdc: address(agent.cusdcAccount),
      cusdcMint: vault.cusdcMint,
      usdcMint: vault.usdcMint,
      vaultConfig: vault.config,
      rent: await chain.getRentTable(),
      nonceAccount: address(agent.nonceAccount),
      ...extra,
    });
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

/**
 * Sends an agent plan. Right before the stage holding the agent-signed
 * transaction, the policy contract is asked for the agent's signature; if it
 * refuses, the plan's proof contexts are closed and the refusal returned.
 */
async function runAgentPlan(
  c: C,
  agent: AgentRow,
  kind: PlanKind,
  stages: CheckedTransaction[][],
  request: Omit<SignRequest, 'agentId' | 'message'>,
): Promise<string[]> {
  const { chain, logger } = c.get('deps');
  const policy = policyContract(c);
  const label = AGENT_SIGNED[kind]!;
  const agentAddress = address(agent.solanaPubkey);
  try {
    return await executePlan(chain, stages, logger, {
      async beforeStage(_, stage) {
        const step = stage.find((t) => t.label === label);
        if (!step) return;
        const signature = await policy.requestSignature({
          ...request,
          agentId: agent.id,
          message: new Uint8Array(step.transaction.messageBytes),
        });
        step.transaction = {
          ...step.transaction,
          signatures: {
            ...step.transaction.signatures,
            [agentAddress]: signature as SignatureBytes,
          },
        };
      },
    });
  } catch (e) {
    if (e instanceof PlanFailed) {
      logger.warn({ err: e.message, logs: e.logs, agentId: agent.id }, 'agent plan failed');
      throw new ApiError(502, ErrorCode.ChainFailure, 'A transaction failed on-chain', {
        signatures: e.signatures,
      });
    }
    return refused(e);
  }
}

/** The grouped ciphertexts from an agent payment's validity context. */
function groupedCiphertexts(validityContext: Uint8Array) {
  // proof type (1) | three pubkeys (96) | grouped lo (128) | grouped hi (128)
  if (
    validityContext.length !== 353 ||
    validityContext[0] !== ProofType.VerifyBatchedGroupedCiphertext3HandlesValidity
  )
    throw new ApiError(
      400,
      ErrorCode.InvalidRequest,
      'validityContext is not a validity proof context',
    );
  return {
    groupedLo: base64Encode(validityContext.subarray(97, 225)),
    groupedHi: base64Encode(validityContext.subarray(225, 353)),
  };
}

/** The validity proof inside a checked plan must be the one described to the policy contract. */
function sameValidityProof(stages: CheckedTransaction[][], validityContext: Uint8Array): boolean {
  for (const stage of stages) {
    for (const tx of stage) {
      for (const ix of tx.instructions) {
        if (
          ix.program === ZK_ELGAMAL_PROOF_PROGRAM &&
          ix.data[0] === ProofType.VerifyBatchedGroupedCiphertext3HandlesValidity
        ) {
          const ctx = ix.data.subarray(1, 353);
          return ctx.every((b, i) => b === validityContext[i + 1]);
        }
      }
    }
  }
  return false;
}

export const agents = new Hono<AppBindings>()
  /** What a device needs to derive agent addresses and authorizations. */
  .get('/config', authenticate(), async (c) => {
    const policy = policyContract(c);
    return c.json({
      policyContract: policy.contractId,
      mpcRootKey: await policy.mpcRoot(),
      feePayer: c.get('deps').chain.feePayer,
    });
  })

  .post('/', authenticate(), idempotent(), async (c) => {
    const { store, chain, vault } = c.get('deps');
    const policy = policyContract(c);
    const body = await parseBody(c, CreateAgentRequest);
    const me = await ownerOf(c);
    const policyTerms = terms(body.policy);
    await withinTier(c, me.wallet, policyTerms.dailyLimit, true);

    const agentAddress = address(await policy.agentAddress(body.id));
    const [cusdc, nonceAccount] = await Promise.all([
      findAta(agentAddress, vault.cusdcMint, TOKEN_2022_PROGRAM),
      findAgentNonceAccount(chain.feePayer, body.id),
    ]);

    // The durable nonce the agent's payments use. Sponsored, once per agent.
    if (!(await chain.getAccountData(nonceAccount))) {
      const rent = await chain.getMinimumBalance(NONCE_ACCOUNT_LEN);
      await chain.sendAsFeePayer(
        await createAgentNonceInstructions({
          feePayer: chain.feePayerSigner,
          agentId: body.id,
          agent: agentAddress,
          lamports: rent,
        }),
      );
    }
    await policy
      .createPolicy({
        agentId: body.id,
        owner: me.wallet,
        authority: body.authority,
        nonceAccount,
        policy: policyTerms,
        signature: body.ownerSignature,
      })
      .catch(refused);

    const agent = await store.agents.create({
      id: body.id,
      ownerId: me.userId,
      name: body.name ?? null,
      solanaPubkey: agentAddress,
      cusdcAccount: cusdc,
      nonceAccount,
      authority: body.authority,
      elgamalPubkey: body.elgamalPubkey,
      policy: { ...policyTerms },
    });
    return c.json(view(agent), 201);
  })

  .get('/', authenticate(), async (c) => {
    const list = await c.get('deps').store.agents.list(principalOf(c).userId);
    return c.json({ data: list.map(view) });
  })

  /** The agent as stored, plus what the policy contract says right now. */
  .get('/:id', authenticate(), async (c) => {
    const agent = await agentOf(c, c.req.param('id'));
    const onChain = await policyContract(c).getAgent(agent.id);
    return c.json({
      ...view(agent),
      authNonce: onChain?.authNonce.toString() ?? null,
      nextPaymentIndex: onChain?.nextIndex.toString() ?? null,
    });
  })

  .patch('/:id/policy', authenticate(), idempotent(), async (c) => {
    const { store } = c.get('deps');
    const agent = await agentOf(c, c.req.param('id'));
    const body = await parseBody(c, UpdateAgentPolicyRequest);
    const me = await ownerOf(c);
    const policyTerms = terms(body.policy);
    await withinTier(c, me.wallet, policyTerms.dailyLimit, false);
    await policyContract(c)
      .updatePolicy({
        agentId: agent.id,
        policy: policyTerms,
        nonce: BigInt(body.nonce),
        signature: body.ownerSignature,
      })
      .catch(refused);
    await store.agents.setPolicy(agent.id, policyTerms);
    return c.json(view((await store.agents.get(me.userId, agent.id))!));
  })

  .post('/:id/pause', authenticate(), idempotent(), async (c) => {
    const agent = await agentOf(c, c.req.param('id'));
    const body = await parseBody(c, SetAgentPausedRequest);
    await policyContract(c)
      .setPaused({
        agentId: agent.id,
        paused: body.paused,
        nonce: BigInt(body.nonce),
        signature: body.ownerSignature,
      })
      .catch(refused);
    await c.get('deps').store.agents.setStatus(agent.id, body.paused ? 'paused' : 'active');
    return c.json({ id: agent.id, status: body.paused ? 'paused' : 'active' });
  })

  .post('/:id/revoke', authenticate(), idempotent(), async (c) => {
    const agent = await agentOf(c, c.req.param('id'));
    const body = await parseBody(c, RevokeAgentRequest);
    await policyContract(c)
      .revoke({ agentId: agent.id, nonce: BigInt(body.nonce), signature: body.ownerSignature })
      .catch(refused);
    await c.get('deps').store.agents.setStatus(agent.id, 'revoked');
    return c.json({ id: agent.id, status: 'revoked' });
  })

  /** Opens the agent's confidential account. Vexa sponsors its rent, once. */
  .post('/:id/configure', authenticate(), idempotent(), async (c) => {
    const agent = await agentOf(c, c.req.param('id'));
    const body = await parseBody(c, AgentPlanRequest);
    const missing =
      (await c.get('deps').chain.getAccountData(address(agent.cusdcAccount))) === null;
    const stages = await checkAgentPlan(c, agent, body, 'agent-configure', {
      sponsorAccountRent: missing,
    });
    const signatures = await runAgentPlan(c, agent, 'agent-configure', stages, {
      signer: body.signer,
      nonce: BigInt(body.nonce),
      signature: body.signature,
    });
    return c.json({ signatures }, 201);
  })

  /** Makes funds sent to the agent spendable. */
  .post('/:id/apply', authenticate(), idempotent(), async (c) => {
    const agent = await agentOf(c, c.req.param('id'));
    const body = await parseBody(c, AgentPlanRequest);
    const stages = await checkAgentPlan(c, agent, body, 'agent-apply-pending');
    const signatures = await runAgentPlan(c, agent, 'agent-apply-pending', stages, {
      signer: body.signer,
      nonce: BigInt(body.nonce),
      signature: body.signature,
    });
    return c.json({ signatures }, 201);
  })

  /**
   * Everything the agent's device needs to build its next payment: its
   * balance ciphertexts, the durable nonce, the next payment index, and the
   * payments in its 24-hour window (as ciphertexts, which it decrypts).
   */
  .get('/:id/state', authenticate(), async (c) => {
    const { chain, store } = c.get('deps');
    const agent = await agentOf(c, c.req.param('id'));
    const onChain = await policyContract(c).getAgent(agent.id);
    if (!onChain) throw notFound('Agent policy');
    const [account, nonce] = await Promise.all([
      chain.getAccountData(address(agent.cusdcAccount)),
      chain.getAccountData(address(agent.nonceAccount)),
    ]);
    const state = account ? decodeConfidentialAccount(account) : null;
    const now = Date.now();
    const live = onChain.window.filter((w) => w.atMs + 24 * 60 * 60 * 1000 > now);
    const windowStart = live.length ? live[0]!.index : onChain.nextIndex;
    const payments = await store.money.agentPayments(agent.id, Number(windowStart));
    return c.json({
      status: onChain.status.toLowerCase(),
      authNonce: onChain.authNonce.toString(),
      nextIndex: onChain.nextIndex.toString(),
      windowStart: windowStart.toString(),
      window: live.map((w) => {
        const p = payments.find((x) => BigInt(x.index) === w.index);
        return {
          index: w.index.toString(),
          atMs: w.atMs,
          groupedLo: p?.transfer.ciphertext.groupedLo ?? null,
          groupedHi: p?.transfer.ciphertext.groupedHi ?? null,
        };
      }),
      nonce: nonce ? (decodeNonceAccount(nonce)?.nonce ?? null) : null,
      confidential: state && {
        availableBalance: base64Encode(state.availableBalance),
        decryptableAvailableBalance: base64Encode(state.decryptableAvailableBalance),
        pendingBalanceLo: base64Encode(state.pendingBalanceLo),
        pendingBalanceHi: base64Encode(state.pendingBalanceHi),
        pendingBalanceCreditCounter: state.pendingBalanceCreditCounter.toString(),
      },
    });
  })

  /** A payment, prepared with POST /v1/transfers/prepare { agentId }. */
  .post('/:id/payments', authenticate(), idempotent(), async (c) => {
    const { store } = c.get('deps');
    const agent = await agentOf(c, c.req.param('id'));
    const body = await parseBody(c, AgentPaymentRequest);
    const transfer = await store.money.getTransfer(body.transferId, principalOf(c).userId);
    if (!transfer || transfer.fromAgentId !== agent.id) throw notFound('Transfer');
    if (transfer.status !== 'pending')
      throw new ApiError(
        409,
        ErrorCode.TransferAlreadySubmitted,
        'This transfer was already submitted',
      );

    const validityContext = base64Decode(body.validityContext)!;
    const limitContext = base64Decode(body.limitContext)!;
    const stages = await checkAgentPlan(c, agent, body, 'agent-payment', {
      counterparty: address(transfer.toPubkey),
    });
    if (!sameValidityProof(stages, validityContext))
      throw new ApiError(
        400,
        ErrorCode.PlanRefused,
        'validityContext is not the plan’s validity proof',
      );

    await store.money.markTransferSubmitted(transfer.id);
    let signatures: string[];
    try {
      signatures = await runAgentPlan(c, agent, 'agent-payment', stages, {
        signer: body.signer,
        nonce: BigInt(body.nonce),
        signature: body.signature,
        validityContext,
        limitContext,
        index: BigInt(body.index),
        windowStart: BigInt(body.windowStart),
        domain: body.domain,
      });
    } catch (e) {
      await store.money.failTransfer(
        transfer.id,
        e instanceof ApiError ? e.message : 'failed',
        e instanceof ApiError
          ? ((e.details as { signatures?: string[] } | undefined)?.signatures ?? [])
          : [],
      );
      throw e;
    }
    const settled = await store.money.settleTransfer(transfer.id, {
      ciphertext: groupedCiphertexts(validityContext),
      txSig: signatures[signatures.length - 1]!,
      signatures,
      memoCiphertext: body.memoCiphertext ? base64Decode(body.memoCiphertext) : null,
    });
    await store.money.recordAgentPayment({
      transferId: transfer.id,
      agentId: agent.id,
      index: Number(body.index),
    });
    const event = { transferId: settled.id, txSig: settled.txSig, agentId: agent.id };
    await store.events.emit(principalOf(c).userId, 'transfer.settled', {
      ...event,
      direction: 'sent',
    });
    if (settled.toOwnerId && settled.toOwnerId !== principalOf(c).userId)
      await store.events.emit(settled.toOwnerId, 'transfer.settled', {
        ...event,
        direction: 'received',
      });
    return c.json({ id: settled.id, txSig: settled.txSig, signatures }, 201);
  })

  /** Sends the agent's funds back to its owner: allowed even when paused or revoked. */
  .post('/:id/sweep', authenticate(), idempotent(), async (c) => {
    const { vault } = c.get('deps');
    const agent = await agentOf(c, c.req.param('id'));
    const body = await parseBody(c, AgentPlanRequest);
    const me = await ownerOf(c);
    const ownerCusdc = await findAta(me.wallet, vault.cusdcMint, TOKEN_2022_PROGRAM);
    const stages = await checkAgentPlan(c, agent, body, 'agent-sweep', {
      counterparty: ownerCusdc,
    });
    const signatures = await runAgentPlan(c, agent, 'agent-sweep', stages, {
      signer: body.signer,
      nonce: BigInt(body.nonce),
      signature: body.signature,
    });
    return c.json({ signatures }, 201);
  })

  .get('/:id/activity', authenticate(), async (c) => {
    const { store } = c.get('deps');
    const agent = await agentOf(c, c.req.param('id'));
    const payments = await store.money.agentPayments(agent.id, 0);
    return c.json({
      data: payments.reverse().map(({ index, transfer }) => ({
        id: transfer.id,
        index,
        to: transfer.toHandle ? `@${transfer.toHandle}.vexa` : transfer.toPubkey,
        status: transfer.status,
        txSig: transfer.txSig,
        ciphertext: transfer.ciphertext,
        createdAt: transfer.createdAt.toISOString(),
      })),
    });
  })

  /** Records a step the agent took, for the owner's live trace view. */
  .post('/:id/traces', authenticate(), idempotent(), async (c) => {
    const agent = await agentOf(c, c.req.param('id'));
    const body = await parseBody(c, AgentTraceRequest);
    const trace = await c.get('deps').store.agents.trace({
      agentId: agent.id,
      ownerId: agent.ownerId,
      requestId: body.requestId ?? null,
      step: body.step,
      detail: body.detail,
    });
    return c.json({ ...trace, createdAt: trace.createdAt.toISOString() }, 201);
  })

  .get('/:id/traces', authenticate(), async (c) => {
    const agent = await agentOf(c, c.req.param('id'));
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 500);
    const traces = await c.get('deps').store.agents.traces(agent.id, {
      limit,
      requestId: c.req.query('requestId') ?? undefined,
    });
    return c.json({ data: traces.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })) });
  });
