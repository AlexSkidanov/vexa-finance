# Quantum readiness

This document explains what a large quantum computer would mean for Vexa, what NEAR has already made post-quantum, and where every part of Vexa stands. The public version is at [vexa.finance/quantum](https://vexa.finance/quantum/). Sections marked _planned_ describe work that hasn't shipped yet. We'd rather be precise about the gap than claim protection we don't have.

## Why this matters more for a privacy product

Most systems only need their cryptography to hold up today. A private payments system needs it to hold up for as long as the data exists, and on a public blockchain that is forever.

The risk is **harvest now, decrypt later**: anyone can archive Vexa's encrypted balances and transfers from the chain today, and decrypt them once a capable quantum computer exists. Shor's algorithm breaks the elliptic-curve problems behind ElGamal encryption, Ed25519 and secp256k1 signatures, and most zero-knowledge proof systems. Nobody knows when that day ("Q-Day") arrives, but data written today has to survive it.

## What NEAR has shipped

Vexa enforces agent spending limits in a NEAR contract, `vexa-policy.near`, so NEAR's post-quantum work applies to us directly. Sources: Near One's [Preparing NEAR for the Quantum Computing Era](https://www.near.org/blog/making-near-protocol-post-quantum-safe) (May 2026), [Quantum-Safe NEAR: The Roadmap to Post-Quantum Security](https://www.near.org/blog/near-quantum-safe-roadmap) (August 2026) and the nearcore release notes.

- **Accounts are separate from keys.** A NEAR account is a name controlled by access keys that can be added and removed. On Bitcoin and Ethereum the address is derived from the key, so a broken key means a lost address. On NEAR an account keeps its name and moves to a new key.
- **ML-DSA-65 is live on mainnet.** [nearcore 2.13.0](https://github.com/near/nearcore/releases/tag/2.13.0) stabilized FIPS 204 ML-DSA-65 as a third transaction and access-key scheme next to Ed25519 and secp256k1. Public keys are stored on-trie as a 32-byte SHA3-256 hash of the 1,952-byte key, and verification costs an extra 100 Ggas. Keys print with the `ml-dsa-65:` prefix.
- **Wallets.** Meteor Wallet signs with ML-DSA today. Near One is working with Ledger and other wallets.
- **Next release.** nearcore 2.14 (release candidates as of October 2026) adds an `ml_dsa_verify` host function, so contracts can verify ML-DSA-65 signatures on-chain, and stabilizes universal accounts (`0u`) with a post-quantum-safe derivation.

### What NEAR hasn't solved yet

| Work                                | Status                   | Notes                                                                                                             |
| ----------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Post-quantum consensus              | Targeted for end of 2027 | Validators still sign blocks with Ed25519. ML-DSA is too large for consensus, and Falcon is not yet mature        |
| Post-quantum Chain Signatures (MPC) | No timeline              | There is no practical post-quantum threshold signature scheme yet                                                 |
| Confidential key derivation         | No timeline              | Also based on threshold signing                                                                                   |
| Falcon (FN-DSA)                     | Under consideration      | Smaller signatures than ML-DSA                                                                                    |
| Seed-phrase ownership proofs        | Research                 | Prove ownership with a zero-knowledge proof of the seed, which sits behind a hash quantum computers can't reverse |

An account with only ML-DSA keys can't have its transactions forged by a quantum attacker. Until consensus is post-quantum too, though, the network as a whole isn't.

## Where Vexa stands

| Part of Vexa                               | Today                                                                   | Path to post-quantum                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Full-access keys on `vexa-policy.near`     | ML-DSA-65 added October 2026; the original Ed25519 key is still present | Remove the Ed25519 key                                                |
| Agent limit checks                         | NEAR contract                                                           | Post-quantum when NEAR consensus is, targeted for end of 2027         |
| Agent wallets on Solana                    | Ed25519 via NEAR Chain Signatures                                       | Waits on post-quantum threshold signing                               |
| Encrypted balances and amounts             | Twisted ElGamal on Curve25519 (Token-2022)                              | Waits on a post-quantum confidential token standard on Solana         |
| Solana account and transaction signatures  | Ed25519                                                                 | Waits on Solana                                                       |
| Stealth route                              | Zcash Orchard via NEAR Intents                                          | Waits on Zcash and NEAR Intents                                       |
| Signed audit exports and webhooks          | Ed25519                                                                 | Add an ML-DSA-65 signature next to the Ed25519 one _(planned)_        |
| Passkey sign-in                            | WebAuthn (P-256)                                                        | Rotatable, so not a harvest-now risk; follows platform support        |
| Stored API keys and view keys              | AES-256-GCM                                                             | Already quantum-resistant: Grover's algorithm leaves 128-bit security |
| Hashes (commitments, idempotency, exports) | SHA-256 / SHA3-256                                                      | Already quantum-resistant                                             |

### Live proof

The site reads the access keys of `vexa-policy.near` from NEAR mainnet in the visitor's browser (`view_access_key_list` on a public RPC), not from our API, and shows each key's scheme. It reports the account as post-quantum only when every full-access key is `ml-dsa-65`. Anyone can check the same thing:

```bash
near account list-keys vexa-policy.near network-config mainnet now
```

## Plan

1. **Rotate the policy contract's keys** _(in progress)_. An ML-DSA-65 full-access key was added to `vexa-policy.near` on 9 October 2026 and has signed transactions on mainnet. Deleting the original Ed25519 key finishes the rotation. The site's live check flips on its own. The relayer signs from the deployer account, not from `vexa-policy.near`, so it isn't affected. Contract upgrades through `pnpm deploy:policy` will need an ML-DSA-capable signer afterwards.
2. **Dual-sign audit exports and webhooks** _(planned)_. Add an ML-DSA-65 signature next to `X-Vexa-Signature`, so an auditor can still trust an archived export after Ed25519 falls.
3. **Verify agent approvals post-quantum** _(planned, needs nearcore 2.14)_. Once `ml_dsa_verify` reaches mainnet, owners can sign policy changes with ML-DSA keys and the contract checks them directly.
4. **Track upstream** for the rest: NEAR consensus and Chain Signatures, a post-quantum confidential token on Solana, and Zcash. The vault is upgradeable, so balances can move to a new confidential token standard with one withdraw and re-deposit when one exists.

## What we will and won't claim

- We **will** say Vexa enforces agent limits on NEAR, one of the first blockchains with post-quantum signatures on mainnet.
- We **will** say the policy contract uses post-quantum keys, once the live check shows it.
- We **won't** call Vexa "quantum-proof" or "quantum-secure" as a whole while any row above still depends on elliptic curves.
