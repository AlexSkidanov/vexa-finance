/**
 * pnpm upgrade:vault --authority <keypair file> [--payer <keypair file>] [--priority <µlamports>]
 *                   [--close <buffer address>] [--execute] [--env path]
 *
 * Upgrades the deployed vault to target/deploy/vault.so (`pnpm build:vault`
 * first). The upgrade authority signs; the payer (the authority unless given)
 * funds the upload:
 *
 *   - A buffer holding the new binary, rent-exempt while it's written. The
 *     upgrade closes it and refunds its rent to the payer.
 *   - If the binary is larger than the ProgramData account, an extension.
 *     That rent is permanent: it's what the bigger program costs to keep.
 *
 * Uses the Solana CLI (`solana program deploy`), which uploads, extends and
 * upgrades. Afterwards the on-chain bytecode is hashed and compared with the
 * local binary. Without --execute it prints the exact SOL required.
 *
 * Mainnet drops unprioritised transactions when it's busy, so every write
 * carries a priority fee (--priority, in micro-lamports per compute unit) and
 * the CLI re-signs with a fresh blockhash up to 50 times. A failed attempt
 * prints the address of the buffer it left; pass it as --close and it's closed
 * first, its rent returned to the payer.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { arg, connect, execute, fail, keypairFile, loadEnv, ROOT, sol } from './lib/solana.js';

const SO_PATH = join(ROOT, 'target/deploy/vault.so');
const LOADER = address('BPFLoaderUpgradeab1e11111111111111111111111');
/** ProgramData header: tag u32 | slot u64 | Option<authority>. */
const PROGRAM_DATA_HEADER = 45;
/** Buffer header: tag u32 | Option<authority>. */
const BUFFER_HEADER = 37;
/** The loader refuses smaller extensions, short of reaching the maximum size. */
const MIN_EXTENSION = 10_240;
/** Default priority fee, micro-lamports per compute unit. */
const DEFAULT_PRIORITY = 50_000;
/** The most compute a single deploy transaction is budgeted, for the worst-case fee. */
const MAX_CU_PER_TX = 200_000;

