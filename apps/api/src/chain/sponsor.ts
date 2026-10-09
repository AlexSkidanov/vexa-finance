/**
 * Sponsorship policy: what Vexa's fee payer will co-sign.
 *
 * Clients build and sign their own transactions (only they hold their keys),
 * then ask the API to add the fee payer's signature. The fee payer holds real
 * SOL, so every transaction is decoded and checked against an allow-list
 * before it's signed. Anything not explicitly allowed is refused.
 *
 * The fee payer may appear in exactly these roles:
 *   - as the transaction fee payer (account 0);
 *   - System CreateAccount funding a proof context account: owner is the ZK
 *     ElGamal proof program, size is a known context size, lamports equal its
 *     rent-exempt minimum;
 *   - System Transfer of exactly one confidential account's rent to the
 *     authenticated user, in a `configure` plan only;
 *   - authority of a proof context (verify) and authority + refund destination
 *     when closing one.
 *
 * Every context account created in a plan must be closed by the same plan, so
 * its rent comes back. Programs are limited to System, Token-2022 (only the
 * confidential-transfer instructions a plan needs), the ZK proof program, the
 * vault and the associated token program.
 */
import {
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Address,
  type Transaction,
} from '@solana/kit';
import {
  ASSOCIATED_TOKEN_PROGRAM,
  contextStateSpace,
  ProofType,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  VAULT_PROGRAM,
  ZK_ELGAMAL_PROOF_PROGRAM,
  type PlanKind,
  type RentTable,
  type StepLabel,
} from '@vexa/core/solana';

export class SponsorshipRefused extends Error {
  constructor(
    message: string,
    readonly stage?: number,
    readonly index?: number,
  ) {
    super(message);
    this.name = 'SponsorshipRefused';
  }
}

export interface SponsorContext {
  kind: PlanKind;
  feePayer: Address;
  /** The authenticated user's Solana address: the only allowed token authority. */
  owner: Address;
  ownerCusdc: Address;
  cusdcMint: Address;
  usdcMint: Address;
  vaultConfig: Address;
  rent: RentTable;
  /** transfer: the recipient's cUSDC account. withdraw: the USDC destination. */
  counterparty?: Address;
  /** configure: whether the owner's cUSDC account is still missing (rent is only sponsored then). */
  sponsorAccountRent?: boolean;
}

export interface DecodedInstruction {
  program: Address;
  accounts: Address[];
  data: Uint8Array;
}

export interface CheckedTransaction {
  label: StepLabel;
  transaction: Transaction;
  instructions: DecodedInstruction[];
}

/** Stage/transaction shape the API accepts for each kind of plan. */
const PLAN_SHAPES: Record<PlanKind, StepLabel[][]> = {
  configure: [['fund-and-configure']],
  deposit: [['deposit']],
  'apply-pending': [['apply-pending']],
  transfer: [
    ['create-proof-contexts'],
    ['verify-equality-and-validity', 'verify-range'],
    ['transfer'],
  ],
  withdraw: [['verify-equality'], ['verify-range'], ['withdraw']],
};

const MAX_TRANSACTION_BYTES = 1232;

// Instruction tags.
const SYSTEM_CREATE_ACCOUNT = 0;
const SYSTEM_TRANSFER = 2;
const T22_CONFIDENTIAL_TRANSFER = 27;
const CT_WITHDRAW = 6;
const CT_TRANSFER = 7;
const CT_APPLY_PENDING = 8;
const VAULT_CONFIGURE = 1;
const VAULT_DEPOSIT = 2;
const VAULT_WITHDRAW = 3;

const u32 = (d: Uint8Array, o: number) =>
  new DataView(d.buffer, d.byteOffset + o, 4).getUint32(0, true);
const u64 = (d: Uint8Array, o: number) =>
  new DataView(d.buffer, d.byteOffset + o, 8).getBigUint64(0, true);

export function decodeWireTransaction(base64: string): Transaction {
  try {
    return getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  } catch {
    throw new SponsorshipRefused('not a valid Solana transaction');
  }
}

function decodeInstructions(tx: Transaction, feePayer: Address): DecodedInstruction[] {
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  // Plans compile to v0 messages; anything else is not ours.
  if (message.version !== 0 && message.version !== 'legacy') {
    throw new SponsorshipRefused('unsupported transaction version');
  }
  if ('addressTableLookups' in message && (message.addressTableLookups?.length ?? 0) > 0) {
    throw new SponsorshipRefused('address lookup tables are not accepted');
  }
  const keys = message.staticAccounts;
  if (keys[0] !== feePayer) throw new SponsorshipRefused('fee payer must be Vexa’s fee payer');
  return message.instructions.map((ix) => {
    const program = keys[ix.programAddressIndex];
    if (!program) throw new SponsorshipRefused('instruction references a missing program');
    return {
      program,
      accounts: (ix.accountIndices ?? []).map((i) => {
        const a = keys[i];
        if (!a) throw new SponsorshipRefused('instruction references a missing account');
        return a;
      }),
      data: new Uint8Array(ix.data ?? []),
    };
  });
}

