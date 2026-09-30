/**
 * Everything the screens need from Vexa, in one place. The real client wraps
 * @vexa/sdk and holds the user's keys in memory; the demo client fakes it with
 * sample data. Screens only ever see this interface.
 */
import type {
  ActivityMovement,
  ActivityTransfer,
  AgentPolicyInput,
  AgentSummary,
  ApiKeySummary,
  Balance,
  CreatedApiKey,
  FeeQuote,
  HandleResolution,
  Profile,
  TierInfo,
  ViewKeySummary,
} from '@vexa/sdk';
import type { StealthStatus } from './stealth';

export type Activity = ActivityTransfer | ActivityMovement;
export type {
  ActivityMovement,
  ActivityTransfer,
  AgentPolicyInput,
  AgentSummary,
  ApiKeySummary,
  Balance,
  CreatedApiKey,
  FeeQuote,
  HandleResolution,
  Profile,
  TierInfo,
  ViewKeySummary,
};

export interface TransferStatus {
  id: string;
  status: string;
  mode?: 'standard' | 'stealth';
  txSig: string | null;
  stealth?: { status: StealthStatus; updatedAt: string };
}

export interface AgentFunds {
  status: AgentSummary['status'];
  available: bigint;
  pending: bigint;
  /** Paid in the rolling 24-hour window the policy's daily limit covers. */
  spentToday: bigint;
}

export interface AgentTrace {
  id: string;
  requestId: string | null;
  step: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export type WebhookEvent = 'transfer.settled' | 'deposit.confirmed' | 'withdrawal.sent';
export const WEBHOOK_EVENTS: WebhookEvent[] = [
  'transfer.settled',
  'deposit.confirmed',
  'withdrawal.sent',
];

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  createdAt: string;
  secret?: string;
}

export interface Unlocked {
  profile: Profile;
  /** The confidential cUSDC account exists. */
  accountOpen: boolean;
}

export interface VexaClient {
  readonly demo: boolean;

  // Session and keys
  hasSession(): boolean;
  /** A passkey has been registered or used for this session's account. */
  hasPasskey(): boolean;
  isUnlocked(): boolean;
  sendOtp(email: string): Promise<void>;
  /** Verifies the code and returns the account's profile, if it has one yet. */
  verifyOtp(email: string, code: string): Promise<Profile | null>;
  registerPasskey(): Promise<void>;
  /**
   * Passkey sign-in; derives the keys from its PRF output and keeps them in
   * memory. `sameAccount` refuses a passkey that belongs to another account
   * (used right after sign-up, when the session came from the email code).
   */
  unlock(opts?: { sameAccount?: boolean }): Promise<Unlocked>;
  lock(): void;
  signOut(): void;
  me(): Promise<Profile>;
  /** The user's Solana address (their USDC deposit address). */
  address(): string;

  // Onboarding
  handleAvailable(handle: string): Promise<boolean>;
  claimHandle(handle: string, idempotencyKey: string): Promise<Profile>;
  openAccount(): Promise<void>;

  // Money
  resolve(handle: string): Promise<HandleResolution>;
  balance(): Promise<Balance>;
  /** Plain USDC sitting in the wallet, or null when there's no way to read it. */
  walletUsdc(): Promise<bigint | null>;
  applyPending(): Promise<void>;
  quote(amount: bigint): Promise<FeeQuote>;
  deposit(amount: bigint): Promise<{ id: string; txSig: string | null } & FeeQuote>;
  withdraw(amount: bigint, to: string): Promise<{ id: string; txSig: string | null } & FeeQuote>;
  transfer(input: {
    to: string;
    amount: bigint;
    memo?: string;
    mode: 'standard' | 'stealth';
    idempotencyKey: string;
  }): Promise<{ id: string; txSig: string | null }>;
  transferStatus(id: string): Promise<TransferStatus>;
  activity(opts?: { limit?: number; before?: string }): Promise<Activity[]>;
  tier(): Promise<TierInfo>;
  stake(amount: bigint): Promise<void>;
  unstake(amount: bigint): Promise<void>;

  // Agents
  agents(): Promise<AgentSummary[]>;
  agent(id: string): Promise<AgentSummary>;
  agentFunds(id: string): Promise<AgentFunds>;
  createAgent(input: {
    name?: string;
    policy: AgentPolicyInput;
  }): Promise<{ agent: AgentSummary; credential: string }>;
  credentialFor(id: string): string;
  updateAgentPolicy(id: string, policy: AgentPolicyInput): Promise<AgentSummary>;
  pauseAgent(id: string): Promise<void>;
  resumeAgent(id: string): Promise<void>;
  revokeAgent(id: string): Promise<void>;
  /** Takes everything the agent holds back; returns how much. */
  sweepAgent(id: string): Promise<bigint>;
  fundAgent(id: string, amount: bigint, idempotencyKey: string): Promise<void>;
  agentTraces(id: string): Promise<AgentTrace[]>;
  /** A handle's cUSDC account, the form agent allowlists take. */
  recipientAccount(handle: string): Promise<{ display: string; account: string }>;

  // View keys
  viewKeys(): Promise<ViewKeySummary[]>;
  createViewKey(input: {
    label?: string;
    from: Date;
    to: Date;
  }): Promise<{ id: string; viewKey: string; recorded: number }>;
  viewKeyFor(id: string): string;
  syncViewKeys(): Promise<number>;
  revokeViewKey(id: string): Promise<void>;

  // Developers
  apiKeys(): Promise<ApiKeySummary[]>;
  createApiKey(name: string, idempotencyKey: string): Promise<CreatedApiKey>;
  revokeApiKey(id: string): Promise<void>;
  webhooks(): Promise<Webhook[]>;
  createWebhook(url: string, events: WebhookEvent[], idempotencyKey: string): Promise<Webhook>;
  removeWebhook(id: string): Promise<void>;
}
