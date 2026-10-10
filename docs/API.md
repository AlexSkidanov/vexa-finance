# Vexa API reference

Base URLs

| Environment                   | URL                                | API key prefix |
| ----------------------------- | ---------------------------------- | -------------- |
| Live (Solana mainnet)         | `https://api.vexa.finance`         | `vx_live_`     |
| Test (devnet, when available) | `https://sandbox.api.vexa.finance` | `vx_test_`     |

A deployment serves exactly one environment, and a key from the other one is rejected with `wrong_environment` before any database lookup. `@vexa/sdk` picks the base URL from the key prefix.

## Conventions

### Authentication

Send `Authorization: Bearer <token>`, where the token is either:

- a **session access token** from `/v1/auth/otp/verify`, `/v1/auth/passkeys/login/verify` or `/v1/auth/refresh`, for apps acting as a signed-in user, or
- an **API key** (`vx_live_…`), for servers and agents.

Some actions require a session and refuse API keys; they're marked **session only** below.

### Idempotency

Every endpoint that creates something requires an `Idempotency-Key` header: 8 to 255 printable ASCII characters. A UUID is ideal.

| Situation                                         | Result                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| First request with a key                          | Processed normally; the response is stored for 24 hours          |
| Same key, same method, path and body              | The stored response is returned with `Idempotent-Replayed: true` |
| Same key while the first request is still running | `409 idempotency_request_in_progress`: retry shortly             |
| Same key, different request                       | `422 idempotency_key_reused`                                     |

Server errors (5xx) aren't stored, so a request that failed on our side can be retried with the same key. The SDK generates a key per call and reuses it across its automatic retries.

### Errors

Every error has the same shape:

```json
{
  "error": {
    "code": "handle_taken",
    "message": "That handle is already taken",
    "requestId": "req_3b1f0c2e-…",
    "details": []
  }
}
```

`code` is stable and safe to branch on; `message` is for humans. `details` appears on validation errors with per-field messages. Every response also carries an `x-request-id` header. Include it when reporting a problem.

