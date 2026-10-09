//! The vault's wire format. Every instruction is one tag byte followed by its
//! arguments, little-endian:
//!
//! | Tag | Instruction                    | Arguments                                              |
//! |-----|--------------------------------|--------------------------------------------------------|
//! | 0   | `Initialize`                   | none                                                   |
//! | 1   | `ConfigureConfidentialAccount` | `decryptable_zero_balance: [u8; 36]`, `proof_offset: i8` |
//! | 2   | `Deposit`                      | `amount: u64`                                          |
//! | 3   | `Withdraw`                     | `amount: u64`                                          |
//! | 4   | `SetPaused`                    | `paused: u8` (0 or 1)                                  |
//! | 5   | `SetAdmin`                     | none                                                   |
//!
//! Account lists are documented on each processor and mirrored by the
//! builders in `@vexa/core` and the test harness.

use pinocchio::error::ProgramError;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum VaultInstruction {
    Initialize = 0,
    ConfigureConfidentialAccount = 1,
    Deposit = 2,
    Withdraw = 3,
    SetPaused = 4,
    SetAdmin = 5,
}

impl TryFrom<u8> for VaultInstruction {
    type Error = ProgramError;

    fn try_from(tag: u8) -> Result<Self, Self::Error> {
        Ok(match tag {
            0 => Self::Initialize,
            1 => Self::ConfigureConfidentialAccount,
            2 => Self::Deposit,
            3 => Self::Withdraw,
            4 => Self::SetPaused,
            5 => Self::SetAdmin,
            _ => return Err(ProgramError::InvalidInstructionData),
        })
    }
}

/// Reads a little-endian `u64` amount that must be the whole argument payload.
pub(crate) fn parse_amount(args: &[u8]) -> Result<u64, ProgramError> {
    let bytes: [u8; 8] = args.try_into().map_err(|_| ProgramError::InvalidInstructionData)?;
    Ok(u64::from_le_bytes(bytes))
}
