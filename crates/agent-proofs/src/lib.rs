//! # Agent proofs
//!
//! A Vexa agent pays by confidential transfer, and its spend limits are
//! checked on NEAR against the transfer's hidden amount (see
//! `contracts/near-policy/src/zk.rs`). That needs two things the standard
//! proof generation (`spl-token-confidential-transfer-proof-generation`)
//! doesn't give:
//!
//! - **Known openings.** The daily limit is proven over the sum of the last
//!   24 hours of payments, which needs those payments' Pedersen openings.
//!   Here they're derived from the agent's secret seed and the payment index,
//!   so nothing has to be stored: the agent can always recompute them.
//! - **The limit proof itself**: a U128 range proof that
//!   `max_per_request − amount` and `daily_limit − (spent + amount)` are both
//!   non-negative 64-bit values.
//!
//! Everything else follows `transfer_split_proof_data` in the SPL crate, so
//! Token-2022 accepts the proofs as any other transfer's. Built with
//! `solana-zk-sdk` 7, the version mainnet verifies with, and compiled to
//! WebAssembly for `@vexa/core` (see `build.sh`).

use curve25519_dalek::scalar::Scalar;
use sha2::{Digest, Sha512};
use solana_zk_elgamal_proof_interface::proof_data::ZkProofData;
use solana_zk_sdk::{
    encryption::{
        auth_encryption::{AeCiphertext, AeKey},
        elgamal::{ElGamalCiphertext, ElGamalKeypair, ElGamalPubkey, ElGamalSecretKey},
        grouped_elgamal::GroupedElGamal,
        pedersen::{Pedersen, PedersenOpening},
    },
    zk_elgamal_proof_program::{
        build_batched_grouped_ciphertext_3_handles_validity_proof_data,
        build_batched_range_proof_u128_data, build_ciphertext_commitment_equality_proof_data,
    },
};
use wasm_bindgen::prelude::*;

const LO_BITS: usize = 16;
const HI_BITS: usize = 32;
const REMAINING_BALANCE_BITS: usize = 64;
const PADDING_BITS: usize = 16;

fn err(message: impl Into<String>) -> String {
    message.into()
}

/// A payment's opening for its low or high amount commitment:
/// `SHA-512("vexa/agent-opening/v1" ‖ seed ‖ index ‖ part)` reduced mod ℓ.
/// An index is used once (the policy contract enforces it), so an opening is
/// never reused across payments.
fn opening_scalar(seed: &[u8], index: u64, part: &[u8]) -> Scalar {
    let hash = Sha512::new()
        .chain_update(b"vexa/agent-opening/v1")
        .chain_update(seed)
        .chain_update(index.to_le_bytes())
        .chain_update(part)
        .finalize();
    Scalar::from_bytes_mod_order_wide(&hash.into())
}

/// The opening of a payment's whole amount commitment, `C_lo + 2¹⁶·C_hi`.
fn payment_opening(seed: &[u8], index: u64) -> Scalar {
    opening_scalar(seed, index, b"lo")
        + opening_scalar(seed, index, b"hi") * Scalar::from(1u64 << LO_BITS)
}

/// Everything an agent payment needs: the three transfer proofs, the limit
/// proof, the new decryptable balance, and the contexts the NEAR policy
/// contract checks.
#[wasm_bindgen]
pub struct AgentPaymentProofs {
    equality: Vec<u8>,
    validity: Vec<u8>,
    range: Vec<u8>,
    limit: Vec<u8>,
    new_decryptable_balance: Vec<u8>,
    validity_context: Vec<u8>,
    limit_context: Vec<u8>,
    auditor_ciphertext_lo: Vec<u8>,
    auditor_ciphertext_hi: Vec<u8>,
}

