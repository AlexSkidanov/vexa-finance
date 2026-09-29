//! Test harness: a LiteSVM instance with Token, Token-2022, the associated
//! token program, the ZK ElGamal proof program and the vault, all running the
//! same code as mainnet.

#![allow(dead_code)]

use litesvm::LiteSVM;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_system_interface::{instruction as system_instruction, program as system_program};
use solana_transaction::versioned::VersionedTransaction;
// Proofs and keys come from zk-sdk 7, matching mainnet's verifier. The Token-2022
// builders in spl-token-2022-interface 2.x still use zk-sdk 4 "pod" types; the byte
// layout is identical, so values cross between the two through their raw bytes.
use spl_associated_token_account_interface::address::get_associated_token_address_with_program_id;
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::{
            instruction as ct, ConfidentialTransferAccount, DecryptableBalance,
        },
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    },
    state::{Account as Account2022, Mint as Mint2022},
};
use zk_proof_interface::instruction::ProofInstruction;
use zk_sdk::{
    encryption::{
        auth_encryption::{AeCiphertext, AeKey},
        elgamal::{ElGamalCiphertext, ElGamalKeypair},
    },
    zk_elgamal_proof_program::build_pubkey_validity_proof_data,
};

pub const DECIMALS: u8 = 6;
pub const USDC: u64 = 1_000_000;

pub struct Env {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub usdc_mint: Pubkey,
    pub usdc_authority: Keypair,
    pub cusdc_mint: Pubkey,
    pub config: Pubkey,
    pub reserve: Pubkey,
    pub fees: Pubkey,
    /// The treasury's USDC account, where fees land.
    pub treasury: Pubkey,
}

pub struct User {
    pub kp: Keypair,
    pub usdc: Pubkey,
    pub cusdc: Pubkey,
    pub elgamal: ElGamalKeypair,
    pub ae: AeKey,
}

pub const LOADER_UPGRADEABLE: Pubkey =
    Pubkey::from_str_const("BPFLoaderUpgradeab1e11111111111111111111111");

pub fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[vault::state::CONFIG_SEED], &vault::ID).0
}

pub fn fees_pda() -> Pubkey {
    Pubkey::find_program_address(&[vault::fees::FEES_SEED], &vault::ID).0
}

/// `SetFees` args: fee_bps | fee_cap | vexa_mint | tier_count | tiers.
pub fn set_fees_ix(
    admin: &Pubkey,
    treasury: &Pubkey,
    fee_bps: u16,
    fee_cap: u64,
    vexa_mint: Option<Pubkey>,
    tiers: &[(u64, u16)],
) -> Instruction {
    let mut args = fee_bps.to_le_bytes().to_vec();
    args.extend_from_slice(&fee_cap.to_le_bytes());
    args.extend_from_slice(vexa_mint.unwrap_or_default().as_ref());
    args.push(tiers.len() as u8);
    for (min_balance, discount_bps) in tiers {
        args.extend_from_slice(&min_balance.to_le_bytes());
        args.extend_from_slice(&discount_bps.to_le_bytes());
    }
    vault_ix(
        vault::instruction::VaultInstruction::SetFees,
        &args,
        vec![
            AccountMeta::new(*admin, true),
            AccountMeta::new_readonly(config_pda(), false),
            AccountMeta::new(fees_pda(), false),
            AccountMeta::new_readonly(*treasury, false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
    )
}

/// A vault instruction: tag byte + little-endian args (see `vault::instruction`).
pub fn vault_ix(
    tag: vault::instruction::VaultInstruction,
    args: &[u8],
    accounts: Vec<AccountMeta>,
) -> Instruction {
    let mut data = vec![tag as u8];
    data.extend_from_slice(args);
    Instruction { program_id: vault::ID, accounts, data }
}

pub fn send(
    svm: &mut LiteSVM,
    ixs: &[Instruction],
    payer: &Keypair,
    signers: &[&Keypair],
) -> Result<(), String> {
    // A fresh blockhash per transaction, like a real client. Without it, retrying
    // an identical transaction after a failure is rejected as a duplicate.
    svm.expire_blockhash();
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &blockhash);
    let mut all: Vec<&Keypair> = vec![payer];
    all.extend(signers.iter().filter(|s| s.pubkey() != payer.pubkey()));
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &all)
        .map_err(|e| e.to_string())?;
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))
}

