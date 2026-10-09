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
