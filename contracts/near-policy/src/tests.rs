//! Policy checks, with transactions and proof contexts built by hand. The
//! contract never verifies range proofs itself (Solana does), so the contexts
//! here only need the right commitments.

use curve25519_dalek::{
    constants::RISTRETTO_BASEPOINT_POINT as G, ristretto::RistrettoPoint, scalar::Scalar,
};
use ed25519_dalek::{Signer as _, SigningKey};
use near_sdk::{
    json_types::{Base64VecU8, U64},
    test_utils::{accounts, VMContextBuilder},
    testing_env, NearToken,
};

use crate::{solana::Pubkey, zk, Contract, Policy, Signer, Status};

const USDC: u64 = 1_000_000;
const VAULT: &str = "3g2JPX4roASUJVacf68sBSpARk5m9B3hu9xeaE6mTjPR";
const CUSDC: &str = "4STXpFN2mQSt12XG4os7ftLXHbBq5PVWYCAahToRt6QQ";
const FEE_PAYER: &str = "gH4xWApDaUrvSEJrueiSdVygEemVDuJwnwJx4z2ifDN";
const ROOT: &str = "G9hwngxWNKdmqMCmU1Yt6LPhFpayJeKFxyAV1HqMNLtF";
const AGENT: &str = "a1";

fn b58(s: &str) -> Pubkey {
    crate::solana::decode(s).unwrap()
}

struct Setup {
    contract: Contract,
    owner: SigningKey,
    authority: SigningKey,
    nonce_account: Pubkey,
    now_ms: u64,
}

fn context(now_ms: u64, deposit: NearToken) {
    testing_env!(VMContextBuilder::new()
        .current_account_id("policy.vexa.near".parse().unwrap())
        .predecessor_account_id(accounts(0))
        .block_timestamp(now_ms * 1_000_000)
        .attached_deposit(deposit)
        .build());
}

fn policy(max: u64, daily: u64, recipients: &[Pubkey]) -> Policy {
    Policy {
        max_per_request: U64(max),
        daily_limit: U64(daily),
        allowed_recipients: recipients.iter().map(crate::solana::encode).collect(),
        allowed_domains: vec![],
    }
}

fn sign(
    contract: &Contract,
    key: &SigningKey,
    action: &str,
    nonce: u64,
    payload: &[u8],
) -> Base64VecU8 {
    let message = contract.auth_message(action, AGENT, nonce, payload);
    Base64VecU8(key.sign(&message).to_bytes().to_vec())
}

fn setup(policy: Policy) -> Setup {
    let now_ms = 1_800_000_000_000;
    context(now_ms, NearToken::from_near(1));
    let mut contract = Contract::new(
        accounts(0),
        "v1.signer".parse().unwrap(),
        format!("ed25519:{ROOT}"),
        VAULT.into(),
        CUSDC.into(),
        FEE_PAYER.into(),
    );
    let owner = SigningKey::generate(&mut rand_core::OsRng);
    let authority = SigningKey::generate(&mut rand_core::OsRng);
    let nonce_account = [9u8; 32];
    let mut payload = near_sdk::borsh::to_vec(&policy).unwrap();
    payload.extend_from_slice(authority.verifying_key().as_bytes());
    payload.extend_from_slice(&nonce_account);
    let signature = sign(&contract, &owner, "create", 0, &payload);
    contract.create_policy(
        AGENT.into(),
        crate::solana::encode(owner.verifying_key().as_bytes()),
        crate::solana::encode(authority.verifying_key().as_bytes()),
        crate::solana::encode(&nonce_account),
        policy,
        signature,
    );
    Setup { contract, owner, authority, nonce_account, now_ms }
}

/// A legacy message: signers first, then everything else, deduplicated.
fn message(signers: &[Pubkey], ixs: &[(Pubkey, Vec<Pubkey>, Vec<u8>)]) -> Vec<u8> {
    let mut keys: Vec<Pubkey> = signers.to_vec();
    for (program, accounts, _) in ixs {
        for k in accounts.iter().chain(std::iter::once(program)) {
            if !keys.contains(k) {
                keys.push(*k);
            }
        }
    }
    let index = |k: &Pubkey| keys.iter().position(|x| x == k).unwrap() as u8;
    let mut out = vec![signers.len() as u8, 0, 0, keys.len() as u8];
    for k in &keys {
        out.extend_from_slice(k);
    }
    out.extend_from_slice(&[7; 32]);
    out.push(ixs.len() as u8);
    for (program, accounts, data) in ixs {
        out.push(index(program));
        out.push(accounts.len() as u8);
        out.extend(accounts.iter().map(index));
        out.push(data.len() as u8);
        out.extend_from_slice(data);
    }
    out
}

