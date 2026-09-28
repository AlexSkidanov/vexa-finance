<div align="center">

  <h1><code>vexa</code></h1>

  <p>
    <strong>A private neobank on Solana.</strong>
  </p>
  <p>
    Confidential USDC balances, AI agent accounts with on-chain spend policies, and unlinkable transfers.
  </p>

  <p>
    <a href="https://github.com/AlexSkidanov/vexa-finance/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/AlexSkidanov/vexa-finance/ci.yml?branch=main&style=flat-square&label=CI" alt="CI" /></a>
    <a href="#license"><img src="https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue?style=flat-square" alt="License" /></a>
    <a href="https://solana.com"><img src="https://img.shields.io/badge/solana-mainnet-9945FF?style=flat-square" alt="Solana mainnet" /></a>
    <a href="https://www.anchor-lang.com"><img src="https://img.shields.io/badge/anchor-1.2-lightgray?style=flat-square" alt="Anchor 1.2" /></a>
    <a href="https://docs.near.org/chain-abstraction/chain-signatures"><img src="https://img.shields.io/badge/NEAR-chain%20signatures-00EC97?style=flat-square" alt="NEAR chain signatures" /></a>
    <a href="https://vexa.finance"><img src="https://img.shields.io/badge/web-vexa.finance-black?style=flat-square" alt="vexa.finance" /></a>
  </p>

  <h3>
    <a href="#about-vexa">About</a>
    <span> | </span>
    <a href="#how-it-works">How it works</a>
    <span> | </span>
    <a href="#repository-layout">Layout</a>
    <span> | </span>
    <a href="#quickstart">Quickstart</a>
    <span> | </span>
    <a href="docs/API.md">API reference</a>
    <span> | </span>
    <a href="#contributing">Contributing</a>
  </h3>
</div>

## Release notes

**Release notes and unreleased changes can be found in the [CHANGELOG](CHANGELOG.md).**

## About Vexa

Every transfer on a public blockchain tells the world who paid whom and how much. That's fine for a treasury; it isn't fine for a salary, a rent payment or a company's supplier list. Vexa is a non-custodial neobank that keeps amounts private while everything else about the money (who holds it, where it's settled, what it's backed by) stays verifiable on Solana.

- **Sign up with an email and a passkey.** Your Solana wallet and encryption keys are derived on your device from the passkey itself. Nothing secret is ever stored, by us or anyone else.
- **Get a handle.** People pay `@you.vexa`, not a 44-character address.
- **Hold USDC, privately.** Deposits are wrapped 1:1 into cUSDC, whose balances and transfer amounts are ElGamal-encrypted on-chain.
- **Give AI agents their own accounts.** Each agent gets a sub-account with a daily limit, a per-payment cap and an allow-list, enforced by a NEAR smart contract that only signs the agent's transactions when the policy passes. Agents never hold a private key.
- **Go fully unlinkable when it matters.** Stealth transfers take a detour through the Zcash shielded pool via NEAR Intents and land at a fresh address.
- **Share read access, not control.** View keys give an accountant or auditor a scoped, revocable window into a date range.

## How it works

### Confidential balances

