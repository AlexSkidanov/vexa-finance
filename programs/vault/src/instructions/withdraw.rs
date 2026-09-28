use anchor_lang::prelude::*;
use anchor_spl::{
    token::{self, Mint as SplMint, Token, TokenAccount as SplTokenAccount},
    token_2022::{self, Token2022},
    token_interface::{Mint, TokenAccount},
};

use crate::{constants::*, error::VaultError, events::Withdrawn, state::VaultConfig};

#[derive(Accounts)]
pub struct Withdraw<'info> {
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

    /// Must already hold `amount` in its public (non-confidential) balance,
    /// moved there by a CT Withdraw earlier in the same transaction.
    #[account(
        mut,
        token::mint = cusdc_mint,
        token::authority = owner,
        token::token_program = token_2022_program,
    )]
    pub owner_cusdc: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub usdc_reserve: Account<'info, SplTokenAccount>,

    /// Any USDC account, owned by anyone: withdrawals can go straight to an
    /// exchange deposit address.
    #[account(mut, token::mint = usdc_mint)]
    pub destination: Account<'info, SplTokenAccount>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
}

pub fn handle_withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::ZeroAmount);
    let a = &ctx.accounts;
    let decimals = a.usdc_mint.decimals;

    // Burn first. If the public balance is short, this fails and nothing moves.
    token_2022::burn_checked(
        CpiContext::new(
            Token2022::id(),
            token_2022::BurnChecked {
                mint: a.cusdc_mint.to_account_info(),
                from: a.owner_cusdc.to_account_info(),
                authority: a.owner.to_account_info(),
            },
        ),
        amount,
        decimals,
    )?;

    let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, &[a.config.bump]]];
    token::transfer_checked(
        CpiContext::new_with_signer(
            Token::id(),
            token::TransferChecked {
                from: a.usdc_reserve.to_account_info(),
                mint: a.usdc_mint.to_account_info(),
                to: a.destination.to_account_info(),
                authority: a.config.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
        decimals,
    )?;

    emit!(Withdrawn { owner: a.owner.key(), destination: a.destination.key(), amount });
    Ok(())
}
