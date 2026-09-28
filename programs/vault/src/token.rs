//! Just enough of SPL Token, Token-2022 and the associated token program for
//! the vault: account parsing and the handful of instructions it invokes.
//!
//! Instruction data is encoded by hand to avoid pulling the SPL crates (and
//! their size) into the program. The `*_data` encoders are public so the test
//! suite can assert they are byte-for-byte identical to the official builders
//! in `spl-token-2022-interface`.

use pinocchio::{
    cpi::{invoke_signed, Signer},
    error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
    AccountView, Address, ProgramResult,
};

pub const TOKEN_PROGRAM_ID: Address =
    Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_PROGRAM_ID: Address =
    Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ASSOCIATED_TOKEN_PROGRAM_ID: Address =
    Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM_PROGRAM_ID: Address = Address::from_str_const("11111111111111111111111111111111");
pub const BPF_LOADER_UPGRADEABLE_ID: Address =
    Address::from_str_const("BPFLoaderUpgradeab1e11111111111111111111111");
pub const INSTRUCTIONS_SYSVAR_ID: Address =
    Address::from_str_const("Sysvar1nstructions1111111111111111111111111");

// ---------------------------------------------------------------------------
// Account layouts
// ---------------------------------------------------------------------------

/// Base Mint layout, shared by Token and Token-2022:
/// mint_authority COption<Pubkey> (4 + 32) | supply u64 | decimals u8 |
/// is_initialized bool | freeze_authority COption<Pubkey> (4 + 32)
pub const MINT_LEN: usize = 82;
/// Base token Account layout: mint | owner | amount | ... (165 bytes).
pub const ACCOUNT_LEN: usize = 165;

/// Token-2022 extension types (u16 in the TLV header).
pub const EXT_CONFIDENTIAL_TRANSFER_MINT: u16 = 4;
pub const EXT_CONFIDENTIAL_TRANSFER_ACCOUNT: u16 = 5;

/// Token-2022 `AccountType` byte, stored right after the 165-byte base area.
const ACCOUNT_TYPE_MINT: u8 = 1;
const ACCOUNT_TYPE_ACCOUNT: u8 = 2;

pub struct Mint {
    pub mint_authority: Option<Address>,
    pub supply: u64,
    pub decimals: u8,
    pub freeze_authority: Option<Address>,
}

fn address_at(data: &[u8], offset: usize) -> Address {
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&data[offset..offset + 32]);
    Address::new_from_array(bytes)
}

fn coption_address(data: &[u8], offset: usize) -> Result<Option<Address>, ProgramError> {
    match u32::from_le_bytes(data[offset..offset + 4].try_into().unwrap()) {
        0 => Ok(None),
        1 => Ok(Some(address_at(data, offset + 4))),
        _ => Err(ProgramError::InvalidAccountData),
    }
}

pub fn read_mint(data: &[u8]) -> Result<Mint, ProgramError> {
    if data.len() < MINT_LEN || data[45] != 1 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(Mint {
        mint_authority: coption_address(data, 0)?,
        supply: u64::from_le_bytes(data[36..44].try_into().unwrap()),
        decimals: data[44],
        freeze_authority: coption_address(data, 46)?,
    })
}

/// Returns (mint, owner) of an initialized token account.
pub fn read_token_account(data: &[u8]) -> Result<(Address, Address), ProgramError> {
    // Byte 108 is `state`: 1 = initialized, 2 = frozen.
    if data.len() < ACCOUNT_LEN || data[108] == 0 {
        return Err(ProgramError::UninitializedAccount);
    }
    Ok((address_at(data, 0), address_at(data, 32)))
}

/// Iterates a Token-2022 account's extensions as (type, value). Accounts with
/// no extensions yield nothing. `mint` selects the expected account type.
pub fn extensions(data: &[u8], mint: bool) -> Result<Extensions<'_>, ProgramError> {
    if data.len() <= ACCOUNT_LEN {
        return Ok(Extensions { tlv: &[] });
    }
    let expected = if mint { ACCOUNT_TYPE_MINT } else { ACCOUNT_TYPE_ACCOUNT };
    if data[ACCOUNT_LEN] != expected {
        return Err(ProgramError::InvalidAccountData);
    }
    // For a mint, bytes 82..165 are zero padding so both layouts share offsets.
    if mint && data[MINT_LEN..ACCOUNT_LEN].iter().any(|b| *b != 0) {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(Extensions { tlv: &data[ACCOUNT_LEN + 1..] })
}

pub struct Extensions<'a> {
    tlv: &'a [u8],
}

