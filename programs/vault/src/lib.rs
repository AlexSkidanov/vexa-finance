//! # Vexa vault
//!
//! Wraps USDC 1:1 into cUSDC, a Token-2022 mint with the ConfidentialTransfer
//! extension. Holding cUSDC instead of USDC is what makes balances and
//! transfer amounts private: they live on-chain as ElGamal ciphertexts, and
//! only the account owner (plus an optional auditor) can decrypt them.
//!
//! ```text
//!   deposit(amount)                          withdraw(amount)
//!   ───────────────                          ────────────────
//!   user USDC ──fee──▶ treasury              user cUSDC (public) ──burn──▶ ∅
//!   user USDC ──rest──▶ reserve              reserve ──fee──▶ treasury
//!   ∅ ──mint rest──▶ user cUSDC (public)     reserve ──rest──▶ any USDC account
//!   user cUSDC public ──CT deposit──▶ pending
//! ```
//!
//! Deposit finishes with the funds in the owner's *pending* confidential
//! balance. Applying it needs the owner's AE key, so the SDK appends that
//! instruction in the same transaction. Withdraw expects the SDK to have
//! moved `amount` from the confidential balance to the public one with a
//! Token-2022 CT Withdraw (equality and range proofs) earlier in the same
//! transaction.
//!
//! Deposit and withdrawal amounts are public, as any USDC transfer is.
//! Everything that happens while funds are cUSDC is not. That is also why the
//! protocol fee is charged there and nowhere else: see [`fees`].
//!
//! ## Invariant
//!
//! USDC held by the reserve ≥ cUSDC supply. The config PDA is the only mint
//! authority and the only reserve owner, and every mint is paired with a
//! transfer in, every release with a burn. Fees go to the treasury, never
//! through the reserve.
//!
//! ## Why Pinocchio
//!
//! A program's rent deposit is proportional to its size. Written with
//! Pinocchio, with no allocator and no framework, the vault is a fraction of
//! the size of the equivalent Anchor program. Anchor's account constraints
//! become explicit checks in `processor/`, each one commented.

#![cfg_attr(target_os = "solana", no_std)]

pub mod error;
pub mod fees;
pub mod instruction;
pub mod stake;
pub mod state;

mod processor;
pub mod token;

use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

use crate::instruction::VaultInstruction;

solana_address::declare_id!("3g2JPX4roASUJVacf68sBSpARk5m9B3hu9xeaE6mTjPR");

#[cfg(target_os = "solana")]
mod entrypoint {
    pinocchio::program_entrypoint!(crate::process_instruction);
    pinocchio::no_allocator!();
    pinocchio::nostd_panic_handler!();
}

pub fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    if program_id != &ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    let (tag, args) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    match VaultInstruction::try_from(*tag)? {
        VaultInstruction::Initialize => processor::initialize::process(accounts),
        VaultInstruction::ConfigureConfidentialAccount => {
            processor::configure::process(accounts, args)
        }
        VaultInstruction::Deposit => processor::deposit::process(accounts, args),
        VaultInstruction::Withdraw => processor::withdraw::process(accounts, args),
        VaultInstruction::SetPaused => processor::admin::set_paused(accounts, args),
        VaultInstruction::SetAdmin => processor::admin::set_admin(accounts),
        VaultInstruction::SetFees => processor::admin::set_fees(accounts, args),
        VaultInstruction::Stake => processor::stake::stake(accounts, args),
        VaultInstruction::Unstake => processor::stake::unstake(accounts, args),
    }
}
