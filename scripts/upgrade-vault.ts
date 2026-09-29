/**
 * pnpm upgrade:vault --authority <keypair file> [--payer <keypair file>] [--execute] [--env path]
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
  const growth = Math.max(0, binary.length - capacity);
  const rent = async (n: number) => rpc.getMinimumBalanceForRentExemption(BigInt(n)).send();
  const buffer = await rent(BUFFER_HEADER + binary.length);
  const extension = growth ? (await rent(data.length + growth)) - BigInt(info.lamports) : 0n;
  const writes = Math.ceil(binary.length / 1000);
  const fees = BigInt((writes + 4) * 5_000);
  const needed = buffer + extension + fees;
  const balance = (await rpc.getBalance(payer.address).send()).value;
  const deployed = data.subarray(PROGRAM_DATA_HEADER, PROGRAM_DATA_HEADER + binary.length);

  console.log(`\nVault upgrade (${execute ? 'EXECUTE' : 'dry run'})\n`);
  console.log(`  program            ${program}`);
  console.log(`  upgrade authority  ${authority.address}`);
  console.log(`  payer              ${payer.address} (holds ${sol(balance)} SOL)`);
  console.log(
    `  binary             ${binary.length} bytes, sha256 ${sha256(binary).slice(0, 16)}…`,
  );
  console.log(`  deployed           ${capacity} bytes capacity\n`);
  console.log(`  buffer rent        ${sol(buffer)} SOL  (refunded when the upgrade lands)`);
  console.log(`  extension rent     ${sol(extension)} SOL  (permanent, +${growth} bytes)`);
  console.log(`  transaction fees   ${sol(fees)} SOL  (${writes} writes)`);
  console.log(`  needed up front    ${sol(needed)} SOL`);
  console.log(`  net cost           ${sol(extension + fees)} SOL\n`);

  if (Buffer.from(deployed).equals(binary) && data.length - PROGRAM_DATA_HEADER >= binary.length) {
    console.log('Already deployed: the on-chain bytecode matches.\n');
    return;
  }
  if (!execute) return console.log('Dry run. Re-run with --execute to upgrade.\n');
  if (balance < needed) throw new Error(`the payer needs ${sol(needed - balance)} more SOL`);

  execFileSync(
    'solana',
    [
      'program',
      'deploy',
      SO_PATH,
      '--program-id',
      program,
      '--upgrade-authority',
      expand(authorityPath),
      '--keypair',
      expand(payerPath),
      '--url',
      rpcUrl,
      '--use-rpc',
    ],
    { stdio: 'inherit' },
  );

  const after = (
    await rpc.getAccountInfo(programData, { encoding: 'base64', commitment: 'finalized' }).send()
  ).value;
  const code = Buffer.from(after!.data[0], 'base64').subarray(
    PROGRAM_DATA_HEADER,
    PROGRAM_DATA_HEADER + binary.length,
  );
  if (sha256(code) !== sha256(binary))
    throw new Error('on-chain bytecode does not match the binary');
  console.log(`\nUpgraded and verified: sha256 ${sha256(binary)}\n`);
}

main().catch(fail);
