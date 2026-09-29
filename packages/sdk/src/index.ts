/**
 * @vexa/sdk: typed client for the Vexa API.
 *
 *   import { Vexa } from '@vexa/sdk';
 *
 *   const vexa = new Vexa({ apiKey: process.env.VEXA_API_KEY });
 *   const alice = await vexa.handles.resolve('@alice.vexa');
 *
 * Every create call sends an Idempotency-Key and reuses it across automatic
 * retries, so a flaky network can never make the same request twice.
 */
import {
  apiKeyEnvironment,
  type WebhookEventType,
  type WebhookVerification,
  handleClaimMessage,
  normalizeHandle,
  type ApiEnvironment,
  type ApiKeySummary,
  type CreatedApiKey,
  type HandleResolution,
  type Profile,
  type Session,
} from '@vexa/core';
import { request, VexaError, type HttpOptions, type RequestOptions } from './http.js';
import { createPasskey, getPasskeyAssertion } from './passkeys.js';
import { Money } from './money.js';
import { Agents } from './agents.js';
import { DEFAULT_BASE_URLS } from './base-urls.js';

export { VexaError };
/** Verify webhook deliveries locally: `verifyWebhookSignature({ payload, header, secret })`. */
export {
  signWebhookPayload,
  verifyWebhookSignature,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  type WebhookEventType,
  type WebhookVerification,
} from '@vexa/core';
export type { ActivityMovement, ActivityTransfer, Balance, FeeQuote, TierInfo } from './money.js';
export type { AgentPolicyInput, AgentState, AgentSummary, AgentsConfig } from './agents.js';
export {
  parseX402Payment,
  VexaAgent,
  X402_NETWORK,
  X402_SCHEME,
  type PaymentRequirements,
  type PaymentResult,
  type VexaAgentOptions,
} from './agent.js';
export type { ApiKeySummary, CreatedApiKey, HandleResolution, Profile, Session };

export { DEFAULT_BASE_URLS } from './base-urls.js';

export interface VexaOptions {
  /** A `vx_live_…` or `vx_test_…` key. Picks the environment and base URL. */
  apiKey?: string;
  /** A session access token, for apps acting as a signed-in user. */
  accessToken?: string;
  /** Overrides the base URL inferred from the key (e.g. a local API). */
  baseUrl?: string;
  /** Automatic retries for network errors and 5xx. Default 2. */
  maxRetries?: number;
  fetch?: typeof fetch;
}

/** Keys the SDK needs to claim a handle; produce them with deriveUserKeys(). */
export interface ClaimKeys {
  solanaAddress: string;
  elgamalPubkey: string;
  /** Signs the claim message with the user's Solana key. */
  sign: (message: Uint8Array) => string | Promise<string>;
}

export class Vexa {
  readonly environment: ApiEnvironment;
  readonly baseUrl: string;
  private accessToken: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly http: HttpOptions;

