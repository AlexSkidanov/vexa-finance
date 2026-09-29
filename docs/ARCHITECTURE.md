# Architecture

This document describes how Vexa's pieces fit together and why. It grows with each release. Sections marked _planned_ describe the intended design of features that haven't shipped yet.

## Principles

1. **The server never knows an amount.** Balances and transfer amounts exist only as ElGamal ciphertexts outside the user's device. Proofs are built client-side. The schema has no numeric amount column on transfers, the logger redacts `amount` fields, and the review checklist asks about it on every PR.
2. **The server never holds a user key.** User keys are derived on-device from a passkey. The only private keys the backend holds are its own: a fee payer that sponsors transaction fees and an admin key for the vault.
3. **Every create is idempotent.** Money-moving requests will be retried by flaky networks and impatient users; a retry must never mean a second transfer.
4. **On-chain is the source of truth.** The database mirrors what the chain and the NEAR contract enforce, for search and dashboards, and never overrides them.

## Components

```mermaid
flowchart LR
  subgraph Device
    SDK["@vexa/sdk + @vexa/core/crypto<br/>keys from passkey PRF<br/>ZK proof generation"]
  end
  subgraph Backend
    API["apps/api (Hono)"]
    DB[("Supabase Postgres<br/>RLS on every table")]
    AUTH["Supabase Auth<br/>email OTP"]
  end
  subgraph Solana
    VAULT["vault program"]
    T22["Token-2022<br/>ConfidentialTransfer"]
    ZK["ZK ElGamal<br/>proof program"]
  end
  subgraph NEAR
    POLICY["near-policy contract (planned)"]
    MPC["v1.signer (MPC)"]
  end

  SDK -- "sessions, ciphertexts, proofs" --> API
  SDK -- "signed transactions" --> Solana
  API --> DB
  API --> AUTH
  VAULT --> T22
  T22 --> ZK
  POLICY --> MPC
  MPC -. "Ed25519 signatures for agent keys" .-> Solana
```

## Identity and keys

### Sign-up and passkey registration

```mermaid
sequenceDiagram
  autonumber
  participant U as User device (SDK)
  participant A as Vexa API
  participant S as Supabase Auth

  U->>A: POST /v1/auth/otp {email}
  A->>S: signInWithOtp
  S-->>U: 6-digit code by email
  U->>A: POST /v1/auth/otp/verify {email, code}
  A->>S: verifyOtp
  A-->>U: session
  U->>A: POST /v1/auth/passkeys/register/options
  A-->>U: WebAuthn options (PRF requested)
  U->>U: navigator.credentials.create()
  U->>A: POST /v1/auth/passkeys/register/verify
  A-->>U: 201 passkey stored (public key only)
```

### Passkey sign-in and key derivation

```mermaid
sequenceDiagram
  autonumber
  participant U as User device (SDK)
  participant A as Vexa API
  participant S as Supabase Auth

  U->>A: POST /v1/auth/passkeys/login/options
  A-->>U: challenge
  U->>U: navigator.credentials.get() with PRF eval
  Note over U: PRF output stays on the device
  U->>A: POST /v1/auth/passkeys/login/verify {assertion}
  A->>A: verify signature, bump counter
  A->>S: admin.generateLink + verifyOtp(token_hash)
  A-->>U: session
  U->>U: deriveUserKeys(PRF) → Solana seed, ElGamal keypair, AE key
```

Supabase has no "sign in as this user" call, so after verifying the passkey the API mints a one-time magic-link token with the admin API and redeems it server-side. The token never leaves the process.

### Handle claim

The SDK signs a claim message with the user's Solana key. The message binds the handle, the user id and both public keys, so it can't be replayed for another account or another name. `claim_handle()` then registers the handle and binds the keys in a single transaction.

## Money

### Deposit (vault)

```mermaid
sequenceDiagram
  autonumber
  participant U as User device (SDK)
  participant V as vault program
  participant T as Token program (USDC)
  participant T22 as Token-2022 (cUSDC)

  Note over U: one transaction, signed by the user
  U->>V: deposit(amount)
  V->>T: transfer_checked user USDC → treasury (fee)
  V->>T: transfer_checked user USDC → reserve (amount − fee)
  V->>T22: mint_to_checked cUSDC → user (config PDA signs)
  V->>T22: ConfidentialTransfer::Deposit public → pending
  U->>T22: ApplyPendingBalance(new AE-encrypted balance)
```

