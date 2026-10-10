/**
 * Instruction builders for the vault program. Account order and flags follow
 * programs/vault/src/processor/*.rs; data is a one-byte tag plus
 * little-endian arguments (programs/vault/src/instruction.rs).
 */
import {
  AccountRole,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit';
import {
  ASSOCIATED_TOKEN_PROGRAM,
  INSTRUCTIONS_SYSVAR,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  VAULT_PROGRAM,
} from './programs.js';

export const VaultInstruction = {
  Initialize: 0,
  ConfigureConfidentialAccount: 1,
  Deposit: 2,
  Withdraw: 3,
  SetPaused: 4,
  SetAdmin: 5,
  SetFees: 6,
  Stake: 7,
  Unstake: 8,
  RequireContexts: 9,
} as const;

export interface VaultAccounts {
  program?: Address;
  config: Address;
  usdcMint: Address;
  cusdcMint: Address;
  usdcReserve: Address;
  /** The fee schedule PDA, `["fees"]`. */
  fees: Address;
  /** The treasury's USDC account, as recorded in the fee schedule. */
  treasury: Address;
}

const ro = (address: Address) => ({ address, role: AccountRole.READONLY });
const rw = (address: Address) => ({ address, role: AccountRole.WRITABLE });

/**
 * Trailing accounts of Deposit and Withdraw: the fee schedule, the treasury,
 * then up to two discount accounts ($VEXA wallet account, stake record).
 */
function feeAccounts(vault: VaultAccounts, discountAccounts: Address[] = []) {
  return [ro(vault.fees), rw(vault.treasury), ...discountAccounts.slice(0, 2).map(ro)];
}

function u64(amount: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, amount, true);
  return out;
}

/**
 * Creates the owner's cUSDC account if needed and configures it for
 * confidential transfers. The pubkey validity proof must be the instruction
 * right before this one.
 */
export function configureConfidentialAccountInstruction(input: {
  vault: VaultAccounts;
  owner: TransactionSigner;
  tokenAccount: Address;
  decryptableZeroBalance: Uint8Array;
  proofInstructionOffset?: number;
}): Instruction {
  if (input.decryptableZeroBalance.length !== 36)
    throw new Error('decryptable zero balance must be 36 bytes');
  const data = new Uint8Array(38);
  data[0] = VaultInstruction.ConfigureConfidentialAccount;
  data.set(input.decryptableZeroBalance, 1);
  data[37] = (input.proofInstructionOffset ?? -1) & 0xff;
  return {
    programAddress: input.vault.program ?? VAULT_PROGRAM,
    accounts: [
      { address: input.owner.address, role: AccountRole.WRITABLE_SIGNER, signer: input.owner },
      ro(input.vault.config),
      ro(input.vault.cusdcMint),
      rw(input.tokenAccount),
      ro(INSTRUCTIONS_SYSVAR),
      ro(TOKEN_2022_PROGRAM),
      ro(ASSOCIATED_TOKEN_PROGRAM),
      ro(SYSTEM_PROGRAM),
    ],
    data,
  } as Instruction;
}

export function depositInstruction(input: {
  vault: VaultAccounts;
  owner: TransactionSigner;
  ownerUsdc: Address;
  ownerCusdc: Address;
  /** USDC taken from the owner. The fee comes out of it; the rest is minted. */
  amount: bigint;
  /** The owner's $VEXA token account and/or stake record, for a fee discount. */
  discountAccounts?: Address[];
}): Instruction {
  return {
    programAddress: input.vault.program ?? VAULT_PROGRAM,
    accounts: [
      { address: input.owner.address, role: AccountRole.READONLY_SIGNER, signer: input.owner },
      ro(input.vault.config),
      ro(input.vault.usdcMint),
      rw(input.vault.cusdcMint),
      rw(input.ownerUsdc),
      rw(input.vault.usdcReserve),
      rw(input.ownerCusdc),
      ro(TOKEN_PROGRAM),
      ro(TOKEN_2022_PROGRAM),
      ...feeAccounts(input.vault, input.discountAccounts),
    ],
    data: new Uint8Array([VaultInstruction.Deposit, ...u64(input.amount)]),
  } as Instruction;
}

export function withdrawInstruction(input: {
  vault: VaultAccounts;
  owner: TransactionSigner;
  ownerCusdc: Address;
  destination: Address;
  /** cUSDC burned. The destination receives it less the fee. */
  amount: bigint;
  discountAccounts?: Address[];
}): Instruction {
  return {
    programAddress: input.vault.program ?? VAULT_PROGRAM,
    accounts: [
      { address: input.owner.address, role: AccountRole.READONLY_SIGNER, signer: input.owner },
      ro(input.vault.config),
      ro(input.vault.usdcMint),
      rw(input.vault.cusdcMint),
      rw(input.ownerCusdc),
      rw(input.vault.usdcReserve),
      rw(input.destination),
      ro(TOKEN_PROGRAM),
      ro(TOKEN_2022_PROGRAM),
      ...feeAccounts(input.vault, input.discountAccounts),
    ],
    data: new Uint8Array([VaultInstruction.Withdraw, ...u64(input.amount)]),
  } as Instruction;
}

