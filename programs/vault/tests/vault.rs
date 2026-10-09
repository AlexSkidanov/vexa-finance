mod common;

use common::*;
use litesvm::LiteSVM;
use proof_generation::withdraw::withdraw_proof_data;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use spl_associated_token_account_interface::address::get_associated_token_address_with_program_id;
use spl_token_2022_interface::extension::confidential_transfer::instruction::{
    self as ct, BatchedRangeProofU64Data, CiphertextCommitmentEqualityProofData,
    PubkeyValidityProofData,
};
use spl_token_confidential_transfer_proof_extraction::instruction::ProofLocation;
use std::num::NonZeroI8;
use vault::{error::VaultError, instruction::VaultInstruction, token};
use zk_proof_interface::instruction::ProofInstruction;

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

fn fresh() -> (LiteSVM, Keypair, Pubkey) {
    let mut svm = LiteSVM::new();
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 100_000_000_000).unwrap();
    load_vault(&mut svm, &admin.pubkey());
    let usdc = create_usdc_mint(&mut svm, &admin, &admin.pubkey());
    (svm, admin, usdc)
}

fn good_cusdc() -> CusdcOptions {
    CusdcOptions {
        mint_authority: config_pda(),
        freeze_authority: None,
        auto_approve: true,
        extra_extension: false,
    }
}

#[test]
fn initialize_records_mints_and_creates_reserve() {
    let env = setup();
    let config = env.config_state();
    assert_eq!(config.admin, env.admin.pubkey());
    assert_eq!(config.usdc_mint, env.usdc_mint);
    assert_eq!(config.cusdc_mint, env.cusdc_mint);
    assert_eq!(config.usdc_reserve, env.reserve);
    assert!(!config.paused);
    assert_eq!(env.usdc_balance(&env.reserve), 0);
}

#[test]
fn initialize_is_reserved_for_the_upgrade_authority() {
    let (mut svm, admin, usdc) = fresh();
    let cusdc = create_cusdc_mint(&mut svm, &admin, good_cusdc());
    let attacker = Keypair::new();
    svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();

    let err = send(&mut svm, &[initialize_ix(&attacker.pubkey(), &usdc, &cusdc)], &attacker, &[])
        .unwrap_err();
    assert!(err.contains(&code(VaultError::NotUpgradeAuthority)), "{err}");

    send(&mut svm, &[initialize_ix(&admin.pubkey(), &usdc, &cusdc)], &admin, &[]).unwrap();
    // And only once.
    let err =
        send(&mut svm, &[initialize_ix(&admin.pubkey(), &usdc, &cusdc)], &admin, &[]).unwrap_err();
    assert!(err.contains(&code(VaultError::AlreadyInitialized)), "{err}");
}

#[test]
fn initialize_survives_lamports_sent_to_the_config_address_first() {
    // Sending lamports to a PDA before it's created makes a plain CreateAccount
    // fail, which would block initialization forever. The vault tops up,
    // allocates and assigns instead.
    let (mut svm, admin, usdc) = fresh();
    let cusdc = create_cusdc_mint(&mut svm, &admin, good_cusdc());
    // The cheapest way to do it: the rent-exempt minimum for an empty account.
    let griefing_lamports = svm.minimum_balance_for_rent_exemption(0);
    svm.airdrop(&config_pda(), griefing_lamports).unwrap();
    send(&mut svm, &[initialize_ix(&admin.pubkey(), &usdc, &cusdc)], &admin, &[]).unwrap();
    let config = svm.get_account(&config_pda()).unwrap();
    assert_eq!(config.owner, vault::ID);
    assert_eq!(config.data.len(), vault::state::CONFIG_LEN);
}

/// (expected error, how to build the bad mint)
type MintCase = (VaultError, fn(Pubkey) -> CusdcOptions);

