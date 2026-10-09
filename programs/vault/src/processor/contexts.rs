//! `RequireContexts`: fails unless each proof context account holds exactly
//! the proof its hash names.
//!
//! This is how an agent's spend policy, enforced on NEAR, is bound to what
//! actually executes on Solana. The policy contract sees the proofs a payment
//! will use (the transfer's validity proof, whose commitments hide the amount,
//! and a range proof that the amount fits the limits) and signs the transfer
//! transaction only if they satisfy the policy. That transaction starts with
//! this instruction, carrying the hashes of those proofs' contexts. A context
//! account's data can only be written by the ZK ElGamal proof program after a
//! successful verification, so if anyone verified a different proof into one
//! of the accounts, or none at all, the transfer fails.
//!
//! Accounts: the context accounts, `[]`, in the order of the hashes.
//! Data: `sha256(proof_type ‖ context)` for each, 32 bytes apiece.

use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use crate::{error::VaultError, token::ZK_ELGAMAL_PROOF_PROGRAM_ID};

/// Context state accounts: authority (32) | proof type (1) | context.
const PROOF_TYPE_OFFSET: usize = 32;

pub fn require(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    if accounts.is_empty() || args.len() != accounts.len() * 32 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (hashes, _) = args.as_chunks::<32>();
    for (account, expected) in accounts.iter().zip(hashes) {
        if !account.owned_by(&ZK_ELGAMAL_PROOF_PROGRAM_ID) {
            return Err(VaultError::ContextMismatch.into());
        }
        let data = account.try_borrow()?;
        // Proof type 0 is an account allocated for a context but never
        // verified into: its data is all zeroes, which no approval covers.
        if data.len() <= PROOF_TYPE_OFFSET + 1 || data[PROOF_TYPE_OFFSET] == 0 {
            return Err(VaultError::ContextMismatch.into());
        }
        let hash = solana_sha256_hasher::hash(&data[PROOF_TYPE_OFFSET..]);
        if hash.as_ref() != expected {
            return Err(VaultError::ContextMismatch.into());
        }
    }
    Ok(())
}
