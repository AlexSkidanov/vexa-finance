/**
 * A LiteSVM test bed with the real Token-2022, ZK ElGamal proof program and
 * associated token program, plus the vault binary from target/deploy.
 *
 * Shared by the core flow tests and the API's money route tests, so both run
 * against exactly the same chain setup.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LiteSVM } from 'litesvm';
import {
  address,
  AccountRole,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromPrivateKeyBytes,
  createSignerFromKeyPair,
  createTransactionMessage,
  generateKeyPair,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  lamports,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Transaction,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeConfidentialTransferMintInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
} from '@solana-program/token-2022';
import { deriveUserKeys, type UserKeys } from '../../src/crypto/index.js';
import { feeScheduleTiers } from '../../src/tiers.js';
import {
  ASSOCIATED_TOKEN_PROGRAM,
  CONFIDENTIAL_ACCOUNT_SPACE,
  contextStateSpace,
  findAta,
  findVaultConfig,
  ProofType,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  VAULT_PROGRAM,
  type RentTable,
  encodeFeeTerms,
  findFeeSchedule,
  setFeesInstruction,
  STAKE_RECORD_LEN,
  type FeeSchedule,
  type VaultAccounts,
} from '../../src/solana/index.js';

export const VAULT_SO = fileURLToPath(
  new URL('../../../../target/deploy/vault.so', import.meta.url),
);
export const vaultBinaryExists = () => existsSync(VAULT_SO);

const LOADER = address('BPFLoaderUpgradeab1e11111111111111111111111');

export interface Wallet {
  keys: UserKeys;
  signer: KeyPairSigner;
  usdc: Address;
  cusdc: Address;
}

export class TransactionFailed extends Error {
  constructor(
    message: string,
    readonly logs: string[],
  ) {
    super(message);
  }
}

export interface Testbed {
  svm: LiteSVM;
  feePayerPair: CryptoKeyPair;
  feePayer: KeyPairSigner;
  admin: KeyPairSigner;
  vault: VaultAccounts & { program: Address };
  /** What the vault charges; the launch schedule. */
  feeSchedule: FeeSchedule;
  rent: RentTable;
  blockhash(): { blockhash: ReturnType<LiteSVM['latestBlockhash']>; lastValidBlockHeight: bigint };
  account(address: Address): Uint8Array | null;
  accountOwner(address: Address): Address | null;
  tokenAmount(address: Address): bigint;
  /** Signs with the fee payer and sends; what the API's chain does. */
  sendAsFeePayer(tx: Transaction): Promise<string>;
  /** Sends admin-side setup instructions signed by `payer`. */
  sendDirect(payer: KeyPairSigner, instructions: Instruction[]): Promise<void>;
  /** A wallet derived from a random passkey, holding `usdc` base units of USDC and no SOL. */
  newWallet(usdc: bigint): Promise<Wallet>;
  /** Creates a $VEXA mint and adds the tier discounts to the fee schedule. */
  launchVexa(): Promise<Address>;
  /** Mints `amount` $VEXA to a wallet; returns its $VEXA account. */
  giveVexa(wallet: Wallet, amount: bigint): Promise<Address>;
}

function failureOf(result: unknown): TransactionFailed | null {
  const r = result as { err?: () => unknown; meta?: () => { logs: () => string[] } };
  if (typeof r.err !== 'function') return null;
  return new TransactionFailed(`transaction failed: ${String(r.err())}`, r.meta?.().logs() ?? []);
}

