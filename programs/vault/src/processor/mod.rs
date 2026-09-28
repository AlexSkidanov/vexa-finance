pub mod admin;
pub mod configure;
pub mod deposit;
pub mod initialize;
pub mod withdraw;

use pinocchio::{cpi::Seed, error::ProgramError, AccountView, Address};

use crate::{error::VaultError, state::CONFIG_SEED};

// Account checks a framework would generate, written out. Every processor starts
// with these.

pub(crate) fn require_signer(account: &AccountView) -> Result<(), ProgramError> {
    if account.is_signer() {
        Ok(())
    } else {
        Err(ProgramError::MissingRequiredSignature)
    }
}

pub(crate) fn require_writable(account: &AccountView) -> Result<(), ProgramError> {
    if account.is_writable() {
        Ok(())
    } else {
        Err(ProgramError::InvalidArgument)
    }
}

pub(crate) fn require_program(account: &AccountView, id: &Address) -> Result<(), ProgramError> {
    if account.address() == id {
        Ok(())
    } else {
        Err(ProgramError::IncorrectProgramId)
    }
}

/// The account must be the one recorded in the vault config.
pub(crate) fn require_config_match(
    account: &AccountView,
    expected: &Address,
) -> Result<(), ProgramError> {
    if account.address() == expected {
        Ok(())
    } else {
        Err(VaultError::ConfigMismatch.into())
    }
}

/// A token account's mint and owner, checked against what the caller expects.
pub(crate) fn require_token_account(
    account: &AccountView,
    token_program: &Address,
    mint: &Address,
    owner: Option<&Address>,
) -> Result<(), ProgramError> {
    if !account.owned_by(token_program) {
        return Err(ProgramError::InvalidAccountOwner);
    }
    let data = account.try_borrow()?;
    let (account_mint, account_owner) = crate::token::read_token_account(&data)?;
    if &account_mint != mint {
        return Err(VaultError::TokenMintMismatch.into());
    }
    if let Some(owner) = owner {
        if &account_owner != owner {
            return Err(VaultError::TokenOwnerMismatch.into());
        }
    }
    Ok(())
}

/// Seeds for the config PDA to sign CPIs.
pub(crate) fn config_seeds(bump: &[u8; 1]) -> [Seed<'_>; 2] {
    [Seed::from(CONFIG_SEED), Seed::from(bump)]
}
