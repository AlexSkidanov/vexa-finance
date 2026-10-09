/**
 * Demo mode: every call answered from sample data in memory, with a little
 * latency so loading states show. Nothing leaves the browser. The one real
 * thing is the key derivation (from a fixed, public test secret), so the demo
 * also exercises the WebAssembly the real app depends on.
 *
 * Only bundled in `next dev` or when NEXT_PUBLIC_VEXA_DEMO=1 at build time.
 */
import type {
  Activity,
  AgentFunds,
  AgentPolicyInput,
  AgentSummary,
  AgentTrace,
  ApiKeySummary,
  Profile,
  TransferStatus,
  VexaClient,
  ViewKeySummary,
  Webhook,
} from './client';
import type { StealthStatus } from './stealth';

const U = 1_000_000n;
const HOUR = 3_600_000;
const wait = (ms = 250 + Math.random() * 450) => new Promise((r) => setTimeout(r, ms));
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const uuid = () => crypto.randomUUID();
const fakeSig = () =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(64)),
    (b) => '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[b % 58],
  ).join('');

/** Shaped like the SDK's VexaError, so error mapping is exercised too. */
class DemoApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId = `req_demo_${uuid().slice(0, 8)}`,
  ) {
    super(message);
    this.name = 'VexaError';
  }
}

const TAKEN = new Set(['alice', 'bob', 'maya', 'noor', 'kestrel', 'shop', 'research-bot']);
const STEALTH_ORDER: StealthStatus[] = [
  'awaiting_funds',
  'routing',
  'shielded',
  'returning',
  'settling',
  'settled',
];

interface State {
  session: boolean;
  passkey: boolean;
  unlocked: boolean;
  address: string;
  profile: Profile;
  accountOpen: boolean;
  available: bigint;
  pending: bigint;
  wallet: bigint;
  activity: Activity[];
  stealth: Map<string, number>;
  agents: AgentSummary[];
  agentFunds: Map<string, AgentFunds>;
  viewKeys: ViewKeySummary[];
  apiKeys: ApiKeySummary[];
  webhooks: Webhook[];
}

function sampleActivity(): Activity[] {
  return [
    {
      kind: 'transfer',
      id: uuid(),
      direction: 'received',
      amount: 25n * U,
      memo: 'Dinner, thanks!',
      to: '@maya.vexa',
      txSig: fakeSig(),
      createdAt: ago(0.6 * HOUR),
    },
    {
      kind: 'transfer',
      id: uuid(),
      direction: 'sent',
      amount: 120n * U + 500_000n,
      memo: 'September studio rent',
      to: '@noor.vexa',
      txSig: fakeSig(),
      createdAt: ago(20 * HOUR),
    },
    {
      kind: 'deposit',
      id: uuid(),
      status: 'confirmed',
      txSig: fakeSig(),
      createdAt: ago(2 * 24 * HOUR),
    },
    {
      kind: 'transfer',
      id: uuid(),
      direction: 'sent',
      amount: 40n * U,
      memo: null,
      to: '@kestrel.vexa',
      txSig: fakeSig(),
      createdAt: ago(3 * 24 * HOUR),
    },
    {
      kind: 'withdrawal',
      id: uuid(),
      status: 'confirmed',
      txSig: fakeSig(),
      destination: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      createdAt: ago(6 * 24 * HOUR),
    },
    {
      kind: 'transfer',
      id: uuid(),
      direction: 'received',
      amount: 1_000n * U,
      memo: 'Invoice #0142',
      to: '@alice.vexa',
      txSig: fakeSig(),
      createdAt: ago(9 * 24 * HOUR),
    },
  ];
}

