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

/** Returned exactly once, at creation. The secret is never retrievable again. */
export const CreatedApiKey = ApiKeySummary.extend({
  secret: z.string().refine(isApiKey),
});
export type CreatedApiKey = z.infer<typeof CreatedApiKey>;
