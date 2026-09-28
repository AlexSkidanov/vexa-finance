//! Admin instructions. The admin can pause the vault and hand the role to
//! another key. It cannot move funds.

use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use super::{require_signer, require_writable};
use crate::{error::VaultError, state::Config};

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

fn authorize(admin: &AccountView, config: &AccountView) -> Result<Config, ProgramError> {
    require_signer(admin)?;
    require_writable(config)?;
    let cfg = Config::load(config)?;
    if admin.address() != &cfg.admin {
        return Err(VaultError::NotAdmin.into());
    }
    Ok(cfg)
}
