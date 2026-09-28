//! Test harness: a LiteSVM instance with Token, Token-2022, the associated
//! token program, the ZK ElGamal proof program and the vault, all running the
//! same code as mainnet.

#![allow(dead_code)]

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{instruction::Instruction, system_instruction, system_program},
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
// Proofs and keys come from zk-sdk 7, matching mainnet's verifier. The Token-2022
// builders pinned by anchor-spl still use zk-sdk 4 "pod" types; the byte layout is
// identical, so values cross between the two through their raw bytes.
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
}

pub struct User {
    pub kp: Keypair,
    pub usdc: Pubkey,
    pub cusdc: Pubkey,
    pub elgamal: ElGamalKeypair,
    pub ae: AeKey,
}

pub fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[vault::CONFIG_SEED], &vault::id()).0
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
/// `admin`, the way it looks on mainnet after `anchor deploy`.
pub fn load_vault(svm: &mut LiteSVM, admin: &Pubkey) {
    let bytes = include_bytes!("../../../../target/deploy/vault.so");
    svm.add_program(vault::id(), bytes).unwrap();

    // Patch ProgramData metadata: enum tag (4) | slot (8) | Option<Pubkey> (1 + 32).
    let programdata = Pubkey::find_program_address(
        &[vault::id().as_ref()],
        &anchor_lang::solana_program::bpf_loader_upgradeable::id(),
    )
    .0;
    let mut account = svm.get_account(&programdata).unwrap();
    account.data[12] = 1;
    account.data[13..45].copy_from_slice(admin.as_ref());
    svm.set_account(programdata, account).unwrap();
}

pub fn programdata() -> Pubkey {
    Pubkey::find_program_address(
        &[vault::id().as_ref()],
        &anchor_lang::solana_program::bpf_loader_upgradeable::id(),
    )
    .0
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
    Instruction::new_with_bytes(
        vault::id(),
        &vault::instruction::Initialize {}.data(),
        vault::accounts::Initialize {
            admin: *admin,
            config,
            usdc_mint: *usdc_mint,
            cusdc_mint: *cusdc_mint,
            usdc_reserve: get_associated_token_address_with_program_id(
                &config,
                usdc_mint,
                &spl_token_interface::id(),
            ),
            program: vault::id(),
            program_data: programdata(),
            token_program: spl_token_interface::id(),
            associated_token_program: spl_associated_token_account_interface::program::id(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

/// A fresh SVM with mints created and the vault initialized.
pub fn setup() -> Env {
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
    Env { svm, admin, usdc_mint, usdc_authority, cusdc_mint, config, reserve }
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
        let zero = user.ae.encrypt(0).to_bytes();
        let configure_ix = Instruction::new_with_bytes(
            vault::id(),
            &vault::instruction::ConfigureConfidentialAccount {
                decryptable_zero_balance: zero,
                proof_instruction_offset: -1,
            }
            .data(),
            vault::accounts::ConfigureConfidentialAccount {
                owner: user.kp.pubkey(),
                config: self.config,
                cusdc_mint: self.cusdc_mint,
                token_account: user.cusdc,
                instructions: solana_instructions_sysvar_id(),
                token_program: spl_token_2022_interface::id(),
                associated_token_program: spl_associated_token_account_interface::program::id(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        send(&mut self.svm, &[proof_ix, configure_ix], &user.kp, &[])
    }

    pub fn deposit_ix(&self, user: &User, amount: u64) -> Instruction {
        Instruction::new_with_bytes(
            vault::id(),
            &vault::instruction::Deposit { amount }.data(),
            vault::accounts::Deposit {
                owner: user.kp.pubkey(),
                config: self.config,
                usdc_mint: self.usdc_mint,
                cusdc_mint: self.cusdc_mint,
                owner_usdc: user.usdc,
                usdc_reserve: self.reserve,
                owner_cusdc: user.cusdc,
                token_program: spl_token_interface::id(),
                token_2022_program: spl_token_2022_interface::id(),
            }
            .to_account_metas(None),
        )
    }

    pub fn withdraw_ix(&self, user: &User, destination: &Pubkey, amount: u64) -> Instruction {
        Instruction::new_with_bytes(
            vault::id(),
            &vault::instruction::Withdraw { amount }.data(),
            vault::accounts::Withdraw {
                owner: user.kp.pubkey(),
                config: self.config,
                usdc_mint: self.usdc_mint,
                cusdc_mint: self.cusdc_mint,
                owner_cusdc: user.cusdc,
                usdc_reserve: self.reserve,
                destination: *destination,
                token_program: spl_token_interface::id(),
                token_2022_program: spl_token_2022_interface::id(),
            }
            .to_account_metas(None),
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
        let acc = self.svm.get_account(account).unwrap();
        spl_token_interface::state::Account::unpack_from_slice_compat(&acc.data)
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

    pub fn config_state(&self) -> vault::VaultConfig {
        let acc = self.svm.get_account(&self.config).unwrap();
        vault::VaultConfig::try_deserialize(&mut acc.data.as_slice()).unwrap()
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

// Small shim so the tests read naturally regardless of the Pack trait's location.
trait UnpackCompat {
    fn unpack_from_slice_compat(data: &[u8]) -> u64;
}
impl UnpackCompat for spl_token_interface::state::Account {
    fn unpack_from_slice_compat(data: &[u8]) -> u64 {
        // Token account layout: mint (32) | owner (32) | amount (8, LE) | ...
        u64::from_le_bytes(data[64..72].try_into().unwrap())
    }
}