/**
 * Validates a whole plan. Returns the decoded transactions in stage order,
 * ready to be co-signed. Throws SponsorshipRefused on the first violation.
 */
export function checkPlan(
  stages: { label: string; transaction: string }[][],
  ctx: SponsorContext,
): CheckedTransaction[][] {
  const shape = PLAN_SHAPES[ctx.kind];
  if (stages.length !== shape.length)
    throw new SponsorshipRefused(`a ${ctx.kind} plan has ${shape.length} stages`);

  const created = new Set<Address>();
  const closed = new Set<Address>();
  let sponsoredRent = 0n;

  const checked = stages.map((stage, s) => {
    const labels = stage.map((t) => t.label).sort();
    if (JSON.stringify(labels) !== JSON.stringify([...shape[s]!].sort())) {
      throw new SponsorshipRefused(`stage ${s + 1} must contain ${shape[s]!.join(', ')}`, s);
    }
    return stage.map((step, i) => {
      const transaction = decodeWireTransaction(step.transaction);
      const size =
        1 + 64 * Object.keys(transaction.signatures).length + transaction.messageBytes.length;
      if (size > MAX_TRANSACTION_BYTES)
        throw new SponsorshipRefused('transaction exceeds 1232 bytes', s, i);

      const instructions = decodeInstructions(transaction, ctx.feePayer);
      for (const ix of instructions) {
        try {
          sponsoredRent += checkInstruction(ix, ctx, step.label as StepLabel, created, closed);
        } catch (e) {
          if (e instanceof SponsorshipRefused) throw new SponsorshipRefused(e.message, s, i);
          throw e;
        }
      }
      return { label: step.label as StepLabel, transaction, instructions };
    });
  });

  for (const account of created) {
    if (!closed.has(account))
      throw new SponsorshipRefused('every proof context created must be closed by the plan');
  }
  if (sponsoredRent > ctx.rent.confidentialAccount) {
    throw new SponsorshipRefused('plan asks for more sponsored rent than allowed');
  }
  return checked;
}

