/**
 * pnpm deploy:vault [--execute] [--env path/to/.env]
 *
 * Deploys programs/vault to the cluster in .env and sets it up:
 *
 *   1. Deploys target/deploy/vault.so with the admin key as upgrade authority.
 *   2. In ONE transaction: creates the cUSDC Token-2022 mint (ConfidentialTransfer,
 *      auto-approve on, no auditor yet, mint authority = vault config PDA, no
 *      freeze authority) and calls vault.initialize. Doing both atomically
 *      leaves no window in which the mint exists without the vault owning it.
 *   3. Writes VAULT_PROGRAM_ID and CUSDC_MINT back into .env.
 *
 * Without --execute it only prints the plan and the exact SOL required.
 * Safe to rerun: finished steps are detected and skipped.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase58Decoder,
  getBase58Encoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  getInitializeConfidentialTransferMintInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFlag = process.argv.indexOf('--env');
const ENV_PATH =
  envFlag > -1 && process.argv[envFlag + 1]
    ? resolve(process.argv[envFlag + 1]!)
    : join(ROOT, '.env');
const SO_PATH = join(ROOT, 'target/deploy/vault.so');
const PROGRAM_KEYPAIR = join(ROOT, 'target/deploy/vault-keypair.json');
const execute = process.argv.includes('--execute');

const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
const UPGRADEABLE_LOADER = address('BPFLoaderUpgradeab1e11111111111111111111111');
const LAMPORTS = 1_000_000_000;

config({ path: ENV_PATH, quiet: true });
const env = (k: string) => {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`${k} is not set in .env`);
  return v;
};

function keypairBytes(raw: string): Uint8Array {
  return raw.startsWith('[')
    ? Uint8Array.from(JSON.parse(raw))
    : new Uint8Array(getBase58Encoder().encode(raw));
}

const sol = (lamports: bigint | number) => (Number(lamports) / LAMPORTS).toFixed(6);

async function main() {
  const rpcUrl = env('ALCHEMY_SOLANA_RPC_URL');
  const rpc = createSolanaRpc(rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(websocketUrl(rpcUrl));
  const admin = await createKeyPairSignerFromBytes(keypairBytes(env('SOLANA_ADMIN_KEYPAIR')));
  const usdcMint = address(env('USDC_MINT'));
  const programKeypair = await createKeyPairSignerFromBytes(
    Uint8Array.from(JSON.parse(readFileSync(PROGRAM_KEYPAIR, 'utf8'))),
  );
  const programId = programKeypair.address;

  const [config] = await getProgramDerivedAddress({ programAddress: programId, seeds: ['config'] });
  const [programData] = await getProgramDerivedAddress({
    programAddress: UPGRADEABLE_LOADER,
    seeds: [getAddressEncoder().encode(programId)],
  });
  const [reserve] = await getProgramDerivedAddress({
    programAddress: ATA_PROGRAM,
    seeds: [
      getAddressEncoder().encode(config),
      getAddressEncoder().encode(TOKEN_PROGRAM),
      getAddressEncoder().encode(usdcMint),
    ],
  });

  // ---- Plan and cost -------------------------------------------------------
  if (!existsSync(SO_PATH))
    throw new Error('target/deploy/vault.so not found. Run `pnpm build:vault` first.');
  const soLen = statSync(SO_PATH).size;
  const mintSize = getMintSize([
    {
      __kind: 'ConfidentialTransferMint',
      authority: admin.address,
      autoApproveNewAccounts: true,
      auditorElgamalPubkey: null,
    },
  ]);
  const rent = async (n: number) => rpc.getMinimumBalanceForRentExemption(BigInt(n)).send();

  const deployed = await isDeployed(rpc, programId);
  const initialized =
    (await rpc.getAccountInfo(config, { encoding: 'base64' }).send()).value !== null;

  const writeTxs = Math.ceil(soLen / 1012);
  const costs = {
    programData: deployed ? 0n : await rent(45 + soLen),
    program: deployed ? 0n : await rent(36),
    uploadFees: deployed ? 0n : BigInt(writeTxs * 5000 + 20_000),
    mint: initialized ? 0n : await rent(mintSize),
    config: initialized ? 0n : await rent(8 + 130),
    reserve: initialized ? 0n : await rent(165),
    setupFees: initialized ? 0n : 10_000n,
  };
  const total = Object.values(costs).reduce((a, b) => a + b, 0n);
  const balance = (await rpc.getBalance(admin.address).send()).value;

  console.log(`\nVault deploy plan (${execute ? 'EXECUTE' : 'dry run'})\n`);
  console.log(`  program id     ${programId}`);
  console.log(`  admin          ${admin.address}`);
  console.log(`  config PDA     ${config}`);
  console.log(`  USDC reserve   ${reserve}`);
  console.log(`  program size   ${soLen} bytes (${writeTxs} upload transactions)\n`);
  console.log(
    `  1. deploy program        ${deployed ? 'already done' : `${sol(costs.programData + costs.program)} SOL rent + ${sol(costs.uploadFees)} SOL fees`}`,
  );
  console.log(
    `  2. create mint + init    ${initialized ? 'already done' : `${sol(costs.mint + costs.config + costs.reserve)} SOL rent + ${sol(costs.setupFees)} SOL fees`}`,
  );
  console.log(`\n  required ${sol(total)} SOL, admin holds ${sol(balance)} SOL`);

  if (balance < total) {
    console.log(
      `\n  Short by ${sol(total - balance)} SOL. Send it to ${admin.address}, then rerun.\n`,
    );
    process.exit(1);
  }
  if (!execute) {
    console.log('\n  Balance is sufficient. Rerun with --execute to deploy.\n');
    return;
  }

  // ---- 1. Deploy -----------------------------------------------------------
  if (!deployed) {
    const dir = mkdtempSync(join(tmpdir(), 'vexa-deploy-'));
    const adminFile = join(dir, 'admin.json');
    writeFileSync(
      adminFile,
      JSON.stringify(Array.from(keypairBytes(env('SOLANA_ADMIN_KEYPAIR')))),
      { mode: 0o600 },
    );
    try {
      console.log(
        '\nDeploying program (this uploads the binary in ~' + writeTxs + ' transactions)...',
      );
      execFileSync(
        'solana',
        [
          'program',
          'deploy',
          SO_PATH,
          '--program-id',
          PROGRAM_KEYPAIR,
          '--keypair',
          adminFile,
          '--upgrade-authority',
          adminFile,
          '--url',
          rpcUrl,
          '--use-rpc',
          '--with-compute-unit-price',
          '1000',
          '--max-sign-attempts',
          '50',
        ],
        { stdio: 'inherit' },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (!(await isDeployed(rpc, programId)))
      throw new Error('deploy finished but the program is not executable');
    console.log(`Deployed ${programId}`);
    // A freshly deployed program isn't visible to every bank at once, and
    // transaction pre-flight simulation may run against the finalized one.
    // Wait until the deployment is finalized before calling initialize.
    process.stdout.write('Waiting for the deployment to finalize');
    while (!(await isDeployed(rpc, programId, 'finalized'))) {
      process.stdout.write('.');
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log(' done');
  }

  // ---- 2. Mint + initialize, atomically -------------------------------------
  let cusdcMint: Address;
  if (!initialized) {
    const mint = await generateKeyPairSigner();
    cusdcMint = mint.address;
    const instructions: Instruction[] = [
      getCreateAccountInstruction({
        payer: admin,
        newAccount: mint,
        lamports: costs.mint,
        space: mintSize,
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
      }),
      getInitializeConfidentialTransferMintInstruction({
        mint: mint.address,
        authority: admin.address,
        autoApproveNewAccounts: true,
        auditorElgamalPubkey: null,
      }),
      getInitializeMint2Instruction({
        mint: mint.address,
        decimals: 6,
        mintAuthority: config,
        freezeAuthority: null,
      }),
      initializeInstruction(programId, {
        admin,
        config,
        usdcMint,
        cusdcMint: mint.address,
        reserve,
        programData,
      }),
    ];
    const sig = await sendTx(rpc, rpcSubscriptions, admin, instructions);
    console.log(`Created cUSDC mint ${cusdcMint} and initialized the vault: ${sig}`);
  } else {
    const data = (await rpc.getAccountInfo(config, { encoding: 'base64' }).send()).value!.data[0];
    const bytes = Buffer.from(data, 'base64');
    // type (1) | admin (32) | usdc_mint (32) | cusdc_mint (32) | ...  (programs/vault/src/state.rs)
    cusdcMint = address(getBase58Decoder().decode(bytes.subarray(65, 97)));
    console.log(`Vault already initialized; cUSDC mint ${cusdcMint}`);
  }

  // ---- 3. Record in .env ------------------------------------------------------
  let text = readFileSync(ENV_PATH, 'utf8');
  for (const [k, v] of [
    ['VAULT_PROGRAM_ID', programId],
    ['CUSDC_MINT', cusdcMint],
  ] as const) {
    text = text.replace(new RegExp(`^${k}=[^\\n#]*?(\\s*#)`, 'm'), `${k}=${v}$1`);
  }
  writeFileSync(ENV_PATH, text);
  console.log(
    '\nUpdated .env with VAULT_PROGRAM_ID and CUSDC_MINT. Run pnpm check-env to verify.\n',
  );
}

/**
 * Hosted RPCs (Alchemy, Helius) serve WebSockets on the same URL. A plain
 * validator serves them on the RPC port + 1.
 */
