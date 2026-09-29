/**
 * pnpm deploy:policy [--account vexa-policy.near] [--execute] [--env path]
 *
 * Deploys the NEAR policy contract (contracts/near-policy) to mainnet:
 *
 *   1. Creates the contract account through the `near` registrar, funded by
 *      the deployer (NEAR_DEPLOYER_ACCOUNT_ID) with the contract's storage
 *      deposit, and with a fresh full-access key saved to
 *      ~/.near-credentials/mainnet/<account>.json. That key can redeploy the
 *      contract; keep it offline like the vault's upgrade authority.
 *   2. Deploys target/near/vexa_near_policy.wasm (`cargo near build` first).
 *   3. Initializes it: the deployer is the relayer the API calls through,
 *      v1.signer's Ed25519 root key, the vault, the cUSDC mint and the fee payer.
 *   4. Writes NEAR_POLICY_CONTRACT_ID into .env.
 *
 * The account id is permanent in practice: agents' Solana addresses derive
 * from it. Without --execute it prints the plan and the exact NEAR needed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Encode } from '@vexa/core';
import { createNearClient, NEAR, TGAS } from '../apps/api/src/near/client.js';
import { arg, execute, fail, keypairBytes, loadEnv, ROOT } from './lib/solana.js';
import { createKeyPairSignerFromBytes } from '@solana/kit';

const WASM = join(ROOT, 'contracts/near-policy/target/near/vexa_near_policy.wasm');
/** yoctoNEAR per byte of storage. */
const STORAGE_BYTE_COST = 10n ** 19n;
/** State for the contract config and the first agents, on top of the code. */
const STATE_ALLOWANCE = NEAR / 10n;
const near = (y: bigint) => (Number(y) / 1e24).toFixed(4);

async function rpc<T>(url: string, method: string, params: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: unknown };
  if (body.error) throw Object.assign(new Error(JSON.stringify(body.error)), { error: body.error });
  return body.result as T;
}

async function main() {
  const env = loadEnv();
  const rpcUrl = env('NEAR_RPC_URL');
  const deployerId = env('NEAR_DEPLOYER_ACCOUNT_ID');
  const account = arg('account') ?? 'vexa-policy.near';
  if (!existsSync(WASM))
    throw new Error(
      'build the contract first: cd contracts/near-policy && cargo near build non-reproducible-wasm',
    );
  const code = readFileSync(WASM);

  const view = (id: string) =>
    rpc<{ amount: string; code_hash: string }>(rpcUrl, 'query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: id,
    }).catch(() => null);
  const [deployer, existing] = await Promise.all([view(deployerId), view(account)]);
  if (!deployer) throw new Error(`${deployerId} doesn't exist`);

  const storage = BigInt(code.length) * STORAGE_BYTE_COST + STATE_ALLOWANCE;
  const needed = existing ? 0n : storage;
  const gas = NEAR / 20n; // generous: account creation, deploy, init
  const balance = BigInt(deployer.amount);

  console.log(`\nNEAR policy contract (${execute ? 'EXECUTE' : 'dry run'})\n`);
  console.log(
    `  contract account  ${account} ${existing ? `(exists, code ${existing.code_hash})` : '(to create)'}`,
  );
  console.log(`  relayer           ${deployerId}`);
  console.log(`  wasm              ${code.length} bytes`);
  console.log(`  storage deposit   ${near(needed)} NEAR  (locked while the contract exists)`);
  console.log(`  gas               up to ${near(gas)} NEAR`);
  console.log(`  deployer holds    ${near(balance)} NEAR; keeps ≥ 0.2 NEAR to relay agent calls\n`);
  if (!execute) return console.log('Dry run. Re-run with --execute to deploy.\n');
  if (balance < needed + gas + NEAR / 5n)
    throw new Error(`send ${near(needed + gas + NEAR / 5n - balance)} more NEAR to ${deployerId}`);

  const deployerClient = createNearClient({
    rpcUrl,
    accountId: deployerId,
    privateKey: env('NEAR_DEPLOYER_PRIVATE_KEY'),
  });

  // 1. The contract account, with its own key.
  const credentials = join(homedir(), '.near-credentials/mainnet', `${account}.json`);
  let privateKey: string;
  if (existsSync(credentials)) {
    privateKey = (JSON.parse(readFileSync(credentials, 'utf8')) as { private_key: string })
      .private_key;
  } else {
    const seed = ed25519.utils.randomSecretKey();
    const publicKey = ed25519.getPublicKey(seed);
    privateKey = `ed25519:${base58Encode(new Uint8Array([...seed, ...publicKey]))}`;
    mkdirSync(join(homedir(), '.near-credentials/mainnet'), { recursive: true });
    writeFileSync(
      credentials,
      JSON.stringify({
        account_id: account,
        public_key: `ed25519:${base58Encode(publicKey)}`,
        private_key: privateKey,
      }),
      { mode: 0o600 },
    );
    console.log(`Saved the contract account's key to ${credentials}`);
  }
  if (!existing) {
    const publicKey = (JSON.parse(readFileSync(credentials, 'utf8')) as { public_key: string })
      .public_key;
    const { value } = await deployerClient.call<boolean>(
      'near',
      'create_account',
      { new_account_id: account, new_public_key: publicKey },
      { gas: 50n * TGAS, deposit: storage },
    );
    if (value === false) throw new Error(`the registrar refused to create ${account}`);
    console.log(`Created ${account}`);
  }

  // 2. The code, deployed by the contract account itself.
  const contract = createNearClient({ rpcUrl, accountId: account, privateKey });
  const deployTx = await contract.deploy(code);
  console.log(`Deployed: ${deployTx}`);

  // 3. Init (skipped if it already has state).
  const initialized = await contract
    .view<unknown>(account, 'agent_address', { agent_id: 'probe' })
    .then(
      () => true,
      () => false,
    );
  if (!initialized) {
    const mpcRoot = await contract.view<string>(env('NEAR_MPC_CONTRACT_ID'), 'public_key', {
      domain_id: 1,
    });
    const feePayer = await createKeyPairSignerFromBytes(
      keypairBytes(env('SOLANA_FEE_PAYER_KEYPAIR')),
    );
    const init = await contract.call(account, 'new', {
      relayer: deployerId,
      mpc: env('NEAR_MPC_CONTRACT_ID'),
      mpc_root: mpcRoot,
      vault_program: env('VAULT_PROGRAM_ID'),
      cusdc_mint: env('CUSDC_MINT'),
      fee_payer: feePayer.address,
    });
    console.log(`Initialized: ${init.txHash}`);
  }

  // 4. .env
  const envPath = arg('env') ?? join(ROOT, '.env');
  const current = readFileSync(envPath, 'utf8');
  writeFileSync(
    envPath,
    /^NEAR_POLICY_CONTRACT_ID=.*$/m.test(current)
      ? current.replace(/^NEAR_POLICY_CONTRACT_ID=.*$/m, `NEAR_POLICY_CONTRACT_ID=${account}`)
      : `${current.trimEnd()}\nNEAR_POLICY_CONTRACT_ID=${account}\n`,
  );
  console.log(`\nWrote NEAR_POLICY_CONTRACT_ID=${account} to ${envPath}`);
  console.log(
    `Example agent address: ${await contract.view<string>(account, 'agent_address', { agent_id: 'example' })}\n`,
  );
}

main().catch(fail);
