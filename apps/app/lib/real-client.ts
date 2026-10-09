/**
 * The client for real accounts: @vexa/sdk against the Vexa API.
 *
 * The user's keys are derived from their passkey's PRF output at unlock and
 * live only in this object. Nothing secret is written to storage; the session
 * tokens go to sessionStorage so a reload inside the tab doesn't sign out,
 * but the keys always need the passkey again.
 */
import { address } from '@solana/kit';
import { base64Decode, type ChainContext } from '@vexa/core';
import {
  decryptAvailableBalance,
  decryptPendingBalance,
  decryptTransferAmount,
  deriveUserKeys,
  passkeyPrfInput,
  signWithSolanaSeed,
  type UserKeys,
} from '@vexa/core/crypto';
import { findAta, TOKEN_2022_PROGRAM } from '@vexa/core/solana';
import { Vexa, VexaError, type Session } from '@vexa/sdk';
import type { AgentFunds, AgentTrace, TransferStatus, VexaClient, Webhook } from './client';
import { API_URL, SOLANA_RPC_URL } from './config';

const SESSION_KEY = 'vexa.session';
const PASSKEY_KEY = 'vexa.passkey';

function store(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function loadSession(): Session | null {
  try {
    const raw = store()?.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

const b64 = (s: string) => {
  const bytes = base64Decode(s);
  if (!bytes) throw new Error('malformed base64 from the API');
  return bytes;
};

export class NoPrfError extends Error {
  constructor() {
    super('no PRF output from this passkey');
    this.name = 'NoPrfError';
  }
}

export class WrongPasskeyError extends Error {
  constructor(readonly reason: 'other_account' | 'other_keys') {
    super(reason === 'other_account' ? 'passkey for a different account' : 'passkey keys mismatch');
    this.name = 'WrongPasskeyError';
  }
}

class RealClient implements VexaClient {
  readonly demo = false;
  private vexa: Vexa;
  private session: Session | null;
  private keys: UserKeys | null = null;
  private refreshing: Promise<void> | null = null;
  private chainCtx: Promise<ChainContext> | null = null;

  constructor() {
    this.session = loadSession();
    this.vexa = new Vexa({ baseUrl: API_URL, accessToken: this.session?.accessToken });
  }

  private saveSession(session: Session | null) {
    this.session = session;
    this.vexa.setSession(session);
    try {
      if (session) store()?.setItem(SESSION_KEY, JSON.stringify(session));
      else store()?.removeItem(SESSION_KEY);
    } catch {
      // Private mode without storage: the session lasts until reload.
    }
  }

  /** Refreshes the access token a minute before it expires. */
  private async fresh(): Promise<Vexa> {
    const s = this.session;
    if (s && s.expiresAt * 1000 - Date.now() < 60_000) {
      this.refreshing ??= this.vexa.auth
        .refresh(s.refreshToken)
        .then((next) => this.saveSession(next))
        .finally(() => {
          this.refreshing = null;
        });
      await this.refreshing;
    }
    return this.vexa;
  }

  private k(): UserKeys {
    if (!this.keys) throw new Error('Locked: unlock with your passkey first');
    return this.keys;
  }

  hasSession() {
    return this.session !== null;
  }

  hasPasskey() {
    return !!this.session && store()?.getItem(PASSKEY_KEY) === this.session.user.id;
  }

  isUnlocked() {
    return this.keys !== null;
  }

  async sendOtp(email: string) {
    await this.vexa.auth.sendOtp(email);
  }

  async verifyOtp(email: string, code: string) {
    const session = await this.vexa.auth.verifyOtp(email, code);
    this.saveSession(session);
    try {
      return await this.vexa.me();
    } catch (e) {
      if (e instanceof VexaError && e.status === 404) return null;
      throw e;
    }
  }

  async registerPasskey() {
    const vexa = await this.fresh();
    await vexa.passkeys.register('Vexa');
    if (this.session) store()?.setItem(PASSKEY_KEY, this.session.user.id);
  }

  async unlock(opts: { sameAccount?: boolean } = {}) {
    const expected = this.session?.user.id;
    const { session, prfOutput } = await this.vexa.passkeys.signIn(passkeyPrfInput());
    if (opts.sameAccount && expected && session.user.id !== expected) {
      // Mid sign-up: the browser offered a passkey from another Vexa account.
      this.vexa.setSession(this.session);
      throw new WrongPasskeyError('other_account');
    }
    this.saveSession(session);
    store()?.setItem(PASSKEY_KEY, session.user.id);
    // Without keys the session is no use; don't leave it half signed in.
    if (!prfOutput) {
      this.signOut();
      throw new NoPrfError();
    }
    const keys = deriveUserKeys(prfOutput);
    prfOutput.fill(0);

    const profile = await this.vexa.me();
    if (profile.solanaPubkey && profile.solanaPubkey !== keys.solanaAddress) {
      this.signOut();
      throw new WrongPasskeyError('other_keys');
    }
    this.keys = keys;
    const accountOpen = profile.handle ? (await this.vexa.money.balance(keys)).configured : false;
    return { profile, accountOpen };
  }

  lock() {
    this.keys = null;
    this.chainCtx = null;
  }

  signOut() {
    this.lock();
    this.saveSession(null);
    try {
      store()?.removeItem(PASSKEY_KEY);
    } catch {
      // nothing stored
    }
  }

  async me() {
    return (await this.fresh()).me();
  }

  address() {
    return this.k().solanaAddress;
  }

  async handleAvailable(handle: string) {
    try {
      await (await this.fresh()).handles.resolve(handle);
      return false;
    } catch (e) {
      if (e instanceof VexaError && e.status === 404) return true;
      throw e;
    }
  }

  async claimHandle(handle: string, idempotencyKey: string) {
    const keys = this.k();
    return (await this.fresh()).handles.claim(
      handle,
      {
        solanaAddress: keys.solanaAddress,
        elgamalPubkey: keys.elgamalPubkey,
        sign: (m) => signWithSolanaSeed(keys.solanaSeed, m),
      },
      { idempotencyKey },
    );
  }

  async openAccount() {
    await (await this.fresh()).money.openAccount(this.k());
  }

  async resolve(handle: string) {
    return (await this.fresh()).handles.resolve(handle);
  }

  async balance() {
    return (await this.fresh()).money.balance(this.k());
  }

  async walletUsdc() {
    if (!SOLANA_RPC_URL) return null;
    const { usdcAccount } = await this.balance();
    const res = await fetch(SOLANA_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenAccountBalance',
        params: [usdcAccount, { commitment: 'confirmed' }],
      }),
    });
    const body = (await res.json()) as {
      result?: { value: { amount: string } };
      error?: { message: string };
    };
    // No token account yet means no USDC yet.
    if (body.error) return /could not find account/i.test(body.error.message) ? 0n : null;
    return body.result ? BigInt(body.result.value.amount) : null;
  }

  async applyPending() {
    await (await this.fresh()).money.applyPending(this.k());
  }

  async quote(amount: bigint) {
    return (await this.fresh()).money.quote(amount);
  }

  async deposit(amount: bigint) {
    return (await this.fresh()).money.deposit(amount, this.k());
  }

  async withdraw(amount: bigint, to: string) {
    return (await this.fresh()).money.withdraw({ amount, to }, this.k());
  }

  async transfer(input: {
    to: string;
    amount: bigint;
    memo?: string;
    mode: 'standard' | 'stealth';
    idempotencyKey: string;
  }) {
    return (await this.fresh()).money.transfer(input, this.k());
  }

  async transferStatus(id: string) {
    // The API also returns the transfer's mode; the SDK's type leaves it out.
    return (await (await this.fresh()).money.transferStatus(id)) as TransferStatus;
  }

  async activity(opts: { limit?: number; before?: string } = {}) {
    return (await this.fresh()).money.activity(this.k(), opts);
  }

  async tier() {
    return (await this.fresh()).money.tier();
  }

  async stake(amount: bigint) {
    await (await this.fresh()).money.stake(amount, this.k());
  }

  async unstake(amount: bigint) {
    await (await this.fresh()).money.unstake(amount, this.k());
  }

  async agents() {
    return (await this.fresh()).agents.list();
  }

  async agent(id: string) {
    return (await this.fresh()).agents.get(id);
  }

  async agentFunds(id: string): Promise<AgentFunds> {
    const vexa = await this.fresh();
    const state = await vexa.agents.state(id);
    const agentKeys = vexa.agents.keysFor(id, this.k());
    const secret = agentKeys.elgamal.secret();
    const c = state.confidential;
    const available = c
      ? decryptAvailableBalance(agentKeys.ae, b64(c.decryptableAvailableBalance))
      : 0n;
    const pending = c
      ? decryptPendingBalance(secret, b64(c.pendingBalanceLo), b64(c.pendingBalanceHi))
      : 0n;
    let spentToday = 0n;
    for (const w of state.window) {
      if (BigInt(w.index) < BigInt(state.windowStart) || !w.groupedLo || !w.groupedHi) continue;
      spentToday += decryptTransferAmount(secret, b64(w.groupedLo), b64(w.groupedHi), 0);
    }
    return { status: state.status, available, pending, spentToday };
  }

  async createAgent(input: Parameters<VexaClient['createAgent']>[0]) {
    return (await this.fresh()).agents.create(input, this.k());
  }

  credentialFor(id: string) {
    return this.vexa.agents.credentialFor(id, this.k());
  }

  async updateAgentPolicy(id: string, policy: Parameters<VexaClient['updateAgentPolicy']>[1]) {
    return (await this.fresh()).agents.updatePolicy(id, policy, this.k());
  }

  async pauseAgent(id: string) {
    await (await this.fresh()).agents.pause(id, this.k());
  }

  async resumeAgent(id: string) {
    await (await this.fresh()).agents.resume(id, this.k());
  }

  async revokeAgent(id: string) {
    await (await this.fresh()).agents.revoke(id, this.k());
  }

  async sweepAgent(id: string) {
    return (await (await this.fresh()).agents.sweep(id, this.k())).amount;
  }

  async fundAgent(id: string, amount: bigint, idempotencyKey: string) {
    await (
      await this.fresh()
    ).money.transfer({ to: `agent:${id}`, amount, idempotencyKey }, this.k());
  }

  async agentTraces(id: string) {
    return (await (await this.fresh()).agents.traces(id, { limit: 50 })) as AgentTrace[];
  }

  /**
   * The SDK has no call for a handle's cUSDC account, so this derives it from
   * the handle's wallet and the vault's cUSDC mint in GET /v1/chain.
   */
  async recipientAccount(handle: string) {
    const vexa = await this.fresh();
    const resolved = await vexa.handles.resolve(handle);
    this.chainCtx ??= fetch(`${API_URL}/v1/chain`, {
      headers: { authorization: `Bearer ${this.session?.accessToken ?? ''}` },
    }).then((r) => {
      if (!r.ok) throw new Error(`Couldn’t load the vault’s accounts (${r.status})`);
      return r.json() as Promise<ChainContext>;
    });
    const ctx = await this.chainCtx.catch((e: unknown) => {
      this.chainCtx = null;
      throw e;
    });
    const account = await findAta(
      address(resolved.solanaPubkey),
      address(ctx.vault.cusdcMint),
      TOKEN_2022_PROGRAM,
    );
    return { display: resolved.display, account };
  }

  async viewKeys() {
    return (await this.fresh()).viewKeys.list();
  }

  async createViewKey(input: { label?: string; from: Date; to: Date }) {
    return (await this.fresh()).viewKeys.create(input, this.k());
  }

  viewKeyFor(id: string) {
    return this.vexa.viewKeys.viewKeyFor(id, this.k());
  }

  async syncViewKeys() {
    return (await this.fresh()).viewKeys.sync(this.k());
  }

  async revokeViewKey(id: string) {
    await (await this.fresh()).viewKeys.revoke(id);
  }

  async apiKeys() {
    return (await this.fresh()).apiKeys.list();
  }

  async createApiKey(name: string, idempotencyKey: string) {
    return (await this.fresh()).apiKeys.create(name, { idempotencyKey });
  }

  async revokeApiKey(id: string) {
    await (await this.fresh()).apiKeys.revoke(id);
  }

  async webhooks(): Promise<Webhook[]> {
    return (await this.fresh()).webhooks.list();
  }

  async createWebhook(
    url: string,
    events: Parameters<VexaClient['createWebhook']>[1],
    key: string,
  ) {
    return (await this.fresh()).webhooks.create(url, events, { idempotencyKey: key });
  }

  async removeWebhook(id: string) {
    await (await this.fresh()).webhooks.remove(id);
  }
}

export function createRealClient(): VexaClient {
  return new RealClient();
}