#[test]
fn initialize_rejects_unsafe_cusdc_mints() {
    let cases: [MintCase; 4] = [
        (VaultError::WrongMintAuthority, |admin| CusdcOptions {
            mint_authority: admin,
            ..good_cusdc()
        }),
        (VaultError::FreezeAuthoritySet, |admin| CusdcOptions {
            freeze_authority: Some(admin),
            ..good_cusdc()
        }),
        (VaultError::AutoApproveDisabled, |_| CusdcOptions { auto_approve: false, ..good_cusdc() }),
        (VaultError::UnexpectedExtension, |_| CusdcOptions {
            extra_extension: true,
            ..good_cusdc()
        }),
    ];
    for (expected, opts) in cases {
        let (mut svm, admin, usdc) = fresh();
        let cusdc = create_cusdc_mint(&mut svm, &admin, opts(admin.pubkey()));
        let err = send(&mut svm, &[initialize_ix(&admin.pubkey(), &usdc, &cusdc)], &admin, &[])
            .unwrap_err();
        assert!(err.contains(&code(expected)), "expected {expected:?}, got:\n{err}");
    }
}

// ---------------------------------------------------------------------------
// configure_confidential_account
// ---------------------------------------------------------------------------

#[test]
fn configure_binds_the_users_elgamal_key_and_is_idempotent() {
    let mut env = setup();
    let alice = env.user(0);
    let (public, ct_state) = env.cusdc_state(&alice);
    assert_eq!(public, 0);
    assert_eq!(bytemuck::bytes_of(&ct_state.elgamal_pubkey), alice.elgamal.pubkey().to_bytes());
    assert!(bool::from(ct_state.approved));
    assert_eq!(decrypt_available(&alice, &ct_state), 0);

    // A retry after success is a no-op, not an error.
    env.configure(&alice).unwrap();
}

#[test]
fn configure_requires_a_pubkey_validity_proof() {
    let mut env = setup();
    let bob = Keypair::new();
    env.svm.airdrop(&bob.pubkey(), 1_000_000_000).unwrap();
    let zero = zk_sdk::encryption::auth_encryption::AeKey::new_rand().encrypt(0).to_bytes();
    let token_account = get_associated_token_address_with_program_id(
        &bob.pubkey(),
        &env.cusdc_mint,
        &spl_token_2022_interface::id(),
    );

    // The offset says "the proof is the previous instruction", but there is none.
    let ix = env.configure_ix(&bob.pubkey(), &token_account, &zero, -1);
    assert!(env.send(&[ix], &bob, &[]).is_err());

    // Offset zero would mean "look in a context account", which the vault doesn't use.
    let ix = env.configure_ix(&bob.pubkey(), &token_account, &zero, 0);
    let err = env.send(&[ix], &bob, &[]).unwrap_err();
    assert!(err.contains(&code(VaultError::InvalidProofOffset)), "{err}");
}

// ---------------------------------------------------------------------------
// deposit
// ---------------------------------------------------------------------------

#[test]
fn deposit_moves_usdc_in_and_lands_cusdc_in_the_pending_confidential_balance() {
    let mut env = setup();
    let alice = env.user(100);

    let ix = env.deposit_ix(&alice, 25 * USDC);
    env.send(&[ix], &alice.kp, &[]).unwrap();

    assert_eq!(env.usdc_balance(&alice.usdc), 75 * USDC);
    assert_eq!(env.usdc_balance(&env.reserve), 25 * USDC);
    assert_eq!(env.cusdc_supply(), 25 * USDC);

    let (public, state) = env.cusdc_state(&alice);
    assert_eq!(public, 0, "cUSDC must not linger in the public balance");
    assert_eq!(decrypt_pending(&alice, &state), 25 * USDC);
    assert_eq!(u64::from(state.pending_balance_credit_counter), 1);

    // The client applies the pending balance with its AE key.
    let apply = env.apply_pending_ix(&alice, 25 * USDC, 1);
    env.send(&[apply], &alice.kp, &[]).unwrap();
    let (_, state) = env.cusdc_state(&alice);
    assert_eq!(decrypt_available(&alice, &state), 25 * USDC);
    assert_eq!(decrypt_pending(&alice, &state), 0);
}

#[test]
fn deposit_and_apply_fit_in_one_transaction() {
    let mut env = setup();
    let alice = env.user(10);
    let ixs = [env.deposit_ix(&alice, 10 * USDC), env.apply_pending_ix(&alice, 10 * USDC, 1)];
    env.send(&ixs, &alice.kp, &[]).unwrap();
    let (_, state) = env.cusdc_state(&alice);
    assert_eq!(decrypt_available(&alice, &state), 10 * USDC);
}