impl<'a> Iterator for Extensions<'a> {
    type Item = Result<(u16, &'a [u8]), ProgramError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.tlv.len() < 4 {
            return None;
        }
        let ty = u16::from_le_bytes([self.tlv[0], self.tlv[1]]);
        // Type 0 (Uninitialized) marks unused trailing space.
        if ty == 0 {
            return None;
        }
        let len = u16::from_le_bytes([self.tlv[2], self.tlv[3]]) as usize;
        if self.tlv.len() < 4 + len {
            self.tlv = &[];
            return Some(Err(ProgramError::InvalidAccountData));
        }
        let value = &self.tlv[4..4 + len];
        self.tlv = &self.tlv[4 + len..];
        Some(Ok((ty, value)))
    }
}

// ---------------------------------------------------------------------------
// Instruction data encoders
// ---------------------------------------------------------------------------

const TRANSFER_CHECKED: u8 = 12;
const MINT_TO_CHECKED: u8 = 14;
const BURN_CHECKED: u8 = 15;
const CONFIDENTIAL_TRANSFER_EXTENSION: u8 = 27;
const REALLOCATE: u8 = 29;
const CT_CONFIGURE_ACCOUNT: u8 = 2;
const CT_DEPOSIT: u8 = 5;
const ATA_CREATE_IDEMPOTENT: u8 = 1;

/// TransferChecked, MintToChecked and BurnChecked share one layout.
pub fn amount_decimals_data(instruction: u8, amount: u64, decimals: u8) -> [u8; 10] {
    let mut d = [0u8; 10];
    d[0] = instruction;
    d[1..9].copy_from_slice(&amount.to_le_bytes());
    d[9] = decimals;
    d
}

pub fn transfer_checked_data(amount: u64, decimals: u8) -> [u8; 10] {
    amount_decimals_data(TRANSFER_CHECKED, amount, decimals)
}

pub fn mint_to_checked_data(amount: u64, decimals: u8) -> [u8; 10] {
    amount_decimals_data(MINT_TO_CHECKED, amount, decimals)
}

pub fn burn_checked_data(amount: u64, decimals: u8) -> [u8; 10] {
    amount_decimals_data(BURN_CHECKED, amount, decimals)
}

pub fn ct_deposit_data(amount: u64, decimals: u8) -> [u8; 11] {
    let mut d = [0u8; 11];
    d[0] = CONFIDENTIAL_TRANSFER_EXTENSION;
    d[1] = CT_DEPOSIT;
    d[2..10].copy_from_slice(&amount.to_le_bytes());
    d[10] = decimals;
    d
}

pub fn ct_configure_account_data(
    decryptable_zero_balance: &[u8; 36],
    maximum_pending_balance_credit_counter: u64,
    proof_instruction_offset: i8,
) -> [u8; 47] {
    let mut d = [0u8; 47];
    d[0] = CONFIDENTIAL_TRANSFER_EXTENSION;
    d[1] = CT_CONFIGURE_ACCOUNT;
    d[2..38].copy_from_slice(decryptable_zero_balance);
    d[38..46].copy_from_slice(&maximum_pending_balance_credit_counter.to_le_bytes());
    d[46] = proof_instruction_offset as u8;
    d
}

pub fn reallocate_data(extension_type: u16) -> [u8; 3] {
    let t = extension_type.to_le_bytes();
    [REALLOCATE, t[0], t[1]]
}

// ---------------------------------------------------------------------------
// CPIs
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
pub fn transfer_checked(
    token_program: &Address,
    from: &AccountView,
    mint: &AccountView,
    to: &AccountView,
    authority: &AccountView,
    amount: u64,
    decimals: u8,
    signers: &[Signer],
) -> ProgramResult {
    let data = transfer_checked_data(amount, decimals);
    let metas = [
        InstructionAccount::writable(from.address()),
        InstructionAccount::readonly(mint.address()),
        InstructionAccount::writable(to.address()),
        InstructionAccount::readonly_signer(authority.address()),
    ];
    let ix = InstructionView { program_id: token_program, data: &data, accounts: &metas };
    invoke_signed(&ix, &[from, mint, to, authority], signers)
}

pub fn mint_to_checked(
    mint: &AccountView,
    to: &AccountView,
    authority: &AccountView,
    amount: u64,
    decimals: u8,
    signers: &[Signer],
) -> ProgramResult {
    let data = mint_to_checked_data(amount, decimals);
    let metas = [
        InstructionAccount::writable(mint.address()),
        InstructionAccount::writable(to.address()),
        InstructionAccount::readonly_signer(authority.address()),
    ];
    let ix = InstructionView { program_id: &TOKEN_2022_PROGRAM_ID, data: &data, accounts: &metas };
    invoke_signed(&ix, &[mint, to, authority], signers)
}

