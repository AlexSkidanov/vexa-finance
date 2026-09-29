/**
 * Request and response shapes shared by the API and the SDK. The API validates
 * incoming requests with these schemas and the SDK derives its types from them,
 * so the two can't drift apart silently.
 */
import { z } from 'zod';
import { isApiKey } from './api-keys.js';
import { isElGamalPubkey, isSolanaAddress } from './keys.js';
import { validateHandle } from './handles.js';

export const SolanaAddress = z
  .string()
  .refine(isSolanaAddress, 'must be a base58-encoded 32-byte Solana address');

export const ElGamalPubkey = z
  .string()
  .refine(isElGamalPubkey, 'must be a base64-encoded Ristretto255 point (ElGamal public key)');

export const SolanaSignature = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/, 'must be a base58-encoded ed25519 signature');

export const Handle = z.string().transform((value, ctx) => {
  const result = validateHandle(value);
  if (!result.ok) {
    ctx.addIssue({ code: 'custom', message: `handle ${result.reason.replace(/_/g, ' ')}` });
    return z.NEVER;
  }
  return result.handle;
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const SendOtpRequest = z.object({ email: z.email() });
export type SendOtpRequest = z.infer<typeof SendOtpRequest>;

export const VerifyOtpRequest = z.object({
  email: z.email(),
  token: z.string().regex(/^\d{6,10}$/, 'must be the numeric code from the email'),
});
export type VerifyOtpRequest = z.infer<typeof VerifyOtpRequest>;

export const RefreshSessionRequest = z.object({ refreshToken: z.string().min(10) });
export type RefreshSessionRequest = z.infer<typeof RefreshSessionRequest>;

export const Session = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number().int(),
  user: z.object({ id: z.uuid(), email: z.string().nullable() }),
});
export type Session = z.infer<typeof Session>;

/** WebAuthn payloads are validated by @simplewebauthn/server; here we only check the envelope. */
export const PasskeyRegistrationVerifyRequest = z.object({
  challengeId: z.uuid(),
  response: z.record(z.string(), z.unknown()),
  name: z.string().trim().min(1).max(64).optional(),
});
export type PasskeyRegistrationVerifyRequest = z.infer<typeof PasskeyRegistrationVerifyRequest>;

export const PasskeyLoginOptionsRequest = z.object({ email: z.email().optional() });
export type PasskeyLoginOptionsRequest = z.infer<typeof PasskeyLoginOptionsRequest>;

export const PasskeyLoginVerifyRequest = z.object({
  challengeId: z.uuid(),
  response: z.record(z.string(), z.unknown()),
});
export type PasskeyLoginVerifyRequest = z.infer<typeof PasskeyLoginVerifyRequest>;

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

export const ClaimHandleRequest = z.object({
  handle: Handle,
  solanaPubkey: SolanaAddress,
  elgamalPubkey: ElGamalPubkey,
  /** ed25519 signature by `solanaPubkey` over `handleClaimMessage(...)`. */
  signature: SolanaSignature,
});
export type ClaimHandleRequest = z.input<typeof ClaimHandleRequest>;

export const HandleResolution = z.object({
  handle: z.string(),
  display: z.string(),
  kind: z.enum(['user', 'agent']),
  solanaPubkey: z.string(),
  elgamalPubkey: z.string(),
});
export type HandleResolution = z.infer<typeof HandleResolution>;

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export const KycStatus = z.enum(['none', 'pending', 'approved', 'rejected']);
export type KycStatus = z.infer<typeof KycStatus>;

export const Profile = z.object({
  userId: z.uuid(),
  email: z.string().nullable(),
  handle: z.string().nullable(),
  solanaPubkey: z.string().nullable(),
  elgamalPubkey: z.string().nullable(),
  kycStatus: KycStatus,
  tier: z.number().int().min(0),
  createdAt: z.string(),
});
export type Profile = z.infer<typeof Profile>;

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export const CreateApiKeyRequest = z.object({
  name: z.string().trim().min(1).max(64),
});
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequest>;

