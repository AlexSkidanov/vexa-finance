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
} as const;

export interface VaultAccounts {
  program?: Address;
  config: Address;
  usdcMint: Address;
  cusdcMint: Address;
  usdcReserve: Address;
}

const ro = (address: Address) => ({ address, role: AccountRole.READONLY });
const rw = (address: Address) => ({ address, role: AccountRole.WRITABLE });

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
  amount: bigint;
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
    ],
    data: new Uint8Array([VaultInstruction.Deposit, ...u64(input.amount)]),
  } as Instruction;
}

export function withdrawInstruction(input: {
  vault: VaultAccounts;
  owner: TransactionSigner;
  ownerCusdc: Address;
  destination: Address;
  amount: bigint;
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
    ],
    data: new Uint8Array([VaultInstruction.Withdraw, ...u64(input.amount)]),
  } as Instruction;
}
