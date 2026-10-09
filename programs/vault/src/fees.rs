//! The protocol fee, charged in USDC where money crosses the vault's edge.
//!
//! Deposits and withdrawals are the only moments an amount is public, so they
//! are the only place a fee can be charged without a proof. Transfers between
//! cUSDC holders are free. The fee goes straight to the treasury's USDC
//! account; the reserve only ever holds what backs cUSDC, so the invariant
//! `reserve ≥ supply` is untouched.
//!
//! ```text
//!   fee = min(⌈amount × fee_bps / 10 000⌉, fee_cap) × (1 − discount)
//! ```
//!
//! Rounding up means every non-empty movement pays at least one base unit
//! while a fee is set, so splitting a deposit into dust doesn't dodge it. The
//! discount comes from the best tier whose `min_balance` the owner's $VEXA
//! account meets, and is rounded in the vault's favour too.
//!
//! The schedule lives in its own PDA, `["fees"]`. Everything after the
//! treasury is exactly the `SetFees` argument payload, so setting the fees is
//! one copy and the account is read in place, with no field-by-field
//! (de)serialization code to pay rent on.
//!
//! ```text
//! offset  size  field
//!      0     1  account type (2 = FeeSchedule v1)
//!      1     1  bump
//!      2    32  treasury      a USDC token account
//!     34     2  fee_bps       at most MAX_FEE_BPS             ┐
//!     36     8  fee_cap       in USDC base units              │ SetFees
//!     44    32  vexa_mint     all zeroes: no discounts        │ arguments
//!     76     1  tier_count    at most MAX_TIERS               │
//!     77    40  tiers         (min_balance u64, discount_bps  │
//!                             u16) × tier_count, then zeroes  ┘
//! ```
//!
//! Tiers must climb strictly in both balance and discount, so the best tier
//! an owner meets is simply the last one.

use pinocchio::{error::ProgramError, AccountView, Address};

use crate::{error::VaultError, ID};

pub const FEES_SEED: &[u8] = b"fees";
pub const FEES_LEN: usize = 117;
pub const FEES_ACCOUNT_TYPE: u8 = 2;

/// 1%. A hard ceiling the admin key can't exceed, whatever happens to it.
pub const MAX_FEE_BPS: u16 = 100;
pub const MAX_TIERS: usize = 4;
const BPS: u64 = 10_000;
const TIER_LEN: usize = 10;
const TERMS: usize = 34;
const TERMS_HEAD: usize = 2 + 8 + 32 + 1;

/// The account's bytes, read in place. Every field is a byte array, so the
/// struct has alignment 1 and any 117-byte buffer is a valid instance.
#[derive(Clone, Copy)]
#[repr(C)]
pub struct FeeSchedule {
    account_type: u8,
    bump: u8,
    treasury: [u8; 32],
    fee_bps: [u8; 2],
    fee_cap: [u8; 8],
    vexa_mint: [u8; 32],
    tier_count: u8,
    tiers: [[u8; TIER_LEN]; MAX_TIERS],
}

const _: () = assert!(core::mem::size_of::<FeeSchedule>() == FEES_LEN);

impl FeeSchedule {
    fn from_bytes(bytes: &[u8]) -> Self {
        debug_assert_eq!(bytes.len(), FEES_LEN);
        // SAFETY: the length is checked by every caller, and every bit pattern
        // is a valid `FeeSchedule` (see the struct docs).
        unsafe { core::ptr::read_unaligned(bytes.as_ptr() as *const Self) }
    }

    fn as_bytes(&self) -> &[u8] {
        // SAFETY: `repr(C)` of byte arrays: no padding, FEES_LEN bytes.
        unsafe { core::slice::from_raw_parts(self as *const Self as *const u8, FEES_LEN) }
    }

