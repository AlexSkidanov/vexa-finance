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
{ "to": "@bob.vexa" }
```

```json
{
  "transferId": "…",
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

| Event               | `data`                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------- |
| `transfer.settled`  | `transferId`, `direction`, `txSig`, `ciphertext`                                        |
| `deposit.confirmed` | `depositId`, `txSig`, and `source: "chain"` when the deposit was made directly on-chain |
| `withdrawal.sent`   | `withdrawalId`, `destination`, `txSig`                                                  |

No event ever contains a plaintext amount.

---

## Provider hooks

### `POST /v1/hooks/alchemy`

Alchemy address-activity notifications, authenticated by `x-alchemy-signature` (HMAC-SHA256 of the raw body under the webhook's signing key). Each transaction is queued once, keyed by signature, and processed by the indexer, which records vault deposits made directly on-chain. Disabled when `ALCHEMY_WEBHOOK_SIGNING_KEY` isn't set.
