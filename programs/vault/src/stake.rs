//! $VEXA stakes: one record per owner, PDA `["stake", owner]`.
//!
//! Staked $VEXA sits in the stake vault, the config PDA's associated token
//! account for the $VEXA mint. It counts at full weight towards fee discounts
//! and agent limits; $VEXA merely held in a wallet counts at half. Each stake
//! locks the whole position for `STAKE_LOCK_SECONDS`, so staking can't be
//! done and undone inside one transaction to borrow the higher weight.
//!
//! ```text
//! offset  size  field
//!      0     1  account type (3 = Stake v1)
//!      1     1  bump
//!      2    32  owner
//!     34    32  vexa_mint   the mint staked; a stake of any other mint counts for nothing
//!     66     8  amount
//!     74     8  unlock_at   unix seconds
//! ```

use pinocchio::{error::ProgramError, AccountView, Address};

use crate::ID;

pub const STAKE_SEED: &[u8] = b"stake";
pub const STAKE_LEN: usize = 82;
pub const STAKE_ACCOUNT_TYPE: u8 = 3;
pub const STAKE_LOCK_SECONDS: i64 = 7 * 24 * 60 * 60;

#[derive(Clone, Copy)]
#[repr(C)]
pub struct Stake {
    account_type: u8,
    bump: u8,
    owner: [u8; 32],
    vexa_mint: [u8; 32],
    amount: [u8; 8],
    unlock_at: [u8; 8],
}

const _: () = assert!(core::mem::size_of::<Stake>() == STAKE_LEN);

impl Stake {
    pub fn new(bump: u8, owner: &Address, vexa_mint: &Address) -> Self {
        Stake {
            account_type: STAKE_ACCOUNT_TYPE,
            bump,
            owner: owner.to_bytes(),
            vexa_mint: vexa_mint.to_bytes(),
            amount: [0; 8],
            unlock_at: [0; 8],
        }
    }

    /// Loads and authenticates a stake record: owned by this program, the
    /// right type and length, and at the PDA its stored bump derives for the
    /// owner it records.
    pub fn load(account: &AccountView) -> Result<Self, ProgramError> {
        if !account.owned_by(&ID) {
            return Err(ProgramError::InvalidAccountOwner);
        }
        let data = account.try_borrow()?;
        if data.len() != STAKE_LEN || data[0] != STAKE_ACCOUNT_TYPE {
            return Err(ProgramError::InvalidAccountData);
        }
        // SAFETY: length checked; the struct is byte arrays only (alignment 1).
        let stake = unsafe { core::ptr::read_unaligned(data.as_ptr() as *const Self) };
        let expected = Address::derive_address(&[STAKE_SEED, &stake.owner], Some(stake.bump), &ID);
        if expected != *account.address() {
            return Err(ProgramError::InvalidSeeds);
        }
        Ok(stake)
    }

    pub fn store(&self, account: &mut AccountView) -> Result<(), ProgramError> {
        let mut data = account.try_borrow_mut()?;
        if data.len() != STAKE_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        // SAFETY: `repr(C)` of byte arrays: no padding, STAKE_LEN bytes.
        let bytes =
            unsafe { core::slice::from_raw_parts(self as *const Self as *const u8, STAKE_LEN) };
        data.copy_from_slice(bytes);
        Ok(())
    }

    pub fn owner(&self) -> Address {
        Address::new_from_array(self.owner)
    }

    pub fn vexa_mint(&self) -> Address {
        Address::new_from_array(self.vexa_mint)
    }

    pub fn amount(&self) -> u64 {
        u64::from_le_bytes(self.amount)
    }

    pub fn unlock_at(&self) -> i64 {
        i64::from_le_bytes(self.unlock_at)
    }

    pub fn set_amount(&mut self, amount: u64) {
        self.amount = amount.to_le_bytes();
    }

    pub fn lock_until(&mut self, unlock_at: i64) {
        self.unlock_at = unlock_at.to_le_bytes();
    }
}
