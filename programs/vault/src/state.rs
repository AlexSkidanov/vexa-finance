//! The vault's one account: its config, at PDA `["config"]`.
//!
//! ```text
//! offset  size  field
//!      0     1  account type (1 = VaultConfig v1)
//!      1    32  admin         can pause and hand over the role; cannot move funds
//!     33    32  usdc_mint
//!     65    32  cusdc_mint
//!     97    32  usdc_reserve  associated token account of this PDA for usdc_mint
//!    129     1  paused
//!    130     1  bump
//! ```

use pinocchio::{error::ProgramError, AccountView, Address};

use crate::ID;

pub const CONFIG_SEED: &[u8] = b"config";
pub const CONFIG_LEN: usize = 131;
pub const CONFIG_ACCOUNT_TYPE: u8 = 1;

const ADMIN: usize = 1;
const USDC_MINT: usize = 33;
const CUSDC_MINT: usize = 65;
const USDC_RESERVE: usize = 97;
const PAUSED: usize = 129;
const BUMP: usize = 130;

#[derive(Clone, Copy)]
pub struct Config {
    pub admin: Address,
    pub usdc_mint: Address,
    pub cusdc_mint: Address,
    pub usdc_reserve: Address,
    pub paused: bool,
    pub bump: u8,
}

fn address_at(data: &[u8], offset: usize) -> Address {
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&data[offset..offset + 32]);
    Address::new_from_array(bytes)
}

impl Config {
    /// Loads and authenticates the config account: it must be owned by this
    /// program, carry the right type tag and length, and sit at the PDA its
    /// stored bump derives.
    pub fn load(account: &AccountView) -> Result<Self, ProgramError> {
        if !account.owned_by(&ID) {
            return Err(ProgramError::InvalidAccountOwner);
        }
        let data = account.try_borrow()?;
        if data.len() != CONFIG_LEN || data[0] != CONFIG_ACCOUNT_TYPE {
            return Err(ProgramError::InvalidAccountData);
        }
        let config = Config {
            admin: address_at(&data, ADMIN),
            usdc_mint: address_at(&data, USDC_MINT),
            cusdc_mint: address_at(&data, CUSDC_MINT),
            usdc_reserve: address_at(&data, USDC_RESERVE),
            paused: data[PAUSED] != 0,
            bump: data[BUMP],
        };
        if Address::derive_address(&[CONFIG_SEED], Some(config.bump), &ID) != *account.address() {
            return Err(ProgramError::InvalidSeeds);
        }
        Ok(config)
    }

    pub fn store(&self, account: &mut AccountView) -> Result<(), ProgramError> {
        let mut data = account.try_borrow_mut()?;
        if data.len() != CONFIG_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        data[0] = CONFIG_ACCOUNT_TYPE;
        data[ADMIN..ADMIN + 32].copy_from_slice(self.admin.as_ref());
        data[USDC_MINT..USDC_MINT + 32].copy_from_slice(self.usdc_mint.as_ref());
        data[CUSDC_MINT..CUSDC_MINT + 32].copy_from_slice(self.cusdc_mint.as_ref());
        data[USDC_RESERVE..USDC_RESERVE + 32].copy_from_slice(self.usdc_reserve.as_ref());
        data[PAUSED] = self.paused as u8;
        data[BUMP] = self.bump;
        Ok(())
    }
}
