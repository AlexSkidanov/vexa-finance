//! `Withdraw`: burn cUSDC, release USDC to any token account.
//!
//! Accounts:
//!   0. `[signer]`   owner
//!   1. `[]`         config
//!   2. `[]`         USDC mint
//!   3. `[writable]` cUSDC mint
//!   4. `[writable]` owner's cUSDC token account. Must already hold `amount`
//!      in its public balance, moved there by a CT Withdraw earlier in the
//!      same transaction.
//!   5. `[writable]` USDC reserve
//!   6. `[writable]` destination: any USDC token account, owned by anyone
//!   7. `[]`         Token program
//!   8. `[]`         Token-2022 program
//!
//! Data: `amount: u64`.

use pinocchio::{cpi::Signer, error::ProgramError, AccountView, ProgramResult};

use super::{
    config_seeds, require_config_match, require_program, require_signer, require_token_account,
};
use crate::{
    error::VaultError,
    instruction::parse_amount,
    state::Config,
    token::{self, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID},
};

pub fn process(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let [owner, config, usdc_mint, cusdc_mint, owner_cusdc, usdc_reserve, destination, token_program, token_2022_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let amount = parse_amount(args)?;
    if amount == 0 {
        return Err(VaultError::ZeroAmount.into());
    }

    require_signer(owner)?;
    require_program(token_program, &TOKEN_PROGRAM_ID)?;
    require_program(token_2022_program, &TOKEN_2022_PROGRAM_ID)?;
    let cfg = Config::load(config)?;
    if cfg.paused {
        return Err(VaultError::Paused.into());
    }
    require_config_match(usdc_mint, &cfg.usdc_mint)?;
    require_config_match(cusdc_mint, &cfg.cusdc_mint)?;
    require_config_match(usdc_reserve, &cfg.usdc_reserve)?;
    require_token_account(
        owner_cusdc,
        &TOKEN_2022_PROGRAM_ID,
        &cfg.cusdc_mint,
        Some(owner.address()),
    )?;
    // Withdrawals can go anywhere, e.g. straight to an exchange deposit address.
    require_token_account(destination, &TOKEN_PROGRAM_ID, &cfg.usdc_mint, None)?;

    let decimals = token::read_mint(&usdc_mint.try_borrow()?)?.decimals;

    // Burn first. If the public balance is short, this fails and nothing moves.
    token::burn_checked(owner_cusdc, cusdc_mint, owner, amount, decimals)?;

    let bump = [cfg.bump];
    let seeds = config_seeds(&bump);
    token::transfer_checked(
        &TOKEN_PROGRAM_ID,
        usdc_reserve,
        usdc_mint,
        destination,
        config,
        amount,
        decimals,
        &[Signer::from(&seeds)],
    )
}
