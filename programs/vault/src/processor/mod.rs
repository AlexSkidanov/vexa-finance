pub mod admin;
pub mod configure;
pub mod deposit;
pub mod initialize;
pub mod withdraw;

use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::{Allocate, Assign, CreateAccount, Transfer};

use crate::{
    error::VaultError, state::CONFIG_SEED, token::TOKEN_2022_PROGRAM_ID, token::TOKEN_PROGRAM_ID,
    ID,
};

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

/// Creates a PDA owned by this program. If someone has already sent lamports
/// to the address (which would make CreateAccount fail and block setup
/// forever), tops it up and allocates and assigns it instead.
pub(crate) fn create_pda_account(
    payer: &AccountView,
    account: &AccountView,
    space: usize,
    signer: &Signer,
) -> ProgramResult {
    let rent = Rent::get()?.try_minimum_balance(space)?;
    let signers = core::slice::from_ref(signer);

    if account.lamports() == 0 {
        return CreateAccount {
            from: payer,
            to: account,
            lamports: rent,
            space: space as u64,
            owner: &ID,
        }
        .invoke_signed(signers);
    }

    let shortfall = rent.saturating_sub(account.lamports());
    if shortfall > 0 {
        Transfer { from: payer, to: account, lamports: shortfall }.invoke()?;
    }
    Allocate { account, space: space as u64 }.invoke_signed(signers)?;
    Assign { account, owner: &ID }.invoke_signed(signers)
}

/// The owner's $VEXA balance, read from an optional account that must be
/// theirs and of the configured mint. No account, or no $VEXA mint set,
/// means a balance of zero: discounts are opt-in, never a way to fail.
pub(crate) fn vexa_balance(
    account: Option<&AccountView>,
    vexa_mint: &Address,
    owner: &Address,
) -> Result<u64, ProgramError> {
    let Some(account) = account else { return Ok(0) };
    if vexa_mint == &Address::default() {
        return Ok(0);
    }
    let program =
        if account.owned_by(&TOKEN_PROGRAM_ID) { TOKEN_PROGRAM_ID } else { TOKEN_2022_PROGRAM_ID };
    require_token_account(account, &program, vexa_mint, Some(owner))?;
    crate::token::read_token_amount(&account.try_borrow()?)
}
