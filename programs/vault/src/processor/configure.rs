//! `ConfigureConfidentialAccount`: gets a user's cUSDC account ready to hold a
//! confidential balance.
//!
//! Accounts:
//!   0. `[writable, signer]` owner (pays for the account and its growth)
//!   1. `[]`                 config
//!   2. `[]`                 cUSDC mint
//!   3. `[writable]`         owner's cUSDC associated token account
//!   4. `[]`                 Instructions sysvar
//!   5. `[]`                 Token-2022 program
//!   6. `[]`                 Associated Token program
//!   7. `[]`                 System program
//!
//! Data: `decryptable_zero_balance: [u8; 36]`, `proof_instruction_offset: i8`.
//! The pubkey validity proof must sit at that offset from this instruction,
//! usually `-1` (the instruction just before).

use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use super::{require_config_match, require_program, require_signer, require_writable};
use crate::{
    error::VaultError,
    state::Config,
    token::{
        self, ASSOCIATED_TOKEN_PROGRAM_ID, EXT_CONFIDENTIAL_TRANSFER_ACCOUNT,
        INSTRUCTIONS_SYSVAR_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
    },
};

/// How many incoming transfers an account may accumulate in its pending
/// balance before the owner must apply them. Token-2022 caps pending balances
/// so decryption stays tractable. 2^16 is the value the spl-token CLI uses.
pub const MAX_PENDING_BALANCE_CREDIT_COUNTER: u64 = 65_536;

pub fn process(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let [owner, config, cusdc_mint, token_account, instructions, token_program, ata_program, system_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if args.len() != 37 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let decryptable_zero_balance: &[u8; 36] = args[..36].try_into().unwrap();
    let proof_offset = args[36] as i8;
    if proof_offset == 0 {
        return Err(VaultError::InvalidProofOffset.into());
    }

    require_signer(owner)?;
    require_writable(owner)?;
    require_writable(token_account)?;
    require_program(instructions, &INSTRUCTIONS_SYSVAR_ID)?;
    require_program(token_program, &TOKEN_2022_PROGRAM_ID)?;
    require_program(ata_program, &ASSOCIATED_TOKEN_PROGRAM_ID)?;
    require_program(system_program, &SYSTEM_PROGRAM_ID)?;
    let cfg = Config::load(config)?;
    require_config_match(cusdc_mint, &cfg.cusdc_mint)?;

    // Validates the address and creates the account if it's missing.
    token::create_associated_token_account_idempotent(
        owner,
        token_account,
        owner,
        cusdc_mint,
        system_program,
        token_program,
        &[],
    )?;

    // Safe to call twice: an account that's already configured is left alone.
    if already_configured(token_account)? {
        return Ok(());
    }

    // An associated token account is created with room only for the mint's
    // required extensions. Grow it to fit the confidential state, then
    // configure it with the owner's ElGamal key (proved by the sibling proof).
    token::reallocate(
        token_account,
        owner,
        system_program,
        owner,
        EXT_CONFIDENTIAL_TRANSFER_ACCOUNT,
    )?;
    token::configure_confidential_account(
        token_account,
        cusdc_mint,
        instructions,
        owner,
        decryptable_zero_balance,
        MAX_PENDING_BALANCE_CREDIT_COUNTER,
        proof_offset,
    )
}

fn already_configured(account: &AccountView) -> Result<bool, ProgramError> {
    let data = account.try_borrow()?;
    for extension in token::extensions(&data, false)? {
        if extension?.0 == EXT_CONFIDENTIAL_TRANSFER_ACCOUNT {
            return Ok(true);
        }
    }
    Ok(false)
}