#[test]
fn deposit_rejects_zero_and_someone_elses_usdc() {
    let mut env = setup();
    let alice = env.user(10);
    let bob = env.user(10);

    let err = env.send(&[env.deposit_ix(&alice, 0)], &alice.kp, &[]).unwrap_err();
    assert!(err.contains(&code(VaultError::ZeroAmount)), "{err}");

    // Alice tries to deposit Bob's USDC into her own cUSDC account.
    let mut ix = env.deposit_ix(&alice, USDC);
    let owner_usdc_index = 4;
    ix.accounts[owner_usdc_index].pubkey = bob.usdc;
    let err = env.send(&[ix], &alice.kp, &[]).unwrap_err();
    assert!(err.contains(&code(VaultError::TokenOwnerMismatch)), "{err}");
}

#[test]
fn deposit_rejects_a_reserve_other_than_the_vaults() {
    let mut env = setup();
    let alice = env.user(10);
    let bob = env.user(0);
    let mut ix = env.deposit_ix(&alice, USDC);
    let reserve_index = 5;
    ix.accounts[reserve_index].pubkey = bob.usdc;
    let err = env.send(&[ix], &alice.kp, &[]).unwrap_err();
    assert!(err.contains(&code(VaultError::ConfigMismatch)), "{err}");
}

// ---------------------------------------------------------------------------
// withdraw
// ---------------------------------------------------------------------------

/// [CT withdraw, equality proof, range proof, vault.withdraw]
///
/// Proofs are generated with zk-sdk 7 and encoded as sibling instructions the
/// CT withdraw points at (+1 and +2). The Token-2022 builder only needs to know
/// where they are, so it gets zeroed placeholders.
fn withdraw_ixs(
    env: &Env,
    user: &User,
    destination: &Pubkey,
    amount: u64,
    balance_before: u64,
) -> Vec<Instruction> {
    let (_, state) = env.cusdc_state(user);
    let available = elgamal_ciphertext(&state.available_balance);
    let proofs = withdraw_proof_data(&available, balance_before, amount, &user.elgamal).unwrap();

    let equality_placeholder: CiphertextCommitmentEqualityProofData = bytemuck::Zeroable::zeroed();
    let range_placeholder: BatchedRangeProofU64Data = bytemuck::Zeroable::zeroed();
    let withdraw = ct::inner_withdraw(
        &spl_token_2022_interface::id(),
        &user.cusdc,
        &env.cusdc_mint,
        amount,
        DECIMALS,
        &decryptable(&user.ae.encrypt(balance_before - amount)),
        &user.kp.pubkey(),
        &[],
        ProofLocation::InstructionOffset(NonZeroI8::new(1).unwrap(), &equality_placeholder),
        ProofLocation::InstructionOffset(NonZeroI8::new(2).unwrap(), &range_placeholder),
    )
    .unwrap();

    vec![
        withdraw,
        ProofInstruction::VerifyCiphertextCommitmentEquality
            .encode_verify_proof(None, &proofs.equality_proof_data),
        ProofInstruction::VerifyBatchedRangeProofU64
            .encode_verify_proof(None, &proofs.range_proof_data),
        env.withdraw_ix(user, destination, amount),
    ]
}

#[test]
fn withdraw_burns_cusdc_and_releases_usdc_to_any_account() {
    let mut env = setup();
    let alice = env.user(50);
    let ixs = [env.deposit_ix(&alice, 50 * USDC), env.apply_pending_ix(&alice, 50 * USDC, 1)];
    env.send(&ixs, &alice.kp, &[]).unwrap();

    // Withdraw to Carol, who never touched Vexa.
    let carol = Keypair::new();
    let carol_usdc = get_associated_token_address_with_program_id(
        &carol.pubkey(),
        &env.usdc_mint,
        &spl_token_interface::id(),
    );
    let create =
        spl_associated_token_account_interface::instruction::create_associated_token_account(
            &alice.kp.pubkey(),
            &carol.pubkey(),
            &env.usdc_mint,
            &spl_token_interface::id(),
        );
    env.send(&[create], &alice.kp, &[]).unwrap();

    let ixs = withdraw_ixs(&env, &alice, &carol_usdc, 20 * USDC, 50 * USDC);
    env.send(&ixs, &alice.kp, &[]).unwrap();

    assert_eq!(env.usdc_balance(&carol_usdc), 20 * USDC);
    assert_eq!(env.usdc_balance(&env.reserve), 30 * USDC);
    assert_eq!(env.cusdc_supply(), 30 * USDC);
    let (public, state) = env.cusdc_state(&alice);
    assert_eq!(public, 0);
    assert_eq!(decrypt_available(&alice, &state), 30 * USDC);
}