#[wasm_bindgen]
impl AgentPaymentProofs {
    /// The amount's low and high parts encrypted to the auditor (64 bytes
    /// each), which the transfer instruction carries.
    #[wasm_bindgen(getter, js_name = auditorCiphertextLo)]
    pub fn auditor_ciphertext_lo(&self) -> Vec<u8> {
        self.auditor_ciphertext_lo.clone()
    }
    #[wasm_bindgen(getter, js_name = auditorCiphertextHi)]
    pub fn auditor_ciphertext_hi(&self) -> Vec<u8> {
        self.auditor_ciphertext_hi.clone()
    }
    /// `VerifyCiphertextCommitmentEquality` proof data.
    #[wasm_bindgen(getter)]
    pub fn equality(&self) -> Vec<u8> {
        self.equality.clone()
    }
    /// `VerifyBatchedGroupedCiphertext3HandlesValidity` proof data.
    #[wasm_bindgen(getter)]
    pub fn validity(&self) -> Vec<u8> {
        self.validity.clone()
    }
    /// The transfer's `VerifyBatchedRangeProofU128` proof data.
    #[wasm_bindgen(getter)]
    pub fn range(&self) -> Vec<u8> {
        self.range.clone()
    }
    /// The limit proof: `VerifyBatchedRangeProofU128` over the two remainders.
    #[wasm_bindgen(getter)]
    pub fn limit(&self) -> Vec<u8> {
        self.limit.clone()
    }
    /// The source account's new decryptable available balance (36 bytes).
    #[wasm_bindgen(getter, js_name = newDecryptableBalance)]
    pub fn new_decryptable_balance(&self) -> Vec<u8> {
        self.new_decryptable_balance.clone()
    }
    /// `proof_type ‖ context` of the validity proof, as a context account holds it.
    #[wasm_bindgen(getter, js_name = validityContext)]
    pub fn validity_context(&self) -> Vec<u8> {
        self.validity_context.clone()
    }
    /// `proof_type ‖ context` of the limit proof.
    #[wasm_bindgen(getter, js_name = limitContext)]
    pub fn limit_context(&self) -> Vec<u8> {
        self.limit_context.clone()
    }
}

const PROOF_TYPE_RANGE_U128: u8 = 7;
const PROOF_TYPE_VALIDITY_3_HANDLES_BATCHED: u8 = 12;

fn typed_context(proof_type: u8, context: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + context.len());
    out.push(proof_type);
    out.extend_from_slice(context);
    out
}

/// Builds an agent payment.
///
/// - `elgamal_secret` (32), `ae_key` (16): the agent's confidential keys.
/// - `available_balance` (64), `decryptable_available_balance` (36): the
///   agent account's current balance, as stored on-chain.
/// - `destination_pubkey`, `auditor_pubkey` (32 each; zeroes for no auditor).
/// - `opening_seed` (32) and `index`: where this payment's openings come from.
/// - `window_indices`, `window_amount`: the payments in the last 24 hours
///   (their indices, and their amounts summed), which the daily limit covers.
#[wasm_bindgen(js_name = agentPaymentProofs)]
#[allow(clippy::too_many_arguments)]
pub fn agent_payment_proofs_js(
    elgamal_secret: &[u8],
    ae_key: &[u8],
    available_balance: &[u8],
    decryptable_available_balance: &[u8],
    amount: u64,
    destination_pubkey: &[u8],
    auditor_pubkey: &[u8],
    opening_seed: &[u8],
    index: u64,
    max_per_request: u64,
    daily_limit: u64,
    window_indices: Vec<u64>,
    window_amount: u64,
) -> Result<AgentPaymentProofs, JsError> {
    agent_payment_proofs(
        elgamal_secret,
        ae_key,
        available_balance,
        decryptable_available_balance,
        amount,
        destination_pubkey,
        auditor_pubkey,
        opening_seed,
        index,
        max_per_request,
        daily_limit,
        window_indices,
        window_amount,
    )
    .map_err(|e| JsError::new(&e))
}

