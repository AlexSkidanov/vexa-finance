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