#[test]
fn withdraw_without_a_confidential_withdraw_first_moves_nothing() {
    let mut env = setup();
    let alice = env.user(10);
    let ixs = [env.deposit_ix(&alice, 10 * USDC), env.apply_pending_ix(&alice, 10 * USDC, 1)];
    env.send(&ixs, &alice.kp, &[]).unwrap();

    // The confidential balance can't be burned directly; the public balance is empty.
    let err = env.send(&[env.withdraw_ix(&alice, &alice.usdc, USDC)], &alice.kp, &[]).unwrap_err();
    assert!(err.contains("insufficient funds") || err.contains("InsufficientFunds"), "{err}");
    assert_eq!(env.usdc_balance(&env.reserve), 10 * USDC);
}

#[test]
fn nobody_can_withdraw_from_someone_elses_cusdc_account() {
    let mut env = setup();
    let alice = env.user(10);
    let mallory = env.user(0);
    let ixs = [env.deposit_ix(&alice, 10 * USDC)];
    env.send(&ixs, &alice.kp, &[]).unwrap();

    let mut ix = env.withdraw_ix(&mallory, &mallory.usdc, USDC);
    let owner_cusdc_index = 4;
    ix.accounts[owner_cusdc_index].pubkey = alice.cusdc;
    let err = env.send(&[ix], &mallory.kp, &[]).unwrap_err();
    assert!(err.contains(&code(VaultError::TokenOwnerMismatch)), "{err}");
}

// ---------------------------------------------------------------------------
// admin
// ---------------------------------------------------------------------------

fn set_paused_ix(admin: &Pubkey, paused: bool) -> Instruction {
    vault_ix(
        VaultInstruction::SetPaused,
        &[paused as u8],
        vec![AccountMeta::new_readonly(*admin, true), AccountMeta::new(config_pda(), false)],
    )
}

fn set_admin_ix(admin: &Pubkey, new_admin: &Pubkey) -> Instruction {
    vault_ix(
        VaultInstruction::SetAdmin,
        &[],
        vec![
            AccountMeta::new_readonly(*admin, true),
            AccountMeta::new_readonly(*new_admin, true),
            AccountMeta::new(config_pda(), false),
        ],
    )
}

#[test]
fn pausing_blocks_deposits_and_only_the_admin_can_pause() {
    let mut env = setup();
    let alice = env.user(10);

    let err = env.send(&[set_paused_ix(&alice.kp.pubkey(), true)], &alice.kp, &[]).unwrap_err();
    assert!(err.contains(&code(VaultError::NotAdmin)), "{err}");

    let admin = env.admin.insecure_clone();
    env.send(&[set_paused_ix(&admin.pubkey(), true)], &admin, &[]).unwrap();
    assert!(env.config_state().paused);
    let err = env.send(&[env.deposit_ix(&alice, USDC)], &alice.kp, &[]).unwrap_err();
    assert!(err.contains(&code(VaultError::Paused)), "{err}");

    env.send(&[set_paused_ix(&admin.pubkey(), false)], &admin, &[]).unwrap();
    env.send(&[env.deposit_ix(&alice, USDC)], &alice.kp, &[]).unwrap();
}

#[test]
fn handing_over_admin_needs_both_keys() {
    let mut env = setup();
    let admin = env.admin.insecure_clone();
    let next = Keypair::new();

    // Without the new admin's signature the instruction is rejected.
    let mut unsigned = set_admin_ix(&admin.pubkey(), &next.pubkey());
    unsigned.accounts[1].is_signer = false;
    assert!(env.send(&[unsigned], &admin, &[]).is_err());

    env.send(&[set_admin_ix(&admin.pubkey(), &next.pubkey())], &admin, &[&next]).unwrap();
    assert_eq!(env.config_state().admin, next.pubkey());

    // The old admin is out.
    let err = env.send(&[set_paused_ix(&admin.pubkey(), true)], &admin, &[]).unwrap_err();
    assert!(err.contains(&code(VaultError::NotAdmin)), "{err}");
}