export const ApiKeySummary = z.object({
  id: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  environment: z.enum(['live', 'test']),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type ApiKeySummary = z.infer<typeof ApiKeySummary>;

/**
 * Returned at creation. `secret` is present exactly once: an idempotent replay
 * of the same request returns the summary without it.
 */
export const CreatedApiKey = ApiKeySummary.extend({
  secret: z.string().refine(isApiKey).optional(),
});
export type CreatedApiKey = z.infer<typeof CreatedApiKey>;

// ---------------------------------------------------------------------------
// Money: every movement is a plan of transactions built and signed on the
// user's device (see @vexa/core/solana). The API validates and co-signs.
// ---------------------------------------------------------------------------

export const CompiledPlanSchema = z.object({
  kind: z.enum([
    'configure',
    'deposit',
    'apply-pending',
    'transfer',
    'withdraw',
    'stake',
    'unstake',
    'agent-configure',
    'agent-apply-pending',
    'agent-payment',
    'agent-sweep',
  ]),
  stages: z
    .array(
      z
        .array(z.object({ label: z.string().max(64), transaction: z.string().max(2048) }))
        .min(1)
        .max(3),
    )
    .min(1)
    .max(4),
});
export type CompiledPlanInput = z.infer<typeof CompiledPlanSchema>;

export const SubmitPlanRequest = z.object({ plan: CompiledPlanSchema });
export type SubmitPlanRequest = z.infer<typeof SubmitPlanRequest>;

export const PrepareTransferRequest = z.object({
  /** `@alice.vexa`, `@alice` or `alice`; or `agent:<id>` to fund one of your agents. */
  to: z.string().min(1).max(48),
  mode: z.enum(['standard', 'stealth']).default('standard'),
  /** Set when one of your agents is the payer. */
  agentId: z.uuid().optional(),
});
export type PrepareTransferRequest = z.input<typeof PrepareTransferRequest>;

const Base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'must be base64');

export const SubmitTransferRequest = z.object({
  transferId: z.uuid(),
  /**
   * Stealth transfers only: the amount encrypted to the sender's own AE key,
   * so their activity can show it. Nobody else can read it.
   */
  senderNote: Base64.max(64).optional(),
  plan: CompiledPlanSchema,
  /** Encrypted on the device to the recipient; the API stores it opaquely. */
  memoCiphertext: Base64.max(1400).optional(),
});
export type SubmitTransferRequest = z.infer<typeof SubmitTransferRequest>;

export const WithdrawRequest = z.object({
  plan: CompiledPlanSchema,
  /** An existing USDC token account receiving the funds. */
  destinationAccount: SolanaAddress,
});
export type WithdrawRequest = z.infer<typeof WithdrawRequest>;

/** Chain context a device needs to build plans. Lamport values are strings. */
export const ChainContext = z.object({
  cluster: z.enum(['mainnet-beta', 'devnet']),
  feePayer: z.string(),
  vault: z.object({
    program: z.string(),
    config: z.string(),
    usdcMint: z.string(),
    cusdcMint: z.string(),
    usdcReserve: z.string(),
    fees: z.string(),
  }),
  /** The vault's fee schedule; null until the admin sets one (money can't move before). */
  feeSchedule: z
    .object({
      feeBps: z.number().int(),
      feeCap: z.string(),
      treasury: z.string(),
      vexaMint: z.string().nullable(),
      tiers: z.array(z.object({ minBalance: z.string(), discountBps: z.number().int() })),
    })
    .nullable(),
  auditorElgamalPubkey: z.string().nullable(),
  rent: z.object({
    confidentialAccount: z.string(),
    equalityContext: z.string(),
    validityContext: z.string(),
    rangeU128Context: z.string(),
    rangeU64Context: z.string(),
    stakeRecord: z.string(),
    tokenAccount: z.string(),
  }),
  blockhash: z.string(),
  lastValidBlockHeight: z.string(),
});
export type ChainContext = z.infer<typeof ChainContext>;

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export const CreateWebhookRequest = z.object({
  url: z
    .url()
    .refine((u) => u.startsWith('https://'), 'must be https')
    .refine((u) => {
      const host = new URL(u).hostname;
      // No deliveries to loopback or private networks.
      return !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|\[?::1\]?$|\[?f[cd])/i.test(
        host,
      );
    }, 'must be a public host'),
  events: z.array(z.enum(['transfer.settled', 'deposit.confirmed', 'withdrawal.sent'])).min(1),
});
export type CreateWebhookRequest = z.infer<typeof CreateWebhookRequest>;

export const VerifyWebhookRequest = z.object({
  webhookId: z.uuid(),
  payload: z.string().max(65536),
  signature: z.string().max(1024),
});
export type VerifyWebhookRequest = z.infer<typeof VerifyWebhookRequest>;

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const Base58Key = SolanaAddress;
const Base58Signature = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/, 'must be a base58 signature');
const UsdcAmount = z.string().regex(/^\d{1,19}$/, 'USDC base units, as an integer string');
const Domain = z
  .string()
  .max(253)
  .regex(/^(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/, 'must be a lowercase domain name');

export const AgentPolicy = z
  .object({
    /** USDC base units. */
    maxPerRequest: UsdcAmount,
    /** USDC base units per rolling 24 hours. */
    dailyLimit: UsdcAmount,
    /** cUSDC accounts the agent may pay. Empty: any. */
    allowedRecipients: z.array(Base58Key).max(32).default([]),
    /** Domains the agent may pay for (x402). Empty: any. */
    allowedDomains: z.array(Domain).max(32).default([]),
  })
  .refine((p) => BigInt(p.maxPerRequest) <= BigInt(p.dailyLimit), {
    message: 'maxPerRequest can’t exceed dailyLimit',
  });
export type AgentPolicy = z.input<typeof AgentPolicy>;

/** Owner-authorized: `ownerSignature` is by the owner's Solana key (see @vexa/core/agent). */
export const CreateAgentRequest = z.object({
  /** Chosen by the client: agent keys and the agent's address derive from it. */
  id: z.uuid(),
  name: z.string().trim().min(1).max(64).optional(),
  authority: Base58Key,
  elgamalPubkey: Base64,
  policy: AgentPolicy,
  ownerSignature: Base58Signature,
});
export type CreateAgentRequest = z.input<typeof CreateAgentRequest>;

const OwnerAuthorization = z.object({
  /** The agent's current `authNonce`. */
  nonce: z.string().regex(/^\d+$/),
  ownerSignature: Base58Signature,
});

export const UpdateAgentPolicyRequest = OwnerAuthorization.extend({ policy: AgentPolicy });
export type UpdateAgentPolicyRequest = z.input<typeof UpdateAgentPolicyRequest>;

export const SetAgentPausedRequest = OwnerAuthorization.extend({ paused: z.boolean() });
export type SetAgentPausedRequest = z.input<typeof SetAgentPausedRequest>;

export const RevokeAgentRequest = OwnerAuthorization;
export type RevokeAgentRequest = z.input<typeof RevokeAgentRequest>;

/** A plan with a transaction the agent signs through NEAR. */
export const AgentPlanRequest = z.object({
  plan: CompiledPlanSchema,
  signer: z.enum(['agent', 'owner']),
  nonce: z.string().regex(/^\d+$/),
  /** Over the authorization message for `sign` (see @vexa/core/agent). */
  signature: Base58Signature,
});
export type AgentPlanRequest = z.input<typeof AgentPlanRequest>;

export const AgentPaymentRequest = AgentPlanRequest.extend({
  transferId: z.uuid(),
  index: z.string().regex(/^\d+$/),
  windowStart: z.string().regex(/^\d+$/),
  domain: Domain.optional(),
  /** `proof_type ‖ context` of the validity and limit proofs. */
  validityContext: Base64,
  limitContext: Base64,
  memoCiphertext: Base64.optional(),
});
export type AgentPaymentRequest = z.input<typeof AgentPaymentRequest>;

export const AgentTraceRequest = z.object({
  requestId: z.string().max(128).optional(),
  step: z.enum([
    'request',
    'payment_required',
    'quote',
    'policy_check',
    'paid',
    'retried',
    'completed',
    'failed',
  ]),
  /** What happened: URL, recipient, outcome. Never an amount. */
  detail: z
    .record(z.string(), z.union([z.string().max(512), z.number(), z.boolean(), z.null()]))
    .default({}),
});
export type AgentTraceRequest = z.input<typeof AgentTraceRequest>;

// ---------------------------------------------------------------------------
// View keys
// ---------------------------------------------------------------------------

export const CreateViewKeyRequest = z
  .object({
    /** Chosen by the client: the view key derives from it. */
    id: z.uuid(),
    label: z.string().trim().min(1).max(64).optional(),
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    /** Hex SHA-256 of the key's access secret (see @vexa/core/crypto). */
    accessHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .refine((v) => new Date(v.from) < new Date(v.to), { message: 'from must be before to' });
export type CreateViewKeyRequest = z.input<typeof CreateViewKeyRequest>;

export const AddViewRecordsRequest = z.object({
  records: z
    .array(z.object({ transferId: z.uuid(), record: Base64.max(5600) }))
    .min(1)
    .max(200),
});
export type AddViewRecordsRequest = z.input<typeof AddViewRecordsRequest>;
