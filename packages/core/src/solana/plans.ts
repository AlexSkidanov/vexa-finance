/**
 * Transaction plans: every Vexa money movement as an ordered set of Solana
 * transactions.
 *
 * Users hold USDC, not SOL, so Vexa's fee payer pays network fees and any
 * temporary rent. A plan is built and partially signed on the user's device.
 * The API checks each transaction against a strict policy, co-signs as fee
 * payer and broadcasts. Stages run in order; transactions within a stage are
 * independent and may land in any order.
 *
 * A confidential transfer doesn't fit in one transaction (proofs alone are
 * ~1.9 KB against a 1232-byte limit), so it runs as:
 *
 *   stage 1  create equality, validity and range context accounts   (fee payer + 3 fresh keys sign)
 *   stage 2  verify equality + validity  ∥  verify range             (fee payer signs)
 *   stage 3  Token-2022 Transfer reading the contexts, then close them (owner + fee payer sign)
 *
 * The fee payer is the contexts' authority, which keeps the range-proof
 * transaction at 1207 bytes, and gets their rent back when they close.
 */
import {
  appendTransactionMessageInstructions,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLifetimeUsingDurableNonce,
  type Nonce,
  type Address,
  type Blockhash,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit';
import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import {
  getApplyConfidentialPendingBalanceInstruction,
  getConfidentialTransferInstruction,
  getConfidentialWithdrawInstruction,
} from '@solana-program/token-2022';
import {
  closeContextStateInstruction,
  contextStateSpace,
  ProofType,
  verifyProofInstruction,
} from './proof-program.js';
import {
  findAta,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  VAULT_PROGRAM,
  ZK_ELGAMAL_PROOF_PROGRAM,
} from './programs.js';
import {
  configureConfidentialAccountInstruction,
  depositInstruction,
  findStakeRecord,
  stakeInstruction,
  unstakeInstruction,
  withdrawInstruction,
  type VaultAccounts,
} from './vault.js';

export type PlanKind =
  | 'configure'
  | 'deposit'
  | 'apply-pending'
  | 'transfer'
  | 'withdraw'
  | 'stake'
  | 'unstake'
  | 'agent-configure'
  | 'agent-apply-pending'
  | 'agent-payment'
  | 'agent-sweep';

export type StepLabel =
  | 'fund-and-configure'
  | 'deposit'
  | 'apply-pending'
  | 'create-proof-contexts'
  | 'verify-equality-and-validity'
  | 'verify-range'
  | 'verify-equality'
  | 'transfer'
  | 'withdraw'
  | 'stake'
  | 'unstake'
  | 'verify-limit'
  | 'agent-transfer';

export interface PlannedTransaction {
  label: StepLabel;
  /**
   * Use a durable nonce instead of the recent blockhash. The nonce advance is
   * prepended to the instructions. Agent payments use this.
   */
  durableNonce?: { nonceAccount: Address; authority: Address; nonce: string };
  instructions: Instruction[];
}

export interface Plan {
  kind: PlanKind;
  stages: PlannedTransaction[][];
}

/** Rent-exempt minimums the plan needs, supplied by the API's prepare call. */
export interface RentTable {
  /** A cUSDC ATA with the confidential extension (469 bytes). */
  confidentialAccount: bigint;
  equalityContext: bigint;
  validityContext: bigint;
  rangeU128Context: bigint;
  rangeU64Context: bigint;
  /** A vault stake record (82 bytes). */
  stakeRecord: bigint;
  /** A plain SPL token account (165 bytes): the stake vault. */
  tokenAccount: bigint;
}

/** Bytes of a Token-2022 ATA (with ImmutableOwner) plus the confidential extension. */
export const CONFIDENTIAL_ACCOUNT_SPACE = 469n;

// ---------------------------------------------------------------------------
// Configure (first use): fund the owner's rent, prove the key, configure
// ---------------------------------------------------------------------------

export function configurePlan(input: {
  vault: VaultAccounts;
  feePayer: Address;
  owner: TransactionSigner;
  tokenAccount: Address;
  pubkeyValidityProof: Uint8Array;
  decryptableZeroBalance: Uint8Array;
  rent: Pick<RentTable, 'confidentialAccount'>;
}): Plan {
  return {
    kind: 'configure',
    stages: [
      [
        {
          label: 'fund-and-configure',
          instructions: [
            // The vault charges the account's rent to its owner; Vexa sponsors it.
            getTransferSolInstruction({
              source: createNoopSigner(input.feePayer),
              destination: input.owner.address,
              amount: input.rent.confidentialAccount,
            }),
            verifyProofInstruction(ProofType.VerifyPubkeyValidity, input.pubkeyValidityProof),
            configureConfidentialAccountInstruction({
              vault: input.vault,
              owner: input.owner,
              tokenAccount: input.tokenAccount,
              decryptableZeroBalance: input.decryptableZeroBalance,
              proofInstructionOffset: -1,
            }),
          ],
        },
      ],
    ],
  };
}

// ---------------------------------------------------------------------------
// Deposit: USDC in, cUSDC to pending, apply to available
// ---------------------------------------------------------------------------

export function depositPlan(input: {
  vault: VaultAccounts;
  owner: TransactionSigner;
  ownerUsdc: Address;
  ownerCusdc: Address;
  /** USDC taken from the wallet, fee included. */
  amount: bigint;
  discountAccounts?: Address[];
  /** The account's credit counter after this deposit lands (current + 1). */
  expectedPendingBalanceCreditCounter: bigint;
  /** AE encryption of (available + everything pending + amount − fee). */
  newDecryptableAvailableBalance: Uint8Array;
}): Plan {
  return {
    kind: 'deposit',
    stages: [
      [
        {
          label: 'deposit',
          instructions: [
            depositInstruction({
              vault: input.vault,
              owner: input.owner,
              ownerUsdc: input.ownerUsdc,
              ownerCusdc: input.ownerCusdc,
              amount: input.amount,
              discountAccounts: input.discountAccounts,
            }),
            getApplyConfidentialPendingBalanceInstruction({
              token: input.ownerCusdc,
              authority: input.owner,
              expectedPendingBalanceCreditCounter: input.expectedPendingBalanceCreditCounter,
              newDecryptableAvailableBalance: input.newDecryptableAvailableBalance,
            }),
          ],
        },
      ],
    ],
  };
}

// ---------------------------------------------------------------------------
// Apply pending: make received transfers spendable
// ---------------------------------------------------------------------------

/**
 * Incoming transfers land in the recipient's pending balance. Applying moves
 * them into the available balance, re-encrypting the total under the owner's
 * AE key; only the owner can do it.
 */
export function applyPendingPlan(input: {
  owner: TransactionSigner;
  ownerCusdc: Address;
  /** The account's current `pending_balance_credit_counter`. */
  expectedPendingBalanceCreditCounter: bigint;
  /** AE encryption of (available + pending). */
  newDecryptableAvailableBalance: Uint8Array;
}): Plan {
  return {
    kind: 'apply-pending',
    stages: [
      [
        {
          label: 'apply-pending',
          instructions: [
            getApplyConfidentialPendingBalanceInstruction({
              token: input.ownerCusdc,
              authority: input.owner,
              expectedPendingBalanceCreditCounter: input.expectedPendingBalanceCreditCounter,
              newDecryptableAvailableBalance: input.newDecryptableAvailableBalance,
            }),
          ],
        },
      ],
    ],
  };
}

// ---------------------------------------------------------------------------
// Confidential transfer
// ---------------------------------------------------------------------------

export interface TransferPlanInput {
  feePayer: Address;
  owner: TransactionSigner;
  mint: Address;
  sourceToken: Address;
  destinationToken: Address;
  proofs: {
    equalityProof: Uint8Array;
    ciphertextValidityProof: Uint8Array;
    rangeProof: Uint8Array;
    auditorCiphertextLo: Uint8Array;
    auditorCiphertextHi: Uint8Array;
    newDecryptableAvailableBalance: Uint8Array;
  };
  rent: Pick<RentTable, 'equalityContext' | 'validityContext' | 'rangeU128Context'>;
}

export async function transferPlan(input: TransferPlanInput): Promise<Plan> {
  const feePayer = createNoopSigner(input.feePayer);
  const [equality, validity, range] = await Promise.all([
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
  ]);
  const ctx = (account: Address) => ({ account, authority: input.feePayer });
  const create = (account: TransactionSigner, lamports: bigint, space: bigint) =>
    getCreateAccountInstruction({
      payer: feePayer,
      newAccount: account,
      lamports,
      space,
      programAddress: ZK_ELGAMAL_PROOF_PROGRAM,
    });

  return {
    kind: 'transfer',
    stages: [
      [
        {
          label: 'create-proof-contexts',
          instructions: [
            create(
              equality,
              input.rent.equalityContext,
              contextStateSpace(ProofType.VerifyCiphertextCommitmentEquality),
            ),
            create(
              validity,
              input.rent.validityContext,
              contextStateSpace(ProofType.VerifyBatchedGroupedCiphertext3HandlesValidity),
            ),
            create(
              range,
              input.rent.rangeU128Context,
              contextStateSpace(ProofType.VerifyBatchedRangeProofU128),
            ),
          ],
        },
      ],
      [
        {
          label: 'verify-equality-and-validity',
          instructions: [
            verifyProofInstruction(
              ProofType.VerifyCiphertextCommitmentEquality,
              input.proofs.equalityProof,
              ctx(equality.address),
            ),
            verifyProofInstruction(
              ProofType.VerifyBatchedGroupedCiphertext3HandlesValidity,
              input.proofs.ciphertextValidityProof,
              ctx(validity.address),
            ),
          ],
        },
        {
          label: 'verify-range',
          instructions: [
            verifyProofInstruction(
              ProofType.VerifyBatchedRangeProofU128,
              input.proofs.rangeProof,
              ctx(range.address),
            ),
          ],
        },
      ],
      [
        {
          label: 'transfer',
          instructions: [
            getConfidentialTransferInstruction({
              sourceToken: input.sourceToken,
              mint: input.mint,
              destinationToken: input.destinationToken,
              equalityRecord: equality.address,
              ciphertextValidityRecord: validity.address,
              rangeRecord: range.address,
              authority: input.owner,
              newSourceDecryptableAvailableBalance: input.proofs.newDecryptableAvailableBalance,
              transferAmountAuditorCiphertextLo: input.proofs.auditorCiphertextLo,
              transferAmountAuditorCiphertextHi: input.proofs.auditorCiphertextHi,
              equalityProofInstructionOffset: 0,
              ciphertextValidityProofInstructionOffset: 0,
              rangeProofInstructionOffset: 0,
            }),
            closeContextStateInstruction(equality.address, input.feePayer, input.feePayer),
            closeContextStateInstruction(validity.address, input.feePayer, input.feePayer),
            closeContextStateInstruction(range.address, input.feePayer, input.feePayer),
          ],
        },
      ],
    ],
  };
}

// ---------------------------------------------------------------------------
// Stake / unstake: lock $VEXA in the vault for discounts and agent limits
// ---------------------------------------------------------------------------

async function stakeAccounts(
  vault: VaultAccounts,
  owner: Address,
  vexaMint: Address,
  tokenProgram: Address,
) {
  const [ownerVexa, stakeVault, stakeRecord] = await Promise.all([
    findAta(owner, vexaMint, tokenProgram),
    findAta(vault.config, vexaMint, tokenProgram),
    findStakeRecord(owner, vault.program ?? VAULT_PROGRAM),
  ]);
  return { ownerVexa, stakeVault, stakeRecord };
}

/**
 * Stakes `amount` $VEXA. The fee payer funds the stake record (and the stake
 * vault, once) the first time; after that it only pays the fee.
 */
export async function stakePlan(input: {
  vault: VaultAccounts;
  feePayer: Address;
  owner: TransactionSigner;
  vexaMint: Address;
  amount: bigint;
  /** The token program that owns the $VEXA mint (Token or Token-2022); classic Token unless given. */
  tokenProgram?: Address;
}): Promise<Plan> {
  const tokenProgram = input.tokenProgram ?? TOKEN_PROGRAM;
  const accounts = await stakeAccounts(
    input.vault,
    input.owner.address,
    input.vexaMint,
    tokenProgram,
  );
  return {
    kind: 'stake',
    stages: [
      [
        {
          label: 'stake',
          instructions: [
            stakeInstruction({
              vault: input.vault,
              owner: input.owner,
              payer: createNoopSigner(input.feePayer),
              vexaMint: input.vexaMint,
              amount: input.amount,
              tokenProgram,
              ...accounts,
            }),
          ],
        },
      ],
    ],
  };
}

export async function unstakePlan(input: {
  vault: VaultAccounts;
  owner: TransactionSigner;
  vexaMint: Address;
  amount: bigint;
  /** The token program that owns the $VEXA mint (Token or Token-2022); classic Token unless given. */
  tokenProgram?: Address;
}): Promise<Plan> {
  const tokenProgram = input.tokenProgram ?? TOKEN_PROGRAM;
  const accounts = await stakeAccounts(
    input.vault,
    input.owner.address,
    input.vexaMint,
    tokenProgram,
  );
  return {
    kind: 'unstake',
    stages: [
      [
        {
          label: 'unstake',
          instructions: [
            unstakeInstruction({
              vault: input.vault,
              owner: input.owner,
              vexaMint: input.vexaMint,
              amount: input.amount,
              tokenProgram,
              ...accounts,
            }),
          ],
        },
      ],
    ],
  };
}

// ---------------------------------------------------------------------------
// Withdraw: confidential → public → burn, USDC out
// ---------------------------------------------------------------------------

export interface WithdrawPlanInput {
  vault: VaultAccounts;
  feePayer: Address;
  owner: TransactionSigner;
  ownerCusdc: Address;
  /**
   * An existing USDC token account receiving the funds. Creating one costs
   * permanent rent, which Vexa doesn't sponsor.
   */
  destination: Address;
  /** cUSDC leaving the confidential balance; the destination gets it less the fee. */
  amount: bigint;
  discountAccounts?: Address[];
  decimals: number;
  proofs: {
    equalityProof: Uint8Array;
    rangeProof: Uint8Array;
    newDecryptableAvailableBalance: Uint8Array;
  };
  rent: Pick<RentTable, 'equalityContext' | 'rangeU64Context'>;
}

export async function withdrawPlan(input: WithdrawPlanInput): Promise<Plan> {
  const feePayer = createNoopSigner(input.feePayer);
  const [equality, range] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  const ctx = (account: Address) => ({ account, authority: input.feePayer });

  const withdraw: Instruction[] = [
    getConfidentialWithdrawInstruction({
      token: input.ownerCusdc,
      mint: input.vault.cusdcMint,
      equalityRecord: equality.address,
      rangeRecord: range.address,
      authority: input.owner,
      amount: input.amount,
      decimals: input.decimals,
      newDecryptableAvailableBalance: input.proofs.newDecryptableAvailableBalance,
      equalityProofInstructionOffset: 0,
      rangeProofInstructionOffset: 0,
    }),
    withdrawInstruction({
      vault: input.vault,
      owner: input.owner,
      ownerCusdc: input.ownerCusdc,
      destination: input.destination,
      amount: input.amount,
      discountAccounts: input.discountAccounts,
    }),
    closeContextStateInstruction(equality.address, input.feePayer, input.feePayer),
    closeContextStateInstruction(range.address, input.feePayer, input.feePayer),
  ];

  return {
    kind: 'withdraw',
    stages: [
      [
        {
          label: 'verify-equality',
          instructions: [
            getCreateAccountInstruction({
              payer: feePayer,
              newAccount: equality,
              lamports: input.rent.equalityContext,
              space: contextStateSpace(ProofType.VerifyCiphertextCommitmentEquality),
              programAddress: ZK_ELGAMAL_PROOF_PROGRAM,
            }),
            getCreateAccountInstruction({
              payer: feePayer,
              newAccount: range,
              lamports: input.rent.rangeU64Context,
              space: contextStateSpace(ProofType.VerifyBatchedRangeProofU64),
              programAddress: ZK_ELGAMAL_PROOF_PROGRAM,
            }),
            verifyProofInstruction(
              ProofType.VerifyCiphertextCommitmentEquality,
              input.proofs.equalityProof,
              ctx(equality.address),
            ),
          ],
        },
      ],
      [
        {
          label: 'verify-range',
          instructions: [
            verifyProofInstruction(
              ProofType.VerifyBatchedRangeProofU64,
              input.proofs.rangeProof,
              ctx(range.address),
            ),
          ],
        },
      ],
      [{ label: 'withdraw', instructions: withdraw }],
    ],
  };
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

export interface CompiledTransaction {
  label: StepLabel;
  /** Base64 wire transaction, signed by everyone except the fee payer. */
  transaction: string;
}

export interface CompiledPlan {
  kind: PlanKind;
  stages: CompiledTransaction[][];
}

/**
 * Turns a plan into wire transactions with `feePayer` as fee payer, signed by
 * every signer attached to the instructions (the owner, fresh context keys).
 * The fee payer's signature is added by the API.
 */
export async function compilePlan(
  plan: Plan,
  opts: { feePayer: Address; blockhash: Blockhash; lastValidBlockHeight: bigint },
): Promise<CompiledPlan> {
  const feePayer = createNoopSigner(opts.feePayer);
  const stages: CompiledTransaction[][] = [];
  for (const stage of plan.stages) {
    const compiled: CompiledTransaction[] = [];
    for (const step of stage) {
      const base = pipe(createTransactionMessage({ version: 0 }), (m) =>
        setTransactionMessageFeePayerSigner(feePayer, m),
      );
      const timed = step.durableNonce
        ? setTransactionMessageLifetimeUsingDurableNonce(
            {
              nonce: step.durableNonce.nonce as Nonce,
              nonceAccountAddress: step.durableNonce.nonceAccount,
              nonceAuthorityAddress: step.durableNonce.authority,
            },
            base,
          )
        : setTransactionMessageLifetimeUsingBlockhash(
            { blockhash: opts.blockhash, lastValidBlockHeight: opts.lastValidBlockHeight },
            base,
          );
      const message = appendTransactionMessageInstructions(step.instructions, timed);
      const signed = await partiallySignTransactionMessageWithSigners(message);
      compiled.push({ label: step.label, transaction: getBase64EncodedWireTransaction(signed) });
    }
    stages.push(compiled);
  }
  return { kind: plan.kind, stages };
}

export { TOKEN_2022_PROGRAM };
