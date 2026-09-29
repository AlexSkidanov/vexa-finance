/**
 * Agents, from the owner's side: create them, set their limits, fund them,
 * pause or revoke them, and take their funds back.
 *
 * Every change is authorized with the owner's Solana key (from their passkey)
 * and checked by the NEAR policy contract, so neither the Vexa API nor the
 * agent can change a policy. Creating an agent returns a one-time
 * **credential** (`vxagent_…`) to give the agent software; the owner can
 * always re-derive it, which is how `sweep` works after a revoke.
 */
import { address, getBase64Encoder, getTransactionDecoder, type Address } from '@solana/kit';
import { AeCiphertext } from '@solana/zk-sdk';
import { base64Decode, type AgentPolicy } from '@vexa/core';
import {
  buildTransferProofs,
  decryptableZeroBalance,
  decryptPendingBalance,
  pubkeyValidityProof,
  signWithSolanaSeed,
  type UserKeys,
} from '@vexa/core/crypto';
import {
  agentApplyPendingPlan,
  agentConfigurePlan,
  agentSecret,
  agentTransferPlan,
  authorizationMessage,
  createPayload,
  deriveAgentKeys,
  encodeAgentCredential,
  encodePolicy,
  signPayload,
  type AgentAccounts,
  type AgentKeys,
  type PolicyAction,
  type PolicyTerms,
} from '@vexa/core/agent';
import { compilePlan, findAgentNonceAccount, type Plan } from '@vexa/core/solana';
import type { ChainContext } from '@vexa/core';
import type { RequestOptions } from './http.js';

type Call = <T>(method: string, path: string, opts?: RequestOptions) => Promise<T>;

export interface AgentPolicyInput {
  /** USDC base units. */
  maxPerRequest: bigint;
  /** USDC base units per rolling 24 hours. */
  dailyLimit: bigint;
  /** cUSDC accounts the agent may pay. Omit for any. */
  allowedRecipients?: string[];
  /** Domains the agent may pay for with x402. Omit for any. */
  allowedDomains?: string[];
}

export interface AgentSummary {
  id: string;
  name: string | null;
  address: string;
  cusdcAccount: string;
  nonceAccount: string;
  authority: string;
  elgamalPubkey: string;
  status: 'active' | 'paused' | 'revoked';
  policy: {
    version: number;
    maxPerRequest: string;
    dailyLimit: string;
    allowedRecipients: string[];
    allowedDomains: string[];
  };
  createdAt: string;
}

export interface AgentsConfig {
  policyContract: string;
  mpcRootKey: string;
  feePayer: string;
}

export interface AgentState {
  status: 'active' | 'paused' | 'revoked';
  authNonce: string;
  nextIndex: string;
  windowStart: string;
  window: { index: string; atMs: number; groupedLo: string | null; groupedHi: string | null }[];
  nonce: string | null;
  confidential: {
    availableBalance: string;
    decryptableAvailableBalance: string;
    pendingBalanceLo: string;
    pendingBalanceHi: string;
    pendingBalanceCreditCounter: string;
  } | null;
}

const b64 = (s: string) => base64Decode(s)!;

function toTerms(p: AgentPolicyInput): PolicyTerms {
  return {
    maxPerRequest: p.maxPerRequest,
    dailyLimit: p.dailyLimit,
    allowedRecipients: p.allowedRecipients ?? [],
    allowedDomains: p.allowedDomains ?? [],
  };
}

function toBody(p: PolicyTerms): AgentPolicy {
  return {
    maxPerRequest: p.maxPerRequest.toString(),
    dailyLimit: p.dailyLimit.toString(),
    allowedRecipients: p.allowedRecipients,
    allowedDomains: p.allowedDomains,
  };
}

export function agentAccounts(
  a: Pick<AgentSummary, 'address' | 'cusdcAccount' | 'nonceAccount'>,
): AgentAccounts {
  return {
    address: address(a.address),
    cusdc: address(a.cusdcAccount),
    nonceAccount: address(a.nonceAccount),
  };
}

