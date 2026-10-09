# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Deployed

- Vault program on Solana mainnet at `3g2JPX4roASUJVacf68sBSpARk5m9B3hu9xeaE6mTjPR`, with the cUSDC
  mint at `4STXpFN2mQSt12XG4os7ftLXHbBq5PVWYCAahToRt6QQ`. The upgrade authority was moved to a
  dedicated key right after initialization.
- Vault v0.3.0 (the protocol fee) upgraded in place, with the fee schedule set to 0.10% capped at
  5 USDC.

### Added (Phase 3)

- **Agents**: sub-accounts whose Solana key is a NEAR MPC key (`v1.signer`), signed only through the
  new `near-policy` contract, which enforces per-payment and rolling 24-hour limits on the
  payment's hidden amount with a range proof over Pedersen commitments, recipient and domain
  allow-lists, pause and revoke. Agent proofs come from `crates/agent-proofs` (solana-zk-sdk 7 in
  WebAssembly) with openings derived per payment. The vault's `RequireContexts` binds each payment
  to the proofs NEAR approved.
- **x402**: `VexaAgent.fetch()` pays `402 Payment Required` responses in the `vexa` scheme and logs
  every step to `agent_traces`.
- **Stealth transfers** through the Zcash shielded pool with NEAR Intents 1Click, with a refund
  path, run by an API worker driving a zingolib wallet over the Nym mixnet.
- **View keys** and signed audit exports, decrypted on the auditor's device.
- **$VEXA**: staking in the vault with a 7-day lock, tiers from staked + wallet ÷ 2 for fee
  discounts (10/25/50/75%) and agent limits, and `pnpm token:create`.
- Card and KYC interfaces with mock implementations.

### Added

- **Confidential transfers** between handles, with proofs built on the device and end-to-end
  encrypted memos. A transfer is four sponsored transactions; the API only ever stores the
  ciphertexts from its validity proof.
- **Deposits, withdrawals, balances and activity** through `vexa.money` in the SDK, with users
  needing no SOL: Vexa's fee payer co-signs under a strict sponsorship policy.
- **Outbound webhooks** (`transfer.settled`, `deposit.confirmed`, `withdrawal.sent`), signed with
  HMAC-SHA256 and replay-protected, delivered with retries and SSRF checks.
- **Alchemy receiver and indexer** that records vault deposits made directly on-chain.
- **Protocol fee**: 0.10% of each deposit and withdrawal, capped at 5 USDC, charged by the vault
  in USDC to the treasury, with $VEXA discount tiers. The rate can never exceed 1%. The SDK quotes
  it with the program's exact arithmetic (`vexa.money.quote()`).

- **Vault program** (`programs/vault`): wraps USDC 1:1 into cUSDC, a Token-2022 mint with
  confidential transfers. Deposits land directly in the owner's pending confidential balance;
  withdrawals burn cUSDC and release USDC to any account. Initialization is restricted to the
  upgrade authority and rejects any mint that could be frozen, seized or inflated. Written with
  Pinocchio: 36 KB on-chain, about 0.18 SOL of rent.
- **API** (`apps/api`): email OTP and passkey sign-in, handle claims bound to the user's Solana
  key by signature, public handle resolution, API keys, request ids, structured logging with
  amount and secret redaction, per-IP rate limits and idempotency on every create endpoint.
- **Database**: initial Supabase schema with row-level security on every table and no plaintext
  amount columns; `pnpm db:migrate` with invariant checks and a `--dry-run` mode.
- **`@vexa/sdk`**: typed client with environment inference from the key prefix, idempotent
  retries and browser passkey helpers.
- **`@vexa/core`**: shared schemas, handle rules, key validation, and client-side key derivation
  from a passkey's PRF output.
- `pnpm deploy:vault`: prints the exact SOL required, then deploys and initializes the vault.
- CI: lint, typecheck, tests, vault build and tests, and a secret scan on every pull request.

- `pnpm check-env`: validates every setting in `.env` and probes Supabase, Solana RPC,
  NEAR RPC and the NEAR Intents 1Click API, including whether the ZK ElGamal proof
  program is live on the target cluster.
- Environment setup guide for mainnet in `docs/SETUP.md`.