cUSDC is a [Token-2022](https://spl.solana.com/token-2022) mint with the **ConfidentialTransfer** extension. Each account's balance is stored as a twisted-ElGamal ciphertext under the owner's public key, and every transfer carries zero-knowledge proofs (equality, ciphertext validity and range proofs) that the Solana runtime verifies natively through the ZK ElGamal proof program. The chain checks that no money was created or destroyed without ever learning an amount.

Proofs are generated **in the SDK, on the user's device**. The API relays ciphertexts and proofs; it never sees, logs or stores a plaintext amount.

### The vault

[`programs/vault`](programs/vault) is the bridge between USDC and cUSDC:

```text
  deposit(amount)                            withdraw(amount)
  ───────────────                            ────────────────
  user USDC ──transfer──▶ reserve            user cUSDC (public) ──burn──▶ ∅
  ∅ ──mint──▶ user cUSDC                     reserve ──transfer──▶ any USDC account
  user cUSDC ──CT deposit──▶ pending balance
```

The vault's config PDA is the only mint authority for cUSDC and the only owner of the USDC reserve, so the reserve always covers the supply. The mint has no freeze authority and no extensions beyond confidential transfers. Deposit and withdrawal amounts are public, as any USDC transfer is; everything in between is not.

### Keys from a passkey

Signing in uses a WebAuthn passkey with the [PRF extension](https://w3c.github.io/webauthn/#prf-extension). The PRF output, a secret only the authenticator can compute, is the root of everything:

```text
passkey PRF output ─┬─ ConfidentialKeys.fromPrf ─┬─ ElGamal keypair   decrypt balances, build proofs
                    │                            └─ AE key            fast local balance decryption
                    └─ HKDF("vexa/solana-wallet/v1") ─ ed25519 seed    sign Solana transactions
```

Passkeys sync through iCloud Keychain and Google Password Manager, so the same keys are available on every device the user owns.

### Agents, stealth transfers and view keys

These land in upcoming releases; see [Status](#status). The designs are summarized in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Repository layout

### ⛓️ On-chain

| Name        | Description                                                              | Path                                |
| ----------- | ------------------------------------------------------------------------ | ----------------------------------- |
| vault       | Anchor program wrapping USDC 1:1 into confidential cUSDC                 | [`programs/vault`](programs/vault)  |
| near-policy | NEAR contract enforcing agent spend policies and gating chain signatures | `contracts/near-policy` _(planned)_ |

### 🧩 Packages

| Name         | Description                                                         | Path                             |
| ------------ | ------------------------------------------------------------------- | -------------------------------- |
| `@vexa/sdk`  | Typed API client with idempotent retries and passkey sign-in        | [`packages/sdk`](packages/sdk)   |
| `@vexa/core` | Shared schemas, handle rules, key validation and client-side crypto | [`packages/core`](packages/core) |

### 🛠 Services

| Name        | Description                                                | Path                                         |
| ----------- | ---------------------------------------------------------- | -------------------------------------------- |
| `@vexa/api` | Hono REST API, webhooks and background workers             | [`apps/api`](apps/api)                       |
| database    | Postgres schema and row-level security policies (Supabase) | [`supabase/migrations`](supabase/migrations) |

## Status

| Phase | Scope                                                                                    | State        |
| ----- | ---------------------------------------------------------------------------------------- | ------------ |
| 0     | Environment and secrets audit                                                            | ✅ Done      |
| 1     | Monorepo, API, Supabase schema and RLS, email + passkey auth, handles, vault program, CI | 🚧 In review |
| 2     | Deposits, confidential transfers, withdrawals, fees, webhooks                            | Planned      |
| 3     | Agent accounts and policies, x402 payments, stealth mode, view keys, $VEXA               | Planned      |

Card issuing and KYC ship as interfaces with mock implementations first.

## Deployments

| Network        | Component     | Address                                                                                                                            |
| -------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Solana mainnet | Vault program | [`3g2JPX4roASUJVacf68sBSpARk5m9B3hu9xeaE6mTjPR`](https://explorer.solana.com/address/3g2JPX4roASUJVacf68sBSpARk5m9B3hu9xeaE6mTjPR) |
| Solana mainnet | cUSDC mint    | _set at deployment_                                                                                                                |
| NEAR mainnet   | MPC signer    | [`v1.signer`](https://nearblocks.io/address/v1.signer)                                                                             |

## Pre-requisites

- [Node.js](https://nodejs.org) 22 (20+ works) and [pnpm](https://pnpm.io) 9 via `corepack enable`
- For the programs: [Rust](https://rustup.rs), the [Solana CLI](https://docs.anza.xyz/cli/install) and [Anchor](https://www.anchor-lang.com/docs/installation) 1.2

## Quickstart

### Using the SDK

```ts
import { Vexa } from '@vexa/sdk';
import { deriveUserKeys, passkeyPrfInput, signWithSolanaSeed } from '@vexa/core/crypto';

const vexa = new Vexa();

// 1. Email code: creates the account and returns a session.
await vexa.auth.sendOtp('alex@example.com');
await vexa.auth.verifyOtp('alex@example.com', '123456');

// 2. Register a passkey, then sign in with it to derive keys on-device.
await vexa.passkeys.register('MacBook');
const { prfOutput } = await vexa.passkeys.signIn(passkeyPrfInput());
const keys = deriveUserKeys(prfOutput!);

// 3. Claim a handle, signed by the Solana key it points to.
await vexa.handles.claim('alex', {
  solanaAddress: keys.solanaAddress,
  elgamalPubkey: keys.elgamalPubkey,
  sign: (message) => signWithSolanaSeed(keys.solanaSeed, message),
});

// Anyone can resolve it.
const alex = await vexa.handles.resolve('@alex.vexa');
```

Server-side code authenticates with an API key instead. The environment is read from the key prefix:

```ts
const vexa = new Vexa({ apiKey: process.env.VEXA_API_KEY }); // vx_live_…
```

### Running the backend

```bash
corepack enable
pnpm install
cp .env.example .env     # docs/SETUP.md walks through every value
pnpm check-env           # validates settings and probes every dependency
pnpm db:migrate          # applies supabase/migrations
pnpm dev                 # API on http://localhost:8787
```

### Building and testing the vault

```bash
anchor build
anchor test --skip-deploy --skip-local-validator
```

The tests run on [LiteSVM](https://github.com/LiteSVM/litesvm) with the same Agave runtime and ZK SDK versions as mainnet, including real equality and range proofs.

## Security

Vexa moves real money. Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), never in a public issue.

## Contributing

The workflow and conventions are described in [CONTRIBUTING.md](CONTRIBUTING.md). Everyone interacting with the project is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in the work by you, as defined in the Apache-2.0 license, shall be dual licensed as above, without any additional terms or conditions.