/** The serialized message of the transaction labelled `label` in a compiled plan. */
export function messageOf(
  compiled: Awaited<ReturnType<typeof compilePlan>>,
  label: string,
): Uint8Array {
  for (const stage of compiled.stages) {
    for (const tx of stage) {
      if (tx.label === label)
        return new Uint8Array(
          getTransactionDecoder().decode(getBase64Encoder().encode(tx.transaction)).messageBytes,
        );
    }
  }
  throw new Error(`plan has no ${label} transaction`);
}

/**
 * Compiles an agent plan and signs the authorization for its agent-signed
 * transaction: what POST /v1/agents/{id}/configure|apply|sweep|payments take.
 */
export async function authorizeAgentPlan(input: {
  plan: Plan;
  ctx: ChainContext;
  agentsConfig: AgentsConfig;
  agentId: string;
  label: string;
  nonce: bigint;
  signer: 'agent' | 'owner';
  seed: Uint8Array;
  payment?: { index: bigint; windowStart: bigint; domain?: string };
}) {
  const compiled = await compilePlan(input.plan, {
    feePayer: address(input.ctx.feePayer),
    blockhash: input.ctx.blockhash as Parameters<typeof compilePlan>[1]['blockhash'],
    lastValidBlockHeight: BigInt(input.ctx.lastValidBlockHeight),
  });
  const message = authorizationMessage({
    contract: input.agentsConfig.policyContract,
    action: 'sign',
    agentId: input.agentId,
    nonce: input.nonce,
    payload: signPayload({ message: messageOf(compiled, input.label), ...input.payment }),
  });
  return {
    plan: compiled,
    signer: input.signer,
    nonce: input.nonce.toString(),
    signature: signWithSolanaSeed(input.seed, message),
  };
}

function rentTable(ctx: ChainContext) {
  return {
    confidentialAccount: BigInt(ctx.rent.confidentialAccount),
    equalityContext: BigInt(ctx.rent.equalityContext),
    validityContext: BigInt(ctx.rent.validityContext),
    rangeU128Context: BigInt(ctx.rent.rangeU128Context),
    rangeU64Context: BigInt(ctx.rent.rangeU64Context),
    stakeRecord: BigInt(ctx.rent.stakeRecord),
    tokenAccount: BigInt(ctx.rent.tokenAccount),
  };
}

export class Agents {
  private cachedConfig: Promise<AgentsConfig> | undefined;

  constructor(private readonly call: Call) {}

  config(): Promise<AgentsConfig> {
    this.cachedConfig ??= this.call<AgentsConfig>('GET', '/v1/agents/config');
    return this.cachedConfig;
  }

  list(): Promise<AgentSummary[]> {
    return this.call<{ data: AgentSummary[] }>('GET', '/v1/agents').then((r) => r.data);
  }

  get(
    id: string,
  ): Promise<AgentSummary & { authNonce: string | null; nextPaymentIndex: string | null }> {
    return this.call('GET', `/v1/agents/${id}`);
  }

  state(id: string): Promise<AgentState> {
    return this.call('GET', `/v1/agents/${id}/state`);
  }

  /** The keys of one of your agents, re-derived from your passkey. */
  keysFor(agentId: string, keys: UserKeys): AgentKeys {
    return deriveAgentKeys(agentId, agentSecret(keys.agentRoot, agentId));
  }

  private async ownerSigned(
    agentId: string,
    action: PolicyAction,
    payload: Uint8Array,
    keys: UserKeys,
  ) {
    const config = await this.config();
    const nonce = BigInt((await this.get(agentId)).authNonce ?? '0');
    const message = authorizationMessage({
      contract: config.policyContract,
      action,
      agentId,
      nonce,
      payload,
    });
    return {
      nonce: nonce.toString(),
      ownerSignature: signWithSolanaSeed(keys.solanaSeed, message),
    };
  }

