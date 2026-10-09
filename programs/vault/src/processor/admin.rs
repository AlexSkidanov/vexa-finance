//! Admin instructions. The admin can pause the vault, set the fee schedule
//! within hard limits, and hand the role to another key. It cannot move funds.

use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    AccountView, Address, ProgramResult,
};

use super::{
    create_pda_account, require_program, require_signer, require_token_account, require_writable,
};
use crate::{
    error::VaultError,
    fees::{FeeSchedule, FEES_LEN, FEES_SEED},
    state::Config,
    token::{SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID},
    ID,
};

/// `SetPaused`: stops deposits and withdrawals. Confidential transfers between
/// cUSDC holders keep working: they never touch the vault.
///
/// Accounts: 0. `[signer]` admin, 1. `[writable]` config. Data: `paused: u8`.
pub fn set_paused(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let [admin, config, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let paused = match args {
        [0] => false,
        [1] => true,
        _ => return Err(ProgramError::InvalidInstructionData),
    };
    let mut cfg = authorize(admin, config)?;
    cfg.paused = paused;
    cfg.store(config)
}

/// `SetAdmin`: hands the admin role to a new key. Both keys must sign, so a
/// typo can't lock the vault forever.
///
/// Accounts: 0. `[signer]` admin, 1. `[signer]` new admin, 2. `[writable]` config.
pub fn set_admin(accounts: &mut [AccountView]) -> ProgramResult {
    let [admin, new_admin, config, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    require_signer(new_admin)?;
    let mut cfg = authorize(admin, config)?;
    cfg.admin = *new_admin.address();
    cfg.store(config)
}

/// `SetFees`: creates or replaces the fee schedule. The fee can never exceed
/// `MAX_FEE_BPS`, so a stolen admin key can't turn the vault into a trap.
///
/// Accounts:
///   0. `[writable, signer]` admin: pays for the schedule account the first time
///   1. `[]`                 config
///   2. `[writable]`         fee schedule PDA `["fees"]`
///   3. `[]`                 treasury: a USDC token account, owned by anyone
///   4. `[]`                 System program
///
/// Data: see [`FeeSchedule::parse_args`].
pub fn set_fees(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let [admin, config, fees, treasury, system_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    require_signer(admin)?;
    require_writable(admin)?;
    require_writable(fees)?;
    require_program(system_program, &SYSTEM_PROGRAM_ID)?;
    let cfg = Config::load(config)?;
    if admin.address() != &cfg.admin {
        return Err(VaultError::NotAdmin.into());
    }
    require_token_account(treasury, &TOKEN_PROGRAM_ID, &cfg.usdc_mint, None)?;

    let (address, bump) = Address::find_program_address(&[FEES_SEED], &ID);
    if fees.address() != &address {
        return Err(ProgramError::InvalidSeeds);
    }
    let schedule = FeeSchedule::from_args(bump, treasury.address(), args)?;

    if !fees.owned_by(&ID) {
        let bump_seed = [bump];
        let seeds = [Seed::from(FEES_SEED), Seed::from(&bump_seed)];
        create_pda_account(admin, fees, FEES_LEN, &Signer::from(&seeds))?;
    }
    schedule.store(fees)
}

fn authorize(admin: &AccountView, config: &AccountView) -> Result<Config, ProgramError> {
    require_signer(admin)?;
    require_writable(config)?;
    let cfg = Config::load(config)?;
    if admin.address() != &cfg.admin {
        return Err(VaultError::NotAdmin.into());
    }
    Ok(cfg)
}