function sampleAgents(): [AgentSummary[], Map<string, AgentFunds>] {
  const a: AgentSummary = {
    id: uuid(),
    name: 'research-bot',
    address: '5vJ1H2b9kQ3xTnYfTq6yP8oM3vQ4cR7dW2eLkS9aZbXc',
    cusdcAccount: '8KfPq2mB7sR4xJ9nT3vWc6yH1dL5gZ2aE8uN4oQ7iXrM',
    nonceAccount: '3hTg7Yp2xK9vN4mB6cR8wQ1sD5fL2jZ7aE3uP9oX6iMn',
    authority: '6aR2mN8kP4xT7vB1cW9yQ3sH5dL2gJ8fZ4eU6oX1iMpK',
    elgamalPubkey: 'demo',
    status: 'active',
    policy: {
      version: 2,
      maxPerRequest: String(2n * U),
      dailyLimit: String(25n * U),
      allowedRecipients: [],
      allowedDomains: ['api.example.com', 'data.example.org'],
    },
    createdAt: ago(12 * 24 * HOUR),
  };
  const b: AgentSummary = {
    ...a,
    id: uuid(),
    name: 'groceries',
    address: '2mN8kP4xT7vB1cW9yQ3sH5dL2gJ8fZ4eU6oX1iMpK6aR',
    cusdcAccount: '4xT7vB1cW9yQ3sH5dL2gJ8fZ4eU6oX1iMpK6aR2mN8k',
    status: 'paused',
    policy: {
      version: 1,
      maxPerRequest: String(80n * U),
      dailyLimit: String(150n * U),
      allowedRecipients: ['7dQ2pL9xR4mT6vB8nW1cY3sH5gJ2kZ8fE4uA6oX1iMr'],
      allowedDomains: [],
    },
    createdAt: ago(30 * 24 * HOUR),
  };
  return [
    [a, b],
    new Map([
      [
        a.id,
        {
          status: 'active',
          available: 18n * U + 250_000n,
          pending: 5n * U,
          spentToday: 6n * U + 750_000n,
        },
      ],
      [b.id, { status: 'paused', available: 62n * U, pending: 0n, spentToday: 0n }],
    ]),
  ];
}

function newState(): State {
  const [agents, agentFunds] = sampleAgents();
  return {
    session: false,
    passkey: false,
    unlocked: false,
    address: '',
    profile: {
      userId: uuid(),
      email: 'maya@example.com',
      handle: '@maya.vexa',
      solanaPubkey: null,
      elgamalPubkey: null,
      kycStatus: 'none',
      tier: 0,
      createdAt: ago(40 * 24 * HOUR),
    },
    accountOpen: true,
    available: 1_284n * U + 500_000n,
    pending: 25n * U,
    wallet: 310n * U,
    activity: sampleActivity(),
    stealth: new Map(),
    agents,
    agentFunds,
    viewKeys: [
      {
        id: uuid(),
        label: 'Accountant, this year',
        from: new Date(new Date().getFullYear(), 0, 1).toISOString(),
        to: new Date(new Date().getFullYear() + 1, 0, 1).toISOString(),
        revokedAt: null,
        createdAt: ago(15 * 24 * HOUR),
      },
    ],
    apiKeys: [
      {
        id: uuid(),
        name: 'research-bot server',
        prefix: 'vx_live_7Hq2',
        environment: 'live',
        createdAt: ago(12 * 24 * HOUR),
        lastUsedAt: ago(2 * HOUR),
        revokedAt: null,
      },
    ],
    webhooks: [],
  };
}

const SESSION_KEY = 'vexa.demo.session';

class DemoClient implements VexaClient {
  readonly demo = true;
  private s = newState();

  constructor() {
    try {
      this.s.session = sessionStorage.getItem(SESSION_KEY) === '1';
      this.s.passkey = this.s.session;
    } catch {
      // no storage: start signed out
    }
  }

  private setSession(on: boolean) {
    this.s.session = on;
    try {
      if (on) sessionStorage.setItem(SESSION_KEY, '1');
      else sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // fine
    }
  }

  private need() {
    if (!this.s.unlocked) throw new Error('Locked: unlock with your passkey first');
  }

  private agentOr404(id: string) {
    const a = this.s.agents.find((x) => x.id === id);
    if (!a) throw new DemoApiError(404, 'not_found', 'Agent not found');
    return a;
  }

  hasSession() {
    return this.s.session;
  }
  hasPasskey() {
    return this.s.passkey;
  }
  isUnlocked() {
    return this.s.unlocked;
  }

  async sendOtp() {
    await wait();
  }

  async verifyOtp(email: string, code: string) {
    await wait();
    if (!/^\d{6}$/.test(code)) throw new DemoApiError(401, 'unauthenticated', 'Code is invalid');
    this.setSession(true);
    // A brand-new account: no handle, no keys, nothing open yet.
    this.s.profile = { ...this.s.profile, email, handle: null, solanaPubkey: null };
    this.s.accountOpen = false;
    this.s.available = 0n;
    this.s.pending = 0n;
    this.s.activity = [];
    this.s.agents = [];
    this.s.viewKeys = [];
    this.s.apiKeys = [];
    return null;
  }

  async registerPasskey() {
    await wait(900);
    this.s.passkey = true;
  }

  async unlock() {
    await wait(700);
    // A fixed, public test secret stands in for the passkey's PRF output.
    const { deriveUserKeys } = await import('@vexa/core/crypto');
    const keys = deriveUserKeys(new Uint8Array(32).fill(7));
    this.s.address = keys.solanaAddress;
    this.s.unlocked = true;
    this.s.passkey = true;
    this.setSession(true);
    if (this.s.profile.handle) this.s.profile.solanaPubkey = keys.solanaAddress;
    return { profile: { ...this.s.profile }, accountOpen: this.s.accountOpen };
  }

