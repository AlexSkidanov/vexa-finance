//! `Deposit`: USDC in, cUSDC into the owner's pending confidential balance.
//!
//! Accounts:
//!   0. `[signer]`   owner
//!   1. `[]`         config
//!   2. `[]`         USDC mint
//!   3. `[writable]` cUSDC mint
//!   4. `[writable]` owner's USDC token account
//!   5. `[writable]` USDC reserve
//!   6. `[writable]` owner's cUSDC token account (configured for confidential transfers)
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
    let [owner, config, usdc_mint, cusdc_mint, owner_usdc, usdc_reserve, owner_cusdc, token_program, token_2022_program, ..] =
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
    // Both token legs must belong to the signer: no depositing someone else's
    // USDC (even as their delegate) and no minting into someone else's account.
    require_token_account(owner_usdc, &TOKEN_PROGRAM_ID, &cfg.usdc_mint, Some(owner.address()))?;
    require_token_account(
        owner_cusdc,
        &TOKEN_2022_PROGRAM_ID,
        &cfg.cusdc_mint,
        Some(owner.address()),
    )?;

    let decimals = token::read_mint(&usdc_mint.try_borrow()?)?.decimals;

    // 1. USDC in.
    token::transfer_checked(
        &TOKEN_PROGRAM_ID,
        owner_usdc,
        usdc_mint,
        usdc_reserve,
        owner,
        amount,
        decimals,
        &[],
    )?;

    // 2. The same amount of cUSDC out, signed by the config PDA.
    let bump = [cfg.bump];
    let seeds = config_seeds(&bump);
    token::mint_to_checked(
        cusdc_mint,
        owner_cusdc,
        config,
        amount,
        decimals,
        &[Signer::from(&seeds)],
    )?;

    // 3. Straight into the pending confidential balance, so it never lingers
    //    in the account's public balance.
    token::confidential_deposit(owner_cusdc, cusdc_mint, owner, amount, decimals)
}
