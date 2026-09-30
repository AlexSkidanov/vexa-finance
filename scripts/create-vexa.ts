/**
 * pnpm token:create --uri <metadata JSON url> [--name Vexa] [--symbol VEXA] [--execute] [--env path]
 *
 * Creates $VEXA the way pump.fun tokens are set up, in ONE transaction signed
 * by the vault admin:
 *
 *   1. A classic SPL mint with 6 decimals and no freeze authority.
 *   2. The full supply, 1,000,000,000 VEXA, minted to the treasury's $VEXA
 *      account (owned by TREASURY_OWNER_PUBKEY).
 *   3. Metaplex metadata (name, symbol, URI), immutable.
 *   4. The mint authority revoked: nobody can ever mint more.
 *
 * Metadata can only be created while the mint authority exists, which is why
 * everything happens in one transaction. The URI must point to the token's
 * JSON (name, symbol, description, image) somewhere permanent, such as IPFS
 * or Arweave: it can't be changed afterwards.
 *
 * Afterwards, run `pnpm vault:set-fees --vexa-mint <mint>` to turn on the
 * $VEXA fee discounts and staking. Writes VEXA_TOKEN_MINT into .env.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AccountRole,
  address,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  AuthorityType,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintToInstruction,
  getSetAuthorityInstruction,
} from '@solana-program/token-2022';
import { findAta, SYSTEM_PROGRAM, TOKEN_PROGRAM } from '@vexa/core/solana';
import {
  arg,
  connect,
  execute,
  fail,
  keypairBytes,
  loadEnv,
  ROOT,
  sendTx,
  sol,
} from './lib/solana.js';

const METADATA_PROGRAM = address('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const DECIMALS = 6;
const SUPPLY = 1_000_000_000n * 10n ** BigInt(DECIMALS);
const MINT_LEN = 82;
/** Metaplex metadata account size (fixed, with padding). */
const METADATA_LEN = 679;

/** Borsh: a u32 length prefix then UTF-8 bytes. */
function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

/**
 * Metaplex `CreateMetadataAccountV3` (discriminator 33): DataV2 { name,
 * symbol, uri, seller_fee_basis_points: 0, creators: None, collection: None,
 * uses: None }, is_mutable, collection_details: None.
 */