function websocketUrl(rpcUrl: string): string {
  const u = new URL(rpcUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  if (u.port) u.port = String(Number(u.port) + 1);
  return u.toString();
}

async function isDeployed(
  rpc: ReturnType<typeof createSolanaRpc>,
  programId: Address,
  commitment: 'confirmed' | 'finalized' = 'confirmed',
) {
  const info = (await rpc.getAccountInfo(programId, { encoding: 'base64', commitment }).send())
    .value;
  return !!info?.executable;
}

/**
 * vault `Initialize`: tag 0, no arguments. Account order and flags follow
 * programs/vault/src/processor/initialize.rs.
 */
function initializeInstruction(
  programId: Address,
  a: {
    admin: KeyPairSigner;
    config: Address;
    usdcMint: Address;
    cusdcMint: Address;
    reserve: Address;
    programData: Address;
  },
): Instruction {
  const ro = (address: Address) => ({ address, role: AccountRole.READONLY });
  const rw = (address: Address) => ({ address, role: AccountRole.WRITABLE });
  return {
    programAddress: programId,
    data: Uint8Array.of(0),
    accounts: [
      { address: a.admin.address, role: AccountRole.WRITABLE_SIGNER, signer: a.admin },
      rw(a.config),
      ro(a.usdcMint),
      ro(a.cusdcMint),
      rw(a.reserve),
      ro(programId),
      ro(a.programData),
      ro(TOKEN_PROGRAM),
      ro(ATA_PROGRAM),
      ro(SYSTEM_PROGRAM),
    ],
  } as Instruction;
}

async function sendTx(
  rpc: ReturnType<typeof createSolanaRpc>,
  rpcSubscriptions: ReturnType<typeof createSolanaRpcSubscriptions>,
  payer: KeyPairSigner,
  instructions: Instruction[],
) {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  // The RPC URL comes from .env, so its cluster isn't known to the type system.
  type Factory = typeof sendAndConfirmTransactionFactory;
  const sendAndConfirm = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions,
  } as Parameters<Factory>[0]);
  await sendAndConfirm(signed as Parameters<typeof sendAndConfirm>[0], {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  return getSignatureFromTransaction(signed);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  // Kit errors carry the simulation logs; they're the fastest way to see why.
  const logs =
    (e as { context?: { logs?: string[] }; cause?: { context?: { logs?: string[] } } })?.context
      ?.logs ?? (e as { cause?: { context?: { logs?: string[] } } })?.cause?.context?.logs;
  if (logs) console.error(logs.join('\n'));
  process.exit(1);
});