struct Payment {
    message: Vec<u8>,
    validity: Vec<u8>,
    limit: Vec<u8>,
    commitment: RistrettoPoint,
}

/// A payment of `amount` to `destination`, with a limit proof over `spent`
/// (the window it claims) and the policy's limits.
fn payment(
    s: &Setup,
    destination: Pubkey,
    amount: u64,
    spent: &[RistrettoPoint],
    max: u64,
    daily: u64,
) -> Payment {
    payment_with(s, destination, amount, spent, max, daily, vec![])
}

type Ix = (Pubkey, Vec<Pubkey>, Vec<u8>);

#[allow(clippy::too_many_arguments)]
fn payment_with(
    s: &Setup,
    destination: Pubkey,
    amount: u64,
    spent: &[RistrettoPoint],
    max: u64,
    daily: u64,
    extra: Vec<Ix>,
) -> Payment {
    let agent = s.contract.agents.get(AGENT).unwrap().clone();
    // Commitments with random openings, shaped like Token-2022's lo/hi split.
    let h = G * Scalar::from(987_654_321u64);
    let (r_lo, r_hi) = (Scalar::from(11u64), Scalar::from(13u64));
    let c_lo = G * Scalar::from(amount & 0xffff) + h * r_lo;
    let c_hi = G * Scalar::from(amount >> 16) + h * r_hi;
    let commitment = c_lo + c_hi * Scalar::from(1u64 << 16);

    let mut validity = vec![zk::PROOF_TYPE_VALIDITY_3_HANDLES_BATCHED];
    validity.extend_from_slice(&[1; 96]);
    for c in [c_lo, c_hi] {
        validity.extend_from_slice(c.compress().as_bytes());
        validity.extend_from_slice(&[2; 96]);
    }
    let mut all: Vec<RistrettoPoint> = spent.to_vec();
    all.push(commitment);
    let mut limit = vec![zk::PROOF_TYPE_RANGE_U128];
    limit.extend_from_slice(&zk::remaining(max, &[commitment]));
    limit.extend_from_slice(&zk::remaining(daily, &all));
    limit.extend_from_slice(&[0; 192]);
    limit.extend_from_slice(&[64, 64, 0, 0, 0, 0, 0, 0]);

    let (validity_ctx, limit_ctx, eq, range) = ([21; 32], [22; 32], [23; 32], [24; 32]);
    let mut require = vec![9u8];
    require.extend_from_slice(&near_sdk::env::sha256_array(&validity));
    require.extend_from_slice(&near_sdk::env::sha256_array(&limit));
    let mut transfer = vec![27u8, 7];
    transfer.extend_from_slice(&[0; 36]);
    transfer.extend_from_slice(&[0, 0, 0]);
    let fee_payer = b58(FEE_PAYER);
    let mut ixs = vec![
        (
            crate::solana::SYSTEM_PROGRAM,
            vec![s.nonce_account, crate::solana::RECENT_BLOCKHASHES_SYSVAR, agent.address],
            vec![4, 0, 0, 0],
        ),
        (b58(VAULT), vec![validity_ctx, limit_ctx], require),
        (
            crate::solana::TOKEN_2022_PROGRAM,
            vec![agent.cusdc, b58(CUSDC), destination, eq, validity_ctx, range, agent.address],
            transfer,
        ),
        (crate::solana::ZK_ELGAMAL_PROOF_PROGRAM, vec![eq, fee_payer, fee_payer], vec![0]),
    ];
    ixs.extend(extra);
    let message = message(&[fee_payer, agent.address], &ixs);
    Payment { message, validity, limit, commitment }
}

fn request(s: &mut Setup, p: &Payment, index: u64, window_start: u64) {
    context(s.now_ms, NearToken::from_millinear(1));
    let nonce = s.contract.agents.get(AGENT).unwrap().auth_nonce;
    let mut payload = p.message.clone();
    payload.extend_from_slice(&index.to_le_bytes());
    payload.extend_from_slice(&window_start.to_le_bytes());
    let signature = sign(&s.contract, &s.authority, "sign", nonce, &payload);
    let _ = s.contract.request_signature(
        AGENT.into(),
        Base64VecU8(p.message.clone()),
        Some(Base64VecU8(p.validity.clone())),
        Some(Base64VecU8(p.limit.clone())),
        Some(U64(index)),
        Some(U64(window_start)),
        None,
        Signer::Agent,
        U64(nonce),
        signature,
    );
}