    /// Builds a schedule from `SetFees` arguments: `fee_bps: u16`,
    /// `fee_cap: u64`, `vexa_mint: [u8; 32]`, `tier_count: u8`, then
    /// `tier_count` × (`min_balance: u64`, `discount_bps: u16`), and checks it.
    pub fn from_args(bump: u8, treasury: &Address, args: &[u8]) -> Result<Self, ProgramError> {
        let tier_count = *args.get(TERMS_HEAD - 1).ok_or(ProgramError::InvalidInstructionData)?;
        if tier_count as usize > MAX_TIERS
            || args.len() != TERMS_HEAD + tier_count as usize * TIER_LEN
        {
            return Err(ProgramError::InvalidInstructionData);
        }
        let mut bytes = [0u8; FEES_LEN];
        bytes[0] = FEES_ACCOUNT_TYPE;
        bytes[1] = bump;
        bytes[2..TERMS].copy_from_slice(treasury.as_ref());
        bytes[TERMS..TERMS + args.len()].copy_from_slice(args);
        let schedule = Self::from_bytes(&bytes);
        schedule.validate()?;
        Ok(schedule)
    }

    /// Loads and authenticates the schedule, the same way `Config::load`
    /// does. A vault without one refuses to move money rather than run free.
    pub fn load(account: &AccountView) -> Result<Self, ProgramError> {
        if !account.owned_by(&ID) {
            return Err(VaultError::FeesNotSet.into());
        }
        let data = account.try_borrow()?;
        if data.len() != FEES_LEN || data[0] != FEES_ACCOUNT_TYPE {
            return Err(ProgramError::InvalidAccountData);
        }
        let schedule = Self::from_bytes(&data);
        if Address::derive_address(&[FEES_SEED], Some(schedule.bump), &ID) != *account.address() {
            return Err(ProgramError::InvalidSeeds);
        }
        Ok(schedule)
    }

    pub fn store(&self, account: &mut AccountView) -> Result<(), ProgramError> {
        let mut data = account.try_borrow_mut()?;
        if data.len() != FEES_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        data.copy_from_slice(self.as_bytes());
        Ok(())
    }

    pub fn treasury(&self) -> Address {
        Address::new_from_array(self.treasury)
    }

    pub fn vexa_mint(&self) -> Address {
        Address::new_from_array(self.vexa_mint)
    }

    fn fee_bps(&self) -> u64 {
        u16::from_le_bytes(self.fee_bps) as u64
    }

    fn fee_cap(&self) -> u64 {
        u64::from_le_bytes(self.fee_cap)
    }