const expand = (p: string) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function main() {
  const env = loadEnv();
  const rpcUrl = env('ALCHEMY_SOLANA_RPC_URL');
  const { rpc } = connect(rpcUrl);
  const program = address(env('VAULT_PROGRAM_ID'));
  const authorityPath = arg('authority');
  if (!authorityPath) throw new Error('--authority <upgrade authority keypair file> is required');
  const payerPath = arg('payer') ?? authorityPath;
  const [authority, payer] = await Promise.all([
    keypairFile(authorityPath),
    keypairFile(payerPath),
  ]);
  if (!existsSync(SO_PATH))
    throw new Error('target/deploy/vault.so not found; run pnpm build:vault');
  const binary = readFileSync(SO_PATH);

  const [programData] = await getProgramDerivedAddress({
    programAddress: LOADER,
    seeds: [getAddressEncoder().encode(program)],
  });
  const info = (await rpc.getAccountInfo(programData, { encoding: 'base64' }).send()).value;
  if (!info) throw new Error(`${program} is not deployed; use pnpm deploy:vault`);
  const data = Buffer.from(info.data[0], 'base64');
  const expected = getAddressEncoder().encode(authority.address);
  if (data[12] !== 1 || !data.subarray(13, 45).equals(Buffer.from(expected)))
    throw new Error(`${authority.address} is not the program's upgrade authority`);

  const capacity = data.length - PROGRAM_DATA_HEADER;
  const growth = binary.length > capacity ? Math.max(binary.length - capacity, MIN_EXTENSION) : 0;
  const rent = async (n: number) => rpc.getMinimumBalanceForRentExemption(BigInt(n)).send();
  const buffer = await rent(BUFFER_HEADER + binary.length);
  const extension = growth ? (await rent(data.length + growth)) - BigInt(info.lamports) : 0n;
  const priority = Number(arg('priority') ?? DEFAULT_PRIORITY);
  if (!Number.isInteger(priority) || priority < 0)
    throw new Error('--priority must be a whole number');
  const writes = Math.ceil(binary.length / 1000);
  const txs = writes + 4;
  // Base fees, plus the most the priority fee can add if every transaction
  // used its whole compute budget. Writes use far less, so this over-reserves.
  const fees = BigInt(txs * 5_000) + BigInt(Math.ceil((txs * MAX_CU_PER_TX * priority) / 1e6));
  const needed = buffer + extension + fees;
  const stale = arg('close') ? address(arg('close')!) : null;
  const staleInfo = stale
    ? (await rpc.getAccountInfo(stale, { encoding: 'base64' }).send()).value
    : null;
  if (stale && (!staleInfo || staleInfo.owner !== LOADER))
    throw new Error(`${stale} is not an upload buffer (already closed?)`);
  const staleLamports = staleInfo ? BigInt(staleInfo.lamports) : 0n;
  const balance = (await rpc.getBalance(payer.address).send()).value;
  const deployed = data.subarray(PROGRAM_DATA_HEADER, PROGRAM_DATA_HEADER + binary.length);

  console.log(`\nVault upgrade (${execute ? 'EXECUTE' : 'dry run'})\n`);
  console.log(`  program            ${program}`);
  console.log(`  upgrade authority  ${authority.address}`);
  console.log(`  payer              ${payer.address} (holds ${sol(balance)} SOL)`);
  if (stale) {
    console.log(
      `  leftover buffer    ${stale}, ${sol(staleLamports)} SOL (closed and refunded first)`,
    );
  }
  console.log(
    `  binary             ${binary.length} bytes, sha256 ${sha256(binary).slice(0, 16)}…`,
  );
  console.log(`  deployed           ${capacity} bytes capacity\n`);
  console.log(`  buffer rent        ${sol(buffer)} SOL  (refunded when the upgrade lands)`);
  console.log(`  extension rent     ${sol(extension)} SOL  (permanent, +${growth} bytes)`);
  console.log(
    `  transaction fees   ${sol(fees)} SOL at most  (${writes} writes, priority ${priority} µlamports/CU)`,
  );
  console.log(`  needed up front    ${sol(needed)} SOL`);
  console.log(`  net cost           ${sol(extension + fees)} SOL\n`);

  if (Buffer.from(deployed).equals(binary) && data.length - PROGRAM_DATA_HEADER >= binary.length) {
    console.log('Already deployed: the on-chain bytecode matches.\n');
    return;
  }
  if (!execute) return console.log('Dry run. Re-run with --execute to upgrade.\n');
  const available = balance + (payer.address === authority.address ? staleLamports : 0n);
  if (available < needed) throw new Error(`the payer needs ${sol(needed - available)} more SOL`);

  const cli = (args: string[]) =>
    execFileSync('solana', [...args, '--url', rpcUrl, '--commitment', 'confirmed'], {
      stdio: 'inherit',
    });
  if (stale) {
    cli([
      'program',
      'close',
      stale,
      '--authority',
      expand(authorityPath),
      '--recipient',
      payer.address,
      '--keypair',
      expand(payerPath),
    ]);
  }
  // Extend explicitly: the CLI's automatic extension budgets more than it
  // spends and refuses to start when the payer holds exactly what's needed.
  if (growth) {
    cli([
      'program',
      'extend',
      program,
      String(growth),
      '--keypair',
      expand(authorityPath),
      '--payer',
      expand(payerPath),
    ]);
  }
  cli([
    'program',
    'deploy',
    SO_PATH,
    '--program-id',
    program,
    '--upgrade-authority',
    expand(authorityPath),
    '--keypair',
    expand(payerPath),
    '--no-auto-extend',
    '--use-rpc',
    '--with-compute-unit-price',
    String(priority),
    '--max-sign-attempts',
    '50',
  ]);

  // The RPC can serve the old code for a few seconds after the upgrade lands.
  let code = Buffer.alloc(0);
  for (let attempt = 0; attempt < 20; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 3_000));
    const after = (await rpc.getAccountInfo(programData, { encoding: 'base64' }).send()).value;
    code = Buffer.from(after!.data[0], 'base64').subarray(
      PROGRAM_DATA_HEADER,
      PROGRAM_DATA_HEADER + binary.length,
    );
    if (sha256(code) === sha256(binary)) break;
  }
  if (sha256(code) !== sha256(binary))
    throw new Error('on-chain bytecode does not match the binary');
  console.log(`\nUpgraded and verified: sha256 ${sha256(binary)}\n`);
}

main().catch(fail);
