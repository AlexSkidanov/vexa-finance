use anchor_lang::prelude::*;

// Deposit and withdrawal amounts are already public: they're visible in the
// USDC transfer itself. Events just make them easy for the indexer to read.

#[event]
pub struct Deposited {
    pub owner: Pubkey,
    pub cusdc_account: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Withdrawn {
    pub owner: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
}

#[event]
pub struct PausedSet {
    pub paused: bool,
}

#[event]
pub struct AdminChanged {
    pub previous: Pubkey,
    pub admin: Pubkey,
}
