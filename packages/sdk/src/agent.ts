/**
 * The client an agent runs.
 *
 *   const agent = new VexaAgent({ apiKey: process.env.VEXA_API_KEY, credential: process.env.VEXA_AGENT });
 *   await agent.pay({ to: '@shop.vexa', amount: 2_500_000n });
 *   const res = await agent.fetch('https://api.example.com/paid');   // x402: pays when asked
 *
 * The API key is the owner's; the credential is the agent's (from
 * `vexa.agents.create`). Payments are confidential transfers whose proofs,
 * including the proof that the amount fits the agent's limits, are built
 * here. The NEAR policy contract checks them before the MPC network signs.
 * Neither Vexa nor NEAR ever sees an amount.
 */
import { address } from '@solana/kit';
import { AeCiphertext } from '@solana/zk-sdk';
import { base64Decode, base64Encode, type ChainContext } from '@vexa/core';
import { decryptPendingBalance, decryptTransferAmount, encryptMemo } from '@vexa/core/crypto';
import {
  agentApplyPendingPlan,
  agentTransferPlan,
  buildAgentPaymentProofs,
  decodeAgentCredential,
  type AgentKeys,
} from '@vexa/core/agent';
import { request, type HttpOptions, type RequestOptions } from './http.js';
import {
  agentAccounts,
  agentRentTable,
  authorizeAgentPlan,
  vaultOf,
  type AgentState,
  type AgentSummary,
  type AgentsConfig,
} from './agents.js';
import { DEFAULT_BASE_URLS } from './base-urls.js';
import { apiKeyEnvironment } from '@vexa/core';

const b64 = (s: string) => base64Decode(s)!;

export interface VexaAgentOptions {
  /** The owner's `vx_live_…` API key. */
  apiKey?: string;
  /** Or a session access token of the owner (apps acting for a signed-in user). */
  accessToken?: string;
  /** The agent's `vxagent_…` credential. */
  credential: string;
  baseUrl?: string;
  maxRetries?: number;
  fetch?: typeof fetch;
}

export interface PaymentResult {
  id: string;
  txSig: string;
  signatures: string[];
}

type TraceStep =
  | 'request'
  | 'payment_required'
  | 'quote'
  | 'policy_check'
  | 'paid'
  | 'retried'
  | 'completed'
  | 'failed';

/** An x402 payment requirement, as a server lists it in a 402 response's `accepts`. */
export interface PaymentRequirements {
  scheme: string;
  network: string;
  /** Base units of `asset`. */
  maxAmountRequired: string;
  resource: string;
  description?: string;
  /** For the `vexa` scheme: the recipient's handle, e.g. `@shop.vexa`. */
  payTo: string;
  asset: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

/** The scheme Vexa agents pay with: a confidential cUSDC transfer to a handle. */
export const X402_SCHEME = 'vexa';
export const X402_NETWORK = 'solana';

export class VexaAgent {
  readonly keys: AgentKeys;
  readonly agentId: string;
  private readonly http: HttpOptions;
  private readonly rawFetch: typeof fetch;
  private cachedConfig: Promise<AgentsConfig> | undefined;

  constructor(options: VexaAgentOptions) {
    const env = options.apiKey ? apiKeyEnvironment(options.apiKey) : 'live';
    if (!env) throw new Error('apiKey must look like vx_live_… or vx_test_…');
    if (!options.apiKey && !options.accessToken) throw new Error('pass an apiKey or accessToken');
    this.keys = decodeAgentCredential(options.credential);
    this.agentId = this.keys.agentId;
    this.rawFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.http = {
      baseUrl: (options.baseUrl ?? DEFAULT_BASE_URLS[env]).replace(/\/$/, ''),
      getToken: () => options.apiKey ?? options.accessToken,
      fetch: this.rawFetch,
      maxRetries: options.maxRetries ?? 2,
    };
  }

  private async call<T>(method: string, path: string, opts?: RequestOptions): Promise<T> {
    return (await request<T>(this.http, method, path, opts)).data;
  }

  private config(): Promise<AgentsConfig> {
    this.cachedConfig ??= this.call<AgentsConfig>('GET', '/v1/agents/config');
    return this.cachedConfig;
  }

  info(): Promise<AgentSummary & { authNonce: string | null; nextPaymentIndex: string | null }> {
    return this.call('GET', `/v1/agents/${this.agentId}`);
  }

  private state(): Promise<AgentState> {
    return this.call('GET', `/v1/agents/${this.agentId}/state`);
  }

  /** The agent's balance, decrypted here. USDC base units. */
  async balance(): Promise<{ available: bigint; pending: bigint }> {
    return this.decrypt(await this.state());
  }