#[test]
fn unknown_instructions_are_rejected() {
    let mut env = setup();
    let admin = env.admin.insecure_clone();
    let ix = Instruction { program_id: vault::ID, accounts: vec![], data: vec![42] };
    let err = env.send(&[ix], &admin, &[]).unwrap_err();
    assert!(err.contains("InvalidInstructionData"), "{err}");
}

// ---------------------------------------------------------------------------
// invariant
// ---------------------------------------------------------------------------

#[test]
fn reserve_always_covers_cusdc_supply() {
    let mut env = setup();
    let users: Vec<User> = (0..3).map(|_| env.user(100)).collect();
    let amounts = [13, 7, 42];
    for (u, a) in users.iter().zip(amounts) {
        let ixs = [env.deposit_ix(u, a * USDC), env.apply_pending_ix(u, a * USDC, 1)];
        env.send(&ixs, &u.kp, &[]).unwrap();
        assert!(env.usdc_balance(&env.reserve) >= env.cusdc_supply());
    }
    let ixs = withdraw_ixs(&env, &users[2], &users[2].usdc, 40 * USDC, 42 * USDC);
    env.send(&ixs, &users[2].kp, &[]).unwrap();
    assert_eq!(env.usdc_balance(&env.reserve), env.cusdc_supply());
    assert_eq!(env.cusdc_supply(), 22 * USDC);
}

// ---------------------------------------------------------------------------
// wire format
// ---------------------------------------------------------------------------

/// The vault encodes Token-2022 instructions by hand to stay small. These must
/// stay byte-identical to the official builders.
#[test]
fn hand_encoded_token_instructions_match_the_spl_builders() {
    let t22 = spl_token_2022_interface::id();
    let (a, b, c) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
    let amount = 123_456_789u64;

    let spl = spl_token_interface::instruction::transfer_checked(
        &spl_token_interface::id(),
        &a,
        &b,
        &c,
        &a,
        &[],
        amount,
        DECIMALS,
    )
    .unwrap();
    assert_eq!(spl.data, token::transfer_checked_data(amount, DECIMALS));

    let spl = spl_token_2022_interface::instruction::mint_to_checked(
        &t22,
        &a,
        &b,
        &c,
        &[],
        amount,
        DECIMALS,
    )
    .unwrap();
    assert_eq!(spl.data, token::mint_to_checked_data(amount, DECIMALS));

    let spl = spl_token_2022_interface::instruction::burn_checked(
        &t22,
        &a,
        &b,
        &c,
        &[],
        amount,
        DECIMALS,
    )
    .unwrap();
    assert_eq!(spl.data, token::burn_checked_data(amount, DECIMALS));

    let spl = ct::deposit(&t22, &a, &b, amount, DECIMALS, &c, &[]).unwrap();
    assert_eq!(spl.data, token::ct_deposit_data(amount, DECIMALS));

    let spl = spl_token_2022_interface::instruction::reallocate(
        &t22,
        &a,
        &b,
        &c,
        &[],
        &[spl_token_2022_interface::extension::ExtensionType::ConfidentialTransferAccount],
    )
    .unwrap();
    assert_eq!(spl.data, token::reallocate_data(token::EXT_CONFIDENTIAL_TRANSFER_ACCOUNT));

    let zero = [7u8; 36];
    let placeholder: PubkeyValidityProofData = bytemuck::Zeroable::zeroed();
    let spl = ct::inner_configure_account(
        &t22,
        &a,
        &b,
        &bytemuck::pod_read_unaligned(&zero),
        65_536,
        &c,
        &[],
        ProofLocation::InstructionOffset(NonZeroI8::new(-1).unwrap(), &placeholder),
    )
    .unwrap();
    assert_eq!(spl.data, token::ct_configure_account_data(&zero, 65_536, -1));
    // Same accounts, same order, same flags as the vault's CPI.
    let metas: Vec<(bool, bool)> =
        spl.accounts.iter().map(|m| (m.is_writable, m.is_signer)).collect();
    assert_eq!(metas, [(true, false), (false, false), (false, false), (false, true)]);
}
