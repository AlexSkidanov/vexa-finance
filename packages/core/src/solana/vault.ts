/**
 * Instruction builders for the vault program. Account order and flags follow
 * programs/vault/src/processor/*.rs; data is a one-byte tag plus
 * little-endian arguments (programs/vault/src/instruction.rs).
 */
import { AccountRole, type Address, type Instruction, type TransactionSigner } from '@solana/kit';
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

/** Trailing accounts of Deposit and Withdraw: schedule, treasury, optional $VEXA. */
function feeAccounts(vault: VaultAccounts, vexaAccount?: Address) {
  return [ro(vault.fees), rw(vault.treasury), ...(vexaAccount ? [ro(vexaAccount)] : [])];
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
  /** The owner's $VEXA account, for a fee discount. */
  vexaAccount?: Address;
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
      ...feeAccounts(input.vault, input.vexaAccount),
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
  vexaAccount?: Address;
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
      ...feeAccounts(input.vault, input.vexaAccount),
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
