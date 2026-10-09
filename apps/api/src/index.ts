import { createPolicyContract } from './agents/policy.js';
import { createNearClient } from './near/client.js';
import { createOneClick } from './stealth/oneclick.js';
import { createZingoWallet } from './stealth/zcash.js';
import { startStealthWorker } from './stealth/worker.js';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadEnv } from './env.js';
import { createLogger } from './logger.js';
import { createSupabaseAuthProvider } from './lib/auth-provider.js';
import { createSupabaseTokenVerifier } from './lib/tokens.js';
import { createPostgresStore } from './store/postgres.js';
import { createRpcChain } from './chain/chain.js';
import { startWebhookWorker } from './workers/webhooks.js';
import { startIndexer } from './indexer/worker.js';
import { watchAddresses } from './indexer/notify.js';
import {
  ASSOCIATED_TOKEN_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  ZK_ELGAMAL_PROOF_PROGRAM,
} from '@vexa/core/solana';
import { address } from '@solana/kit';
import { findAta, findFeeSchedule, findVaultConfig, TOKEN_PROGRAM } from '@vexa/core/solana';

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
  fees: await findFeeSchedule(vaultProgram),
};
const chain = await createRpcChain({
  rpcUrl: env.ALCHEMY_SOLANA_RPC_URL,
  feePayerKeypair: env.SOLANA_FEE_PAYER_KEYPAIR,
});

const policy =
  env.NEAR_POLICY_CONTRACT_ID && env.NEAR_DEPLOYER_ACCOUNT_ID && env.NEAR_DEPLOYER_PRIVATE_KEY
    ? createPolicyContract({
        near: createNearClient({
          rpcUrl: env.NEAR_RPC_URL,
          accountId: env.NEAR_DEPLOYER_ACCOUNT_ID,
          privateKey: env.NEAR_DEPLOYER_PRIVATE_KEY,
        }),
        contractId: env.NEAR_POLICY_CONTRACT_ID,
        mpcContract: env.NEAR_MPC_CONTRACT_ID,
      })
    : null;
if (!policy) logger.warn('NEAR policy contract not configured: agents are disabled');

const stealth =
  env.STEALTH_ROUTE_SEED && env.ZCASH_SEED && env.ZCASH_BIRTHDAY
    ? {
        seed: env.STEALTH_ROUTE_SEED,
        oneClick: createOneClick({
          baseUrl: env.INTENTS_1CLICK_BASE_URL,
          apiKey: env.INTENTS_1CLICK_API_KEY,
        }),
        zcash: createZingoWallet({
          cliPath: env.ZINGO_CLI_PATH,
          dataDir: env.ZCASH_DATA_DIR,
          server: env.ZCASH_LIGHTWALLETD_URL,
          seed: env.ZCASH_SEED,
          birthday: env.ZCASH_BIRTHDAY,
          nymProxy: env.ZINGO_NYM_PROXY,
        }),
      }
    : null;
if (!stealth) logger.warn('stealth routing not configured: stealth transfers are disabled');

const app = createApp({
  env,
  logger,
  store,
  chain,
  vault,
  policy,
  stealth,
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

const stopWebhookWorker = startWebhookWorker({
  store,
  logger: logger.child({ worker: 'webhooks' }),
  masterSecret: env.WEBHOOK_SIGNING_SECRET,
});

const stopIndexer = startIndexer({
  store,
  logger: logger.child({ worker: 'indexer' }),
  vaultProgram: vault.program,
  ignore: new Set([
    chain.feePayer,
    vault.program,
    vault.config,
    vault.usdcMint,
    vault.cusdcMint,
    vault.usdcReserve,
    vault.fees,
    TOKEN_PROGRAM,
    TOKEN_2022_PROGRAM,
    ASSOCIATED_TOKEN_PROGRAM,
    SYSTEM_PROGRAM,
    ZK_ELGAMAL_PROOF_PROGRAM,
  ]),
});
// Make sure the reserve is watched, so every deposit reaches the indexer.
void watchAddresses({
  authToken: env.ALCHEMY_NOTIFY_AUTH_TOKEN,
  webhookId: env.ALCHEMY_WEBHOOK_ID,
  addresses: [vault.usdcReserve],
  logger,
});

const stopStealthWorker = stealth
  ? startStealthWorker({
      store,
      chain,
      vault,
      logger: logger.child({ worker: 'stealth' }),
      router: stealth,
    })
  : () => {};

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
    stopWebhookWorker();
    stopIndexer();
    stopStealthWorker();
    server.close(async () => {
      await store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