/**
 * Admin only: creates or replaces the fee schedule. `terms` comes from
 * `encodeFeeTerms`.
 */
export function setFeesInstruction(input: {
  program?: Address;
  admin: TransactionSigner;
  config: Address;
  fees: Address;
  treasury: Address;
  terms: Uint8Array;
}): Instruction {
  return {
    programAddress: input.program ?? VAULT_PROGRAM,
    accounts: [
      { address: input.admin.address, role: AccountRole.WRITABLE_SIGNER, signer: input.admin },
      ro(input.config),
      rw(input.fees),
      ro(input.treasury),
      ro(SYSTEM_PROGRAM),
    ],
    data: new Uint8Array([VaultInstruction.SetFees, ...input.terms]),
  } as Instruction;
}

export async function findStakeRecord(
  owner: Address,
  vault: Address = VAULT_PROGRAM,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: vault,
    seeds: ['stake', getAddressEncoder().encode(owner)],
  });
  return pda;
}

/**
 * Locks `amount` $VEXA in the vault. `payer` funds the stake record and the
 * stake vault the first time (Vexa's fee payer, when sponsored).
 */
export function stakeInstruction(input: {
  vault: VaultAccounts;
  owner: TransactionSigner;
  payer: TransactionSigner;
  vexaMint: Address;
  ownerVexa: Address;
  stakeVault: Address;
  stakeRecord: Address;
  amount: bigint;
  /** The token program that owns the $VEXA mint; classic Token unless given. */
  tokenProgram?: Address;
}): Instruction {
  return {
    programAddress: input.vault.program ?? VAULT_PROGRAM,
    accounts: [
      { address: input.owner.address, role: AccountRole.READONLY_SIGNER, signer: input.owner },
      { address: input.payer.address, role: AccountRole.WRITABLE_SIGNER, signer: input.payer },
      ro(input.vault.config),
      ro(input.vault.fees),
      ro(input.vexaMint),
      rw(input.ownerVexa),
      rw(input.stakeVault),
      rw(input.stakeRecord),
      ro(input.tokenProgram ?? TOKEN_PROGRAM),
      ro(ASSOCIATED_TOKEN_PROGRAM),
      ro(SYSTEM_PROGRAM),
    ],
    data: new Uint8Array([VaultInstruction.Stake, ...u64(input.amount)]),
  } as Instruction;
}

/** Returns staked $VEXA to the owner's wallet once the lock has passed. */
export function unstakeInstruction(input: {
  vault: VaultAccounts;
  owner: TransactionSigner;
  vexaMint: Address;
  ownerVexa: Address;
  stakeVault: Address;
  stakeRecord: Address;
  amount: bigint;
  /** The token program that owns the $VEXA mint; classic Token unless given. */
  tokenProgram?: Address;
}): Instruction {
  return {
    programAddress: input.vault.program ?? VAULT_PROGRAM,
    accounts: [
      { address: input.owner.address, role: AccountRole.READONLY_SIGNER, signer: input.owner },
      ro(input.vault.config),
      ro(input.vexaMint),
      rw(input.stakeVault),
      rw(input.stakeRecord),
      rw(input.ownerVexa),
      ro(input.tokenProgram ?? TOKEN_PROGRAM),
    ],
    data: new Uint8Array([VaultInstruction.Unstake, ...u64(input.amount)]),
  } as Instruction;
}

export const STAKE_RECORD_LEN = 82;
export const STAKE_LOCK_SECONDS = 7 * 24 * 60 * 60;

export interface StakeRecord {
  owner: Address;
  vexaMint: Address;
  amount: bigint;
  /** Unix seconds after which the stake can be withdrawn. */
  unlockAt: number;
}

export function decodeStakeRecord(data: Uint8Array): StakeRecord | null {
  if (data.length !== STAKE_RECORD_LEN || data[0] !== 3) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const addresses = getAddressDecoder();
  return {
    owner: addresses.decode(data.subarray(2, 34)),
    vexaMint: addresses.decode(data.subarray(34, 66)),
    amount: view.getBigUint64(66, true),
    unlockAt: Number(view.getBigInt64(74, true)),
  };
}

/**
 * Fails unless each proof context account holds exactly the proof whose
 * `sha256(proof_type ‖ context)` is given. Binds an agent payment to the
 * proofs the NEAR policy contract approved.
 */
export function requireContextsInstruction(input: {
  program?: Address;
  contexts: { account: Address; hash: Uint8Array }[];
}): Instruction {
  const data = new Uint8Array(1 + 32 * input.contexts.length);
  data[0] = VaultInstruction.RequireContexts;
  input.contexts.forEach((c, i) => data.set(c.hash, 1 + 32 * i));
  return {
    programAddress: input.program ?? VAULT_PROGRAM,
    accounts: input.contexts.map((c) => ro(c.account)),
    data,
  } as Instruction;
}
