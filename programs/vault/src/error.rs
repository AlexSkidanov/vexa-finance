use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("The vault is paused")]
    Paused,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("cUSDC mint authority must be the vault config PDA")]
    WrongMintAuthority,
    #[msg("cUSDC mint must not have a freeze authority")]
    FreezeAuthoritySet,
    #[msg("cUSDC and USDC must have the same number of decimals")]
    DecimalsMismatch,
    #[msg("cUSDC mint must have a zero supply at initialization")]
    NonZeroSupply,
    #[msg("cUSDC mint is missing the ConfidentialTransfer extension")]
    MissingConfidentialTransfer,
    #[msg("cUSDC mint must auto-approve new confidential accounts")]
    AutoApproveDisabled,
    #[msg("cUSDC mint has an extension the vault does not allow")]
    UnexpectedExtension,
    #[msg("Proof instruction offset must be non-zero")]
    InvalidProofOffset,
}
