//! Checking an agent payment's limit proof against the payment itself,
//! without learning the amount.
//!
//! Amounts in a confidential transfer are Pedersen commitments `C = a·G + r·H`
//! over Ristretto. The transfer's validity proof context carries the amount
//! as two commitments, the low 16 bits and the high 32: `C = C_lo + 2¹⁶·C_hi`.
//! Commitments add, so the policy contract can compute, for the payment's
//! amount `a`, the window of recent payments `W` and the limits,
//!
//! ```text
//!   D_request = max_per_request·G − C          commits to  max_per_request − a
//!   D_daily   = daily_limit·G − W − C          commits to  daily_limit − (spent + a)
//! ```
//!
//! and require the payment to carry a range proof, verified on Solana, that
//! both lie in [0, 2⁶⁴). A range proof over a negative value (which wraps to a
//! huge number modulo the group order) can't exist, so passing it means the
//! payment is within both limits. The contract only compares points; it never
//! sees `a`.

use curve25519_dalek::{
    constants::RISTRETTO_BASEPOINT_POINT,
    ristretto::{CompressedRistretto, RistrettoPoint},
    scalar::Scalar,
    traits::Identity,
};

/// `ProofType` bytes that lead each context (and each context state account).
pub const PROOF_TYPE_RANGE_U128: u8 = 7;
pub const PROOF_TYPE_VALIDITY_3_HANDLES_BATCHED: u8 = 12;

/// source, destination and auditor pubkeys, then grouped ciphertexts lo and hi.
const VALIDITY_CONTEXT_LEN: usize = 352;
/// Eight commitments, then eight bit lengths.
const RANGE_CONTEXT_LEN: usize = 264;

pub fn point(bytes: &[u8]) -> Result<RistrettoPoint, &'static str> {
    let compressed = CompressedRistretto::from_slice(bytes).map_err(|_| "bad point length")?;
    compressed.decompress().ok_or("not a valid Ristretto point")
}

/// The amount commitment of a transfer, from its validity proof context
/// (`proof_type ‖ context`, as the vault's RequireContexts hashes it).
pub fn transfer_amount_commitment(validity: &[u8]) -> Result<RistrettoPoint, &'static str> {
    if validity.len() != 1 + VALIDITY_CONTEXT_LEN
        || validity[0] != PROOF_TYPE_VALIDITY_3_HANDLES_BATCHED
    {
        return Err("not a batched 3-handle validity context");
    }
    // Each grouped ciphertext is its commitment (32) then three handles (96).
    let lo = point(&validity[1 + 96..1 + 128])?;
    let hi = point(&validity[1 + 224..1 + 256])?;
    Ok(lo + hi * Scalar::from(1u64 << 16))
}

/// The two commitments a limit proof covers, from its range proof context.
/// It must be a U128 batch of exactly two 64-bit values.
pub fn limit_commitments(limit: &[u8]) -> Result<([u8; 32], [u8; 32]), &'static str> {
    if limit.len() != 1 + RANGE_CONTEXT_LEN || limit[0] != PROOF_TYPE_RANGE_U128 {
        return Err("not a U128 range proof context");
    }
    let context = &limit[1..];
    let (commitments, bit_lengths) = context.split_at(256);
    if bit_lengths != [64, 64, 0, 0, 0, 0, 0, 0] {
        return Err("the limit proof must cover exactly two 64-bit values");
    }
    if commitments[64..].iter().any(|b| *b != 0) {
        return Err("unused limit proof slots must be empty");
    }
    Ok((commitments[..32].try_into().unwrap(), commitments[32..64].try_into().unwrap()))
}

/// `limit·G − Σ others`, compressed: the commitment a limit proof must cover.
pub fn remaining(limit: u64, spent: &[RistrettoPoint]) -> [u8; 32] {
    let total = spent.iter().fold(RistrettoPoint::identity(), |acc, p| acc + p);
    (RISTRETTO_BASEPOINT_POINT * Scalar::from(limit) - total).compress().to_bytes()
}
