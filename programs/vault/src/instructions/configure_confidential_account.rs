use std::num::NonZeroI8;

use anchor_lang::{prelude::*, solana_program::program::invoke};
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{self, Token2022},
    token_interface::{Mint, TokenAccount},
};
use spl_token_2022_interface::extension::{
    confidential_transfer::{
        instruction::{inner_configure_account, PubkeyValidityProofData},
        ConfidentialTransferAccount, DecryptableBalance,
    },
    BaseStateWithExtensions, ExtensionType, StateWithExtensions,
};
use spl_token_2022_interface::state::Account as Account2022;
use spl_token_confidential_transfer_proof_extraction::instruction::ProofLocation;

use crate::{constants::*, error::VaultError, state::VaultConfig};

#[derive(Accounts)]
pub struct ConfigureConfidentialAccount<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = cusdc_mint)]
    pub config: Account<'info, VaultConfig>,

    pub cusdc_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = cusdc_mint,
        associated_token::authority = owner,
        associated_token::token_program = token_program,
    )]
    pub token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: the instructions sysvar, read by Token-2022 to find the proof.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_configure_confidential_account(
    ctx: Context<ConfigureConfidentialAccount>,
    decryptable_zero_balance: [u8; 36],
    proof_instruction_offset: i8,
) -> Result<()> {
    let offset = NonZeroI8::new(proof_instruction_offset).ok_or(VaultError::InvalidProofOffset)?;

    // Safe to call twice: an account that's already configured is left alone.
    if already_configured(&ctx.accounts.token_account.to_account_info())? {
        return Ok(());
    }

    // An associated token account is created with room only for the mint's
    // required extensions. Grow it to fit the confidential transfer state.
    token_2022::reallocate(
        CpiContext::new(
            Token2022::id(),
            token_2022::Reallocate {
                account: ctx.accounts.token_account.to_account_info(),
                payer: ctx.accounts.owner.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
        ),
        &[ExtensionType::ConfidentialTransferAccount],
    )?;

    // ConfigureAccount reads the pubkey validity proof from another
    // instruction in this transaction. The offset is relative to the
    // top-level instruction, i.e. this one. The proof data argument is only
    // used by the builder to emit that sibling instruction, so a zeroed
    // placeholder is fine here.
    let placeholder: PubkeyValidityProofData = bytemuck::Zeroable::zeroed();
    let zero_balance: DecryptableBalance = bytemuck::pod_read_unaligned(&decryptable_zero_balance);
    let ix = inner_configure_account(
        &Token2022::id(),
        &ctx.accounts.token_account.key(),
        &ctx.accounts.cusdc_mint.key(),
        &zero_balance,
        MAX_PENDING_BALANCE_CREDIT_COUNTER,
        &ctx.accounts.owner.key(),
        &[],
        ProofLocation::InstructionOffset(offset, &placeholder),
    )?;
    invoke(
        &ix,
        &[
            ctx.accounts.token_account.to_account_info(),
            ctx.accounts.cusdc_mint.to_account_info(),
            ctx.accounts.instructions.to_account_info(),
            ctx.accounts.owner.to_account_info(),
        ],
    )?;
    Ok(())
}

fn already_configured(account: &AccountInfo) -> Result<bool> {
    let data = account.try_borrow_data()?;
    let state = StateWithExtensions::<Account2022>::unpack(&data)?;
    Ok(state.get_extension::<ConfidentialTransferAccount>().is_ok())
}