/** Returns lamports permanently given away by this instruction (sponsored rent). */
function checkInstruction(
  ix: DecodedInstruction,
  ctx: SponsorContext,
  label: StepLabel,
  created: Set<Address>,
  closed: Set<Address>,
): bigint {
  const usesFeePayer = ix.accounts.includes(ctx.feePayer);

  switch (ix.program) {
    case SYSTEM_PROGRAM: {
      const tag = ix.data.length >= 4 ? u32(ix.data, 0) : -1;
      if (tag === SYSTEM_CREATE_ACCOUNT) {
        // from, new account; data: tag | lamports u64 | space u64 | owner
        const [from, account] = ix.accounts;
        const lamports = u64(ix.data, 4);
        const space = u64(ix.data, 12);
        const owner = addressAt(ix.data, 20);
        if (from !== ctx.feePayer || !account)
          throw new SponsorshipRefused('unexpected account creation');
        if (owner !== ZK_ELGAMAL_PROOF_PROGRAM) {
          throw new SponsorshipRefused('the fee payer only creates proof context accounts');
        }
        const expected = contextRent(space, ctx.rent);
        if (expected === null) throw new SponsorshipRefused('not a proof context size');
        if (lamports !== expected)
          throw new SponsorshipRefused('context rent must be exactly rent-exempt');
        created.add(account);
        return 0n; // refunded when the context is closed
      }
      if (tag === SYSTEM_TRANSFER) {
        const [from, to] = ix.accounts;
        const lamports = u64(ix.data, 4);
        if (from !== ctx.feePayer)
          throw new SponsorshipRefused('transfers must not move others’ SOL');
        if (ctx.kind !== 'configure' || label !== 'fund-and-configure' || !ctx.sponsorAccountRent) {
          throw new SponsorshipRefused(
            'rent is only sponsored when opening a confidential account',
          );
        }
        if (to !== ctx.owner || lamports !== ctx.rent.confidentialAccount) {
          throw new SponsorshipRefused('sponsored rent must go to the account owner, exactly');
        }
        return lamports;
      }
      throw new SponsorshipRefused('system instruction not allowed');
    }

    case ZK_ELGAMAL_PROOF_PROGRAM: {
      const type = ix.data[0];
      if (type === ProofType.CloseContextState) {
        const [account, destination, authority] = ix.accounts;
        if (destination !== ctx.feePayer || authority !== ctx.feePayer || !account) {
          throw new SponsorshipRefused('contexts must be closed back to the fee payer');
        }
        closed.add(account);
        return 0n;
      }
      const allowed: number[] = [
        ProofType.VerifyPubkeyValidity,
        ProofType.VerifyCiphertextCommitmentEquality,
        ProofType.VerifyBatchedRangeProofU64,
        ProofType.VerifyBatchedRangeProofU128,
        ProofType.VerifyBatchedGroupedCiphertext3HandlesValidity,
      ];
      if (type === undefined || !allowed.includes(type))
        throw new SponsorshipRefused('proof type not allowed');
      if (ix.accounts.length > 0) {
        const [account, authority] = ix.accounts;
        if (authority !== ctx.feePayer || !account || !created.has(account)) {
          throw new SponsorshipRefused('proofs must be recorded in a context created by this plan');
        }
      }
      return 0n;
    }

    case TOKEN_2022_PROGRAM: {
      if (usesFeePayer)
        throw new SponsorshipRefused('the fee payer takes no part in token instructions');
      if (ix.data[0] !== T22_CONFIDENTIAL_TRANSFER)
        throw new SponsorshipRefused('token instruction not allowed');
      const sub = ix.data[1];
      const source = ix.accounts[0];
      if (source !== ctx.ownerCusdc)
        throw new SponsorshipRefused('only the user’s own cUSDC account may be debited');
      const authority = ix.accounts[ix.accounts.length - 1];
      if (authority !== ctx.owner)
        throw new SponsorshipRefused('the user must authorize their own account');
      if (sub === CT_APPLY_PENDING && (ctx.kind === 'deposit' || ctx.kind === 'apply-pending'))
        return 0n;
      if (sub === CT_TRANSFER && ctx.kind === 'transfer') {
        // source, mint, destination, 3 contexts, authority
        if (ix.accounts[1] !== ctx.cusdcMint) throw new SponsorshipRefused('wrong mint');
        if (ix.accounts[2] !== ctx.counterparty)
          throw new SponsorshipRefused('recipient does not match the prepared transfer');
        for (const c of ix.accounts.slice(3, 6)) {
          if (!created.has(c))
            throw new SponsorshipRefused('transfer must use this plan’s proof contexts');
        }
        return 0n;
      }
      if (sub === CT_WITHDRAW && ctx.kind === 'withdraw') {
        if (ix.accounts[1] !== ctx.cusdcMint) throw new SponsorshipRefused('wrong mint');
        for (const c of ix.accounts.slice(2, 4)) {
          if (!created.has(c))
            throw new SponsorshipRefused('withdraw must use this plan’s proof contexts');
        }
        return 0n;
      }
      throw new SponsorshipRefused('confidential instruction not allowed in this plan');
    }

    case VAULT_PROGRAM: {
      if (usesFeePayer)
        throw new SponsorshipRefused('the fee payer takes no part in vault instructions');
      const tag = ix.data[0];
      const [owner, config] = ix.accounts;
      if (owner !== ctx.owner)
        throw new SponsorshipRefused('vault instructions must be the user’s own');
      if (tag === VAULT_CONFIGURE && ctx.kind === 'configure') {
        if (config !== ctx.vaultConfig || ix.accounts[3] !== ctx.ownerCusdc) {
          throw new SponsorshipRefused('unexpected configure accounts');
        }
        return 0n;
      }
      if (tag === VAULT_DEPOSIT && ctx.kind === 'deposit') {
        if (ix.accounts[6] !== ctx.ownerCusdc)
          throw new SponsorshipRefused('deposit must credit the user’s cUSDC');
        return 0n;
      }
      if (tag === VAULT_WITHDRAW && ctx.kind === 'withdraw') {
        if (ix.accounts[4] !== ctx.ownerCusdc)
          throw new SponsorshipRefused('withdraw must debit the user’s cUSDC');
        if (ix.accounts[6] !== ctx.counterparty)
          throw new SponsorshipRefused('destination does not match');
        return 0n;
      }
      throw new SponsorshipRefused('vault instruction not allowed in this plan');
    }

    case ASSOCIATED_TOKEN_PROGRAM:
      // Creating a token account costs permanent rent. Sponsoring it for
      // withdrawal destinations would let anyone drain the fee payer by
      // withdrawing dust to fresh wallets, so it's never sponsored.
      throw new SponsorshipRefused('the withdrawal destination must already have a USDC account');

    default:
      throw new SponsorshipRefused(`program ${ix.program} is not allowed`);
  }
}

function contextRent(space: bigint, rent: RentTable): bigint | null {
  switch (space) {
    case contextStateSpace(ProofType.VerifyCiphertextCommitmentEquality):
      return rent.equalityContext;
    case contextStateSpace(ProofType.VerifyBatchedGroupedCiphertext3HandlesValidity):
      return rent.validityContext;
    // U64 and U128 range contexts share a size; either rent value is the same.
    case contextStateSpace(ProofType.VerifyBatchedRangeProofU128):
      return rent.rangeU128Context;
    default:
      return null;
  }
}

function addressAt(data: Uint8Array, offset: number): Address {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const bytes = data.subarray(offset, offset + 32);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = A[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out as Address;
}
