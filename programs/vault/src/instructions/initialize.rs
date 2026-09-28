use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
    token_2022::Token2022,
};
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::ConfidentialTransferMint, BaseStateWithExtensions, ExtensionType,
        StateWithExtensions,
    },
    state::Mint as Mint2022,
};

use crate::{constants::*, error::VaultError, program::Vault, state::VaultConfig};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + VaultConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, VaultConfig>,

    pub usdc_mint: Account<'info, Mint>,

    /// CHECK: a Token-2022 mint. Deserialized with its extensions and fully
    /// validated in the handler.
    #[account(owner = Token2022::id())]
    pub cusdc_mint: UncheckedAccount<'info>,

    #[account(
        init,
        payer = admin,
        associated_token::mint = usdc_mint,
        associated_token::authority = config,
        associated_token::token_program = token_program,
    )]
    pub usdc_reserve: Account<'info, TokenAccount>,

    // Only the program's upgrade authority may initialize. Without this, anyone
    // watching the chain could initialize a freshly deployed vault with a mint
    // they control before we do.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, Vault>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()))]
    pub program_data: Account<'info, ProgramData>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize(ctx: Context<Initialize>) -> Result<()> {
    let config_key = ctx.accounts.config.key();
    validate_cusdc_mint(&ctx.accounts.cusdc_mint, &config_key, ctx.accounts.usdc_mint.decimals)?;

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.cusdc_mint = ctx.accounts.cusdc_mint.key();
    config.usdc_reserve = ctx.accounts.usdc_reserve.key();
    config.paused = false;
    config.bump = ctx.bumps.config;
    Ok(())
}

/// A cUSDC mint is only safe to back with real USDC if nobody but the vault
/// can create or seize it. So it must:
///   - have the config PDA as its sole mint authority,
///   - have no freeze authority, so balances can't be frozen,
///   - carry no extension besides ConfidentialTransferMint (no permanent
///     delegate, no transfer hook, no fees),
///   - auto-approve new confidential accounts,
///   - start with zero supply and match USDC's decimals.
fn validate_cusdc_mint(mint_info: &AccountInfo, config: &Pubkey, usdc_decimals: u8) -> Result<()> {
    let data = mint_info.try_borrow_data()?;
    let mint = StateWithExtensions::<Mint2022>::unpack(&data)?;

    require!(
        Option::<Pubkey>::from(mint.base.mint_authority) == Some(*config),
        VaultError::WrongMintAuthority
    );
    require!(mint.base.freeze_authority.is_none(), VaultError::FreezeAuthoritySet);
    require!(mint.base.supply == 0, VaultError::NonZeroSupply);
    require!(mint.base.decimals == usdc_decimals, VaultError::DecimalsMismatch);

    let ct = mint
        .get_extension::<ConfidentialTransferMint>()
        .map_err(|_| error!(VaultError::MissingConfidentialTransfer))?;
    require!(bool::from(ct.auto_approve_new_accounts), VaultError::AutoApproveDisabled);

    for extension in mint.get_extension_types()? {
        require!(
            extension == ExtensionType::ConfidentialTransferMint,
            VaultError::UnexpectedExtension
        );
    }
    Ok(())
}