  private decrypt(state: AgentState): { available: bigint; pending: bigint } {
    const c = state.confidential;
    if (!c) return { available: 0n, pending: 0n };
    const ae = AeCiphertext.fromBytes(b64(c.decryptableAvailableBalance));
    const available = ae?.decrypt(this.keys.ae) ?? 0n;
    ae?.free();
    const pending = decryptPendingBalance(
      this.keys.elgamal.secret(),
      b64(c.pendingBalanceLo),
      b64(c.pendingBalanceHi),
    );
    return { available, pending };
  }

  /** Makes funds sent to the agent spendable. */
  async applyPending(): Promise<{ signatures: string[] }> {
    const state = await this.state();
    if (!state.confidential || state.confidential.pendingBalanceCreditCounter === '0')
      return { signatures: [] };
    const { available, pending } = this.decrypt(state);
    const [ctx, config, agent] = await Promise.all([this.chain(), this.config(), this.info()]);
    const body = await authorizeAgentPlan({
      plan: agentApplyPendingPlan({
        agent: agentAccounts(agent),
        expectedPendingBalanceCreditCounter: BigInt(state.confidential.pendingBalanceCreditCounter),
        newDecryptableAvailableBalance: this.keys.ae.encrypt(available + pending).toBytes(),
      }),
      ctx,
      agentsConfig: config,
      agentId: this.agentId,
      label: 'apply-pending',
      nonce: BigInt(state.authNonce),
      signer: 'agent',
      seed: this.keys.authoritySeed,
    });
    return this.call('POST', `/v1/agents/${this.agentId}/apply`, { body, idempotencyKey: true });
  }

  private chain(): Promise<ChainContext> {
    return this.call<ChainContext>('GET', '/v1/chain');
  }

  /** Logs a step for the owner's live trace view. Details must never include an amount. */
  async trace(
    step: TraceStep,
    detail: Record<string, string | number | boolean | null> = {},
    requestId?: string,
  ) {
    await this.call('POST', `/v1/agents/${this.agentId}/traces`, {
      body: { step, detail, ...(requestId ? { requestId } : {}) },
      idempotencyKey: true,
    }).catch(() => undefined);
  }