The deposit amount is public, since it's a USDC transfer. From the moment it becomes cUSDC it's part of an encrypted balance.

### Withdraw (vault)

```mermaid
sequenceDiagram
  autonumber
  participant U as User device (SDK)
  participant T22 as Token-2022 (cUSDC)
  participant ZK as ZK ElGamal proof program
  participant V as vault program
  participant T as Token program (USDC)

  Note over U: builds equality + range proofs locally
  U->>T22: ConfidentialTransfer::Withdraw(amount) confidential → public
  T22->>ZK: verify equality proof, range proof
  U->>V: withdraw(amount)
  V->>T22: burn_checked user cUSDC (public balance)
  V->>T: transfer_checked reserve → treasury (fee, config PDA signs)
  V->>T: transfer_checked reserve → destination (amount − fee)
```

### Protocol fee

The vault charges 0.10% of each deposit and withdrawal, capped at 5 USDC, in USDC, to the treasury's USDC account. The schedule lives in a second PDA, `["fees"]`: rate, cap, treasury, and up to four $VEXA discount tiers. The admin sets it with `SetFees` (`pnpm vault:set-fees`); the program rejects any rate above 1%, and refuses deposits and withdrawals until a schedule exists rather than run without one.

Charging on the vault's edges is a deliberate choice. Deposit and withdrawal amounts are public anyway, so the program can compute the fee itself and nobody can route around it. A fee on confidential transfers would need a second transfer to the treasury plus a percentage-with-cap proof binding the two, roughly doubling a transfer's transactions, and the fee's size would itself reveal something about the amount.

The rate is rounded up, so every movement pays at least one base unit; otherwise splitting a deposit into dust would dodge the fee on transactions Vexa sponsors. $VEXA discounts are read from the owner's own token account, passed as an optional last account, so the program checks the balance itself. `quoteFee` in `@vexa/core/solana` repeats the arithmetic to the base unit so a device can show the fee and encrypt its new balance for what actually lands.

### Invariants the vault enforces

- The config PDA is the only cUSDC mint authority and the only owner of the USDC reserve.
- Every mint is paired with a USDC transfer in; every USDC release is paired with a burn. Fees go to the treasury and never pass through the reserve, so the reserve equals the cUSDC supply.
- The cUSDC mint has no freeze authority and no extensions besides ConfidentialTransfer, so nobody can freeze or seize balances.
- Only the program's upgrade authority can initialize it, which closes the window in which a freshly deployed program could be initialized with a hostile mint.

### Proof compatibility

Mainnet validators verify proofs with the `solana-zk-sdk` version built into their Agave release (7.x for Agave 4.3). A proof generated with a different major version fails with an algebraic-relation error. The vault tests generate proofs with the exact version mainnet uses, and `@solana/zk-sdk` 0.5.3 (the WASM build the SDK uses) produces proofs that mainnet accepts. This was verified by simulating one against mainnet.

### Confidential transfer

Proofs are too big for one Solana transaction (about 1.9 KB against a 1232-byte limit), so each is verified into a _context state account_ first and the transfer reads them from there. The fee payer is the contexts' authority, which keeps the range-proof transaction at 1207 bytes, and closes them in the last transaction, getting their rent back.

```mermaid
sequenceDiagram
  autonumber
  participant D as Sender device (SDK)
  participant A as Vexa API
  participant S as Solana

  D->>A: POST /v1/transfers/prepare {to: "@bob"}
  A-->>D: transferId, Bob's ElGamal key and cUSDC account
  D->>A: GET /v1/balance
  A-->>D: sender's balance ciphertexts
  Note over D: decrypt balance locally, build equality,<br/>validity and range proofs, encrypt memo,<br/>compile and sign the 4-transaction plan
  D->>A: POST /v1/transfers/submit {plan}
  A->>A: sponsorship policy; ciphertexts bound to sender, Bob, auditor
  A->>S: 1 create 3 proof contexts
  par
    A->>S: 2a verify equality + validity
  and
    A->>S: 2b verify range (1207 bytes)
  end
  A->>S: 3 Transfer reading the contexts, close contexts
  A->>A: store grouped ciphertexts, emit transfer.settled
  A-->>D: 201
```