  lock() {
    this.s.unlocked = false;
  }

  signOut() {
    this.s = newState();
    this.setSession(false);
  }

  async me() {
    await wait(150);
    return { ...this.s.profile };
  }

  address() {
    this.need();
    return this.s.address;
  }

  async handleAvailable(handle: string) {
    await wait(300);
    return !TAKEN.has(
      handle
        .replace(/^@/, '')
        .replace(/\.vexa$/, '')
        .toLowerCase(),
    );
  }

  async claimHandle(handle: string) {
    this.need();
    await wait(800);
    const bare = handle
      .replace(/^@/, '')
      .replace(/\.vexa$/, '')
      .toLowerCase();
    if (TAKEN.has(bare))
      throw new DemoApiError(409, 'handle_taken', 'That handle is already taken');
    this.s.profile = { ...this.s.profile, handle: `@${bare}.vexa`, solanaPubkey: this.s.address };
    return { ...this.s.profile };
  }

  async openAccount() {
    this.need();
    await wait(1600);
    this.s.accountOpen = true;
  }

  async resolve(handle: string) {
    await wait(300);
    const bare = handle
      .replace(/^@/, '')
      .replace(/\.vexa$/, '')
      .toLowerCase();
    if (!TAKEN.has(bare)) throw new DemoApiError(404, 'not_found', 'Handle not found');
    return {
      handle: bare,
      display: `@${bare}.vexa`,
      kind: bare.endsWith('bot') || bare === 'shop' ? ('agent' as const) : ('user' as const),
      solanaPubkey: '7dQ2pL9xR4mT6vB8nW1cY3sH5gJ2kZ8fE4uA6oX1iMr',
      elgamalPubkey: 'demo',
    };
  }

  async balance() {
    this.need();
    await wait();
    return {
      available: this.s.available,
      pending: this.s.pending,
      configured: this.s.accountOpen,
      cusdcAccount: 'DemoCusdc1111111111111111111111111111111111',
      usdcAccount: 'DemoUsdc11111111111111111111111111111111111',
    };
  }

  async walletUsdc() {
    await wait();
    return this.s.wallet;
  }

  async applyPending() {
    this.need();
    await wait(1200);
    this.s.available += this.s.pending;
    this.s.pending = 0n;
  }

  async quote(amount: bigint) {
    await wait(200);
    const raw = (amount * 10n) / 10_000n;
    const fee = raw > 5n * U ? 5n * U : raw;
    return { fee, net: amount - fee, discountBps: 0 };
  }

  async deposit(amount: bigint) {
    this.need();
    if (amount > this.s.wallet)
      throw new DemoApiError(502, 'chain_error', 'A transaction failed on-chain');
    const q = await this.quote(amount);
    await wait(1800);
    this.s.wallet -= amount;
    this.s.available += q.net;
    const id = uuid();
    const txSig = fakeSig();
    this.s.activity.unshift({
      kind: 'deposit',
      id,
      status: 'confirmed',
      txSig,
      createdAt: new Date().toISOString(),
    });
    return { id, txSig, ...q };
  }

  async withdraw(amount: bigint, to: string) {
    this.need();
    if (amount > this.s.available) throw new Error('insufficient confidential balance');
    const q = await this.quote(amount);
    await wait(2200);
    this.s.available -= amount;
    const id = uuid();
    const txSig = fakeSig();
    this.s.activity.unshift({
      kind: 'withdrawal',
      id,
      status: 'confirmed',
      txSig,
      destination: to,
      createdAt: new Date().toISOString(),
    });
    return { id, txSig, ...q };
  }

  async transfer(input: {
    to: string;
    amount: bigint;
    memo?: string;
    mode: 'standard' | 'stealth';
  }) {
    this.need();
    const r = await this.resolve(input.to);
    if (input.mode === 'stealth') {
      if (input.amount < 5n * U) throw new Error('stealth transfers start at 5 USDC');
      if (input.amount > this.s.available) throw new Error('insufficient confidential balance');
    } else if (input.amount > this.s.available + this.s.pending) {
      throw new Error('insufficient confidential balance');
    } else if (input.amount > this.s.available) {
      this.s.available += this.s.pending;
      this.s.pending = 0n;
    }
    await wait(2000);
    this.s.available -= input.amount;
    const id = uuid();
    const txSig = input.mode === 'stealth' ? null : fakeSig();
    if (input.mode === 'stealth') this.s.stealth.set(id, Date.now());
    this.s.activity.unshift({
      kind: 'transfer',
      id,
      direction: 'sent',
      amount: input.amount,
      memo: input.memo ?? null,
      to: r.display,
      txSig,
      createdAt: new Date().toISOString(),
    });
    return { id, txSig };
  }

