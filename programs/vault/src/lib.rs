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
//!   user USDC ──transfer──▶ reserve          user cUSDC (public) ──burn──▶ ∅
//!   ∅ ──mint──▶ user cUSDC (public)          reserve ──transfer──▶ any USDC account
//!   user cUSDC public ──CT deposit──▶ pending
//! ```
//!
//! Deposit finishes with the funds in the owner's *pending* confidential
//! balance. The owner then applies it, which needs their AE key, so the SDK
//! appends that instruction in the same transaction. Withdraw expects the SDK
//! to have already moved `amount` from the confidential balance to the public
//! one with a Token-2022 CT Withdraw (equality and range proofs) earlier in
//! the same transaction.
//!
//! Deposit and withdrawal amounts are public, as any USDC transfer is.
//! Everything that happens while funds are cUSDC is not.
//!
//! ## Invariant
//!
//! USDC held by the reserve ≥ cUSDC supply. The config PDA is the only mint
//! authority and the only reserve owner, and every mint is paired with a
//! transfer in, every release with a burn.

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("3g2JPX4roASUJVacf68sBSpARk5m9B3hu9xeaE6mTjPR");

#[program]
pub mod vault {
    use super::*;

    /// One-time setup: records the USDC and cUSDC mints and creates the USDC
    /// reserve owned by the config PDA. The cUSDC mint is created beforehand
    /// (see `scripts/create-cusdc-mint.ts`) and must hand its mint authority to
    /// the config PDA; `initialize` verifies that and every other property of
    /// the mint before accepting it.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        instructions::initialize::handle_initialize(ctx)
    }

    /// Creates the caller's cUSDC account if needed, adds space for the
    /// confidential extension, and configures it with their ElGamal key. The
    /// pubkey validity proof must be the instruction immediately before this
    /// one (`proof_instruction_offset = -1`).
    pub fn configure_confidential_account(
        ctx: Context<ConfigureConfidentialAccount>,
        decryptable_zero_balance: [u8; 36],
        proof_instruction_offset: i8,
    ) -> Result<()> {
        instructions::configure_confidential_account::handle_configure_confidential_account(
            ctx,
            decryptable_zero_balance,
            proof_instruction_offset,
        )
    }

    /// Locks `amount` USDC in the reserve, mints the same amount of cUSDC and
    /// moves it straight into the owner's pending confidential balance.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit::handle_deposit(ctx, amount)
    }

    /// Burns `amount` cUSDC from the owner's public balance and releases the
    /// same amount of USDC to any token account.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::withdraw::handle_withdraw(ctx, amount)
    }

    /// Stops deposits and withdrawals. Confidential transfers between cUSDC
    /// holders keep working: they never touch the vault.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        instructions::admin::handle_set_paused(ctx, paused)
    }

    /// Hands the admin role to a new key. Both keys must sign, so a typo can't
    /// lock the vault forever.
    pub fn set_admin(ctx: Context<SetAdmin>) -> Result<()> {
        instructions::admin::handle_set_admin(ctx)
    }
}
