//! `Stake` and `Unstake`: lock $VEXA in the vault for fee discounts and
//! higher agent limits. See `crate::stake` for the record and the weights.

use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};

use super::{
    config_seeds, create_pda_account, require_config_match, require_program, require_signer,
    require_token_account, require_writable,
};
use crate::{
    error::VaultError,
    fees::FeeSchedule,
    instruction::parse_amount,
    stake::{Stake, STAKE_LEN, STAKE_LOCK_SECONDS, STAKE_SEED},
    state::Config,
    token::{self, ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID},
    ID,
};

/// The configured $VEXA mint; staking is closed until the fee schedule names one.
fn vexa_mint(fees: &AccountView, mint: &AccountView) -> Result<Address, ProgramError> {
    let vexa = FeeSchedule::load(fees)?.vexa_mint();
    if vexa == Address::default() {
        return Err(VaultError::VexaNotSet.into());
    }
    require_config_match(mint, &vexa)?;
    if !mint.owned_by(&TOKEN_PROGRAM_ID) {
        return Err(ProgramError::InvalidAccountOwner);
    }
    Ok(vexa)
}

/// `Stake`: moves $VEXA from the owner's wallet into the stake vault and
/// relocks the whole position for `STAKE_LOCK_SECONDS`.
///
/// Accounts:
///   0. `[signer]`           owner
///   1. `[writable, signer]` payer: funds the stake record and stake vault the first time
///   2. `[]`                 config
///   3. `[]`                 fee schedule (names the $VEXA mint)
///   4. `[]`                 $VEXA mint
///   5. `[writable]`         owner's $VEXA account
///   6. `[writable]`         stake vault: the config PDA's associated $VEXA account
///   7. `[writable]`         stake record PDA `["stake", owner]`
///   8. `[]`                 Token program
///   9. `[]`                 Associated Token program
///  10. `[]`                 System program
///
/// Data: `amount: u64`.
pub fn stake(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let [owner, payer, config, fees, mint, owner_vexa, stake_vault, record, token_program, ata_program, system_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let amount = parse_amount(args)?;
    if amount == 0 {
        return Err(VaultError::ZeroAmount.into());
    }
    require_signer(owner)?;
    require_signer(payer)?;
    require_writable(record)?;
    require_program(token_program, &TOKEN_PROGRAM_ID)?;
    require_program(ata_program, &ASSOCIATED_TOKEN_PROGRAM_ID)?;
    require_program(system_program, &SYSTEM_PROGRAM_ID)?;
    Config::load(config)?;
    let vexa = vexa_mint(fees, mint)?;
    require_token_account(owner_vexa, &TOKEN_PROGRAM_ID, &vexa, Some(owner.address()))?;

    // The ATA program checks the vault's address, and creates it the first time.
    token::create_associated_token_account_idempotent(
        payer,
        stake_vault,
        config,
        mint,
        system_program,
        token_program,
        &[],
    )?;

    let mut position = if record.owned_by(&ID) {
        let position = Stake::load(record)?;
        if position.owner() != *owner.address() {
            return Err(ProgramError::InvalidSeeds);
        }
        position
    } else {
        let (address, bump) =
            Address::find_program_address(&[STAKE_SEED, owner.address().as_ref()], &ID);
        if record.address() != &address {
            return Err(ProgramError::InvalidSeeds);
        }
        let bump_seed = [bump];
        let seeds =
            [Seed::from(STAKE_SEED), Seed::from(owner.address().as_ref()), Seed::from(&bump_seed)];
        create_pda_account(payer, record, STAKE_LEN, &Signer::from(&seeds))?;
        Stake::new(bump, owner.address(), &vexa)
    };
    // A stake of a previous $VEXA mint can only be withdrawn, never topped up.
    if position.vexa_mint() != vexa {
        return Err(VaultError::TokenMintMismatch.into());
    }

    let decimals = token::read_mint(&mint.try_borrow()?)?.decimals;
    token::transfer_checked(
        &TOKEN_PROGRAM_ID,
        owner_vexa,
        mint,
        stake_vault,
        owner,
        amount,
        decimals,
        &[],
    )?;

    let now = Clock::get()?.unix_timestamp;
    position
        .set_amount(position.amount().checked_add(amount).ok_or(ProgramError::ArithmeticOverflow)?);
    position.lock_until(now.saturating_add(STAKE_LOCK_SECONDS));
    position.store(record)
}

/// `Unstake`: returns staked $VEXA to the owner once the lock has passed.
///
/// Accounts:
///   0. `[signer]`   owner
///   1. `[]`         config
///   2. `[]`         $VEXA mint (the one recorded in the stake)
///   3. `[writable]` stake vault
///   4. `[writable]` stake record
///   5. `[writable]` owner's $VEXA account
///   6. `[]`         Token program
///
/// Data: `amount: u64`.
pub fn unstake(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let [owner, config, mint, stake_vault, record, owner_vexa, token_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let amount = parse_amount(args)?;
    if amount == 0 {
        return Err(VaultError::ZeroAmount.into());
    }
    require_signer(owner)?;
    require_writable(record)?;
    require_program(token_program, &TOKEN_PROGRAM_ID)?;
    let cfg = Config::load(config)?;
    let mut position = Stake::load(record)?;
    if position.owner() != *owner.address() {
        return Err(VaultError::TokenOwnerMismatch.into());
    }
    let vexa = position.vexa_mint();
    require_config_match(mint, &vexa)?;
    require_token_account(owner_vexa, &TOKEN_PROGRAM_ID, &vexa, Some(owner.address()))?;
    // The vault is the config PDA's own $VEXA account: its owner field says so.
    require_token_account(stake_vault, &TOKEN_PROGRAM_ID, &vexa, Some(config.address()))?;

    if Clock::get()?.unix_timestamp < position.unlock_at() {
        return Err(VaultError::StakeLocked.into());
    }
    let remaining = position.amount().checked_sub(amount).ok_or(VaultError::InsufficientStake)?;

    let decimals = token::read_mint(&mint.try_borrow()?)?.decimals;
    let bump = [cfg.bump];
    let seeds = config_seeds(&bump);
    token::transfer_checked(
        &TOKEN_PROGRAM_ID,
        stake_vault,
        mint,
        owner_vexa,
        config,
        amount,
        decimals,
        &[Signer::from(&seeds)],
    )?;
    position.set_amount(remaining);
    position.store(record)
}