  async transferStatus(id: string): Promise<TransferStatus> {
    await wait(200);
    const started = this.s.stealth.get(id);
    const item = this.s.activity.find((a) => a.id === id);
    if (!item) throw new DemoApiError(404, 'not_found', 'Transfer not found');
    if (started === undefined)
      return { id, status: 'settled', mode: 'standard', txSig: item.txSig };
    // Each leg of the demo route takes six seconds.
    const i = Math.min(STEALTH_ORDER.length - 1, Math.floor((Date.now() - started) / 6000));
    const status = STEALTH_ORDER[i]!;
    return {
      id,
      status: status === 'settled' ? 'settled' : 'submitted',
      mode: 'stealth',
      txSig: status === 'settled' ? fakeSig() : null,
      stealth: { status, updatedAt: new Date().toISOString() },
    };
  }

  async activity(opts: { limit?: number; before?: string } = {}) {
    this.need();
    await wait();
    const before = opts.before ? new Date(opts.before).getTime() : Infinity;
    return this.s.activity
      .filter((a) => new Date(a.createdAt).getTime() < before)
      .slice(0, opts.limit ?? 50);
  }

  async tier() {
    await wait();
    return {
      vexaMint: null,
      staked: 0n,
      held: 0n,
      weight: 0n,
      unlockAt: null,
      tier: { level: 0, discountBps: 0, maxAgents: 3, agentDailyLimit: 500n * U },
    };
  }

  async stake() {
    await wait();
    throw new Error('$VEXA staking is not open yet');
  }

  async unstake() {
    await wait();
    throw new Error('$VEXA staking is not open yet');
  }

  async agents() {
    await wait();
    return this.s.agents.map((a) => ({
      ...a,
      status: this.s.agentFunds.get(a.id)?.status ?? a.status,
    }));
  }

  async agent(id: string) {
    await wait();
    const a = this.agentOr404(id);
    return { ...a, status: this.s.agentFunds.get(id)?.status ?? a.status };
  }

  async agentFunds(id: string) {
    await wait();
    this.agentOr404(id);
    return { ...this.s.agentFunds.get(id)! };
  }

  private policyOf(p: AgentPolicyInput, version: number): AgentSummary['policy'] {
    if (p.maxPerRequest > p.dailyLimit)
      throw new DemoApiError(400, 'invalid_request', 'maxPerRequest can’t exceed dailyLimit');
    if (p.dailyLimit > 500n * U)
      throw new DemoApiError(
        403,
        'agent_limit_reached',
        'Your tier allows agents up to 500 USDC a day',
      );
    return {
      version,
      maxPerRequest: p.maxPerRequest.toString(),
      dailyLimit: p.dailyLimit.toString(),
      allowedRecipients: p.allowedRecipients ?? [],
      allowedDomains: p.allowedDomains ?? [],
    };
  }

  async createAgent(input: { name?: string; policy: AgentPolicyInput }) {
    this.need();
    await wait(2500);
    if (this.s.agents.filter((a) => this.s.agentFunds.get(a.id)?.status !== 'revoked').length >= 3)
      throw new DemoApiError(403, 'agent_limit_reached', 'Your tier allows 3 agents');
    const agent: AgentSummary = {
      ...(this.s.agents[0] ?? sampleAgents()[0][0]!),
      id: uuid(),
      name: input.name ?? null,
      status: 'active',
      policy: this.policyOf(input.policy, 1),
      createdAt: new Date().toISOString(),
    };
    this.s.agents.unshift(agent);
    this.s.agentFunds.set(agent.id, {
      status: 'active',
      available: 0n,
      pending: 0n,
      spentToday: 0n,
    });
    return { agent, credential: this.credentialFor(agent.id) };
  }

  credentialFor(id: string) {
    return `vxagent_demo_${id.replace(/-/g, '')}`;
  }

  async updateAgentPolicy(id: string, policy: AgentPolicyInput) {
    this.need();
    await wait(1500);
    const a = this.agentOr404(id);
    a.policy = this.policyOf(policy, a.policy.version + 1);
    return { ...a };
  }

  private async setStatus(id: string, status: AgentSummary['status']) {
    this.need();
    await wait(1200);
    this.agentOr404(id);
    const f = this.s.agentFunds.get(id)!;
    f.status = status;
  }