Bob's funds land in his _pending_ balance. He can read the amount straight away from the grouped ciphertexts (his handle is index 1), and applies the pending balance, or the SDK does it for him, before spending it.

### Sponsored transactions

Users hold USDC and no SOL, so Vexa's fee payer pays every network fee and some rent. It only co-signs a transaction that passes an allow-list (`apps/api/src/chain/sponsor.ts`). The fee payer may appear only:

- as fee payer;
- funding a proof context account, owned by the ZK ElGamal proof program, of a known size, with exactly its rent-exempt lamports;
- sending exactly one confidential account's rent to the user, in an account-opening plan, only while that account doesn't exist;
- as a proof context's authority, and as authority and refund destination when closing one.

Token and vault instructions may only debit the caller's own account; a transfer may only pay the recipient named at prepare time. Every context a plan creates must be closed by the same plan. Lookup tables, unknown programs and oversized transactions are refused. Each transaction is simulated before sending, so a malformed one costs nothing, and if a plan fails halfway the API closes its open contexts itself.

What sponsorship costs Vexa: an account opening is 0.00303 SOL of rent (3,032,760 lamports), once per user; after that, a deposit, transfer or withdrawal costs only transaction fees (a 4-transaction transfer is roughly 0.00004 SOL). Creating a USDC account for a withdrawal destination is never sponsored.

### Deposits made outside the API

Deposits are signed by users, so one can reach the vault without going through `POST /v1/deposits`. The Alchemy webhook watches the reserve; the indexer records any vault deposit it hasn't seen, attributing it to the registered wallet in the transaction, and emits `deposit.confirmed`. Notifications queue in `chain_events` and are retried with backoff before being parked as dead.

## Agents

An agent is a sub-account for software, with limits its owner sets. Three pieces cooperate, and none of them can overspend on its own.

- **Its Solana key is an MPC key.** The agent's address is NEAR `v1.signer`'s Ed25519 key derived for the policy contract and `vexa-agent-{id}` (`root + SHA3-256("near-mpc-recovery v0.1.0 epsilon derivation:" ‖ contract ‖ "," ‖ path)·G`). Nobody holds the private key; only the contract can ask for a signature.
- **The policy contract** (`contracts/near-policy`) stores each agent's policy, authorized by the owner's Solana key, and signs only transactions of a known shape: open the account, apply pending, pay (within limits), or sweep to the owner.
- **The vault's `RequireContexts`** makes the transaction that NEAR signed fail unless the proofs it approved are the ones on-chain.

### Limits on amounts nobody can see

A payment's amount is a Pedersen commitment `C = a·G + r·H`, carried in the transfer's validity proof as `C_lo + 2¹⁶·C_hi`. The agent adds a fourth proof, a range proof that

```text
D_request = max_per_request·G − C          commits to  max_per_request − a  ≥ 0
D_daily   = daily_limit·G − W − C          commits to  daily_limit − (spent + a)  ≥ 0
```

where `W` is the sum of the commitments of its payments in the last 24 hours, which the contract keeps. The contract recomputes both points from the validity proof's context and its window and requires them to equal the range proof's commitments. It never learns `a`; a negative remainder has no range proof. Solana verifies the proofs into context accounts, and `RequireContexts(sha256(validity), sha256(limit))` first in the payment transaction ties it to exactly those contexts, since context data can only be written by a successful verification.

The daily proof needs the openings of past payments. The standard proof generator picks random ones, so agents use `crates/agent-proofs` (solana-zk-sdk 7, the version mainnet verifies with, compiled to WebAssembly): openings derive from the agent's secret and the payment index, the contract assigns each index once, and the agent can always recompute its window.

### An agent paying for an API with x402

