/**
 * Identity verification: the interface Vexa's KYC provider will implement,
 * and a mock for development. `profiles.kyc_status` mirrors the outcome.
 *
 * TODO: implement with a provider (Persona or Sumsub): create an inquiry,
 * hand its hosted-flow URL to the client, and update the status from the
 * provider's signed webhook. Vexa stores the status only, never documents.
 */
import type { KycStatus } from './schemas.js';

export interface KycSession {
  id: string;
  userId: string;
  /** Where to send the user to verify. */
  url: string;
  status: KycStatus;
  createdAt: Date;
}

export interface KycProvider {
  start(input: { userId: string; email: string | null }): Promise<KycSession>;
  get(id: string): Promise<KycSession | null>;
  /** Parses the provider's webhook, after checking its signature. */
  parseWebhook(
    body: string,
    headers: Record<string, string>,
  ): Promise<{ sessionId: string; status: KycStatus }>;
}

/** Approves everyone after `start`, for development and tests. */
export function createMockKycProvider(): KycProvider {
  const sessions = new Map<string, KycSession>();
  return {
    async start({ userId }) {
      const session: KycSession = {
        id: crypto.randomUUID(),
        userId,
        url: 'https://example.invalid/kyc-mock',
        status: 'approved',
        createdAt: new Date(),
      };
      sessions.set(session.id, session);
      return session;
    },
    async get(id) {
      return sessions.get(id) ?? null;
    },
    async parseWebhook(body) {
      const { sessionId, status } = JSON.parse(body) as { sessionId: string; status: KycStatus };
      return { sessionId, status };
    },
  };
}
