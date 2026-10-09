//! Agent addresses. An agent's Solana key is never held by anyone: it's the
//! MPC network's Ed25519 key derived for this contract and the agent's path,
//! computed exactly as `v1.signer` does (crates/contract/src/crypto_shared/kdf.rs
//! in near/mpc):
//!
//! ```text
//!   tweak   = SHA3-256("near-mpc-recovery v0.1.0 epsilon derivation:" ‖ predecessor ‖ "," ‖ path)
//!   derived = root + (tweak mod ℓ)·G
//! ```

use curve25519_dalek::{
    constants::ED25519_BASEPOINT_POINT, edwards::CompressedEdwardsY, scalar::Scalar,
};
use sha3::{Digest, Sha3_256};

const TWEAK_DERIVATION_PREFIX: &str = "near-mpc-recovery v0.1.0 epsilon derivation:";

pub fn agent_path(agent_id: &str) -> String {
    format!("vexa-agent-{agent_id}")
}

pub fn derived_key(root: &[u8; 32], predecessor: &str, path: &str) -> [u8; 32] {
    let tweak: [u8; 32] =
        Sha3_256::digest(format!("{TWEAK_DERIVATION_PREFIX}{predecessor},{path}")).into();
    let root = CompressedEdwardsY(*root).decompress().expect("MPC root key is a valid point");
    (root + ED25519_BASEPOINT_POINT * Scalar::from_bytes_mod_order(tweak)).compress().to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A value read from mainnet `v1.signer`'s `derived_public_key` view.
    #[test]
    fn matches_the_mpc_contract() {
        let root = crate::solana::decode("G9hwngxWNKdmqMCmU1Yt6LPhFpayJeKFxyAV1HqMNLtF").unwrap();
        let derived = derived_key(&root, "example.near", "solana-1");
        assert_eq!(crate::solana::encode(&derived), "3T1x6LQ9EtChr7sn83qYsBEUN3JWDEGiRSNb1DBi2U8d");
    }
}