```mermaid
sequenceDiagram
  autonumber
  participant G as Agent (VexaAgent)
  participant M as Merchant API
  participant A as Vexa API
  participant N as NEAR policy contract
  participant P as NEAR MPC (v1.signer)
  participant S as Solana

  G->>M: GET /report
  M-->>G: 402 {accepts: [{scheme: vexa, payTo: @shop, maxAmountRequired}]}
  G->>A: trace: payment_required, quote
  G->>A: POST /v1/transfers/prepare {to: @shop, agentId}
  G->>A: GET /v1/agents/:id/state
  Note over G: decrypt window amounts, build transfer +<br/>limit proofs (agent-proofs WASM), plan,<br/>sign the request with its authority key
  G->>A: POST /v1/agents/:id/payments
  A->>A: sponsorship policy
  A->>S: create 4 contexts; verify equality+validity, range, limit
  A->>N: request_signature(message, validity, limit, index, window)
  N->>N: shape, recipient, domain, limit commitments, window
  N->>P: sign(payload, path vexa-agent-{id})
  P-->>N: Ed25519 signature
  N-->>A: signature
  A->>S: advance nonce, RequireContexts, Transfer, close contexts
  A-->>G: 201 {txSig}
  G->>M: GET /report, X-PAYMENT
  M-->>G: 200
  G->>A: trace: paid, retried, completed
```

The payment transaction uses the agent's durable nonce, because MPC signing can outlast a blockhash. If the contract refuses, the API closes the proof contexts so their rent comes back, and the payment never happens. A payment the contract approved but that never lands still counts against the window until it ages out, which errs on the safe side.

## Stealth transfers

```mermaid
sequenceDiagram
  autonumber
  participant D as Sender device
  participant A as Vexa API + stealth worker
  participant S as Solana
  participant I as NEAR Intents 1Click
  participant Z as Zcash (shielded)

  D->>A: POST /v1/transfers/prepare {to: @bob, mode: stealth}
  A-->>D: stealth.depositAccount (entry, one-time)
  D->>A: POST /v1/transfers/submit {withdraw plan, senderNote}
  A->>S: withdraw to the entry address
  A->>I: quote USDC → ZEC, recipient: route's shielded address
  A->>S: entry → 1Click deposit address
  I->>Z: ZEC to the shielded address
  Note over A: random 2–20 min wait
  A->>I: quote ZEC → USDC, recipient: exit (one-time)
  A->>Z: shielded → 1Click deposit address
  I->>S: USDC to the exit address
  A->>S: exit: open account, deposit, confidential transfer to Bob, close accounts
  A-->>D: transfer.settled
```

On-chain, the sender's withdrawal and the recipient's incoming transfer are joined only through the shielded pool. Route addresses derive from `STEALTH_ROUTE_SEED` and the route id, so nothing about them is stored; 1Click deposit addresses are stored before money moves; amounts are read from the chain or from 1Click at each step and held in memory only. A failed first leg is refunded to the entry address and paid back to the sender; a failed return leg is retried.

The shielded wallet is zingolib's `zingo-cli`, a light wallet syncing from a public lightwalletd server over the Nym mixnet (`nym-proxy`), installed in the API's Docker image.

## View keys

A view key is an access secret and a decryption key derived from the owner's passkey and the key's id. The owner's device decrypts each transfer in scope and re-encrypts its amount and memo to the key (AES-256-GCM, bound to the transfer id); Vexa stores those records and a hash of the access secret, never the decryption key. `GET /v1/audit/export` returns them as a CSV signed with an Ed25519 key derived from `VIEW_KEY_ENCRYPTION_KEY`; the auditor's SDK checks the signature and decrypts. Revoking deletes the records.

The mint's auditor key would give one key to every transfer on the platform, so it isn't how view keys work.

## $VEXA

An SPL token (1B supply, 6 decimals, mint and freeze authority revoked) created by `pnpm token:create`. Holders stake in the vault (`Stake`/`Unstake`, 7-day lock after each top-up); a holder's weight is staked + wallet ÷ 2. The vault reads the stake record and wallet account passed with a deposit or withdrawal and applies the tier discount itself; the API caps agents and their daily limits by the same tiers.
