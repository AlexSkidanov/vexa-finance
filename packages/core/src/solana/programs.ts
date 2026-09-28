/**
 * Program addresses and the PDAs derived from them.
 */
import { address, getAddressEncoder, getProgramDerivedAddress, type Address } from '@solana/kit';

export const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
export const COMPUTE_BUDGET_PROGRAM = address('ComputeBudget111111111111111111111111111111');
export const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const ZK_ELGAMAL_PROOF_PROGRAM = address('ZkE1Gama1Proof11111111111111111111111111111');
export const INSTRUCTIONS_SYSVAR = address('Sysvar1nstructions1111111111111111111111111');

/** The Vexa vault on mainnet. See programs/vault. */
export const VAULT_PROGRAM = address('3g2JPX4roASUJVacf68sBSpARk5m9B3hu9xeaE6mTjPR');

const encoder = getAddressEncoder();

export async function findVaultConfig(vault: Address = VAULT_PROGRAM): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: vault, seeds: ['config'] });
  return pda;
}

/** Associated token account of `owner` for `mint` under `tokenProgram`. */
export async function findAta(
  owner: Address,
  mint: Address,
  tokenProgram: Address,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [encoder.encode(owner), encoder.encode(tokenProgram), encoder.encode(mint)],
  });
  return pda;
}
