use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct VaultConfig {
    /// Can pause the vault and hand the role to another key. Cannot move funds.
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub cusdc_mint: Pubkey,
    /// Associated token account of this PDA for `usdc_mint`.
    pub usdc_reserve: Pubkey,
    pub paused: bool,
    pub bump: u8,
}
