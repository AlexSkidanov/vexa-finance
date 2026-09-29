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
  kind: z.enum(['configure', 'deposit', 'apply-pending', 'transfer', 'withdraw']),
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
  /** `@alice.vexa`, `@alice` or `alice`. */
  to: z.string().min(1).max(40),
  mode: z.enum(['standard', 'stealth']).default('standard'),
});
export type PrepareTransferRequest = z.input<typeof PrepareTransferRequest>;

const Base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'must be base64');

export const SubmitTransferRequest = z.object({
  transferId: z.uuid(),
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
