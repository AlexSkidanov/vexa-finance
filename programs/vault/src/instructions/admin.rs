use anchor_lang::prelude::*;

use crate::{
    constants::*,
    events::{AdminChanged, PausedSet},
    state::VaultConfig,
};

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, VaultConfig>,
}

#[derive(Accounts)]
pub struct SetAdmin<'info> {
    pub admin: Signer<'info>,
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, VaultConfig>,
}

pub fn handle_set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    emit!(PausedSet { paused });
    Ok(())
}

pub fn handle_set_admin(ctx: Context<SetAdmin>) -> Result<()> {
    let previous = ctx.accounts.config.admin;
    ctx.accounts.config.admin = ctx.accounts.new_admin.key();
    emit!(AdminChanged { previous, admin: ctx.accounts.new_admin.key() });
    Ok(())
}
