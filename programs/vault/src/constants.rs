use anchor_lang::prelude::*;

/// Seed for the config PDA. It is also the cUSDC mint authority and the owner
/// of the USDC reserve.
#[constant]
pub const CONFIG_SEED: &[u8] = b"config";

/// How many incoming transfers an account may accumulate in its pending
/// balance before the owner must apply them. Token-2022 caps pending balances
/// so decryption stays tractable. 2^16 is the value the spl-token CLI uses.
pub const MAX_PENDING_BALANCE_CREDIT_COUNTER: u64 = 65_536;