  pauseAgent(id: string) {
    return this.setStatus(id, 'paused');
  }
  resumeAgent(id: string) {
    return this.setStatus(id, 'active');
  }
  revokeAgent(id: string) {
    return this.setStatus(id, 'revoked');
  }

  async sweepAgent(id: string) {
    this.need();
    await wait(2500);
    const f = this.s.agentFunds.get(id)!;
    const amount = f.available + f.pending;
    f.available = 0n;
    f.pending = 0n;
    this.s.pending += amount;
    return amount;
  }

  async fundAgent(id: string, amount: bigint) {
    this.need();
    if (amount > this.s.available + this.s.pending)
      throw new Error('insufficient confidential balance');
    await wait(2000);
    if (amount > this.s.available) {
      this.s.available += this.s.pending;
      this.s.pending = 0n;
    }
    this.s.available -= amount;
    this.s.agentFunds.get(id)!.pending += amount;
  }

  async agentTraces(id: string): Promise<AgentTrace[]> {
    await wait();
    const a = this.agentOr404(id);
    if (a.name !== 'research-bot') return [];
    const r1 = uuid();
    const r2 = uuid();
    const t = (requestId: string, step: string, detail: Record<string, unknown>, m: number) => ({
      id: uuid(),
      requestId,
      step,
      detail,
      createdAt: ago(m * 60_000),
    });
    return [
      t(r1, 'completed', { status: 200 }, 12),
      t(r1, 'retried', { status: 200 }, 12.1),
      t(r1, 'paid', { payTo: '@shop.vexa' }, 12.2),
      t(r1, 'policy_check', { passed: true }, 12.3),
      t(r1, 'quote', { payTo: '@shop.vexa', resource: 'https://api.example.com/v1/report' }, 12.4),
      t(r1, 'payment_required', { offers: 2, vexa: true }, 12.5),
      t(r1, 'request', { url: 'https://api.example.com/v1/report', method: 'GET' }, 12.6),
      t(r2, 'failed', { reason: 'payment exceeds the per-payment maximum' }, 95),
      t(r2, 'policy_check', { passed: false, reason: 'max_per_request' }, 95.1),
      t(r2, 'request', { url: 'https://data.example.org/bulk', method: 'GET' }, 95.3),
    ];
  }

  async recipientAccount(handle: string) {
    const r = await this.resolve(handle);
    return { display: r.display, account: `${r.solanaPubkey.slice(0, 40)}Demo` };
  }

  async viewKeys() {
    await wait();
    return [...this.s.viewKeys];
  }

  async createViewKey(input: { label?: string; from: Date; to: Date }) {
    this.need();
    await wait(1500);
    const id = uuid();
    this.s.viewKeys.unshift({
      id,
      label: input.label ?? null,
      from: input.from.toISOString(),
      to: input.to.toISOString(),
      revokedAt: null,
      createdAt: new Date().toISOString(),
    });
    return { id, viewKey: this.viewKeyFor(id), recorded: 4 };
  }

  viewKeyFor(id: string) {
    return `vxview_${id}.demoAccessSecret.demoDecryptionKey`;
  }

  async syncViewKeys() {
    this.need();
    await wait(1200);
    return 2;
  }

  async revokeViewKey(id: string) {
    await wait();
    const k = this.s.viewKeys.find((v) => v.id === id);
    if (k) k.revokedAt = new Date().toISOString();
  }

  async apiKeys() {
    await wait();
    return [...this.s.apiKeys];
  }

  async createApiKey(name: string) {
    await wait();
    const key: ApiKeySummary = {
      id: uuid(),
      name,
      prefix: 'vx_live_Dm0x',
      environment: 'live',
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.s.apiKeys.unshift(key);
    return { ...key, secret: `vx_live_Dm0x${'demo'.repeat(8)}` };
  }

  async revokeApiKey(id: string) {
    await wait();
    const k = this.s.apiKeys.find((x) => x.id === id);
    if (k) k.revokedAt = new Date().toISOString();
  }

  async webhooks() {
    await wait();
    return [...this.s.webhooks];
  }

  async createWebhook(url: string, events: string[]) {
    await wait();
    if (!url.startsWith('https://'))
      throw new DemoApiError(400, 'invalid_request', 'url must be https');
    const hook = { id: uuid(), url, events, createdAt: new Date().toISOString() };
    this.s.webhooks.unshift(hook);
    return { ...hook, secret: 'whsec_demoSigningSecretOnlyShownOnce' };
  }

  async removeWebhook(id: string) {
    await wait();
    this.s.webhooks = this.s.webhooks.filter((w) => w.id !== id);
  }
}

export function createDemoClient(): VexaClient {
  return new DemoClient();
}