/// Loads the vault as an upgradeable program whose upgrade authority is
/// `admin`, the way it looks on mainnet after `solana program deploy`.
pub fn load_vault(svm: &mut LiteSVM, admin: &Pubkey) {
    let bytes = include_bytes!("../../../../target/deploy/vault.so");
    svm.add_program(vault::ID, bytes).unwrap();

    // Patch ProgramData metadata: enum tag (4) | slot (8) | Option<Pubkey> (1 + 32).
    let programdata = programdata();
    let mut account = svm.get_account(&programdata).unwrap();
    account.data[12] = 1;
    account.data[13..45].copy_from_slice(admin.as_ref());
    svm.set_account(programdata, account).unwrap();
}

pub fn programdata() -> Pubkey {
    Pubkey::find_program_address(&[vault::ID.as_ref()], &LOADER_UPGRADEABLE).0
}

pub fn create_usdc_mint(svm: &mut LiteSVM, payer: &Keypair, authority: &Pubkey) -> Pubkey {
    let mint = Keypair::new();
    let space = 82;
    let ixs = [
        system_instruction::create_account(
            &payer.pubkey(),
            &mint.pubkey(),
            svm.minimum_balance_for_rent_exemption(space),
            space as u64,
            &spl_token_interface::id(),
        ),
        spl_token_interface::instruction::initialize_mint2(
            &spl_token_interface::id(),
            &mint.pubkey(),
            authority,
            None,
            DECIMALS,
        )
        .unwrap(),
    ];
    send(svm, &ixs, payer, &[&mint]).unwrap();
    mint.pubkey()
}

pub struct CusdcOptions {
    pub mint_authority: Pubkey,
    pub freeze_authority: Option<Pubkey>,
    pub auto_approve: bool,
    pub extra_extension: bool,
}

/// Creates a Token-2022 mint the way `scripts/create-cusdc-mint.ts` does.
pub fn create_cusdc_mint(svm: &mut LiteSVM, payer: &Keypair, opts: CusdcOptions) -> Pubkey {
    let mint = Keypair::new();
    let mut extensions = vec![ExtensionType::ConfidentialTransferMint];
    if opts.extra_extension {
        extensions.push(ExtensionType::MintCloseAuthority);
    }
    let space = ExtensionType::try_calculate_account_len::<Mint2022>(&extensions).unwrap();
    let token22 = spl_token_2022_interface::id();
    let mut ixs = vec![
        system_instruction::create_account(
            &payer.pubkey(),
            &mint.pubkey(),
            svm.minimum_balance_for_rent_exemption(space),
            space as u64,
            &token22,
        ),
        ct::initialize_mint(
            &token22,
            &mint.pubkey(),
            Some(payer.pubkey()),
            opts.auto_approve,
            None,
        )
        .unwrap(),
    ];
    if opts.extra_extension {
        ixs.push(
            spl_token_2022_interface::instruction::initialize_mint_close_authority(
                &token22,
                &mint.pubkey(),
                Some(&payer.pubkey()),
            )
            .unwrap(),
        );
    }
    ixs.push(
        spl_token_2022_interface::instruction::initialize_mint2(
            &token22,
            &mint.pubkey(),
            &opts.mint_authority,
            opts.freeze_authority.as_ref(),
            DECIMALS,
        )
        .unwrap(),
    );
    send(svm, &ixs, payer, &[&mint]).unwrap();
    mint.pubkey()
}