pub fn burn_checked(
    account: &AccountView,
    mint: &AccountView,
    authority: &AccountView,
    amount: u64,
    decimals: u8,
) -> ProgramResult {
    let data = burn_checked_data(amount, decimals);
    let metas = [
        InstructionAccount::writable(account.address()),
        InstructionAccount::writable(mint.address()),
        InstructionAccount::readonly_signer(authority.address()),
    ];
    let ix = InstructionView { program_id: &TOKEN_2022_PROGRAM_ID, data: &data, accounts: &metas };
    invoke_signed(&ix, &[account, mint, authority], &[])
}

/// Moves `amount` from an account's public balance into its pending
/// confidential balance. The owner's signature on the outer instruction
/// carries through to this CPI.
pub fn confidential_deposit(
    account: &AccountView,
    mint: &AccountView,
    owner: &AccountView,
    amount: u64,
    decimals: u8,
) -> ProgramResult {
    let data = ct_deposit_data(amount, decimals);
    let metas = [
        InstructionAccount::writable(account.address()),
        InstructionAccount::readonly(mint.address()),
        InstructionAccount::readonly_signer(owner.address()),
    ];
    let ix = InstructionView { program_id: &TOKEN_2022_PROGRAM_ID, data: &data, accounts: &metas };
    invoke_signed(&ix, &[account, mint, owner], &[])
}

/// ConfigureAccount with the pubkey validity proof in a sibling instruction
/// (`proof_instruction_offset` relative to the current top-level instruction).
pub fn configure_confidential_account(
    account: &AccountView,
    mint: &AccountView,
    instructions_sysvar: &AccountView,
    owner: &AccountView,
    decryptable_zero_balance: &[u8; 36],
    maximum_pending_balance_credit_counter: u64,
    proof_instruction_offset: i8,
) -> ProgramResult {
    let data = ct_configure_account_data(
        decryptable_zero_balance,
        maximum_pending_balance_credit_counter,
        proof_instruction_offset,
    );
    let metas = [
        InstructionAccount::writable(account.address()),
        InstructionAccount::readonly(mint.address()),
        InstructionAccount::readonly(instructions_sysvar.address()),
        InstructionAccount::readonly_signer(owner.address()),
    ];
    let ix = InstructionView { program_id: &TOKEN_2022_PROGRAM_ID, data: &data, accounts: &metas };
    invoke_signed(&ix, &[account, mint, instructions_sysvar, owner], &[])
}

/// Grows a Token-2022 account to fit one more extension, paid by `payer`.
pub fn reallocate(
    account: &AccountView,
    payer: &AccountView,
    system_program: &AccountView,
    owner: &AccountView,
    extension_type: u16,
) -> ProgramResult {
    let data = reallocate_data(extension_type);
    let metas = [
        InstructionAccount::writable(account.address()),
        InstructionAccount::writable_signer(payer.address()),
        InstructionAccount::readonly(system_program.address()),
        InstructionAccount::readonly_signer(owner.address()),
    ];
    let ix = InstructionView { program_id: &TOKEN_2022_PROGRAM_ID, data: &data, accounts: &metas };
    invoke_signed(&ix, &[account, payer, system_program, owner], &[])
}

/// Creates the associated token account if it doesn't exist. The ATA program
/// checks that `ata` is the canonical address for (wallet, mint, token program),
/// which is how the vault validates both the reserve and users' cUSDC accounts.
pub fn create_associated_token_account_idempotent(
    payer: &AccountView,
    ata: &AccountView,
    wallet: &AccountView,
    mint: &AccountView,
    system_program: &AccountView,
    token_program: &AccountView,
    signers: &[Signer],
) -> ProgramResult {
    let data = [ATA_CREATE_IDEMPOTENT];
    let metas = [
        InstructionAccount::writable_signer(payer.address()),
        InstructionAccount::writable(ata.address()),
        InstructionAccount::readonly(wallet.address()),
        InstructionAccount::readonly(mint.address()),
        InstructionAccount::readonly(system_program.address()),
        InstructionAccount::readonly(token_program.address()),
    ];
    let ix =
        InstructionView { program_id: &ASSOCIATED_TOKEN_PROGRAM_ID, data: &data, accounts: &metas };
    invoke_signed(&ix, &[payer, ata, wallet, mint, system_program, token_program], signers)
}
