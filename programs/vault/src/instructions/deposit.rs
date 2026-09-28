use anchor_lang::{prelude::*, solana_program::program::invoke};
use anchor_spl::{
    token::{self, Mint as SplMint, Token, TokenAccount as SplTokenAccount},
    token_2022::{self, Token2022},
    token_interface::{Mint, TokenAccount},
};
use spl_token_2022_interface::extension::confidential_transfer::instruction as ct;

use crate::{constants::*, error::VaultError, events::Deposited, state::VaultConfig};

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub owner: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = usdc_mint,
        has_one = cusdc_mint,
        has_one = usdc_reserve,
        constraint = !config.paused @ VaultError::Paused,
    )]
    pub config: Account<'info, VaultConfig>,

    pub usdc_mint: Account<'info, SplMint>,

    #[account(mut)]
    pub cusdc_mint: InterfaceAccount<'info, Mint>,

    #[account(mut, token::mint = usdc_mint, token::authority = owner)]
    pub owner_usdc: Account<'info, SplTokenAccount>,

    #[account(mut)]
    pub usdc_reserve: Account<'info, SplTokenAccount>,

    #[account(
        mut,
        token::mint = cusdc_mint,
        token::authority = owner,
        token::token_program = token_2022_program,
    )]
    pub owner_cusdc: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
}

pub fn handle_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::ZeroAmount);
    let a = &ctx.accounts;
    let decimals = a.usdc_mint.decimals;

    // 1. USDC in.
    token::transfer_checked(
        CpiContext::new(
            Token::id(),
            token::TransferChecked {
                from: a.owner_usdc.to_account_info(),
                mint: a.usdc_mint.to_account_info(),
                to: a.usdc_reserve.to_account_info(),
                authority: a.owner.to_account_info(),
            },
        ),
        amount,
        decimals,
    )?;

    // 2. The same amount of cUSDC out, signed by the config PDA.
    let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, &[a.config.bump]]];
    token_2022::mint_to_checked(
        CpiContext::new_with_signer(
            Token2022::id(),
            token_2022::MintToChecked {
                mint: a.cusdc_mint.to_account_info(),
                to: a.owner_cusdc.to_account_info(),
                authority: a.config.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
        decimals,
    )?;

    // 3. Straight into the owner's pending confidential balance. The owner's
    // signature on this instruction carries through to the CPI.
    let ix = ct::deposit(
        &Token2022::id(),
        &a.owner_cusdc.key(),
        &a.cusdc_mint.key(),
        amount,
        decimals,
        &a.owner.key(),
        &[],
    )?;
    invoke(
        &ix,
        &[
            a.owner_cusdc.to_account_info(),
            a.cusdc_mint.to_account_info(),
            a.owner.to_account_info(),
        ],
    )?;

    emit!(Deposited { owner: a.owner.key(), cusdc_account: a.owner_cusdc.key(), amount });
    Ok(())
}