pub fn initialize_ix(admin: &Pubkey, usdc_mint: &Pubkey, cusdc_mint: &Pubkey) -> Instruction {
    let config = config_pda();
    let reserve = get_associated_token_address_with_program_id(
        &config,
        usdc_mint,
        &spl_token_interface::id(),
    );
    vault_ix(
        vault::instruction::VaultInstruction::Initialize,
        &[],
        vec![
            AccountMeta::new(*admin, true),
            AccountMeta::new(config, false),
            AccountMeta::new_readonly(*usdc_mint, false),
            AccountMeta::new_readonly(*cusdc_mint, false),
            AccountMeta::new(reserve, false),
            AccountMeta::new_readonly(vault::ID, false),
            AccountMeta::new_readonly(programdata(), false),
            AccountMeta::new_readonly(spl_token_interface::id(), false),
            AccountMeta::new_readonly(spl_associated_token_account_interface::program::id(), false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
    )
}

/// A fresh SVM with mints created, the vault initialized and a zero fee schedule.
pub fn setup() -> Env {
    setup_with(true)
}

pub fn setup_with(fee_schedule: bool) -> Env {
    let mut svm = LiteSVM::new();
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 100_000_000_000).unwrap();
    load_vault(&mut svm, &admin.pubkey());

    let usdc_authority = Keypair::new();
    let usdc_mint = create_usdc_mint(&mut svm, &admin, &usdc_authority.pubkey());
    let config = config_pda();
    let cusdc_mint = create_cusdc_mint(
        &mut svm,
        &admin,
        CusdcOptions {
            mint_authority: config,
            freeze_authority: None,
            auto_approve: true,
            extra_extension: false,
        },
    );
    send(&mut svm, &[initialize_ix(&admin.pubkey(), &usdc_mint, &cusdc_mint)], &admin, &[])
        .unwrap();

    let reserve = get_associated_token_address_with_program_id(
        &config,
        &usdc_mint,
        &spl_token_interface::id(),
    );

    // A treasury, and a zero fee schedule so amounts in most tests stay round.
    // Fee tests raise it with `set_fees_ix`.
    let treasury_owner = Pubkey::new_unique();
    let treasury = get_associated_token_address_with_program_id(
        &treasury_owner,
        &usdc_mint,
        &spl_token_interface::id(),
    );
    let create_treasury =
        spl_associated_token_account_interface::instruction::create_associated_token_account(
            &admin.pubkey(),
            &treasury_owner,
            &usdc_mint,
            &spl_token_interface::id(),
        );
    send(&mut svm, &[create_treasury], &admin, &[]).unwrap();
    if fee_schedule {
        let zero_fees = set_fees_ix(&admin.pubkey(), &treasury, 0, 0, None, &[]);
        send(&mut svm, &[zero_fees], &admin, &[]).unwrap();
    }

    Env {
        svm,
        admin,
        usdc_mint,
        usdc_authority,
        cusdc_mint,
        config,
        reserve,
        fees: fees_pda(),
        treasury,
    }
}

impl Env {
    pub fn send(
        &mut self,
        ixs: &[Instruction],
        payer: &Keypair,
        signers: &[&Keypair],
    ) -> Result<(), String> {
        send(&mut self.svm, ixs, payer, signers)
    }

    /// A user with SOL, `usdc` whole USDC in their wallet, and a configured
    /// confidential cUSDC account.
    pub fn user(&mut self, usdc: u64) -> User {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
        let usdc_ata = get_associated_token_address_with_program_id(
            &kp.pubkey(),
            &self.usdc_mint,
            &spl_token_interface::id(),
        );
        let ixs = [
            spl_associated_token_account_interface::instruction::create_associated_token_account(
                &kp.pubkey(),
                &kp.pubkey(),
                &self.usdc_mint,
                &spl_token_interface::id(),
            ),
            spl_token_interface::instruction::mint_to(
                &spl_token_interface::id(),
                &self.usdc_mint,
                &usdc_ata,
                &self.usdc_authority.pubkey(),
                &[],
                usdc * USDC,
            )
            .unwrap(),
        ];
        send(&mut self.svm, &ixs, &kp, &[&self.usdc_authority]).unwrap();

        let user = User {
            cusdc: get_associated_token_address_with_program_id(
                &kp.pubkey(),
                &self.cusdc_mint,
                &spl_token_2022_interface::id(),
            ),
            usdc: usdc_ata,
            kp,
            elgamal: ElGamalKeypair::new_rand(),
            ae: AeKey::new_rand(),
        };
        self.configure(&user).unwrap();
        user
    }

    /// [VerifyPubkeyValidity proof, vault.configure_confidential_account]
    pub fn configure(&mut self, user: &User) -> Result<(), String> {
        let proof = build_pubkey_validity_proof_data(&user.elgamal).unwrap();
        let proof_ix = ProofInstruction::VerifyPubkeyValidity.encode_verify_proof(None, &proof);
        let configure_ix =
            self.configure_ix(&user.kp.pubkey(), &user.cusdc, &user.ae.encrypt(0).to_bytes(), -1);
        send(&mut self.svm, &[proof_ix, configure_ix], &user.kp, &[])
    }

    pub fn configure_ix(
        &self,
        owner: &Pubkey,
        token_account: &Pubkey,
        zero_balance: &[u8; 36],
        offset: i8,
    ) -> Instruction {
        let mut args = zero_balance.to_vec();
        args.push(offset as u8);
        vault_ix(
            vault::instruction::VaultInstruction::ConfigureConfidentialAccount,
            &args,
            vec![
                AccountMeta::new(*owner, true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new_readonly(self.cusdc_mint, false),
                AccountMeta::new(*token_account, false),
                AccountMeta::new_readonly(solana_instructions_sysvar_id(), false),
                AccountMeta::new_readonly(spl_token_2022_interface::id(), false),
                AccountMeta::new_readonly(
                    spl_associated_token_account_interface::program::id(),
                    false,
                ),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
        )
    }

    pub fn deposit_ix(&self, user: &User, amount: u64) -> Instruction {
        self.deposit_ix_with(user, amount, None)
    }

    /// A deposit that presents a $VEXA account for a fee discount.
    pub fn deposit_ix_with(&self, user: &User, amount: u64, vexa: Option<Pubkey>) -> Instruction {
        let mut ix = vault_ix(
            vault::instruction::VaultInstruction::Deposit,
            &amount.to_le_bytes(),
            vec![
                AccountMeta::new_readonly(user.kp.pubkey(), true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new_readonly(self.usdc_mint, false),
                AccountMeta::new(self.cusdc_mint, false),
                AccountMeta::new(user.usdc, false),
                AccountMeta::new(self.reserve, false),
                AccountMeta::new(user.cusdc, false),
                AccountMeta::new_readonly(spl_token_interface::id(), false),
                AccountMeta::new_readonly(spl_token_2022_interface::id(), false),
                AccountMeta::new_readonly(self.fees, false),
                AccountMeta::new(self.treasury, false),
            ],
        );
        ix.accounts.extend(vexa.map(|v| AccountMeta::new_readonly(v, false)));
        ix
    }

    pub fn withdraw_ix(&self, user: &User, destination: &Pubkey, amount: u64) -> Instruction {
        vault_ix(
            vault::instruction::VaultInstruction::Withdraw,
            &amount.to_le_bytes(),
            vec![
                AccountMeta::new_readonly(user.kp.pubkey(), true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new_readonly(self.usdc_mint, false),
                AccountMeta::new(self.cusdc_mint, false),
                AccountMeta::new(user.cusdc, false),
                AccountMeta::new(self.reserve, false),
                AccountMeta::new(*destination, false),
                AccountMeta::new_readonly(spl_token_interface::id(), false),
                AccountMeta::new_readonly(spl_token_2022_interface::id(), false),
                AccountMeta::new_readonly(self.fees, false),
                AccountMeta::new(self.treasury, false),
            ],
        )
    }

    /// The client half of a deposit: apply the pending balance, which needs
    /// the owner's AE key to re-encrypt the new available balance.
    pub fn apply_pending_ix(&self, user: &User, new_available: u64, credits: u64) -> Instruction {
        let new_balance = decryptable(&user.ae.encrypt(new_available));
        ct::apply_pending_balance(
            &spl_token_2022_interface::id(),
            &user.cusdc,
            credits,
            &new_balance,
            &user.kp.pubkey(),
            &[],
        )
        .unwrap()
    }

    pub fn usdc_balance(&self, account: &Pubkey) -> u64 {
        // Token account layout: mint (32) | owner (32) | amount (8, LE) | ...
        let acc = self.svm.get_account(account).unwrap();
        u64::from_le_bytes(acc.data[64..72].try_into().unwrap())
    }

    pub fn cusdc_state(&self, user: &User) -> (u64, ConfidentialTransferAccount) {
        let acc = self.svm.get_account(&user.cusdc).unwrap();
        let state = StateWithExtensions::<Account2022>::unpack(&acc.data).unwrap();
        (state.base.amount, *state.get_extension::<ConfidentialTransferAccount>().unwrap())
    }

    pub fn cusdc_supply(&self) -> u64 {
        let acc = self.svm.get_account(&self.cusdc_mint).unwrap();
        StateWithExtensions::<Mint2022>::unpack(&acc.data).unwrap().base.supply
    }

    pub fn config_state(&self) -> ConfigView {
        let d = self.svm.get_account(&self.config).unwrap().data;
        assert_eq!(d.len(), vault::state::CONFIG_LEN);
        let key = |o: usize| Pubkey::new_from_array(d[o..o + 32].try_into().unwrap());
        ConfigView {
            admin: key(1),
            usdc_mint: key(33),
            cusdc_mint: key(65),
            usdc_reserve: key(97),
            paused: d[129] != 0,
        }
    }
}

/// Decrypts a pending balance (lo 16 bits + hi 32 bits) with the owner's secret key.
pub fn decrypt_pending(user: &User, ct: &ConfidentialTransferAccount) -> u64 {
    let lo = elgamal_ciphertext(&ct.pending_balance_lo);
    let hi = elgamal_ciphertext(&ct.pending_balance_hi);
    let lo = user.elgamal.secret().decrypt_u32(&lo).unwrap();
    let hi = user.elgamal.secret().decrypt_u32(&hi).unwrap();
    lo + (hi << 16)
}

pub fn decrypt_available(user: &User, ct: &ConfidentialTransferAccount) -> u64 {
    let ae =
        AeCiphertext::from_bytes(bytemuck::bytes_of(&ct.decryptable_available_balance)).unwrap();
    user.ae.decrypt(&ae).unwrap()
}

/// zk-sdk 7 AE ciphertext → the DecryptableBalance type Token-2022's builders take.
pub fn decryptable(ct: &AeCiphertext) -> DecryptableBalance {
    bytemuck::pod_read_unaligned(&ct.to_bytes())
}

/// Any on-chain pod ElGamal ciphertext → zk-sdk 7 ciphertext.
pub fn elgamal_ciphertext<T: bytemuck::Pod>(pod: &T) -> ElGamalCiphertext {
    ElGamalCiphertext::from_bytes(bytemuck::bytes_of(pod)).unwrap()
}

pub fn solana_instructions_sysvar_id() -> Pubkey {
    solana_instructions_sysvar::ID
}

/// The vault config, decoded from the layout documented in `vault::state`.
pub struct ConfigView {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub cusdc_mint: Pubkey,
    pub usdc_reserve: Pubkey,
    pub paused: bool,
}

/// How a vault error shows up in a failed transaction.
pub fn code(e: vault::error::VaultError) -> String {
    format!("Custom({})", e as u32)
}

// ---------------------------------------------------------------------------
// $VEXA and staking
// ---------------------------------------------------------------------------

pub fn stake_pda(owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[vault::stake::STAKE_SEED, owner.as_ref()], &vault::ID).0
}

impl Env {
    /// Creates a $VEXA mint and sets the launch fee (0.10%, 5 USDC cap) with
    /// the brief's tiers: 10/25/50/75% off at 1k/10k/100k/1M $VEXA.
    pub fn launch_vexa(&mut self) -> Pubkey {
        let admin = self.admin.insecure_clone();
        let mint = create_usdc_mint(&mut self.svm, &admin, &admin.pubkey());
        let tiers = [
            (1_000 * USDC, 1_000),
            (10_000 * USDC, 2_500),
            (100_000 * USDC, 5_000),
            (1_000_000 * USDC, 7_500),
        ];
        let ix = set_fees_ix(&admin.pubkey(), &self.treasury, 10, 5 * USDC, Some(mint), &tiers);
        self.send(&[ix], &admin, &[]).unwrap();
        mint
    }

    /// Mints `amount` $VEXA to the user's wallet; returns their $VEXA account.
    pub fn give_vexa(&mut self, mint: &Pubkey, user: &User, amount: u64) -> Pubkey {
        let admin = self.admin.insecure_clone();
        let ata = get_associated_token_address_with_program_id(
            &user.kp.pubkey(),
            mint,
            &spl_token_interface::id(),
        );
        let ixs = [
            spl_associated_token_account_interface::instruction::create_associated_token_account_idempotent(
                &admin.pubkey(),
                &user.kp.pubkey(),
                mint,
                &spl_token_interface::id(),
            ),
            spl_token_interface::instruction::mint_to(
                &spl_token_interface::id(),
                mint,
                &ata,
                &admin.pubkey(),
                &[],
                amount,
            )
            .unwrap(),
        ];
        self.send(&ixs, &admin, &[]).unwrap();
        ata
    }

    pub fn stake_vault(&self, mint: &Pubkey) -> Pubkey {
        get_associated_token_address_with_program_id(&self.config, mint, &spl_token_interface::id())
    }

    pub fn stake_ix(&self, mint: &Pubkey, user: &User, payer: &Pubkey, amount: u64) -> Instruction {
        let owner_vexa = get_associated_token_address_with_program_id(
            &user.kp.pubkey(),
            mint,
            &spl_token_interface::id(),
        );
        vault_ix(
            vault::instruction::VaultInstruction::Stake,
            &amount.to_le_bytes(),
            vec![
                AccountMeta::new_readonly(user.kp.pubkey(), true),
                AccountMeta::new(*payer, true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new_readonly(self.fees, false),
                AccountMeta::new_readonly(*mint, false),
                AccountMeta::new(owner_vexa, false),
                AccountMeta::new(self.stake_vault(mint), false),
                AccountMeta::new(stake_pda(&user.kp.pubkey()), false),
                AccountMeta::new_readonly(spl_token_interface::id(), false),
                AccountMeta::new_readonly(
                    spl_associated_token_account_interface::program::id(),
                    false,
                ),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
        )
    }

    pub fn unstake_ix(&self, mint: &Pubkey, user: &User, amount: u64) -> Instruction {
        let owner_vexa = get_associated_token_address_with_program_id(
            &user.kp.pubkey(),
            mint,
            &spl_token_interface::id(),
        );
        vault_ix(
            vault::instruction::VaultInstruction::Unstake,
            &amount.to_le_bytes(),
            vec![
                AccountMeta::new_readonly(user.kp.pubkey(), true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new_readonly(*mint, false),
                AccountMeta::new(self.stake_vault(mint), false),
                AccountMeta::new(stake_pda(&user.kp.pubkey()), false),
                AccountMeta::new(owner_vexa, false),
                AccountMeta::new_readonly(spl_token_interface::id(), false),
            ],
        )
    }

    pub fn staked(&self, owner: &Pubkey) -> u64 {
        let data = self.svm.get_account(&stake_pda(owner)).unwrap().data;
        u64::from_le_bytes(data[66..74].try_into().unwrap())
    }

    /// Moves the cluster clock forward.
    pub fn warp(&mut self, seconds: i64) {
        let mut clock = self.svm.get_sysvar::<solana_clock::Clock>();
        clock.unix_timestamp += seconds;
        clock.slot += 1;
        self.svm.set_sysvar::<solana_clock::Clock>(&clock);
    }
}