function createMetadataInstruction(a: {
  metadata: Address;
  mint: Address;
  mintAuthority: Address;
  payer: Address;
  updateAuthority: Address;
  name: string;
  symbol: string;
  uri: string;
  mutable: boolean;
}): Instruction {
  const data = Uint8Array.from([
    33,
    ...borshString(a.name),
    ...borshString(a.symbol),
    ...borshString(a.uri),
    0,
    0, // seller_fee_basis_points: u16
    0, // creators: None
    0, // collection: None
    0, // uses: None
    a.mutable ? 1 : 0,
    0, // collection_details: None
  ]);
  return {
    programAddress: METADATA_PROGRAM,
    accounts: [
      { address: a.metadata, role: AccountRole.WRITABLE },
      { address: a.mint, role: AccountRole.READONLY },
      { address: a.mintAuthority, role: AccountRole.READONLY_SIGNER },
      { address: a.payer, role: AccountRole.WRITABLE_SIGNER },
      { address: a.updateAuthority, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data,
  } as Instruction;
}

async function main() {
  const env = loadEnv();
  const conn = connect(env('ALCHEMY_SOLANA_RPC_URL'));
  const { rpc } = conn;
  const admin = await createKeyPairSignerFromBytes(keypairBytes(env('SOLANA_ADMIN_KEYPAIR')));
  const treasuryOwner = address(env('TREASURY_OWNER_PUBKEY'));
  if (process.env.VEXA_TOKEN_MINT?.trim())
    throw new Error(`$VEXA already exists: ${process.env.VEXA_TOKEN_MINT}`);

  const name = arg('name') ?? 'Vexa';
  const symbol = arg('symbol') ?? 'VEXA';
  const uri = arg('uri');
  if (!uri) throw new Error('--uri <metadata JSON url> is required (IPFS or Arweave)');
  if (name.length > 32 || symbol.length > 10 || uri.length > 200)
    throw new Error('name ≤ 32, symbol ≤ 10 and uri ≤ 200 characters');

  const mint = await generateKeyPairSigner();
  const [metadata] = await getProgramDerivedAddress({
    programAddress: METADATA_PROGRAM,
    seeds: [
      'metadata',
      getAddressEncoder().encode(METADATA_PROGRAM),
      getAddressEncoder().encode(mint.address),
    ],
  });
  const treasuryVexa = await findAta(treasuryOwner, mint.address, TOKEN_PROGRAM);

  const rent = async (n: number) => rpc.getMinimumBalanceForRentExemption(BigInt(n)).send();
  const costs = {
    mint: await rent(MINT_LEN),
    treasuryAccount: await rent(165),
    metadata: await rent(METADATA_LEN),
    metaplexFee: 10_000_000n, // Metaplex's protocol fee on metadata creation (0.01 SOL)
    transactionFee: 10_000n,
  };
  const total = Object.values(costs).reduce((a, b) => a + b, 0n);
  const balance = (await rpc.getBalance(admin.address).send()).value;

  console.log(`\n$VEXA token (${execute ? 'EXECUTE' : 'dry run'})\n`);
  console.log(`  name / symbol     ${name} / ${symbol}`);
  console.log(`  uri               ${uri}`);
  console.log(`  supply            1,000,000,000 (6 decimals) to ${treasuryVexa}`);
  console.log(`                    (the $VEXA account of ${treasuryOwner})`);
  console.log(`  mint authority    revoked in the same transaction`);
  console.log(`  freeze authority  none`);
  console.log(`  metadata          immutable\n`);
  for (const [k, v] of Object.entries(costs)) console.log(`  ${k.padEnd(18)}${sol(v)} SOL`);
  console.log(`  ${'total'.padEnd(18)}${sol(total)} SOL (admin holds ${sol(balance)})\n`);

  if (!execute) return console.log('Dry run. Re-run with --execute to create it.\n');
  if (balance < total) throw new Error(`the admin needs ${sol(total - balance)} more SOL`);

  const signature = await sendTx(conn, admin, [
    getCreateAccountInstruction({
      payer: admin,
      newAccount: mint,
      lamports: costs.mint,
      space: MINT_LEN,
      programAddress: TOKEN_PROGRAM,
    }),
    getInitializeMint2Instruction(
      {
        mint: mint.address,
        decimals: DECIMALS,
        mintAuthority: admin.address,
        freezeAuthority: null,
      },
      { programAddress: TOKEN_PROGRAM },
    ),
    getCreateAssociatedTokenIdempotentInstruction({
      payer: admin,
      ata: treasuryVexa,
      owner: treasuryOwner,
      mint: mint.address,
      tokenProgram: TOKEN_PROGRAM,
    }),
    getMintToInstruction(
      { mint: mint.address, token: treasuryVexa, mintAuthority: admin, amount: SUPPLY },
      { programAddress: TOKEN_PROGRAM },
    ),
    createMetadataInstruction({
      metadata,
      mint: mint.address,
      mintAuthority: admin.address,
      payer: admin.address,
      updateAuthority: admin.address,
      name,
      symbol,
      uri,
      mutable: false,
    }),
    getSetAuthorityInstruction(
      {
        owned: mint.address,
        owner: admin,
        authorityType: AuthorityType.MintTokens,
        newAuthority: null,
      },
      { programAddress: TOKEN_PROGRAM },
    ),
  ]);
  console.log(`Created: ${signature}\n$VEXA mint: ${mint.address}\n`);

  const envPath = arg('env') ?? join(ROOT, '.env');
  const current = readFileSync(envPath, 'utf8');
  if (/^VEXA_TOKEN_MINT=.*$/m.test(current)) {
    writeFileSync(
      envPath,
      current.replace(/^VEXA_TOKEN_MINT=.*$/m, `VEXA_TOKEN_MINT=${mint.address}`),
    );
  } else {
    appendFileSync(envPath, `\nVEXA_TOKEN_MINT=${mint.address}\n`);
  }
  console.log(
    `Wrote VEXA_TOKEN_MINT to ${envPath}. Next: pnpm vault:set-fees --vexa-mint ${mint.address}\n`,
  );
}

main().catch(fail);
