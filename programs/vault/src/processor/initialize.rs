//! `Initialize`: one-time setup.
//!
//! Accounts:
//!   0. `[writable, signer]` admin: must be the program's upgrade authority
//!   1. `[writable]`         config PDA `["config"]`
//!   2. `[]`                 USDC mint
//!   3. `[]`                 cUSDC mint (Token-2022)
//!   4. `[writable]`         USDC reserve: the config PDA's associated token account
//!   5. `[]`                 this program
//!   6. `[]`                 this program's ProgramData account
//!   7. `[]`                 Token program
//!   8. `[]`                 Associated Token program
//!   9. `[]`                 System program

use pinocchio::{
    cpi::Signer,
    error::ProgramError,
    sysvars::{rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::{Allocate, Assign, CreateAccount, Transfer};

use super::{config_seeds, require_program, require_signer, require_writable};
use crate::{
    error::VaultError,
    state::{Config, CONFIG_LEN, CONFIG_SEED},
    token::{
        self, ASSOCIATED_TOKEN_PROGRAM_ID, BPF_LOADER_UPGRADEABLE_ID,
        EXT_CONFIDENTIAL_TRANSFER_MINT, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
    },
    ID,
};

pub fn process(accounts: &mut [AccountView]) -> ProgramResult {
    let [admin, config, usdc_mint, cusdc_mint, usdc_reserve, program, program_data, token_program, ata_program, system_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    require_signer(admin)?;
    require_writable(admin)?;
    require_writable(config)?;
    require_program(token_program, &TOKEN_PROGRAM_ID)?;
    require_program(ata_program, &ASSOCIATED_TOKEN_PROGRAM_ID)?;
    require_program(system_program, &SYSTEM_PROGRAM_ID)?;

    // Only the upgrade authority may initialize. Without this, anyone watching
    // the chain could initialize a freshly deployed vault with a mint they
    // control before we do.
    require_upgrade_authority(program, program_data, admin.address())?;

    let (config_address, bump) = Address::find_program_address(&[CONFIG_SEED], &ID);
    if config.address() != &config_address {
        return Err(ProgramError::InvalidSeeds);
    }
    if config.owned_by(&ID) {
        return Err(VaultError::AlreadyInitialized.into());
    }

    if !usdc_mint.owned_by(&TOKEN_PROGRAM_ID) {
        return Err(ProgramError::InvalidAccountOwner);
    }
    let usdc_decimals = token::read_mint(&usdc_mint.try_borrow()?)?.decimals;
    validate_cusdc_mint(cusdc_mint, &config_address, usdc_decimals)?;

    let bump_seed = [bump];
    let seeds = config_seeds(&bump_seed);
    let signer = Signer::from(&seeds);
    create_config_account(admin, config, &signer)?;

    // The ATA program verifies the reserve is the canonical ATA of the config
    // PDA for USDC; if someone already created it, this is a no-op.
    token::create_associated_token_account_idempotent(
        admin,
        usdc_reserve,
        config,
        usdc_mint,
        system_program,
        token_program,
        &[],
    )?;

    Config {
        admin: *admin.address(),
        usdc_mint: *usdc_mint.address(),
        cusdc_mint: *cusdc_mint.address(),
        usdc_reserve: *usdc_reserve.address(),
        paused: false,
        bump,
    }
    .store(config)
}

/// The program account points at its ProgramData account, and ProgramData
/// records the upgrade authority:
///
///   Program:     u32 tag (2) | programdata address (32)
///   ProgramData: u32 tag (3) | slot u64 | Option<Pubkey>: u8 tag + 32
fn require_upgrade_authority(
    program: &AccountView,
    program_data: &AccountView,
    admin: &Address,
) -> ProgramResult {
    if program.address() != &ID || !program.owned_by(&BPF_LOADER_UPGRADEABLE_ID) {
        return Err(ProgramError::IncorrectProgramId);
    }
    {
        let data = program.try_borrow()?;
        if data.len() < 36
            || data[0..4] != 2u32.to_le_bytes()
            || &data[4..36] != program_data.address().as_ref()
        {
            return Err(ProgramError::InvalidAccountData);
        }
    }
    if !program_data.owned_by(&BPF_LOADER_UPGRADEABLE_ID) {
        return Err(ProgramError::InvalidAccountOwner);
    }
    let data = program_data.try_borrow()?;
    if data.len() < 45 || data[0..4] != 3u32.to_le_bytes() {
        return Err(ProgramError::InvalidAccountData);
    }
    if data[12] != 1 || &data[13..45] != admin.as_ref() {
        return Err(VaultError::NotUpgradeAuthority.into());
    }
    Ok(())
}

/// A cUSDC mint is only safe to back with real USDC if nobody but the vault
/// can create or seize it. So it must:
///   - be a Token-2022 mint with the config PDA as its sole mint authority,
///   - have no freeze authority, so balances can't be frozen,
///   - carry no extension besides ConfidentialTransferMint (no permanent
///     delegate, no transfer hook, no fees, no close authority),
///   - auto-approve new confidential accounts,
///   - start with zero supply and match USDC's decimals.
fn validate_cusdc_mint(mint: &AccountView, config: &Address, usdc_decimals: u8) -> ProgramResult {
    if !mint.owned_by(&TOKEN_2022_PROGRAM_ID) {
        return Err(ProgramError::InvalidAccountOwner);
    }
    let data = mint.try_borrow()?;
    let base = token::read_mint(&data)?;

    if base.mint_authority.as_ref() != Some(config) {
        return Err(VaultError::WrongMintAuthority.into());
    }
    if base.freeze_authority.is_some() {
        return Err(VaultError::FreezeAuthoritySet.into());
    }
    if base.supply != 0 {
        return Err(VaultError::NonZeroSupply.into());
    }
    if base.decimals != usdc_decimals {
        return Err(VaultError::DecimalsMismatch.into());
    }

    let mut confidential = None;
    for extension in token::extensions(&data, true)? {
        let (ty, value) = extension?;
        if ty != EXT_CONFIDENTIAL_TRANSFER_MINT {
            return Err(VaultError::UnexpectedExtension.into());
        }
        confidential = Some(value);
    }
    // ConfidentialTransferMint: authority (32) | auto_approve_new_accounts (1) | auditor (32)
    let ct = confidential.ok_or(VaultError::MissingConfidentialTransfer)?;
    if ct.len() < 33 || ct[32] != 1 {
        return Err(VaultError::AutoApproveDisabled.into());
    }
    Ok(())
}

/// Creates the config PDA. If someone has already sent lamports to the address
/// (which would make CreateAccount fail and block initialization forever),
/// tops it up and allocates and assigns it instead.
fn create_config_account(
    payer: &AccountView,
    config: &AccountView,
    signer: &Signer,
) -> ProgramResult {
    let rent = Rent::get()?.try_minimum_balance(CONFIG_LEN)?;
    let signers = core::slice::from_ref(signer);

    if config.lamports() == 0 {
        return CreateAccount {
            from: payer,
            to: config,
            lamports: rent,
            space: CONFIG_LEN as u64,
            owner: &ID,
        }
        .invoke_signed(signers);
    }

    let shortfall = rent.saturating_sub(config.lamports());
    if shortfall > 0 {
        Transfer { from: payer, to: config, lamports: shortfall }.invoke()?;
    }
    Allocate { account: config, space: CONFIG_LEN as u64 }.invoke_signed(signers)?;
    Assign { account: config, owner: &ID }.invoke_signed(signers)
}