| Code                                                        | Status | Meaning                                                                      |
| ----------------------------------------------------------- | ------ | ---------------------------------------------------------------------------- |
| `invalid_request`                                           | 400    | Malformed JSON or failed validation (see `details`)                          |
| `invalid_signature`                                         | 400    | A signature didn't verify against the key it claims                          |
| `idempotency_key_missing` / `idempotency_key_invalid`       | 400    | Create call without a usable `Idempotency-Key`                               |
| `unauthenticated`                                           | 401    | Missing, expired or invalid credentials                                      |
| `invalid_api_key`                                           | 401    | Unknown, malformed or revoked API key                                        |
| `wrong_environment`                                         | 401    | A `vx_test_` key on a live deployment or vice versa                          |
| `forbidden`                                                 | 403    | Authenticated, but not allowed (e.g. an API key where a session is required) |
| `not_found`                                                 | 404    | No such resource, or not yours                                               |
| `handle_taken` / `handle_already_claimed` / `pubkey_in_use` | 409    | Handle conflicts                                                             |
| `idempotency_request_in_progress`                           | 409    | See [Idempotency](#idempotency)                                              |
| `idempotency_key_reused`                                    | 422    | See [Idempotency](#idempotency)                                              |
| `rate_limited`                                              | 429    | Slow down; honor `Retry-After`                                               |
| `internal_error`                                            | 500    | Our fault. Safe to retry with the same idempotency key                       |

### Amounts

The API never accepts, returns or logs a plaintext transfer amount. Amounts travel as ElGamal ciphertexts produced by the SDK on the user's device. Where USDC amounts do appear in plaintext (policy limits, and deposits and withdrawals, which are public on-chain anyway) they are integer strings in base units: `"12500000"` is 12.5 USDC.

---

## Health

### `GET /health`

Liveness. No authentication.

```json
{ "status": "ok", "version": "3f2a91c", "cluster": "mainnet-beta", "environment": "live" }
```

### `GET /health/ready`

Readiness: the database is reachable. `503` with `"status": "unavailable"` otherwise.

---

## Auth

### `POST /v1/auth/otp`

Emails a one-time code. Creates the account on first use. Rate-limited to 5 per minute per IP.

```json
{ "email": "alex@example.com" }
```

Always answers `202 { "sent": true }`, whether or not the address has an account.

### `POST /v1/auth/otp/verify`

```json
{ "email": "alex@example.com", "token": "123456" }
```

Returns a **Session**:

```json
{
  "accessToken": "eyJhbGciOiJFUzI1NiIs…",
  "refreshToken": "v1.MjQ…",
  "expiresAt": 1790581200,
  "user": { "id": "5c1c…", "email": "alex@example.com" }
}
```

`401 unauthenticated` if the code is wrong or expired.

### `POST /v1/auth/refresh`

```json
{ "refreshToken": "v1.MjQ…" }
```

Returns a new Session.

### `POST /v1/auth/passkeys/register/options`

**Session only.** Returns WebAuthn creation options with the PRF extension requested.

```json
{
  "challengeId": "0b7e…",
  "options": { "challenge": "…", "rp": { "id": "vexa.finance", "name": "Vexa" }, "…": "…" }
}
```

### `POST /v1/auth/passkeys/register/verify`

**Session only.**

```json
{
  "challengeId": "0b7e…",
  "response": { "id": "…", "rawId": "…", "response": { "…": "…" }, "type": "public-key" },
  "name": "MacBook"
}
```

`201 { "id": "<credential id>", "backedUp": true }`. `backedUp` is true for synced passkeys (iCloud Keychain, Google Password Manager).

### `POST /v1/auth/passkeys/login/options`

No authentication. Body may be `{}`. Returns `{ challengeId, options }` for a discoverable-credential sign-in: the browser offers whichever Vexa passkey the user has.

### `POST /v1/auth/passkeys/login/verify`

```json
{
  "challengeId": "9a1d…",
  "response": { "id": "…", "response": { "authenticatorData": "…", "signature": "…", "…": "…" } }
}
```

Returns a Session. The passkey's PRF output never leaves the device; the SDK returns it to the caller for key derivation.

---

## Profile

### `GET /v1/me`

```json
{
  "userId": "5c1c…",
  "email": "alex@example.com",
  "handle": "@alex.vexa",
  "solanaPubkey": "7xKX…",
  "elgamalPubkey": "nL3q…=",
  "kycStatus": "none",
  "tier": 0,
  "createdAt": "2026-09-28T09:12:44.000Z"
}
```

`handle`, `solanaPubkey` and `elgamalPubkey` are `null` until a handle is claimed.

---

## Handles

A handle is 3 to 20 characters of lowercase letters, digits, `-` and `_`; it must start and end with a letter or digit and can't repeat separators. `alex`, `@alex` and `@alex.vexa` all refer to the same handle. Names that could impersonate staff, the product or system accounts are reserved.

### `POST /v1/handles/claim`

**Idempotent.** Binds a handle to the caller's public keys, both generated on their device.

```json
{
  "handle": "alex",
  "solanaPubkey": "7xKX…",
  "elgamalPubkey": "nL3q…=",
  "signature": "4vJ9…"
}
```

`signature` is a base58 ed25519 signature by `solanaPubkey` over this exact UTF-8 message, lines joined with `\n`:

```text
Vexa handle claim
handle: @alex.vexa
user: <your user id>
solana: <solanaPubkey>
elgamal: <elgamalPubkey>
```

It proves the caller holds the key the handle will point to, and it can't be replayed for another user or another name. `elgamalPubkey` must be a valid, non-identity Ristretto255 point (base64).

`201` returns the updated Profile. Errors: `invalid_request` (format or reserved name), `invalid_signature`, `409 handle_taken`, `409 handle_already_claimed`, `409 pubkey_in_use`.

### `GET /v1/handles/:handle/resolve`

Public, rate-limited. Returns what a sender needs to pay the handle:

```json
{
  "handle": "alex",
  "display": "@alex.vexa",
  "kind": "user",
  "solanaPubkey": "7xKX…",
  "elgamalPubkey": "nL3q…="
}
```

`404` for unknown, malformed and reserved handles alike.

---

## API keys

### `POST /v1/api-keys`

**Session only. Idempotent.**

```json
{ "name": "trading bot" }
```

```json
{
  "id": "e2b1…",
  "name": "trading bot",
  "prefix": "vx_live_4Hq2",
  "environment": "live",
  "createdAt": "2026-09-28T09:20:00.000Z",
  "lastUsedAt": null,
  "revokedAt": null,
  "secret": "vx_live_4Hq2…"
}
```

`secret` is returned **once**. Only a keyed hash is stored, and the secret is left out of the idempotency record, so a replay of this request returns the summary without it. If the response was lost, revoke the key and create another.

### `GET /v1/api-keys`

`{ "data": [ApiKeySummary, …] }`, newest first. Works with a session or an API key.

### `DELETE /v1/api-keys/:id`

**Session only.** `204` on success; `404` if the key doesn't exist, isn't yours or is already revoked.

---

## Money

Every money movement is a **plan**: one or more stages of Solana transactions, built and signed on the user's device with `@vexa/core/solana` (the SDK's `vexa.money` does all of this for you). The API checks every transaction against its sponsorship policy (see [ARCHITECTURE.md](ARCHITECTURE.md#sponsored-transactions)), adds the fee payer's signature, simulates, sends, and records the result. Users never need SOL.

A plan in a request body:

```json
{
  "kind": "transfer",
  "stages": [
    [{ "label": "create-proof-contexts", "transaction": "<base64 wire transaction>" }],
    [
      { "label": "verify-equality-and-validity", "transaction": "…" },
      { "label": "verify-range", "transaction": "…" }
    ],
    [{ "label": "transfer", "transaction": "…" }]
  ]
}
```

Plans that break the policy are refused with `400 plan_refused`; `details.stage` and `details.transaction` point at the offending transaction. A transaction that fails on-chain returns `502 chain_error` with the signatures that did land; any proof context accounts the plan created are closed so their rent is recovered.

### `GET /v1/chain`

What a device needs to build plans.

```json
{
  "cluster": "mainnet-beta",
  "feePayer": "gH4xWApDaUrvSEJrueiSdVygEemVDuJwnwJx4z2ifDN",
  "vault": {
    "program": "3g2JPX4roASUJVacf68sBSpARk5m9B3hu9xeaE6mTjPR",
    "config": "7Q3LNA4P3J7H4zNdHJEephe2XEvBPKPUJsqGifexRopw",
    "usdcMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "cusdcMint": "4STXpFN2mQSt12XG4os7ftLXHbBq5PVWYCAahToRt6QQ",
    "usdcReserve": "8eeishQYvtHwwM8QRN9629zzU9hBn18dGFW5T75ytqz6",
    "fees": "4PAtQdQRVfozc2F8x4eJF1oHhAQ6EMfX5EqBgPGnj29u"
  },
  "feeSchedule": {
    "feeBps": 10,
    "feeCap": "5000000",
    "treasury": "713NQALYzFN2zVSJ1ERqhSFiQTMqVnFyCVybYdn3r9Gj",
    "vexaMint": null,
    "tiers": []
  },
  "auditorElgamalPubkey": null,
  "rent": {
    "confidentialAccount": "3032760",
    "equalityContext": "1468120",
    "validityContext": "2606040",
    "rangeU128Context": "2159000",
    "rangeU64Context": "2159000"
  },
  "blockhash": "…",
  "lastValidBlockHeight": "…"
}
```

`feeSchedule` is what the vault charges on deposits and withdrawals (see [Fees](#fees)). It's `null` until the vault admin sets one; until then the vault refuses to move money.

### Fees

Vexa charges **0.10% of each deposit and withdrawal, capped at 5 USDC**. Transfers between Vexa users are free. The fee is charged by the vault program itself, in USDC, straight to the treasury, so it applies however the transaction was built and never passes through the reserve that backs cUSDC.

Deposits and withdrawals are the only places an amount is public, which is why the fee lives there: charging it on a confidential transfer would need another proof and would reveal a bound on the amount.

- **Deposit** `amount`: the fee comes out of it; `amount − fee` lands in the confidential balance.
- **Withdrawal** `amount`: `amount` leaves the confidential balance; the destination receives `amount − fee`.
- The fee is `min(⌈amount × feeBps / 10 000⌉, feeCap)`, rounded up, so every movement pays at least one base unit. An amount that doesn't cover its own fee is refused.
- Holding $VEXA earns a discount off the fee, by tier (live once $VEXA launches in Phase 3). The device passes its $VEXA account to the vault, which reads the balance itself.
- The program refuses any rate above **1%**, whoever holds the admin key.

`vexa.money.quote(amount)` returns `{ fee, net, discountBps }` with the vault's exact arithmetic; `deposit()` and `withdraw()` return the same fields.

### `GET /v1/balance`

The user's cUSDC balance **as ciphertexts**. Decrypt on the device: the AE key reads `decryptableAvailableBalance`, the ElGamal key reads the pending halves. `feeDiscount` is the $VEXA fee tier the user qualifies for, if any: the account to present to the vault and its discount, never the balance.

```json
{
  "cusdcAccount": "…",
  "usdcAccount": "…",
  "feeDiscount": null,
  "configured": true,
  "confidential": {
    "pendingBalanceLo": "<base64>",
    "pendingBalanceHi": "<base64>",
    "availableBalance": "<base64>",
    "decryptableAvailableBalance": "<base64>",
    "pendingBalanceCreditCounter": "1",
    "maximumPendingBalanceCreditCounter": "65536"
  }
}
```

### `POST /v1/accounts/confidential`

**Idempotent.** `{ "plan": { "kind": "configure", … } }`. Opens the user's confidential cUSDC account. Vexa sponsors the account's rent, once, only while the account doesn't exist. Returns `201 { "signatures": [...] }`.

### `POST /v1/deposits`

**Idempotent.** `{ "plan": { "kind": "deposit", … } }`. USDC from the user's wallet into the vault, less the [fee](#fees); the cUSDC lands in the confidential balance and is applied in the same transaction. Deposits are public on-chain, like any USDC transfer; the API still doesn't record the amount. Emits `deposit.confirmed`.

```json
{ "id": "…", "status": "confirmed", "txSig": "…" }
```

### `POST /v1/balance/apply`

**Idempotent.** `{ "plan": { "kind": "apply-pending", … } }`. Makes received transfers spendable.

### `POST /v1/transfers/prepare`

**Idempotent.** Resolves the recipient and returns the keys the device encrypts to. **No amount is sent, now or later.**

```json
{ "to": "@bob.vexa", "mode": "standard" }
```

`to` may also be `agent:<id>` to fund one of your agents. Set `agentId` when one of your agents is the payer (its payment is then submitted with [`POST /v1/agents/:id/payments`](#post-v1agentsidpayments)). `mode: "stealth"` starts a [stealth transfer](#stealth-transfers) and adds `stealth.depositAccount`, the one-time address to withdraw to.

```json
{
  "transferId": "…",
  "mode": "standard",
  "recipient": {
    "handle": "@bob.vexa",
    "solanaPubkey": "…",
    "elgamalPubkey": "<base64>",
    "cusdcAccount": "…"
  }
}
```

`404` for an unknown handle, `409 recipient_not_ready` if the recipient hasn't opened their account, `400` when sending to yourself.

### `POST /v1/transfers/submit`

**Idempotent.**

```json
{
  "transferId": "…",
  "plan": { "kind": "transfer", "stages": [ … ] },
  "memoCiphertext": "<optional base64, encrypted on the device>"
}
```

Before sending, the API reads the grouped ciphertexts from the plan's validity proof and checks they're encrypted to the prepared sender, recipient and the mint's auditor. Those ciphertexts are all it stores. Emits `transfer.settled` to both parties. `409 transfer_already_submitted` if the transfer was already sent.

For a stealth transfer, `plan` is a `withdraw` plan paying the prepared `stealth.depositAccount`, plus `senderNote`: the amount encrypted to the sender's own AE key, so their activity can show it. Returns `202`; the route continues in the background.

### `GET /v1/transfers/:id`

A transfer you sent. Stealth transfers add `stealth: { status, updatedAt }`.

### Stealth transfers

A stealth transfer leaves no on-chain link between sender and recipient. The sender withdraws to a one-time **entry** address; Vexa's stealth worker swaps it to ZEC through NEAR Intents 1Click into a shielded Zcash address it controls, waits a random 2 to 20 minutes, swaps back to USDC at a one-time **exit** address, deposits it into the vault and pays the recipient confidentially.

| `stealth.status` | Meaning                                                                      |
| ---------------- | ---------------------------------------------------------------------------- |
| `awaiting_funds` | Prepared; the sender's withdrawal hasn't landed                              |
| `routing`        | USDC → ZEC at 1Click                                                         |
| `shielded`       | ZEC in the shielded pool, waiting out the delay                              |
| `returning`      | ZEC → USDC at 1Click                                                         |
| `settling`       | Paying the recipient                                                         |
| `settled`        | Done: `transfer.settled` to both sides                                       |
| `refunding`      | The first swap failed; paying the sender back                                |
| `refunded`       | Back with the sender: `transfer.refunded`                                    |
| `failed`         | Needs a person (for example 1Click held funds); Vexa's operators are alerted |

Costs: the vault fee twice (withdraw and deposit), 1Click's fees (about 0.6 USDC in withdraw fees at today's prices, plus about 0.2% without a partner key), and ZEC network fees. The SDK refuses stealth transfers under 5 USDC. The recipient receives what's left; the sender's activity shows what they sent. Amounts are read from the chain and from 1Click while routing and held in memory only.

### `POST /v1/withdrawals`

**Idempotent.**

```json
{ "plan": { "kind": "withdraw", … }, "destinationAccount": "<an existing USDC token account>" }
```

The destination receives the amount less the [fee](#fees). It must already be a USDC token account (a wallet's USDC account, an exchange deposit address): creating one costs permanent rent, which Vexa doesn't sponsor. Emits `withdrawal.sent`.

### `GET /v1/activity?limit=50&before=<ISO timestamp>`

Transfers sent and received, deposits and withdrawals, newest first. Transfer amounts come as grouped ElGamal ciphertexts: the sender decrypts with handle 0 and the recipient with handle 1 (`decryptTransferAmount` in `@vexa/core/crypto`), and memos with `decryptMemo`.

```json
{
  "data": [
    {
      "kind": "transfer",
      "id": "…",
      "direction": "received",
      "to": "@bob.vexa",
      "ciphertext": { "groupedLo": "<base64>", "groupedHi": "<base64>" },
      "memoCiphertext": "<base64 or null>",
      "txSig": "…",
      "createdAt": "…"
    },
    { "kind": "deposit", "id": "…", "status": "confirmed", "txSig": "…", "createdAt": "…" }
  ]
}
```

### `GET /v1/tier`

Your $VEXA position and the tier it earns. Staked $VEXA counts in full, wallet $VEXA at half.

```json
{
  "vexaMint": "…",
  "staked": "10000000000",
  "held": "10000000000",
  "weight": "15000000000",
  "unlockAt": "2026-10-07T12:00:00.000Z",
  "tier": { "level": 2, "discountBps": 2500, "maxAgents": 10, "agentDailyLimit": "10000000000" }
}
```

| Tier | Weight ($VEXA) | Fee discount | Agents | Agent limit per day |
| ---- | -------------- | ------------ | ------ | ------------------- |
| 0    | 0              | 0%           | 3      | $500                |
| 1    | 1,000          | 10%          | 5      | $2,500              |
| 2    | 10,000         | 25%          | 10     | $10,000             |
| 3    | 100,000        | 50%          | 25     | $25,000             |
| 4    | 1,000,000      | 75%          | 50     | $50,000             |

### `POST /v1/stake` · `POST /v1/unstake`

**Idempotent.** `{ "plan": { "kind": "stake" | "unstake", … } }`. Stakes lock for 7 days after each top-up. Vexa pays the stake record's rent the first time.

---

## Agents

An agent is a sub-account for software (an AI agent paying for APIs, say) with limits the owner sets. Its Solana address is a NEAR MPC key derived for the policy contract and `vexa-agent-{id}`: nobody holds its private key. The policy contract asks the MPC network to sign an agent's transaction only when it's within the agent's policy.

- **Owners** authorize changes with the Ed25519 key of their Solana wallet (`ownerSignature`), over the contract's authorization message (`authorizationMessage` in `@vexa/core/agent`).
- **Agents** authorize payments with their own authority key, derived from their credential.
- Amounts stay private: a payment carries a proof that it fits the per-payment limit and what's left of the rolling 24-hour limit, which the contract checks against the payment's hidden amount (see [ARCHITECTURE.md](ARCHITECTURE.md#agents)).

All `/v1/agents` routes return `404` where the policy contract isn't configured. Refusals by the contract are `403 policy_refused`, with the contract's rule in `details.rule` (`LIMIT_PROOF_MISMATCH`, `RECIPIENT_NOT_ALLOWED`, `DOMAIN_NOT_ALLOWED`, `AGENT_PAUSED`, `AGENT_REVOKED`, `STALE_INDEX`, `BAD_SIGNATURE`, …). `403 agent_limit_reached` means your tier doesn't allow another agent or that daily limit.

### `GET /v1/agents/config`

`{ policyContract, mpcRootKey, feePayer }`: what a device needs to derive agent addresses and authorizations.

### `POST /v1/agents`

**Idempotent.**

```json
{
  "id": "<uuid chosen by the device>",
  "name": "research-bot",
  "authority": "<base58 Ed25519 key>",
  "elgamalPubkey": "<base64>",
  "policy": {
    "maxPerRequest": "10000000",
    "dailyLimit": "25000000",
    "allowedRecipients": [],
    "allowedDomains": ["api.example.com"]
  },
  "ownerSignature": "<base58>"
}
```

Creates the agent's durable nonce account (sponsored), registers the policy on NEAR and returns the agent. Policy limits are configuration, not balances, and are stored in plaintext. The SDK's `vexa.agents.create()` also opens the agent's confidential account and returns its **credential** (`vxagent_…`) for the agent software.

### `GET /v1/agents` · `GET /v1/agents/:id`

`GET /v1/agents/:id` adds the contract's `authNonce` and `nextPaymentIndex`.

### `PATCH /v1/agents/:id/policy` · `POST /v1/agents/:id/pause` · `POST /v1/agents/:id/revoke`

**Idempotent.** `{ policy | paused, nonce, ownerSignature }`. Revoking is final; the owner can still sweep the agent's funds back.

### `POST /v1/agents/:id/configure` · `POST /v1/agents/:id/apply` · `POST /v1/agents/:id/sweep`

**Idempotent.** `{ plan, signer: "agent" | "owner", nonce, signature }`: open the agent's confidential account, apply its pending balance, or send everything it holds back to the owner (allowed even when paused or revoked).

### `GET /v1/agents/:id/state`

What the agent's device needs for its next payment: balance ciphertexts, the durable nonce, `authNonce`, `nextIndex`, and the payments in its 24-hour window as ciphertexts (which it decrypts to prove the daily limit).

### `POST /v1/agents/:id/payments`

**Idempotent.** A payment prepared with `POST /v1/transfers/prepare { to, agentId }`:

```json
{
  "transferId": "…",
  "plan": { "kind": "agent-payment", "stages": [ … ] },
  "signer": "agent",
  "nonce": "7",
  "signature": "<base58, by the agent's authority>",
  "index": "3",
  "windowStart": "1",
  "domain": "api.example.com",
  "validityContext": "<base64>",
  "limitContext": "<base64>"
}
```

The API checks the plan against the sponsorship policy, sends the proof stages, asks the policy contract for the agent's signature (which checks the limit proof against the transfer's hidden amount), then sends the transfer. Emits `transfer.settled`.

### `GET /v1/agents/:id/activity` · `POST /v1/agents/:id/traces` · `GET /v1/agents/:id/traces?requestId=`

Payments the agent made (as ciphertexts), and the steps it logged: `request`, `payment_required`, `quote`, `policy_check`, `paid`, `retried`, `completed`, `failed`. Trace details describe what happened (URL, recipient, outcome) and never include an amount.

### x402

`VexaAgent.fetch()` in `@vexa/sdk` pays [x402](https://x402.org) `402 Payment Required` responses. A server that accepts Vexa lists this in `accepts`:

```json
{
  "x402Version": 1,
  "accepts": [
    {
      "scheme": "vexa",
      "network": "solana",
      "maxAmountRequired": "5000000",
      "resource": "https://api.example.com/report",
      "payTo": "@shop.vexa",
      "asset": "<cUSDC mint>"
    }
  ]
}
```

The agent pays `payTo` confidentially within its policy (the request's hostname is the policy `domain`) and retries with `X-PAYMENT: base64({ x402Version, scheme, network, payload: { transferId, txSig } })`. `parseX402Payment()` reads that header; the seller sees the payment, amount decrypted, in its own activity.

---

## View keys

A view key gives an auditor read access to your transfers in a date range, and is revocable. It's `vxview_<id>.<access secret>.<decryption key>`, derived from your passkey. Your device re-encrypts each transfer in scope (amount and memo) to the key and uploads only those records. Vexa stores a hash of the access secret and never the decryption key, so it can't read what it serves.

### `POST /v1/view-keys`

**Idempotent.** `{ id, label?, from, to, accessHash }`. `vexa.viewKeys.create()` does this and uploads the records; `vexa.viewKeys.sync()` adds transfers made since.

### `GET /v1/view-keys` · `GET /v1/view-keys/:id` · `POST /v1/view-keys/:id/records` · `DELETE /v1/view-keys/:id`

Records must be transfers you sent or received inside the key's scope. Deleting revokes the key and deletes its records.

### `GET /v1/audit/export?viewKey=<id>.<access secret>`

No other authentication. Returns a CSV of the transfers in scope, each record still encrypted, signed twice over the exact body bytes:

- `X-Vexa-Signature`: Ed25519, base58.
- `X-Vexa-Signature-ML-DSA-65`: post-quantum ML-DSA-65 (NIST FIPS 204), base64, empty context string. An archived export stays verifiable after Ed25519 can be forged.

```csv
# vexa audit export; view key …; scope … to …
transfer_id,created_at,direction,counterparty,tx_sig,record
…,2026-09-30T10:00:00.000Z,sent,bob,5Kx…,<base64>
```

`exportAudit(viewKey)` in `@vexa/sdk` fetches it, checks both signatures against `GET /v1/audit/signing-key`, and decrypts every row on the auditor's device. `signatureValid` is true only if every signature on the export verifies; `pqSignatureValid` reports the ML-DSA-65 one on its own.

### `GET /v1/audit/signing-key`

```json
{
  "algorithm": "ed25519",
  "publicKey": "<base58>",
  "keys": [
    { "algorithm": "ed25519", "encoding": "base58", "publicKey": "<base58>" },
    { "algorithm": "ml-dsa-65", "encoding": "base64", "publicKey": "<base64, 1952 bytes>" }
  ]
}
```

`algorithm` and `publicKey` are kept for existing verifiers. Both keys are derived from `VIEW_KEY_ENCRYPTION_KEY`, so they only change if that secret does.

---

## Webhooks

### `POST /v1/webhooks`

**Idempotent.**

```json
{
  "url": "https://example.com/vexa",
  "events": ["transfer.settled", "deposit.confirmed", "withdrawal.sent"]
}
```

Returns the endpoint with its `secret` (`whsec_…`), **once**. URLs must be https and must not point at loopback or private networks; the delivery worker re-checks the resolved address before every send.

### `GET /v1/webhooks` · `DELETE /v1/webhooks/:id`

### `POST /v1/webhooks/verify`

`{ "webhookId", "payload", "signature" }` → `{ "valid": true, "timestamp": … }` or `{ "valid": false, "reason": "malformed" | "expired" | "mismatch" }`. Handy while wiring up a receiver; in production, verify locally with `verifyWebhookSignature` from `@vexa/sdk`.

### Deliveries

```http
POST /your/endpoint
Content-Type: application/json
Vexa-Signature: t=1790581200,v1=5f0c…
Vexa-Event-Id: 0b7e…

{ "id": "0b7e…", "type": "transfer.settled", "createdAt": "…", "data": { "transferId": "…", "direction": "received", "txSig": "…", "ciphertext": { … } } }
```

`v1` is the hex HMAC-SHA256 of `"<t>.<raw body>"` under the endpoint's secret. Reject timestamps more than five minutes old, and use `Vexa-Event-Id` to ignore duplicates: failed deliveries are retried with exponential backoff (30 s, doubling) for about four hours.

| Event                      | `data`                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `transfer.settled`         | `transferId`, `direction`, `txSig`, `ciphertext`                                        |
| `deposit.confirmed`        | `depositId`, `txSig`, and `source: "chain"` when the deposit was made directly on-chain |
| `withdrawal.sent`          | `withdrawalId`, `destination`, `txSig`                                                  |
| `transfer.stealth_updated` | `transferId`, `status` (`routing`, `shielded`, `returning`)                             |
| `transfer.refunded`        | `transferId`: a stealth transfer went back to the sender                                |

No event ever contains a plaintext amount.

---

## Provider hooks

### `POST /v1/hooks/alchemy`

Alchemy address-activity notifications, authenticated by `x-alchemy-signature` (HMAC-SHA256 of the raw body under the webhook's signing key). Each transaction is queued once, keyed by signature, and processed by the indexer, which records vault deposits made directly on-chain. Disabled when `ALCHEMY_WEBHOOK_SIGNING_KEY` isn't set.