  /**
   * Creates an agent and opens its confidential account. Returns the agent
   * and its credential: give the credential to the agent software (it's
   * shown once; you can re-derive it with `credentialFor`).
   */
  async create(
    input: { name?: string; policy: AgentPolicyInput },
    keys: UserKeys,
  ): Promise<{ agent: AgentSummary; credential: string }> {
    const id = crypto.randomUUID();
    const secret = agentSecret(keys.agentRoot, id);
    const agentKeys = deriveAgentKeys(id, secret);
    const config = await this.config();
    const policy = toTerms(input.policy);
    const nonceAccount = await findAgentNonceAccount(address(config.feePayer), id);
    const message = authorizationMessage({
      contract: config.policyContract,
      action: 'create',
      agentId: id,
      nonce: 0n,
      payload: createPayload(policy, agentKeys.authority, nonceAccount),
    });
    const agent = await this.call<AgentSummary>('POST', '/v1/agents', {
      body: {
        id,
        ...(input.name ? { name: input.name } : {}),
        authority: agentKeys.authority,
        elgamalPubkey: agentKeys.elgamalPubkey,
        policy: toBody(policy),
        ownerSignature: signWithSolanaSeed(keys.solanaSeed, message),
      },
      idempotencyKey: `agent-create:${id}`,
    });
    await this.openAccount(agent, agentKeys, keys);
    return { agent, credential: encodeAgentCredential(id, secret) };
  }

  /** The credential for one of your agents, again. */
  credentialFor(agentId: string, keys: UserKeys): string {
    return encodeAgentCredential(agentId, agentSecret(keys.agentRoot, agentId));
  }

  private async openAccount(agent: AgentSummary, agentKeys: AgentKeys, keys: UserKeys) {
    const [ctx, config, current] = await Promise.all([
      this.call<ChainContext>('GET', '/v1/chain'),
      this.config(),
      this.get(agent.id),
    ]);
    const plan = agentConfigurePlan({
      vault: vaultOf(ctx),
      feePayer: address(ctx.feePayer),
      agent: agentAccounts(agent),
      pubkeyValidityProof: pubkeyValidityProof(agentKeys.elgamal),
      decryptableZeroBalance: decryptableZeroBalance(agentKeys.ae),
      rent: rentTable(ctx),
    });
    const body = await authorizeAgentPlan({
      plan,
      ctx,
      agentsConfig: config,
      agentId: agent.id,
      label: 'fund-and-configure',
      nonce: BigInt(current.authNonce ?? '1'),
      signer: 'owner',
      seed: keys.solanaSeed,
    });
    await this.call('POST', `/v1/agents/${agent.id}/configure`, { body, idempotencyKey: true });
  }

  async updatePolicy(
    agentId: string,
    policy: AgentPolicyInput,
    keys: UserKeys,
  ): Promise<AgentSummary> {
    const terms = toTerms(policy);
    const auth = await this.ownerSigned(agentId, 'update_policy', encodePolicy(terms), keys);
    return this.call('PATCH', `/v1/agents/${agentId}/policy`, {
      body: { ...auth, policy: toBody(terms) },
      idempotencyKey: true,
    });
  }

  async pause(agentId: string, keys: UserKeys) {
    const auth = await this.ownerSigned(agentId, 'set_paused', Uint8Array.of(1), keys);
    return this.call('POST', `/v1/agents/${agentId}/pause`, {
      body: { ...auth, paused: true },
      idempotencyKey: true,
    });
  }

  async resume(agentId: string, keys: UserKeys) {
    const auth = await this.ownerSigned(agentId, 'set_paused', Uint8Array.of(0), keys);
    return this.call('POST', `/v1/agents/${agentId}/pause`, {
      body: { ...auth, paused: false },
      idempotencyKey: true,
    });
  }

  /** Revokes the agent for good. Its funds can still be swept back with `sweep`. */
  async revoke(agentId: string, keys: UserKeys) {
    const auth = await this.ownerSigned(agentId, 'revoke_policy', new Uint8Array(0), keys);
    return this.call('POST', `/v1/agents/${agentId}/revoke`, { body: auth, idempotencyKey: true });
  }

  traces(agentId: string, opts: { requestId?: string; limit?: number } = {}) {
    const q = new URLSearchParams();
    if (opts.requestId) q.set('requestId', opts.requestId);
    if (opts.limit) q.set('limit', String(opts.limit));
    return this.call<{ data: unknown[] }>('GET', `/v1/agents/${agentId}/traces?${q}`).then(
      (r) => r.data,
    );
  }