export async function createTestbed(): Promise<Testbed> {
  const svm = new LiteSVM();
  const feePayerPair = await generateKeyPair();
  const feePayer = await createSignerFromKeyPair(feePayerPair);
  const admin = await generateKeyPairSigner();
  svm.airdrop(feePayer.address, lamports(10_000_000_000n));
  svm.airdrop(admin.address, lamports(10_000_000_000n));

  const blockhash = () => ({ blockhash: svm.latestBlockhash(), lastValidBlockHeight: 0n });

  const sendDirect = async (payer: KeyPairSigner, instructions: Instruction[]) => {
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash(), m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const failure = failureOf(
      svm.sendTransaction(await signTransactionMessageWithSigners(message)),
    );
    svm.expireBlockhash();
    if (failure) throw failure;
  };

  // The vault, as an upgradeable program whose upgrade authority is `admin`.
  svm.addProgram(VAULT_PROGRAM, readFileSync(VAULT_SO));
  const [programData] = await getProgramDerivedAddress({
    programAddress: LOADER,
    seeds: [getAddressEncoder().encode(VAULT_PROGRAM)],
  });
  const pd = svm.getAccount(programData);
  if (!pd.exists) throw new Error('programdata missing');
  const pdData = new Uint8Array(pd.data);
  pdData[12] = 1;
  pdData.set(getAddressEncoder().encode(admin.address), 13);
  svm.setAccount({ ...pd, data: pdData });

  const config = await findVaultConfig();
  const usdcMint = await generateKeyPairSigner();
  const cusdcMint = await generateKeyPairSigner();
  const rentFor = (n: number | bigint) => lamports(svm.minimumBalanceForRentExemption(BigInt(n)));

  await sendDirect(admin, [
    getCreateAccountInstruction({
      payer: admin,
      newAccount: usdcMint,
      lamports: rentFor(82),
      space: 82,
      programAddress: TOKEN_PROGRAM,
    }),
    getInitializeMint2Instruction(
      { mint: usdcMint.address, decimals: 6, mintAuthority: admin.address, freezeAuthority: null },
      { programAddress: TOKEN_PROGRAM },
    ),
  ]);
  const cusdcSpace = getMintSize([
    {
      __kind: 'ConfidentialTransferMint',
      authority: admin.address,
      autoApproveNewAccounts: true,
      auditorElgamalPubkey: null,
    },
  ]);
  const reserve = await findAta(config, usdcMint.address, TOKEN_PROGRAM);
  await sendDirect(admin, [
    getCreateAccountInstruction({
      payer: admin,
      newAccount: cusdcMint,
      lamports: rentFor(cusdcSpace),
      space: cusdcSpace,
      programAddress: TOKEN_2022_PROGRAM,
    }),
    getInitializeConfidentialTransferMintInstruction({
      mint: cusdcMint.address,
      authority: admin.address,
      autoApproveNewAccounts: true,
      auditorElgamalPubkey: null,
    }),
    getInitializeMint2Instruction({
      mint: cusdcMint.address,
      decimals: 6,
      mintAuthority: config,
      freezeAuthority: null,
    }),
    {
      programAddress: VAULT_PROGRAM,
      data: new Uint8Array([0]),
      accounts: [
        { address: admin.address, role: AccountRole.WRITABLE_SIGNER, signer: admin },
        { address: config, role: AccountRole.WRITABLE },
        { address: usdcMint.address, role: AccountRole.READONLY },
        { address: cusdcMint.address, role: AccountRole.READONLY },
        { address: reserve, role: AccountRole.WRITABLE },
        { address: VAULT_PROGRAM, role: AccountRole.READONLY },
        { address: programData, role: AccountRole.READONLY },
        { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
        { address: ASSOCIATED_TOKEN_PROGRAM, role: AccountRole.READONLY },
        { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      ],
    } as Instruction,
  ]);

  // The launch fee schedule: 0.10%, capped at 5 USDC, paid to a treasury.
  const treasuryOwner = (await generateKeyPairSigner()).address;
  const treasury = await findAta(treasuryOwner, usdcMint.address, TOKEN_PROGRAM);
  const fees = await findFeeSchedule(VAULT_PROGRAM);
  const feeSchedule: FeeSchedule = {
    feeBps: 10,
    feeCap: 5_000_000n,
    treasury,
    vexaMint: null,
    tiers: [],
  };
  await sendDirect(admin, [
    getCreateAssociatedTokenIdempotentInstruction({
      payer: admin,
      ata: treasury,
      owner: treasuryOwner,
      mint: usdcMint.address,
      tokenProgram: TOKEN_PROGRAM,
    }),
    setFeesInstruction({
      admin,
      config,
      fees,
      treasury,
      terms: encodeFeeTerms(feeSchedule),
    }),
  ]);

  const vault = {
    program: VAULT_PROGRAM,
    config,
    usdcMint: usdcMint.address,
    cusdcMint: cusdcMint.address,
    usdcReserve: reserve,
    fees,
    treasury,
  };
  const rent: RentTable = {
    confidentialAccount: svm.minimumBalanceForRentExemption(CONFIDENTIAL_ACCOUNT_SPACE),
    equalityContext: svm.minimumBalanceForRentExemption(
      contextStateSpace(ProofType.VerifyCiphertextCommitmentEquality),
    ),
    validityContext: svm.minimumBalanceForRentExemption(
      contextStateSpace(ProofType.VerifyBatchedGroupedCiphertext3HandlesValidity),
    ),
    rangeU128Context: svm.minimumBalanceForRentExemption(
      contextStateSpace(ProofType.VerifyBatchedRangeProofU128),
    ),
    rangeU64Context: svm.minimumBalanceForRentExemption(
      contextStateSpace(ProofType.VerifyBatchedRangeProofU64),
    ),
    stakeRecord: svm.minimumBalanceForRentExemption(BigInt(STAKE_RECORD_LEN)),
    tokenAccount: svm.minimumBalanceForRentExemption(165n),
  };

  const account = (addr: Address) => {
    const a = svm.getAccount(addr);
    return a.exists ? new Uint8Array(a.data) : null;
  };
  const accountOwner = (addr: Address) => {
    const a = svm.getAccount(addr);
    return a.exists ? a.programAddress : null;
  };

  return {
    svm,
    feePayerPair,
    feePayer,
    admin,
    vault,
    feeSchedule,
    rent,
    blockhash,
    account,
    accountOwner,
    tokenAmount: (addr) => {
      const data = account(addr);
      if (!data) throw new Error(`missing account ${addr}`);
      return new DataView(data.buffer).getBigUint64(64, true);
    },
    async sendAsFeePayer(tx) {
      const signed = await partiallySignTransaction([feePayerPair], tx);
      const failure = failureOf(
        svm.sendTransaction(signed as Parameters<typeof svm.sendTransaction>[0]),
      );
      if (failure) throw failure;
      return getSignatureFromTransaction(signed);
    },
    sendDirect,
    async launchVexa() {
      const mint = await generateKeyPairSigner();
      await sendDirect(admin, [
        getCreateAccountInstruction({
          payer: admin,
          newAccount: mint,
          lamports: rentFor(82),
          space: 82,
          programAddress: TOKEN_PROGRAM,
        }),
        getInitializeMint2Instruction(
          { mint: mint.address, decimals: 6, mintAuthority: admin.address, freezeAuthority: null },
          { programAddress: TOKEN_PROGRAM },
        ),
      ]);
      feeSchedule.vexaMint = mint.address;
      feeSchedule.tiers = feeScheduleTiers();
      await sendDirect(admin, [
        setFeesInstruction({ admin, config, fees, treasury, terms: encodeFeeTerms(feeSchedule) }),
      ]);
      return mint.address;
    },
    async giveVexa(wallet, amount) {
      const mint = feeSchedule.vexaMint!;
      const ata = await findAta(wallet.signer.address, mint, TOKEN_PROGRAM);
      await sendDirect(admin, [
        getCreateAssociatedTokenIdempotentInstruction({
          payer: admin,
          ata,
          owner: wallet.signer.address,
          mint,
          tokenProgram: TOKEN_PROGRAM,
        }),
        getMintToInstruction(
          { mint, token: ata, mintAuthority: admin, amount },
          { programAddress: TOKEN_PROGRAM },
        ),
      ]);
      return ata;
    },
    async newWallet(usdc) {
      const keys = deriveUserKeys(crypto.getRandomValues(new Uint8Array(32)));
      const signer = await createKeyPairSignerFromPrivateKeyBytes(keys.solanaSeed);
      const wallet: Wallet = {
        keys,
        signer,
        usdc: await findAta(signer.address, vault.usdcMint, TOKEN_PROGRAM),
        cusdc: await findAta(signer.address, vault.cusdcMint, TOKEN_2022_PROGRAM),
      };
      // Like an exchange withdrawal: a USDC account and balance, but no SOL.
      await sendDirect(admin, [
        getCreateAssociatedTokenIdempotentInstruction({
          payer: admin,
          ata: wallet.usdc,
          owner: signer.address,
          mint: vault.usdcMint,
          tokenProgram: TOKEN_PROGRAM,
        }),
        ...(usdc > 0n
          ? [
              getMintToInstruction(
                { mint: vault.usdcMint, token: wallet.usdc, mintAuthority: admin, amount: usdc },
                { programAddress: TOKEN_PROGRAM },
              ),
            ]
          : []),
      ]);
      return wallet;
    },
  };
}
