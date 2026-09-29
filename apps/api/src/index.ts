import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadEnv } from './env.js';
import { createLogger } from './logger.js';
import { createSupabaseAuthProvider } from './lib/auth-provider.js';
import { createSupabaseTokenVerifier } from './lib/tokens.js';
import { createPostgresStore } from './store/postgres.js';
import { createRpcChain } from './chain/chain.js';
import { address } from '@solana/kit';
import { findAta, findVaultConfig, TOKEN_PROGRAM } from '@vexa/core/solana';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL, env.NODE_ENV === 'development');
const store = createPostgresStore(env.SUPABASE_DB_URL);

const vaultProgram = address(env.VAULT_PROGRAM_ID);
const config = await findVaultConfig(vaultProgram);
const vault = {
  program: vaultProgram,
  config,
  usdcMint: address(env.USDC_MINT),
  cusdcMint: address(env.CUSDC_MINT),
  usdcReserve: await findAta(config, address(env.USDC_MINT), TOKEN_PROGRAM),
};
const chain = await createRpcChain({
  rpcUrl: env.ALCHEMY_SOLANA_RPC_URL,
  feePayerKeypair: env.SOLANA_FEE_PAYER_KEYPAIR,
});

const app = createApp({
  env,
  logger,
  store,
  chain,
  vault,
  version:
    process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? process.env.npm_package_version ?? 'dev',
  auth: createSupabaseAuthProvider({
    url: env.SUPABASE_URL,
    anonKey: env.SUPABASE_ANON_KEY,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  }),
  tokens: createSupabaseTokenVerifier({
    supabaseUrl: env.SUPABASE_URL,
    legacySecret: env.SUPABASE_JWT_SECRET,
  }),
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info(
    { port: info.port, cluster: env.SOLANA_CLUSTER, environment: env.API_ENVIRONMENT },
    'vexa api listening',
  );
});

// Railway sends SIGTERM on redeploy. Stop accepting connections, let in-flight
// requests finish, then close the database pool.
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      await store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