    /// (min_balance, discount_bps) of each active tier, lowest first.
    fn tiers(&self) -> impl DoubleEndedIterator<Item = (u64, u64)> + '_ {
        self.tiers[..(self.tier_count as usize).min(MAX_TIERS)].iter().map(|t| {
            let (min, discount) = t.split_at(8);
            (
                u64::from_le_bytes(min.try_into().unwrap_or_default()),
                u16::from_le_bytes(discount.try_into().unwrap_or_default()) as u64,
            )
        })
    }

    /// Rejects schedules that would be unfair or ambiguous.
    fn validate(&self) -> Result<(), ProgramError> {
        let invalid = || Err(VaultError::InvalidFeeSchedule.into());
        if self.fee_bps() > MAX_FEE_BPS as u64 {
            return invalid();
        }
        if self.tier_count > 0 && self.vexa_mint == [0; 32] {
            return invalid();
        }
        let mut prev = (0, 0);
        for (i, (min, discount)) in self.tiers().enumerate() {
            if discount == 0 || discount > BPS || (i > 0 && (min <= prev.0 || discount <= prev.1)) {
                return invalid();
            }
            prev = (min, discount);
        }
        Ok(())
    }

    /// The fee on `amount`, given the owner's $VEXA balance. Plain `u64`
    /// arithmetic: 128-bit division would pull a large routine into the
    /// program and cost rent on every byte.
    pub fn fee(&self, amount: u64, vexa_balance: u64) -> u64 {
        // An amount so large that `amount × fee_bps` overflows is far past any cap.
        let raw = amount.checked_mul(self.fee_bps()).map_or(u64::MAX, |x| x.div_ceil(BPS));
        let capped = raw.min(self.fee_cap());
        let discount = self
            .tiers()
            .rev()
            .find(|(min, _)| vexa_balance >= *min)
            .map_or(0, |(_, discount)| discount);
        // ⌊capped × discount / 10 000⌋ without overflow. Rounding the discount
        // down rounds the fee up.
        let off = capped / BPS * discount + capped % BPS * discount / BPS;
        capped - off
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const USDC: u64 = 1_000_000;

    fn args(fee_bps: u16, fee_cap: u64, vexa: bool, tiers: &[(u64, u16)]) -> Vec<u8> {
        let mut a = fee_bps.to_le_bytes().to_vec();
        a.extend_from_slice(&fee_cap.to_le_bytes());
        a.extend_from_slice(&[if vexa { 7 } else { 0 }; 32]);
        a.push(tiers.len() as u8);
        for (min, discount) in tiers {
            a.extend_from_slice(&min.to_le_bytes());
            a.extend_from_slice(&discount.to_le_bytes());
        }
        a
    }

    fn schedule(
        fee_bps: u16,
        fee_cap: u64,
        tiers: &[(u64, u16)],
    ) -> Result<FeeSchedule, ProgramError> {
        FeeSchedule::from_args(255, &Address::default(), &args(fee_bps, fee_cap, true, tiers))
    }

    #[test]
    fn ten_basis_points_capped_at_five_usdc() {
        let s = schedule(10, 5 * USDC, &[]).unwrap();
        assert_eq!(s.fee(100 * USDC, 0), 100_000); // 0.10 USDC
        assert_eq!(s.fee(5_000 * USDC, 0), 5 * USDC); // exactly at the cap
        assert_eq!(s.fee(1_000_000 * USDC, 0), 5 * USDC); // capped
        assert_eq!(s.fee(1, 0), 1); // dust still pays one unit
        assert_eq!(s.fee(u64::MAX, 0), 5 * USDC); // no overflow
        assert_eq!(schedule(0, 5 * USDC, &[]).unwrap().fee(100 * USDC, 0), 0);
    }

    #[test]
    fn the_best_tier_met_applies() {
        let s =
            schedule(10, 5 * USDC, &[(1_000, 2_500), (10_000, 5_000), (100_000, 10_000)]).unwrap();
        assert_eq!(s.fee(100 * USDC, 999), 100_000);
        assert_eq!(s.fee(100 * USDC, 1_000), 75_000);
        assert_eq!(s.fee(100 * USDC, 50_000), 50_000);
        assert_eq!(s.fee(100 * USDC, 100_000), 0);
        // 3 units at 25% off: the 0.75 discount rounds down, so the fee stays 3.
        assert_eq!(schedule(10, 3, &[(1, 2_500)]).unwrap().fee(u64::MAX, 1), 3);
        // A cap too big to multiply directly still discounts exactly.
        assert_eq!(
            schedule(10, u64::MAX, &[(1, 5_000)]).unwrap().fee(u64::MAX, 1),
            u64::MAX - u64::MAX / 2
        );
    }

    #[test]
    fn round_trips_through_bytes() {
        let s = schedule(10, 5 * USDC, &[(1_000, 2_500)]).unwrap();
        let copy = FeeSchedule::from_bytes(s.as_bytes());
        assert_eq!(copy.as_bytes(), s.as_bytes());
        assert_eq!(copy.tiers().collect::<Vec<_>>(), vec![(1_000, 2_500)]);
    }

    #[test]
    fn schedules_are_validated() {
        assert!(schedule(10, 5 * USDC, &[(1_000, 2_500), (10_000, 5_000)]).is_ok());
        assert!(schedule(MAX_FEE_BPS + 1, 1, &[]).is_err());
        assert!(schedule(10, 1, &[(1_000, 5_000), (1_000, 6_000)]).is_err());
        assert!(schedule(10, 1, &[(1_000, 5_000), (2_000, 5_000)]).is_err());
        assert!(schedule(10, 1, &[(1_000, 10_001)]).is_err());
        assert!(schedule(10, 1, &[(1_000, 0)]).is_err());
        let no_mint = args(10, 1, false, &[(1_000, 5_000)]);
        assert!(FeeSchedule::from_args(255, &Address::default(), &no_mint).is_err());
        let mut truncated = args(10, 1, true, &[(1_000, 5_000)]);
        truncated.pop();
        assert!(FeeSchedule::from_args(255, &Address::default(), &truncated).is_err());
        let five = [(1, 1), (2, 2), (3, 3), (4, 4), (5, 5)];
        assert!(schedule(10, 1, &five).is_err());
    }
}