fn shop() -> Pubkey {
    [42; 32]
}

#[test]
fn registers_an_agent_at_its_mpc_derived_address() {
    let s = setup(policy(10 * USDC, 50 * USDC, &[]));
    let agent = s.contract.get_agent(AGENT.into()).unwrap();
    assert_eq!(agent.address, s.contract.agent_address(AGENT.into()));
    assert_eq!(agent.status, Status::Active);
    assert_eq!(agent.next_index.0, 0);
}

#[test]
#[should_panic(expected = "BAD_SIGNATURE")]
fn only_the_owner_can_register_a_policy() {
    let s = setup(policy(10 * USDC, 50 * USDC, &[]));
    let mut contract = s.contract;
    let stranger = SigningKey::generate(&mut rand_core::OsRng);
    let p = policy(10 * USDC, 50 * USDC, &[]);
    let mut payload = near_sdk::borsh::to_vec(&p).unwrap();
    payload.extend_from_slice(s.authority.verifying_key().as_bytes());
    payload.extend_from_slice(&s.nonce_account);
    let signature = sign(&contract, &stranger, "create", 0, &payload);
    contract.create_policy(
        "a2".into(),
        crate::solana::encode(s.owner.verifying_key().as_bytes()),
        crate::solana::encode(s.authority.verifying_key().as_bytes()),
        crate::solana::encode(&s.nonce_account),
        p,
        signature,
    );
}

#[test]
fn signs_payments_within_the_limits_and_tracks_the_window() {
    let (max, daily) = (10 * USDC, 25 * USDC);
    let mut s = setup(policy(max, daily, &[]));
    let first = payment(&s, shop(), 9 * USDC, &[], max, daily);
    request(&mut s, &first, 0, 0);
    let second = payment(&s, shop(), 9 * USDC, &[first.commitment], max, daily);
    request(&mut s, &second, 1, 0);
    let agent = s.contract.agents.get(AGENT).unwrap();
    assert_eq!(agent.next_index, 2);
    assert_eq!(agent.window.len(), 2);
}

#[test]
#[should_panic(expected = "LIMIT_PROOF_MISMATCH")]
fn a_limit_proof_must_cover_this_payment() {
    let (max, daily) = (10 * USDC, 25 * USDC);
    let mut s = setup(policy(max, daily, &[]));
    // Proof built against a looser per-payment limit than the policy's.
    let p = payment(&s, shop(), 20 * USDC, &[], 20 * USDC, daily);
    request(&mut s, &p, 0, 0);
}

#[test]
#[should_panic(expected = "LIMIT_PROOF_MISMATCH")]
fn a_limit_proof_cant_leave_out_recent_payments() {
    let (max, daily) = (10 * USDC, 25 * USDC);
    let mut s = setup(policy(max, daily, &[]));
    let first = payment(&s, shop(), 9 * USDC, &[], max, daily);
    request(&mut s, &first, 0, 0);
    // Claims an empty window, as if the first payment never happened.
    let second = payment(&s, shop(), 9 * USDC, &[], max, daily);
    request(&mut s, &second, 1, 1);
}

#[test]
fn payments_age_out_of_the_window_after_24_hours() {
    let (max, daily) = (10 * USDC, 25 * USDC);
    let mut s = setup(policy(max, daily, &[]));
    let first = payment(&s, shop(), 9 * USDC, &[], max, daily);
    request(&mut s, &first, 0, 0);
    s.now_ms += 24 * 60 * 60 * 1000;
    let second = payment(&s, shop(), 9 * USDC, &[], max, daily);
    request(&mut s, &second, 1, 1);
    assert_eq!(s.contract.agents.get(AGENT).unwrap().window.len(), 1);
}

#[test]
#[should_panic(expected = "STALE_INDEX")]
fn payment_indexes_are_never_reused() {
    let (max, daily) = (10 * USDC, 25 * USDC);
    let mut s = setup(policy(max, daily, &[]));
    let first = payment(&s, shop(), USDC, &[], max, daily);
    request(&mut s, &first, 0, 0);
    let again = payment(&s, shop(), USDC, &[first.commitment], max, daily);
    request(&mut s, &again, 0, 0);
}