  /**
   * Sends everything the agent holds back to you, applying anything pending
   * first. Works for paused and revoked agents. Returns what was swept.
   */
  async sweep(agentId: string, keys: UserKeys): Promise<{ amount: bigint; signatures: string[] }> {
    const agentKeys = this.keysFor(agentId, keys);
    const [agent, config] = await Promise.all([this.get(agentId), this.config()]);
    let state = await this.state(agentId);
    if (!state.confidential) return { amount: 0n, signatures: [] };

    const ae = (s: NonNullable<AgentState['confidential']>) =>
      AeCiphertext.fromBytes(b64(s.decryptableAvailableBalance))?.decrypt(agentKeys.ae) ?? 0n;
    if (state.confidential.pendingBalanceCreditCounter !== '0') {
      const pending = decryptPendingBalance(
        agentKeys.elgamal.secret(),
        b64(state.confidential.pendingBalanceLo),
        b64(state.confidential.pendingBalanceHi),
      );
      const ctx = await this.call<ChainContext>('GET', '/v1/chain');
      const body = await authorizeAgentPlan({
        plan: agentApplyPendingPlan({
          agent: agentAccounts(agent),
          expectedPendingBalanceCreditCounter: BigInt(
            state.confidential.pendingBalanceCreditCounter,
          ),
          newDecryptableAvailableBalance: agentKeys.ae
            .encrypt(ae(state.confidential) + pending)
            .toBytes(),
        }),
        ctx,
        agentsConfig: config,
        agentId,
        label: 'apply-pending',
        nonce: BigInt(state.authNonce),
        signer: 'owner',
        seed: keys.solanaSeed,
      });
      await this.call('POST', `/v1/agents/${agentId}/apply`, { body, idempotencyKey: true });
      state = await this.state(agentId);
    }

    const confidential = state.confidential!;
    const amount = ae(confidential);
    if (amount === 0n) return { amount, signatures: [] };
    const ctx = await this.call<ChainContext>('GET', '/v1/chain');
    const proofs = buildTransferProofs({
      elgamal: agentKeys.elgamal,
      ae: agentKeys.ae,
      availableBalance: b64(confidential.availableBalance),
      decryptableAvailableBalance: b64(confidential.decryptableAvailableBalance),
      amount,
      destinationElgamalPubkey: keys.elgamal.pubkey().toBytes(),
      auditorElgamalPubkey: ctx.auditorElgamalPubkey ? b64(ctx.auditorElgamalPubkey) : null,
    });
    const me = await this.call<{ cusdcAccount: string }>('GET', '/v1/balance');
    const plan = await agentTransferPlan({
      vault: vaultOf(ctx),
      feePayer: address(ctx.feePayer),
      agent: agentAccounts(agent),
      nonce: state.nonce!,
      destinationToken: address(me.cusdcAccount) as Address,
      sweep: true,
      proofs: {
        equality: proofs.equalityProof,
        validity: proofs.ciphertextValidityProof,
        range: proofs.rangeProof,
        newDecryptableBalance: proofs.newDecryptableAvailableBalance,
        auditorCiphertextLo: proofs.auditorCiphertextLo,
        auditorCiphertextHi: proofs.auditorCiphertextHi,
      },
      rent: rentTable(ctx),
    });
    const body = await authorizeAgentPlan({
      plan,
      ctx,
      agentsConfig: config,
      agentId,
      label: 'agent-transfer',
      nonce: BigInt(state.authNonce),
      signer: 'owner',
      seed: keys.solanaSeed,
    });
    const { signatures } = await this.call<{ signatures: string[] }>(
      'POST',
      `/v1/agents/${agentId}/sweep`,
      {
        body,
        idempotencyKey: true,
      },
    );
    return { amount, signatures };
  }
}

export function vaultOf(ctx: ChainContext) {
  if (!ctx.feeSchedule) throw new Error('the vault has no fee schedule yet');
  return {
    program: address(ctx.vault.program),
    config: address(ctx.vault.config),
    usdcMint: address(ctx.vault.usdcMint),
    cusdcMint: address(ctx.vault.cusdcMint),
    usdcReserve: address(ctx.vault.usdcReserve),
    fees: address(ctx.vault.fees),
    treasury: address(ctx.feeSchedule.treasury),
  };
}

export { rentTable as agentRentTable };
