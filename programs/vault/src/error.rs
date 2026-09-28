use pinocchio::error::ProgramError;

/// Custom errors, surfaced on-chain as `custom program error: 0x<code>`.
/// Codes are part of the program's interface: append only, never renumber.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VaultError {
    /// The vault is paused.
    Paused = 0,
    /// Amount must be greater than zero.
    ZeroAmount = 1,
    /// Only the program's upgrade authority may initialize the vault.
    NotUpgradeAuthority = 2,
    /// cUSDC mint authority must be the vault config PDA.
    WrongMintAuthority = 3,
    /// cUSDC mint must not have a freeze authority.
    FreezeAuthoritySet = 4,
    /// cUSDC and USDC must have the same number of decimals.
    DecimalsMismatch = 5,
    /// cUSDC mint must have a zero supply at initialization.
    NonZeroSupply = 6,
    /// cUSDC mint is missing the ConfidentialTransfer extension.
    MissingConfidentialTransfer = 7,
    /// cUSDC mint must auto-approve new confidential accounts.
    AutoApproveDisabled = 8,
    /// cUSDC mint has an extension the vault does not allow.
    UnexpectedExtension = 9,
    /// Proof instruction offset must be non-zero.
    InvalidProofOffset = 10,
    /// Account is not the one recorded in the vault config.
    ConfigMismatch = 11,
    /// Token account is not owned by the signer.
    TokenOwnerMismatch = 12,
    /// Token account belongs to a different mint.
    TokenMintMismatch = 13,
    /// Signer is not the vault admin.
    NotAdmin = 14,
    /// The vault config is already initialized.
    AlreadyInitialized = 15,
}

impl From<VaultError> for ProgramError {
    fn from(e: VaultError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