#[test]
#[should_panic(expected = "RECIPIENT_NOT_ALLOWED")]
fn only_allowed_recipients_can_be_paid() {
    let (max, daily) = (10 * USDC, 25 * USDC);
    let mut s = setup(policy(max, daily, &[shop()]));
    let p = payment(&s, [43; 32], USDC, &[], max, daily);
    request(&mut s, &p, 0, 0);
}

#[test]
#[should_panic(expected = "AGENT_PAUSED")]
fn a_paused_agent_cant_pay() {
    let (max, daily) = (10 * USDC, 25 * USDC);
    let mut s = setup(policy(max, daily, &[]));
    let nonce = s.contract.agents.get(AGENT).unwrap().auth_nonce;
    let signature = sign(&s.contract, &s.owner, "set_paused", nonce, &[1]);
    s.contract.set_paused(AGENT.into(), true, U64(nonce), signature);
    let p = payment(&s, shop(), USDC, &[], max, daily);
    request(&mut s, &p, 0, 0);
}

#[test]
#[should_panic(expected = "BAD_SIGNATURE")]
fn the_agent_cant_change_its_own_policy() {
    let mut s = setup(policy(10 * USDC, 25 * USDC, &[]));
    let looser = policy(1_000 * USDC, 1_000 * USDC, &[]);
    let nonce = s.contract.agents.get(AGENT).unwrap().auth_nonce;
    let payload = near_sdk::borsh::to_vec(&looser).unwrap();
    let signature = sign(&s.contract, &s.authority, "update_policy", nonce, &payload);
    s.contract.update_policy(AGENT.into(), looser, U64(nonce), signature);
}

#[test]
#[should_panic(expected = "BAD_TRANSACTION")]
fn nothing_else_rides_along_with_a_payment() {
    let (max, daily) = (10 * USDC, 25 * USDC);
    let mut s = setup(policy(max, daily, &[]));
    // A second instruction after the approved transfer, moving the agent's funds.
    let agent = s.contract.agents.get(AGENT).unwrap().clone();
    let mut drain = vec![27u8, 7];
    drain.extend_from_slice(&[0; 39]);
    let p = payment_with(
        &s,
        shop(),
        USDC,
        &[],
        max,
        daily,
        vec![(
            crate::solana::TOKEN_2022_PROGRAM,
            vec![agent.cusdc, b58(CUSDC), [66; 32], [1; 32], [2; 32], [3; 32], agent.address],
            drain,
        )],
    );
    request(&mut s, &p, 0, 0);
}

#[test]
fn a_revoked_agent_can_still_return_funds_to_its_owner() {
    let (max, daily) = (10 * USDC, 25 * USDC);
    let mut s = setup(policy(max, daily, &[]));
    let nonce = s.contract.agents.get(AGENT).unwrap().auth_nonce;
    let signature = sign(&s.contract, &s.owner, "revoke_policy", nonce, &[]);
    s.contract.revoke_policy(AGENT.into(), U64(nonce), signature);

    let agent = s.contract.agents.get(AGENT).unwrap().clone();
    let mut transfer = vec![27u8, 7];
    transfer.extend_from_slice(&[0; 39]);
    let sweep = message(
        &[b58(FEE_PAYER), agent.address],
        &[
            (
                crate::solana::SYSTEM_PROGRAM,
                vec![s.nonce_account, crate::solana::RECENT_BLOCKHASHES_SYSVAR, agent.address],
                vec![4, 0, 0, 0],
            ),
            (
                crate::solana::TOKEN_2022_PROGRAM,
                vec![
                    agent.cusdc,
                    b58(CUSDC),
                    agent.owner_cusdc,
                    [1; 32],
                    [2; 32],
                    [3; 32],
                    agent.address,
                ],
                transfer,
            ),
        ],
    );
    context(s.now_ms, NearToken::from_millinear(1));
    let nonce = agent.auth_nonce;
    let mut payload = sweep.clone();
    payload.extend_from_slice(&u64::MAX.to_le_bytes());
    payload.extend_from_slice(&u64::MAX.to_le_bytes());
    let signature = sign(&s.contract, &s.owner, "sign", nonce, &payload);
    let _ = s.contract.request_signature(
        AGENT.into(),
        Base64VecU8(sweep),
        None,
        None,
        None,
        None,
        None,
        Signer::Owner,
        U64(nonce),
        signature,
    );
    assert_eq!(s.contract.agents.get(AGENT).unwrap().next_index, 0);
}
