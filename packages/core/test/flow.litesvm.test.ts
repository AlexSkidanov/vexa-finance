/**
 * End-to-end money flow on LiteSVM: the real Token-2022, ZK ElGamal proof
 * program and associated token program, plus the vault binary from
 * target/deploy (run `pnpm build:vault` first; skipped if it's missing).
 *
 * Users hold USDC but no SOL. Every transaction is compiled from a plan on the
 * "device", then co-signed by the fee payer, exactly as the API does it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { LiteSVM } from 'litesvm';
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromPrivateKeyBytes,
  createSignerFromKeyPair,
  createTransactionMessage,
  generateKeyPair,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64Encoder,
  getTransactionDecoder,
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
import {
  buildTransferProofs,
  buildWithdrawProofs,
  decryptableZeroBalance,
  decryptPendingBalance,
  decryptTransferAmount,
  deriveUserKeys,
  pubkeyValidityProof,
  type UserKeys,
} from '../src/crypto/index.js';
import {
  compilePlan,
  configurePlan,
  CONFIDENTIAL_ACCOUNT_SPACE,
  contextStateSpace,
  decodeConfidentialAccount,
  applyPendingPlan,
  depositPlan,
  findAta,
  findVaultConfig,
  ProofType,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  transferPlan,
  VAULT_PROGRAM,
  withdrawPlan,
  type CompiledPlan,
  type RentTable,
  type VaultAccounts,
} from '../src/solana/index.js';
import { AeCiphertext } from '@solana/zk-sdk';

const VAULT_SO = fileURLToPath(new URL('../../../target/deploy/vault.so', import.meta.url));
const LOADER = address('BPFLoaderUpgradeab1e11111111111111111111111');
const USDC = 1_000_000n;

describe.skipIf(!existsSync(VAULT_SO))('money flow on LiteSVM', () => {
  const svm = new LiteSVM();
  let feePayerPair: CryptoKeyPair;
  let feePayer: KeyPairSigner;
  let admin: KeyPairSigner;
  let vault: VaultAccounts;
  let rent: RentTable;

  const blockhash = () => ({ blockhash: svm.latestBlockhash(), lastValidBlockHeight: 0n });

  /** Sends a transaction signed by `signers` (admin-side setup, not a plan). */
  async function sendDirect(payer: KeyPairSigner, instructions: Instruction[]) {
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash(), m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    expectOk(svm.sendTransaction(await signTransactionMessageWithSigners(message)));
    svm.expireBlockhash();
  }

  /** What the API does: decode, co-sign as fee payer, broadcast stage by stage. */
  async function runPlan(plan: CompiledPlan): Promise<Transaction[]> {
    const sent: Transaction[] = [];
    for (const stage of plan.stages) {
      for (const { transaction } of stage) {
        const tx = getTransactionDecoder().decode(getBase64Encoder().encode(transaction));
        expect(
          tx.messageBytes.length + 1 + 64 * Object.keys(tx.signatures).length,
        ).toBeLessThanOrEqual(1232);
        const signed = await partiallySignTransaction([feePayerPair], tx);
        expectOk(svm.sendTransaction(signed as Parameters<typeof svm.sendTransaction>[0]));
        sent.push(signed);
      }
    }
    svm.expireBlockhash();
    return sent;
  }

  function expectOk(result: unknown) {
    const r = result as {
      err?: () => unknown;
      logs?: () => string[];
      meta?: () => { logs: () => string[] };
    };
    if (typeof r.err === 'function') {
      throw new Error(
        `transaction failed: ${String(r.err())}\n${(r.meta?.().logs() ?? []).join('\n')}`,
      );
    }
  }

  const account = (addr: Address) => {
    const a = svm.getAccount(addr);
    if (!a.exists) throw new Error(`missing account ${addr}`);
    return a.data as Uint8Array;
  };
  const tokenAmount = (addr: Address) => new DataView(account(addr).buffer).getBigUint64(64, true);
  const confidential = (addr: Address) => decodeConfidentialAccount(account(addr))!;

  interface User {
    keys: UserKeys;
    signer: KeyPairSigner;
    usdc: Address;
    cusdc: Address;
  }

  async function newUser(usdc: bigint): Promise<User> {
    const keys = deriveUserKeys(crypto.getRandomValues(new Uint8Array(32)));
    const signer = await createKeyPairSignerFromPrivateKeyBytes(keys.solanaSeed);
    const user: User = {
      keys,
      signer,
      usdc: await findAta(signer.address, vault.usdcMint, TOKEN_PROGRAM),
      cusdc: await findAta(signer.address, vault.cusdcMint, TOKEN_2022_PROGRAM),
    };
    // An exchange withdrawal lands USDC in the user's wallet: ATA + balance, no SOL.
    await sendDirect(admin, [
      getCreateAssociatedTokenIdempotentInstruction({
        payer: admin,
        ata: user.usdc,
        owner: signer.address,
        mint: vault.usdcMint,
        tokenProgram: TOKEN_PROGRAM,
      }),
      getMintToInstruction(
        { mint: vault.usdcMint, token: user.usdc, mintAuthority: admin, amount: usdc },
        { programAddress: TOKEN_PROGRAM },
      ),
    ]);
    const plan = configurePlan({
      vault,
      feePayer: feePayer.address,
      owner: signer,
      tokenAccount: user.cusdc,
      pubkeyValidityProof: pubkeyValidityProof(keys.elgamal),
      decryptableZeroBalance: decryptableZeroBalance(keys.ae),
      rent,
    });
    await runPlan(await compilePlan(plan, { feePayer: feePayer.address, ...blockhash() }));
    return user;
  }

  function availableBalance(user: User): bigint {
    const ct = AeCiphertext.fromBytes(confidential(user.cusdc).decryptableAvailableBalance)!;
    return ct.decrypt(user.keys.ae)!;
  }

  /** Apply everything pending, as a recipient's SDK does. */
  async function applyPending(user: User) {
    const state = confidential(user.cusdc);
    const pending = decryptPendingBalance(
      user.keys.elgamal.secret(),
      state.pendingBalanceLo,
      state.pendingBalanceHi,
    );
    const plan = applyPendingPlan({
      owner: user.signer,
      ownerCusdc: user.cusdc,
      expectedPendingBalanceCreditCounter: state.pendingBalanceCreditCounter,
      newDecryptableAvailableBalance: user.keys.ae
        .encrypt(availableBalance(user) + pending)
        .toBytes(),
    });
    await runPlan(await compilePlan(plan, { feePayer: feePayer.address, ...blockhash() }));
  }

  async function transfer(from: User, to: User, amount: bigint) {
    const state = confidential(from.cusdc);
    const proofs = buildTransferProofs({
      elgamal: from.keys.elgamal,
      ae: from.keys.ae,
      availableBalance: state.availableBalance,
      decryptableAvailableBalance: state.decryptableAvailableBalance,
      amount,
      destinationElgamalPubkey: to.keys.elgamal.pubkey().toBytes(),
      auditorElgamalPubkey: null,
    });
    const plan = await transferPlan({
      feePayer: feePayer.address,
      owner: from.signer,
      mint: vault.cusdcMint,
      sourceToken: from.cusdc,
      destinationToken: to.cusdc,
      proofs,
      rent,
    });
    return runPlan(await compilePlan(plan, { feePayer: feePayer.address, ...blockhash() }));
  }

  /** Deposit `amount` and apply everything pending, as the SDK does. */
  async function deposit(user: User, amount: bigint) {
    const state = confidential(user.cusdc);
    const pending = decryptPendingBalance(
      user.keys.elgamal.secret(),
      state.pendingBalanceLo,
      state.pendingBalanceHi,
    );
    const newBalance = availableBalance(user) + pending + amount;
    const plan = depositPlan({
      vault,
      owner: user.signer,
      ownerUsdc: user.usdc,
      ownerCusdc: user.cusdc,
      amount,
      expectedPendingBalanceCreditCounter: state.pendingBalanceCreditCounter + 1n,
      newDecryptableAvailableBalance: user.keys.ae.encrypt(newBalance).toBytes(),
    });
    await runPlan(await compilePlan(plan, { feePayer: feePayer.address, ...blockhash() }));
  }

  beforeAll(async () => {
    feePayerPair = await generateKeyPair();
    feePayer = await createSignerFromKeyPair(feePayerPair);
    admin = await generateKeyPairSigner();
    svm.airdrop(feePayer.address, lamports(10_000_000_000n));
    svm.airdrop(admin.address, lamports(10_000_000_000n));

    // Load the vault as an upgradeable program whose upgrade authority is `admin`.
    svm.addProgram(VAULT_PROGRAM, readFileSync(VAULT_SO));
    const [programData] = await (
      await import('@solana/kit')
    ).getProgramDerivedAddress({
      programAddress: LOADER,
      seeds: [getAddressEncoder().encode(VAULT_PROGRAM)],
    });
    const pd = svm.getAccount(programData);
    if (!pd.exists) throw new Error('programdata missing');
    const data = new Uint8Array(pd.data);
    data[12] = 1;
    data.set(getAddressEncoder().encode(admin.address), 13);
    svm.setAccount({ ...pd, data });

    const config = await findVaultConfig();
    const usdcMint = await generateKeyPairSigner();
    const cusdcMint = await generateKeyPairSigner();
    const mintRent = (n: number | bigint) =>
      lamports(svm.minimumBalanceForRentExemption(BigInt(n)));
    await sendDirect(admin, [
      getCreateAccountInstruction({
        payer: admin,
        newAccount: usdcMint,
        lamports: mintRent(82),
        space: 82,
        programAddress: TOKEN_PROGRAM,
      }),
      getInitializeMint2Instruction(
        {
          mint: usdcMint.address,
          decimals: 6,
          mintAuthority: admin.address,
          freezeAuthority: null,
        },
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
        lamports: mintRent(cusdcSpace),
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
          { address: admin.address, role: 3, signer: admin },
          { address: config, role: 1 },
          { address: usdcMint.address, role: 0 },
          { address: cusdcMint.address, role: 0 },
          { address: reserve, role: 1 },
          { address: VAULT_PROGRAM, role: 0 },
          { address: programData, role: 0 },
          { address: TOKEN_PROGRAM, role: 0 },
          { address: address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'), role: 0 },
          { address: address('11111111111111111111111111111111'), role: 0 },
        ],
      } as Instruction,
    ]);

    vault = {
      config,
      usdcMint: usdcMint.address,
      cusdcMint: cusdcMint.address,
      usdcReserve: reserve,
    };
    rent = {
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
    };
  });

  it('configures a confidential account for a user with no SOL', async () => {
    const carol = await newUser(0n);
    const state = confidential(carol.cusdc);
    expect(state.approved).toBe(true);
    expect([...state.elgamalPubkey]).toEqual([...carol.keys.elgamal.pubkey().toBytes()]);
    expect(svm.getBalance(carol.signer.address) ?? 0n).toBe(0n);
  });

  it('deposits, transfers confidentially and withdraws, with no amount on the wire', async () => {
    const alice = await newUser(100n * USDC);
    const bob = await newUser(0n);

    await deposit(alice, 50n * USDC);
    expect(availableBalance(alice)).toBe(50n * USDC);
    expect(tokenAmount(vault.usdcReserve)).toBe(50n * USDC);

    // --- confidential transfer: alice → bob, 12.5 USDC ---
    const amount = 12_500_000n;
    const feePayerBefore = svm.getBalance(feePayer.address)!;
    const aliceState = confidential(alice.cusdc);
    const proofs = buildTransferProofs({
      elgamal: alice.keys.elgamal,
      ae: alice.keys.ae,
      availableBalance: aliceState.availableBalance,
      decryptableAvailableBalance: aliceState.decryptableAvailableBalance,
      amount,
      destinationElgamalPubkey: bob.keys.elgamal.pubkey().toBytes(),
      auditorElgamalPubkey: null,
    });
    const plan = await transferPlan({
      feePayer: feePayer.address,
      owner: alice.signer,
      mint: vault.cusdcMint,
      sourceToken: alice.cusdc,
      destinationToken: bob.cusdc,
      proofs,
      rent,
    });
    const sent = await runPlan(
      await compilePlan(plan, { feePayer: feePayer.address, ...blockhash() }),
    );

    // The amount never appears in any transaction's bytes, in any encoding we'd use.
    const needles = [amount, amount & 0xffffn, amount >> 16n].map((n) => {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setBigUint64(0, n, true);
      return b;
    });
    for (const tx of sent) {
      for (const needle of needles) expect(indexOf(tx.messageBytes, needle)).toBe(-1);
    }

    expect(availableBalance(alice)).toBe(50n * USDC - amount);
    const bobState = confidential(bob.cusdc);
    expect(
      decryptPendingBalance(
        bob.keys.elgamal.secret(),
        bobState.pendingBalanceLo,
        bobState.pendingBalanceHi,
      ),
    ).toBe(amount);
    // Bob can also read the amount from the transfer's ciphertexts, as the activity feed will.
    expect(
      decryptTransferAmount(
        bob.keys.elgamal.secret(),
        proofs.groupedCiphertextLo,
        proofs.groupedCiphertextHi,
        1,
      ),
    ).toBe(amount);
    // Context accounts were closed: the fee payer only paid transaction fees.
    const feesPaid = feePayerBefore - svm.getBalance(feePayer.address)!;
    expect(feesPaid).toBeLessThan(50_000n);

    // --- withdraw: alice → an outside wallet, 10 USDC ---
    const outside = await generateKeyPairSigner();
    const destination = await findAta(outside.address, vault.usdcMint, TOKEN_PROGRAM);
    const before = confidential(alice.cusdc);
    const withdrawal = buildWithdrawProofs({
      elgamal: alice.keys.elgamal,
      ae: alice.keys.ae,
      availableBalance: before.availableBalance,
      decryptableAvailableBalance: before.decryptableAvailableBalance,
      amount: 10n * USDC,
    });
    const wplan = await withdrawPlan({
      vault,
      feePayer: feePayer.address,
      owner: alice.signer,
      ownerCusdc: alice.cusdc,
      destination,
      createDestinationFor: outside.address,
      amount: 10n * USDC,
      decimals: 6,
      proofs: withdrawal,
      rent,
    });
    await runPlan(await compilePlan(wplan, { feePayer: feePayer.address, ...blockhash() }));

    expect(tokenAmount(destination)).toBe(10n * USDC);
    expect(availableBalance(alice)).toBe(50n * USDC - amount - 10n * USDC);
    expect(tokenAmount(vault.usdcReserve)).toBe(40n * USDC);

    // Bob makes the received funds spendable, then sends some back.
    await applyPending(bob);
    expect(availableBalance(bob)).toBe(amount);
    await transfer(bob, alice, 2_500_000n);
    expect(availableBalance(bob)).toBe(10n * USDC);
    await applyPending(alice);
    expect(availableBalance(alice)).toBe(50n * USDC - amount - 10n * USDC + 2_500_000n);

    // Supply and reserve still match: everything in cUSDC is backed.
    const mintData = account(vault.cusdcMint);
    expect(new DataView(mintData.buffer).getBigUint64(36, true)).toBe(
      tokenAmount(vault.usdcReserve),
    );
  });

  it('refuses to let a transfer overdraw, before anything is sent', async () => {
    const dave = await newUser(5n * USDC);
    await deposit(dave, 5n * USDC);
    const eve = await newUser(0n);
    await expect(transfer(dave, eve, 6n * USDC)).rejects.toThrow(/insufficient/);
  });
});

function indexOf(haystack: ArrayLike<number>, needle: ArrayLike<number>): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