  constructor(options: VexaOptions = {}) {
    if (options.apiKey) {
      const env = apiKeyEnvironment(options.apiKey);
      if (!env) throw new Error('apiKey must look like vx_live_… or vx_test_…');
      this.environment = env;
    } else {
      this.environment = 'live';
    }
    this.apiKey = options.apiKey;
    this.accessToken = options.accessToken;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URLS[this.environment]).replace(/\/$/, '');
    this.http = {
      baseUrl: this.baseUrl,
      getToken: () => this.accessToken ?? this.apiKey,
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      maxRetries: options.maxRetries ?? 2,
    };
  }

  /** Use a session from verifyOtp / passkey sign-in for subsequent calls. */
  setSession(session: Pick<Session, 'accessToken'> | null): void {
    this.accessToken = session?.accessToken;
  }

  private async call<T>(method: string, path: string, opts?: RequestOptions): Promise<T> {
    return (await request<T>(this.http, method, path, opts)).data;
  }

  // -------------------------------------------------------------------------

  readonly auth = {
    /** Emails a one-time code. Always resolves, whether or not the address has an account. */
    sendOtp: (email: string) =>
      this.call<{ sent: true }>('POST', '/v1/auth/otp', { body: { email }, auth: false }),

    /** Exchanges the emailed code for a session and starts using it. */
    verifyOtp: async (email: string, token: string) => {
      const session = await this.call<Session>('POST', '/v1/auth/otp/verify', {
        body: { email, token },
        auth: false,
      });
      this.setSession(session);
      return session;
    },

    refresh: async (refreshToken: string) => {
      const session = await this.call<Session>('POST', '/v1/auth/refresh', {
        body: { refreshToken },
        auth: false,
      });
      this.setSession(session);
      return session;
    },
  };

  readonly passkeys = {
    /** Registers a new passkey for the signed-in user (browser only). */
    register: async (name?: string) => {
      const { challengeId, options } = await this.call<{
        challengeId: string;
        options: Record<string, unknown>;
      }>('POST', '/v1/auth/passkeys/register/options');
      const response = await createPasskey(options);
      return this.call<{ id: string; backedUp: boolean }>(
        'POST',
        '/v1/auth/passkeys/register/verify',
        {
          body: { challengeId, response, ...(name ? { name } : {}) },
        },
      );
    },

    /**
     * Signs in with a passkey (browser only). Also returns the passkey's PRF
     * output. Pass it to `deriveUserKeys()` from `@vexa/core/crypto` to get the
     * user's wallet and encryption keys. It never leaves the device.
     */
    signIn: async (prfInput: Uint8Array) => {
      const { challengeId, options } = await this.call<{
        challengeId: string;
        options: Record<string, unknown>;
      }>('POST', '/v1/auth/passkeys/login/options', { body: {}, auth: false });
      const { assertion, prfOutput } = await getPasskeyAssertion(options, prfInput);
      const session = await this.call<Session>('POST', '/v1/auth/passkeys/login/verify', {
        body: { challengeId, response: assertion },
        auth: false,
      });
      this.setSession(session);
      return { session, prfOutput };
    },
  };

  readonly handles = {
    /**
     * Claims `@handle.vexa` for the signed-in user and binds it to their keys.
     * The claim is signed with the user's Solana key to prove they hold it.
     */
    claim: async (handle: string, keys: ClaimKeys, opts: { idempotencyKey?: string } = {}) => {
      const me = await this.me();
      const bare = normalizeHandle(handle);
      const message = handleClaimMessage({
        handle: bare,
        userId: me.userId,
        solanaPubkey: keys.solanaAddress,
        elgamalPubkey: keys.elgamalPubkey,
      });
      return this.call<Profile>('POST', '/v1/handles/claim', {
        idempotencyKey: opts.idempotencyKey ?? true,
        body: {
          handle: bare,
          solanaPubkey: keys.solanaAddress,
          elgamalPubkey: keys.elgamalPubkey,
          signature: await keys.sign(message),
        },
      });
    },

    /** Looks up the keys needed to pay a handle. Accepts `alice`, `@alice` or `@alice.vexa`. */
    resolve: (handle: string) =>
      this.call<HandleResolution>(
        'GET',
        `/v1/handles/${encodeURIComponent(normalizeHandle(handle))}/resolve`,
      ),
  };

  readonly apiKeys = {
    /** The returned `secret` is shown once. Store it somewhere safe. */
    create: (name: string, opts: { idempotencyKey?: string } = {}) =>
      this.call<CreatedApiKey>('POST', '/v1/api-keys', {
        body: { name },
        idempotencyKey: opts.idempotencyKey ?? true,
      }),
    list: async () => (await this.call<{ data: ApiKeySummary[] }>('GET', '/v1/api-keys')).data,
    revoke: (id: string) => this.call<void>('DELETE', `/v1/api-keys/${encodeURIComponent(id)}`),
  };

  readonly webhooks = {
    /** The returned `secret` is shown once; store it to verify deliveries. */
    create: (url: string, events: WebhookEventType[], opts: { idempotencyKey?: string } = {}) =>
      this.call<{ id: string; url: string; events: string[]; createdAt: string; secret?: string }>(
        'POST',
        '/v1/webhooks',
        { body: { url, events }, idempotencyKey: opts.idempotencyKey ?? true },
      ),
    list: async () =>
      (
        await this.call<{
          data: { id: string; url: string; events: string[]; createdAt: string }[];
        }>('GET', '/v1/webhooks')
      ).data,
    remove: (id: string) => this.call<void>('DELETE', `/v1/webhooks/${encodeURIComponent(id)}`),
    /** Asks the API to check a signature with the stored secret. Prefer verifying locally. */
    verify: (webhookId: string, payload: string, signature: string) =>
      this.call<WebhookVerification>('POST', '/v1/webhooks/verify', {
        body: { webhookId, payload, signature },
      }),
  };

  /** Deposits, confidential transfers, withdrawals, balances and activity. */
  readonly money: Money = new Money((method, path, opts) => this.call(method, path, opts));

  /** Your agents: create, limit, fund, pause, revoke, sweep. */
  readonly agents: Agents = new Agents((method, path, opts) => this.call(method, path, opts));

  me(): Promise<Profile> {
    return this.call<Profile>('GET', '/v1/me');
  }
}