/// [`agent_payment_proofs_js`], for Rust callers.
#[allow(clippy::too_many_arguments)]
pub fn agent_payment_proofs(
    elgamal_secret: &[u8],
    ae_key: &[u8],
    available_balance: &[u8],
    decryptable_available_balance: &[u8],
    amount: u64,
    destination_pubkey: &[u8],
    auditor_pubkey: &[u8],
    opening_seed: &[u8],
    index: u64,
    max_per_request: u64,
    daily_limit: u64,
    window_indices: Vec<u64>,
    window_amount: u64,
) -> Result<AgentPaymentProofs, String> {
    let secret =
        ElGamalSecretKey::try_from(elgamal_secret).map_err(|_| err("bad ElGamal secret"))?;
    let keypair = ElGamalKeypair::new(secret);
    let ae = AeKey::try_from(ae_key).map_err(|_| err("bad AE key"))?;
    let available = ElGamalCiphertext::from_bytes(available_balance)
        .ok_or_else(|| err("bad balance ciphertext"))?;
    let decryptable = AeCiphertext::from_bytes(decryptable_available_balance)
        .ok_or_else(|| err("bad decryptable balance"))?;
    let destination =
        ElGamalPubkey::try_from(destination_pubkey).map_err(|_| err("bad destination pubkey"))?;
    let auditor = ElGamalPubkey::try_from(auditor_pubkey).map_err(|_| err("bad auditor pubkey"))?;
    if opening_seed.len() != 32 {
        return Err(err("the opening seed is 32 bytes"));
    }

    // The same checks the policy contract makes, so an overspend fails here
    // with a clear error instead of producing a proof that can't verify.
    if amount > max_per_request {
        return Err(err("LIMIT_EXCEEDED: amount is over the per-payment limit"));
    }
    let spent = window_amount.checked_add(amount).ok_or_else(|| err("amount overflow"))?;
    if spent > daily_limit {
        return Err(err("LIMIT_EXCEEDED: amount is over what's left of the daily limit"));
    }
    if amount >> (LO_BITS + HI_BITS) != 0 {
        return Err(err("amount is too large for a confidential transfer"));
    }
    let current = decryptable.decrypt(&ae).ok_or_else(|| err("can't decrypt the balance"))?;
    let remaining = current.checked_sub(amount).ok_or_else(|| err("insufficient balance"))?;

    // Transfer amount, split and encrypted with deterministic openings.
    let (amount_lo, amount_hi) = (amount & 0xffff, amount >> LO_BITS);
    let opening_lo = PedersenOpening::new(opening_scalar(opening_seed, index, b"lo"));
    let opening_hi = PedersenOpening::new(opening_scalar(opening_seed, index, b"hi"));
    let pubkeys = [keypair.pubkey(), &destination, &auditor];
    let grouped_lo = GroupedElGamal::encrypt_with(pubkeys, amount_lo, &opening_lo);
    let grouped_hi = GroupedElGamal::encrypt_with(pubkeys, amount_hi, &opening_hi);

    // New source balance: a fresh commitment, proven equal to the ciphertext.
    let (new_commitment, new_opening) = Pedersen::new(remaining);
    let source_lo =
        grouped_lo.to_elgamal_ciphertext(0).map_err(|_| err("ciphertext extraction"))?;
    let source_hi =
        grouped_hi.to_elgamal_ciphertext(0).map_err(|_| err("ciphertext extraction"))?;
    let new_balance = available - (source_lo + source_hi * Scalar::from(1u64 << LO_BITS));
    let equality = build_ciphertext_commitment_equality_proof_data(
        &keypair,
        &new_balance,
        &new_commitment,
        &new_opening,
        remaining,
    )
    .map_err(|e| err(e.to_string()))?;

    let validity = build_batched_grouped_ciphertext_3_handles_validity_proof_data(
        keypair.pubkey(),
        &destination,
        &auditor,
        &grouped_lo,
        &grouped_hi,
        amount_lo,
        amount_hi,
        &opening_lo,
        &opening_hi,
    )
    .map_err(|e| err(e.to_string()))?;

    let (padding, padding_opening) = Pedersen::new(0u64);
    let range = build_batched_range_proof_u128_data(
        vec![&new_commitment, &grouped_lo.commitment, &grouped_hi.commitment, &padding],
        vec![remaining, amount_lo, amount_hi, 0],
        vec![REMAINING_BALANCE_BITS, LO_BITS, HI_BITS, PADDING_BITS],
        vec![&new_opening, &opening_lo, &opening_hi, &padding_opening],
    )
    .map_err(|e| err(e.to_string()))?;

    // The limit proof. With C = a·G + r·H the payment's amount commitment and
    // W = spent_before·G + r_W·H the window's:
    //   max·G − C       = (max − a)·G           + (−r)·H
    //   daily·G − W − C = (daily − spent)·G     + (−r_W − r)·H
    let r = payment_opening(opening_seed, index);
    let r_window: Scalar = window_indices.iter().map(|i| payment_opening(opening_seed, *i)).sum();
    let per_request_opening = PedersenOpening::new(-r);
    let daily_opening = PedersenOpening::new(-(r_window + r));
    let per_request = Pedersen::with(max_per_request - amount, &per_request_opening);
    let daily = Pedersen::with(daily_limit - spent, &daily_opening);
    let limit = build_batched_range_proof_u128_data(
        vec![&per_request, &daily],
        vec![max_per_request - amount, daily_limit - spent],
        vec![64, 64],
        vec![&per_request_opening, &daily_opening],
    )
    .map_err(|e| err(e.to_string()))?;

    let auditor_lo =
        grouped_lo.to_elgamal_ciphertext(2).map_err(|_| err("ciphertext extraction"))?;
    let auditor_hi =
        grouped_hi.to_elgamal_ciphertext(2).map_err(|_| err("ciphertext extraction"))?;

    Ok(AgentPaymentProofs {
        auditor_ciphertext_lo: auditor_lo.to_bytes().to_vec(),
        auditor_ciphertext_hi: auditor_hi.to_bytes().to_vec(),
        equality: bytemuck::bytes_of(&equality).to_vec(),
        validity_context: typed_context(
            PROOF_TYPE_VALIDITY_3_HANDLES_BATCHED,
            bytemuck::bytes_of(validity.context_data()),
        ),
        validity: bytemuck::bytes_of(&validity).to_vec(),
        range: bytemuck::bytes_of(&range).to_vec(),
        limit_context: typed_context(
            PROOF_TYPE_RANGE_U128,
            bytemuck::bytes_of(limit.context_data()),
        ),
        limit: bytemuck::bytes_of(&limit).to_vec(),
        new_decryptable_balance: ae.encrypt(remaining).to_bytes().to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use curve25519_dalek::{
        constants::RISTRETTO_BASEPOINT_POINT as G, ristretto::CompressedRistretto,
    };
    use solana_zk_elgamal_proof_interface::proof_data::{
        BatchedGroupedCiphertext3HandlesValidityProofData, BatchedRangeProofU128Data,
        CiphertextCommitmentEqualityProofData,
    };
    use solana_zk_sdk::zk_elgamal_proof_program::VerifyZkProof;

    const USDC: u64 = 1_000_000;

    fn point(b: &[u8]) -> curve25519_dalek::ristretto::RistrettoPoint {
        CompressedRistretto::from_slice(b).unwrap().decompress().unwrap()
    }

    struct Agent {
        keypair: ElGamalKeypair,
        ae_bytes: [u8; 16],
        ae: AeKey,
        seed: [u8; 32],
    }

    fn pay(
        agent: &Agent,
        balance: u64,
        amount: u64,
        index: u64,
        window: (Vec<u64>, u64),
    ) -> Result<AgentPaymentProofs, String> {
        let available = agent.keypair.pubkey().encrypt(balance);
        agent_payment_proofs(
            agent.keypair.secret().as_bytes(),
            &agent.ae_bytes,
            &available.to_bytes(),
            &agent.ae.encrypt(balance).to_bytes(),
            amount,
            &ElGamalKeypair::new_rand().pubkey().to_bytes(),
            &[0; 32],
            &agent.seed,
            index,
            10 * USDC,
            25 * USDC,
            window.0,
            window.1,
        )
    }

    fn agent() -> Agent {
        let ae_bytes = [3u8; 16];
        Agent {
            keypair: ElGamalKeypair::new_rand(),
            ae_bytes,
            ae: AeKey::try_from(&ae_bytes[..]).unwrap(),
            seed: [5; 32],
        }
    }

    #[test]
    fn every_proof_verifies() {
        let a = agent();
        let p = pay(&a, 100 * USDC, 9 * USDC, 0, (vec![], 0)).unwrap();
        bytemuck::from_bytes::<CiphertextCommitmentEqualityProofData>(&p.equality)
            .verify_proof()
            .unwrap();
        bytemuck::from_bytes::<BatchedGroupedCiphertext3HandlesValidityProofData>(&p.validity)
            .verify_proof()
            .unwrap();
        bytemuck::from_bytes::<BatchedRangeProofU128Data>(&p.range).verify_proof().unwrap();
        bytemuck::from_bytes::<BatchedRangeProofU128Data>(&p.limit).verify_proof().unwrap();
    }

    /// The same arithmetic the NEAR policy contract does, on the contexts.
    #[test]
    fn limit_commitments_match_what_the_policy_contract_computes() {
        let a = agent();
        let first = pay(&a, 100 * USDC, 9 * USDC, 0, (vec![], 0)).unwrap();
        let second = pay(&a, 91 * USDC, 7 * USDC, 1, (vec![0], 9 * USDC)).unwrap();
        let amount = |v: &[u8]| point(&v[97..129]) + point(&v[225..257]) * Scalar::from(1u64 << 16);
        let (c0, c1) = (amount(&first.validity_context), amount(&second.validity_context));
        let limits = &second.limit_context[1..];
        assert_eq!(point(&limits[..32]), G * Scalar::from(10 * USDC) - c1);
        assert_eq!(point(&limits[32..64]), G * Scalar::from(25 * USDC) - c0 - c1);
        assert_eq!(&limits[256..], &[64, 64, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn overspending_is_refused_before_proving() {
        let a = agent();
        assert!(pay(&a, 100 * USDC, 11 * USDC, 0, (vec![], 0)).is_err());
        assert!(pay(&a, 100 * USDC, 9 * USDC, 2, (vec![0, 1], 18 * USDC)).is_err());
    }

    #[test]
    fn openings_are_deterministic_and_distinct() {
        let seed = [5; 32];
        assert_eq!(payment_opening(&seed, 3), payment_opening(&seed, 3));
        assert_ne!(payment_opening(&seed, 3), payment_opening(&seed, 4));
        assert_ne!(opening_scalar(&seed, 3, b"lo"), opening_scalar(&seed, 3, b"hi"));
    }
}