  /**
   * Pays a handle, confidentially. The amount must fit the agent's
   * per-payment limit and what's left of its daily limit; this checks both
   * before proving, and the policy contract checks them again on the proof.
   */
  async pay(input: {
    to: string;
    amount: bigint;
    memo?: string;
    /** For x402: the domain being paid for, checked against the policy's allowed domains. */
    domain?: string;
    idempotencyKey?: string;
  }): Promise<PaymentResult> {
    let state = await this.state();
    let balance = this.decrypt(state);
    if (balance.available < input.amount && balance.available + balance.pending >= input.amount) {
      await this.applyPending();
      state = await this.state();
      balance = this.decrypt(state);
    }
    if (balance.available < input.amount) throw new Error('insufficient agent balance');
    if (state.status !== 'active') throw new Error(`the agent is ${state.status}`);

    const prepared = await this.call<{
      transferId: string;
      recipient: { handle: string | null; elgamalPubkey: string; cusdcAccount: string };
    }>('POST', '/v1/transfers/prepare', {
      body: { to: input.to, agentId: this.agentId },
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:prepare` : true,
    });
    const [ctx, config, agent] = await Promise.all([this.chain(), this.config(), this.info()]);

    // The last 24 hours of payments: their indices and (decrypted here) amounts.
    const window = state.window.filter((w) => BigInt(w.index) >= BigInt(state.windowStart));
    let spent = 0n;
    for (const w of window) {
      if (!w.groupedLo || !w.groupedHi)
        throw new Error(`payment ${w.index} isn't recorded yet; try again shortly`);
      spent += decryptTransferAmount(
        this.keys.elgamal.secret(),
        b64(w.groupedLo),
        b64(w.groupedHi),
        0,
      );
    }
    const index = BigInt(state.nextIndex);
    const windowStart = BigInt(state.windowStart);
    const c = state.confidential!;
    const proofs = buildAgentPaymentProofs({
      elgamalSecret: this.keys.elgamalSecret,
      aeKey: this.keys.aeBytes,
      availableBalance: b64(c.availableBalance),
      decryptableAvailableBalance: b64(c.decryptableAvailableBalance),
      amount: input.amount,
      destinationElgamalPubkey: b64(prepared.recipient.elgamalPubkey),
      auditorElgamalPubkey: ctx.auditorElgamalPubkey ? b64(ctx.auditorElgamalPubkey) : null,
      openingSeed: this.keys.openingSeed,
      index,
      maxPerRequest: BigInt(agent.policy.maxPerRequest),
      dailyLimit: BigInt(agent.policy.dailyLimit),
      window: { indices: window.map((w) => BigInt(w.index)), amount: spent },
    });
    const plan = await agentTransferPlan({
      vault: vaultOf(ctx),
      feePayer: address(ctx.feePayer),
      agent: agentAccounts(agent),
      nonce: state.nonce!,
      destinationToken: address(prepared.recipient.cusdcAccount),
      proofs,
      rent: agentRentTable(ctx),
    });
    const payment = { index, windowStart, ...(input.domain ? { domain: input.domain } : {}) };
    const body = await authorizeAgentPlan({
      plan,
      ctx,
      agentsConfig: config,
      agentId: this.agentId,
      label: 'agent-transfer',
      nonce: BigInt(state.authNonce),
      signer: 'agent',
      seed: this.keys.authoritySeed,
      payment,
    });
    const memoCiphertext = input.memo
      ? base64Encode(
          encryptMemo({
            text: input.memo,
            recipientElgamalPubkey: b64(prepared.recipient.elgamalPubkey),
            senderElgamalPubkey: this.keys.elgamal.pubkey().toBytes(),
          }),
        )
      : undefined;
    return this.call<PaymentResult>('POST', `/v1/agents/${this.agentId}/payments`, {
      body: {
        ...body,
        transferId: prepared.transferId,
        index: index.toString(),
        windowStart: windowStart.toString(),
        ...(input.domain ? { domain: input.domain } : {}),
        validityContext: base64Encode(proofs.validityContext),
        limitContext: base64Encode(proofs.limitContext),
        ...(memoCiphertext ? { memoCiphertext } : {}),
      },
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:pay` : true,
    });
  }

  /**
   * `fetch`, with x402: if the server answers 402 Payment Required and
   * accepts the `vexa` scheme, pays the requested amount to its handle
   * (within the agent's policy) and retries with an `X-PAYMENT` header. Every
   * step is logged to the owner's trace view under one request id.
   *
   * `maxAmount` caps what this call will pay, on top of the agent's policy.
   */
  async fetch(
    input: string | URL,
    init: RequestInit & { maxAmount?: bigint } = {},
  ): Promise<Response> {
    const url = new URL(input.toString());
    const requestId = crypto.randomUUID();
    const { maxAmount, ...requestInit } = init;
    await this.trace(
      'request',
      { url: url.origin + url.pathname, method: requestInit.method ?? 'GET' },
      requestId,
    );

    const first = await this.rawFetch(url, requestInit);
    if (first.status !== 402) {
      await this.trace('completed', { status: first.status }, requestId);
      return first;
    }
    const required = (await first.json().catch(() => null)) as {
      accepts?: PaymentRequirements[];
    } | null;
    const option = required?.accepts?.find(
      (a) => a.scheme === X402_SCHEME && a.network === X402_NETWORK,
    );
    await this.trace(
      'payment_required',
      { offers: required?.accepts?.length ?? 0, vexa: !!option },
      requestId,
    );
    if (!option) {
      await this.trace('failed', { reason: 'no vexa payment option' }, requestId);
      return new Response(null, { status: 402, statusText: 'Payment Required (no vexa option)' });
    }
    const amount = BigInt(option.maxAmountRequired);
    await this.trace('quote', { payTo: option.payTo, resource: option.resource }, requestId);
    if (maxAmount !== undefined && amount > maxAmount) {
      await this.trace('failed', { reason: 'over this request’s maxAmount' }, requestId);
      throw new Error('the payment requested is over maxAmount');
    }

    let paid: PaymentResult;
    try {
      paid = await this.pay({
        to: option.payTo,
        amount,
        domain: url.hostname,
        idempotencyKey: requestId,
      });
      await this.trace('policy_check', { passed: true }, requestId);
    } catch (e) {
      const reason = e instanceof Error ? e.message.slice(0, 200) : 'payment failed';
      await this.trace('policy_check', { passed: false, reason }, requestId);
      await this.trace('failed', { reason }, requestId);
      throw e;
    }
    await this.trace('paid', { payTo: option.payTo, txSig: paid.txSig }, requestId);

    const payment = base64Encode(
      new TextEncoder().encode(
        JSON.stringify({
          x402Version: 1,
          scheme: X402_SCHEME,
          network: X402_NETWORK,
          payload: { transferId: paid.id, txSig: paid.txSig },
        }),
      ),
    );
    const headers = new Headers(requestInit.headers);
    headers.set('X-PAYMENT', payment);
    const retried = await this.rawFetch(url, { ...requestInit, headers });
    await this.trace('retried', { status: retried.status }, requestId);
    await this.trace(retried.ok ? 'completed' : 'failed', { status: retried.status }, requestId);
    return retried;
  }
}

/** Parses an `X-PAYMENT` header from a Vexa agent, for servers selling to agents. */
export function parseX402Payment(header: string): { transferId: string; txSig: string } | null {
  try {
    const decoded = JSON.parse(new TextDecoder().decode(base64Decode(header)!)) as {
      scheme?: string;
      payload?: { transferId?: string; txSig?: string };
    };
    if (decoded.scheme !== X402_SCHEME || !decoded.payload?.transferId || !decoded.payload.txSig)
      return null;
    return { transferId: decoded.payload.transferId, txSig: decoded.payload.txSig };
  } catch {
    return null;
  }
}
