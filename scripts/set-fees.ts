/**
 * pnpm vault:set-fees [--bps 10] [--cap 5] [--execute] [--env path/to/.env]
 *
 * Sets the vault's fee schedule, signed by the vault admin:
 *
 *   1. Creates the treasury's USDC account (the associated token account of
 *      TREASURY_OWNER_PUBKEY) if it doesn't exist yet. Fees land there.
 *   2. Calls vault SetFees with the rate in basis points and the cap in whole
 *      USDC. The first call creates the schedule account; later calls replace
 *      it. $VEXA discount tiers are set here too once $VEXA exists (Phase 3).
 *
 * The program refuses a rate above 1%. Until a schedule exists, the vault
 * refuses deposits and withdrawals. Without --execute it prints the plan, the
 * current schedule and the exact SOL required.
 */
import { address, createKeyPairSignerFromBytes, type Address } from '@solana/kit';
import { getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token-2022';
import {
  decodeFeeSchedule,
  encodeFeeTerms,
  findAta,
  findFeeSchedule,
  findVaultConfig,
  FEE_SCHEDULE_LEN,
  setFeesInstruction,
  TOKEN_PROGRAM,
  type FeeSchedule,
} from '@vexa/core/solana';
import { arg, connect, execute, fail, keypairBytes, loadEnv, sendTx, sol } from './lib/solana.js';

const USDC = 1_000_000n;

function describe(s: Omit<FeeSchedule, 'treasury'> & { treasury?: Address }) {
  const pct = (s.feeBps / 100).toFixed(2);
  const cap = (Number(s.feeCap) / Number(USDC)).toFixed(2);
  const tiers = s.tiers.length
    ? s.tiers.map((t) => `${t.discountBps / 100}% off from ${t.minBalance}`).join(', ')
    : 'none';
  return `${pct}% capped at ${cap} USDC; $VEXA tiers: ${tiers}`;
}

async function main() {
  const env = loadEnv();
  const conn = connect(env('ALCHEMY_SOLANA_RPC_URL'));
  const { rpc } = conn;
  const admin = await createKeyPairSignerFromBytes(keypairBytes(env('SOLANA_ADMIN_KEYPAIR')));
  const program = address(env('VAULT_PROGRAM_ID'));
  const usdcMint = address(env('USDC_MINT'));
  const treasuryOwner = address(env('TREASURY_OWNER_PUBKEY'));

  const feeBps = Number(arg('bps') ?? 10);
  const feeCap = BigInt(Math.round(Number(arg('cap') ?? 5) * Number(USDC)));
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 100)
    throw new Error('--bps must be an integer from 0 to 100 (1%)');

  const [config, fees, treasury] = await Promise.all([
    findVaultConfig(program),
    findFeeSchedule(program),
    findAta(treasuryOwner, usdcMint, TOKEN_PROGRAM),
  ]);
  const account = async (a: Address) =>
    (await rpc.getAccountInfo(a, { encoding: 'base64', commitment: 'confirmed' }).send()).value;
  const [feesInfo, treasuryInfo] = await Promise.all([account(fees), account(treasury)]);
  const current = feesInfo ? decodeFeeSchedule(Buffer.from(feesInfo.data[0], 'base64')) : null;

  const rent = async (n: number) => rpc.getMinimumBalanceForRentExemption(BigInt(n)).send();
  const costs = {
    treasuryAccount: treasuryInfo ? 0n : await rent(165),
    scheduleAccount: feesInfo ? 0n : await rent(FEE_SCHEDULE_LEN),
    transactionFee: 5_000n,
  };
  const total = Object.values(costs).reduce((a, b) => a + b, 0n);
  const balance = (await rpc.getBalance(admin.address).send()).value;
  const next = { feeBps, feeCap, vexaMint: null, tiers: [] };

  console.log(`\nVault fee schedule (${execute ? 'EXECUTE' : 'dry run'})\n`);
  console.log(`  program         ${program}`);
  console.log(`  schedule        ${fees}`);
  console.log(`  admin           ${admin.address}`);
  console.log(`  treasury        ${treasury} (USDC account of ${treasuryOwner})`);
  console.log(
    `  current         ${current ? describe(current) : 'not set: the vault refuses money'}`,
  );
  console.log(`  new             ${describe(next)}\n`);
  for (const [k, v] of Object.entries(costs)) console.log(`  ${k.padEnd(16)}${sol(v)} SOL`);
  console.log(`  ${'total'.padEnd(16)}${sol(total)} SOL (admin holds ${sol(balance)})\n`);

  if (!execute) return console.log('Dry run. Re-run with --execute to apply.\n');
  if (balance < total) throw new Error('the admin needs more SOL for this');

  const signature = await sendTx(conn, admin, [
    getCreateAssociatedTokenIdempotentInstruction({
      payer: admin,
      ata: treasury,
      owner: treasuryOwner,
      mint: usdcMint,
      tokenProgram: TOKEN_PROGRAM,
    }),
    setFeesInstruction({ program, admin, config, fees, treasury, terms: encodeFeeTerms(next) }),
  ]);
  console.log(`Set: ${signature}`);

  const matches = (d: FeeSchedule | null): d is FeeSchedule =>
    !!d && d.feeBps === feeBps && d.feeCap === feeCap && d.treasury === treasury;
  let decoded: FeeSchedule | null = null;
  // The RPC can lag the confirmed write by a moment.
  for (let attempt = 0; attempt < 10 && !matches(decoded); attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2_000));
    const written = await account(fees);
    decoded = written && decodeFeeSchedule(Buffer.from(written.data[0], 'base64'));
  }
  if (!matches(decoded)) throw new Error('the schedule on-chain does not match what was sent');
  console.log(`On-chain: ${describe(decoded)}\n`);
}

main().catch(fail);
