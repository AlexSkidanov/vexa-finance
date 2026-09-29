import { z } from 'zod';

/**
 * Runtime configuration for the API process. `pnpm check-env` validates the
 * full environment, including workers and deploy tooling. This is the subset
 * the HTTP server needs to boot, and it fails fast on anything missing.
 */
const hex32 = z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 32 bytes hex');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  API_BASE_URL: z.url(),

  API_KEY_ENCRYPTION_KEY: hex32,
  WEBHOOK_SIGNING_SECRET: z.string().min(32),
  VIEW_KEY_ENCRYPTION_KEY: hex32,

  WEBAUTHN_RP_ID: z.string().min(1),
  WEBAUTHN_RP_NAME: z.string().min(1),
  WEBAUTHN_ORIGINS: z.string().transform((s) =>
    s
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  ),

  SUPABASE_URL: z.url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SUPABASE_DB_URL: z.string().regex(/^postgres(ql)?:\/\//),
  SUPABASE_JWT_SECRET: z.string().optional(),

  SOLANA_CLUSTER: z.enum(['devnet', 'mainnet-beta']),
  ALCHEMY_SOLANA_RPC_URL: z.url(),
  /** Base58 64-byte secret key, or a solana-keygen JSON array. Pays fees and sponsored rent. */
  SOLANA_FEE_PAYER_KEYPAIR: z.string().min(64),
  VAULT_PROGRAM_ID: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  USDC_MINT: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  CUSDC_MINT: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  // Inbound chain notifications. Without the signing key the receiver is disabled.
  ALCHEMY_WEBHOOK_SIGNING_KEY: z.string().optional(),
  ALCHEMY_WEBHOOK_ID: z.string().optional(),
  ALCHEMY_NOTIFY_AUTH_TOKEN: z.string().optional(),

  // Agents. Without a policy contract the /v1/agents routes are disabled.
  NEAR_RPC_URL: z.url().default('https://rpc.mainnet.near.org'),
  NEAR_DEPLOYER_ACCOUNT_ID: z.string().optional(),
  /** ed25519:<base58>: the relayer that pays for policy calls. */
  NEAR_DEPLOYER_PRIVATE_KEY: z.string().optional(),
  NEAR_POLICY_CONTRACT_ID: z.string().optional(),
  NEAR_MPC_CONTRACT_ID: z.string().default('v1.signer'),
});

export type Env = z.infer<typeof EnvSchema> & {
  /** API keys this deployment accepts. Mainnet runs `live`; devnet runs `test`. */
  API_ENVIRONMENT: 'live' | 'test';
};

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}\nRun pnpm check-env for details.`);
  }
  return {
    ...parsed.data,
    SUPABASE_JWT_SECRET: parsed.data.SUPABASE_JWT_SECRET || undefined,
    API_ENVIRONMENT: parsed.data.SOLANA_CLUSTER === 'mainnet-beta' ? 'live' : 'test',
  };
}
