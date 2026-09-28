# Vexa backend: environment setup

This guide produces every value in `.env.example`. Work top to bottom, then run:

```bash
cp .env.example .env      # first time only
pnpm install
pnpm check-env
```

`check-env` validates formats, probes every service, and prints a pass/fail table. Rows marked **PENDING** are produced by later phases (program deploys, contract deploys) and are expected to be empty now.

Secrets never leave `.env` except into Railway and GitHub Actions secrets. `.env` is gitignored.

---

## 0. Local toolchain

| Tool        | Install                                                           | Needed for                   |
| ----------- | ----------------------------------------------------------------- | ---------------------------- |
| Node 20+    | `brew install node`                                               | everything                   |
| pnpm 9      | `corepack enable`                                                 | everything                   |
| Solana CLI  | `sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`   | keypairs, airdrops, deploys  |
| Rust        | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` | vault program, NEAR contract |
| near-cli-rs | `npm i -g near-cli-rs`                                            | NEAR account below           |
| cargo-near  | `cargo install --locked cargo-near`                               | Phase 3                      |

---

## 1. App secrets (generated locally)

Run three times and paste one value into each:

```bash
openssl rand -hex 32
```

| Variable                  | Value                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| `API_KEY_ENCRYPTION_KEY`  | 1st output. HMAC pepper for hashing `vx_test_` / `vx_live_` API keys. |
| `WEBHOOK_SIGNING_SECRET`  | 2nd output. Master secret for outbound webhook signatures.            |
| `VIEW_KEY_ENCRYPTION_KEY` | 3rd output. Wraps stored view keys. Must differ from the first.       |

Rotating any of these later invalidates existing API keys, webhook secrets, or view keys respectively, so generate once and keep them.

`API_BASE_URL`: `http://localhost:8787` for local dev. Replace with the Railway URL (or `https://api.vexa.finance`) once deployed.

WebAuthn (passkeys):

| Variable           | Local                   | Production                                      |
| ------------------ | ----------------------- | ----------------------------------------------- |
| `WEBAUTHN_RP_ID`   | `localhost`             | `vexa.finance`                                  |
| `WEBAUTHN_RP_NAME` | `Vexa`                  | `Vexa`                                          |
| `WEBAUTHN_ORIGINS` | `http://localhost:3000` | `https://vexa.finance,https://app.vexa.finance` |

The RP ID must be the origin's hostname or a parent of it. Passkeys registered under `localhost` will not work on `vexa.finance`.

---

## 2. Supabase

1. Go to **supabase.com/dashboard** → **New project**. Name `vexa`, pick a strong database password and **save it** (you need it for the DB URL), region closest to your Railway region (e.g. `us-east-1`).
2. **`SUPABASE_URL`**: **Project Settings** (gear, bottom left) → **Data API** → **Project URL**. Looks like `https://abcdxyz.supabase.co`.
3. **`SUPABASE_ANON_KEY`** and **`SUPABASE_SERVICE_ROLE_KEY`**: **Project Settings** → **API Keys**.
   - New-style keys: copy the **Publishable key** (`sb_publishable_...`) → `SUPABASE_ANON_KEY`, and reveal/copy a **Secret key** (`sb_secret_...`) → `SUPABASE_SERVICE_ROLE_KEY`.
   - Or the **Legacy API Keys** tab: `anon` `public` → `SUPABASE_ANON_KEY`, `service_role` `secret` → `SUPABASE_SERVICE_ROLE_KEY`.
   - Either style works. Don't mix the two.
4. **`SUPABASE_JWT_SECRET`**: **Project Settings** → **JWT Keys**.
   - If you used legacy keys in step 3: open the **Legacy JWT Secret** tab → reveal → copy. Required.
   - If the project uses asymmetric **JWT Signing Keys** (the default on new projects), leave this blank. The API verifies sessions against the project's JWKS, and `check-env` confirms the JWKS is populated.
5. **`SUPABASE_DB_URL`**: click **Connect** in the top bar → **Connection String** tab → **Session pooler** → copy the URI and replace `[YOUR-PASSWORD]` with the password from step 1. It looks like:
   `postgresql://postgres.abcdxyz:<password>@aws-0-us-east-1.pooler.supabase.com:5432/postgres`
   Use the **session pooler (port 5432)**, not the direct connection (IPv6-only, which Railway can't reach) and not the transaction pooler (port 6543, breaks migrations). URL-encode special characters in the password (`@` → `%40`, `#` → `%23`, and so on).
6. Auth settings (no env values, but needed for Phase 1):
   - **Authentication** → **Sign In / Providers** → **Email**: enabled. Turn **Confirm email** on.
   - **Authentication** → **Emails** → **Templates** → **Magic Link**: replace the body with a code-based template containing `{{ .Token }}` so users get a 6-digit OTP instead of a link.
   - **Authentication** → **Emails** → **SMTP Settings**: before real users, plug in your own SMTP (Resend, Postmark, SES). The built-in sender is heavily rate-limited.
   - **Authentication** → **URL Configuration** → **Site URL**: your frontend URL.

Passkeys are handled by our API (WebAuthn via `@simplewebauthn/server`) with Supabase issuing the session, so Supabase itself needs no passkey settings.

---

## 3. Alchemy (Solana RPC + deposit webhooks)

1. **dashboard.alchemy.com** → sign in → **Create new app**. Name `vexa-backend`, chain **Solana**. Create.
2. **`ALCHEMY_SOLANA_RPC_URL`**: open the app → **Networks** (or **Endpoints**) tab → select **Solana** → **Mainnet** → copy the **HTTPS** URL:
   `https://solana-mainnet.g.alchemy.com/v2/<api-key>`
3. **`ALCHEMY_WEBHOOK_SIGNING_KEY`**: left nav **Webhooks** (under Data / Notify) → **Create Webhook**:
   - Type: **Address Activity**
   - Chain: **Solana**, Network: **Mainnet**
   - Webhook URL: the API isn't deployed yet, so use a temporary URL from **webhook.site**. We change it to `${API_BASE_URL}/webhooks/alchemy` after the Phase 1 deploy.
   - Addresses: paste the fee payer pubkey from step 4 below as a placeholder. Phase 2 adds the vault's USDC token account automatically.
   - **Create Webhook**, then open it and copy the **Signing Key** (`whsec_...`).
4. For Phase 2 (can fill now):
   - **`ALCHEMY_WEBHOOK_ID`**: the webhook's ID shown on its detail page (`wh_...`).
   - **`ALCHEMY_NOTIFY_AUTH_TOKEN`**: on the **Webhooks** page, click **Auth Token** (top right) → copy. This lets the API add addresses to the webhook programmatically.

---

## 4. Solana keypairs

Two separate keys. The fee payer is hot (the API signs with it on every request). The admin key is the program upgrade authority and should stay out of the API process in production.

```bash
mkdir -p ~/.config/vexa
solana-keygen new -o ~/.config/vexa/fee-payer.json
solana-keygen new -o ~/.config/vexa/admin.json
```

Note both pubkeys (`solana-keygen pubkey ~/.config/vexa/fee-payer.json`).

**`SOLANA_FEE_PAYER_KEYPAIR`** / **`SOLANA_ADMIN_KEYPAIR`**: either format works:

- The JSON array as-is: `cat ~/.config/vexa/fee-payer.json` and paste the whole `[12,34,...]` line.
- Or base58: open the file in **Phantom/Solflare → Import private key** and export as base58, or run:
  ```bash
  node -e "const k=require(process.argv[1]),A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n;for(const b of k)n=n*256n+BigInt(b);let s='';while(n>0n){s=A[Number(n%58n)]+s;n/=58n}for(const b of k){if(b)break;s='1'+s}console.log(s)" ~/.config/vexa/fee-payer.json
  ```

`check-env` confirms the public half matches the secret half.

### Fund them (mainnet, minimum amounts)

Send real SOL from an exchange or your own wallet (Phantom, Solflare) to each pubkey:

| Key       | Send         | What it covers                                                                                                                              |
| --------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Fee payer | **0.05 SOL** | Tx fees (~0.000005 SOL/signature) plus rent for about 10 sponsored confidential token accounts (~0.004 SOL each) during setup and e2e tests |
| Admin     | **0.02 SOL** | Rent for the cUSDC mint, vault config, and vault USDC token account                                                                         |

`check-env` fails below these amounts. Override with `FEE_PAYER_MIN_SOL` / `ADMIN_MIN_SOL`. It also simulates a call to the ZK ElGamal proof program to confirm confidential transfers run on mainnet; that check needs the fee payer to hold some SOL.

**Later, not now:** the vault program deploy is the one large cost. Solana charges refundable rent for the program's bytecode, about 0.0051 SOL per KB on mainnet today. The current 36 KB build needs **0.183 SOL** of rent plus about 0.005 SOL of fees and account rent, **≈ 0.188 SOL** in total. `pnpm deploy:vault` prints the exact figure from live rent prices before anything is sent, and `solana program close` returns the rent if the program is ever retired.

### USDC

- **`USDC_MINT`**: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (Circle, mainnet). Already set.
- For the Phase 2 end-to-end test, keep **2 USDC** in a wallet you control: 1 to deposit, transfer and withdraw between two test users, 1 as buffer. The 0.10% protocol fee on 1 USDC is 0.001 USDC.

### Produced later (leave blank)

| Variable                | Produced by                     |
| ----------------------- | ------------------------------- |
| `VAULT_PROGRAM_ID`      | `pnpm deploy:vault` in Phase 1  |
| `CUSDC_MINT`            | vault init script in Phase 1    |
| `TREASURY_OWNER_PUBKEY` | Phase 2 (fee treasury)          |
| `VEXA_TOKEN_MINT`       | Phase 3 (~0.0015 SOL mint rent) |

---

## 5. NEAR (mainnet)

The deployer needs a **named** account (e.g. `vexa-deployer.near`), because Phase 3 deploys the policy contract to a sub-account of it (`policy.vexa-deployer.near`).

**Option A: wallet (easiest)**

1. Open **meteorwallet.app** (or **app.mynearwallet.com**) → **Create new wallet** → choose the name `vexa-deployer` → finish setup.
2. Fund it with **0.1 NEAR** from an exchange (withdraw on the **NEAR** network, to `vexa-deployer.near`).
3. Export the key: **Settings → Security & Recovery → Export private key** → copy the `ed25519:...` value.

**Option B: CLI, if you already have a funded `.near` account**

```bash
near account create-account fund-myself vexa-deployer.near '0.1 NEAR' \
  autogenerate-new-keypair save-to-legacy-keychain \
  sign-as <your-existing-account>.near network-config mainnet sign-with-keychain send
```

The key lands in `~/.near-credentials/mainnet/vexa-deployer.near.json` → `private_key`.

Then set:

- **`NEAR_DEPLOYER_ACCOUNT_ID`**: `vexa-deployer.near`
- **`NEAR_DEPLOYER_PRIVATE_KEY`**: the `ed25519:...` key. It must be a full-access key; `check-env` verifies this on-chain.
- **`NEAR_RPC_URL`**: keep `https://rpc.mainnet.fastnear.com`.
- **`NEAR_MPC_CONTRACT_ID`**: keep `v1.signer`. `check-env` confirms it exposes an Ed25519 key domain (verified live: it does).
- **`NEAR_POLICY_CONTRACT_ID`**: leave blank until Phase 3.

Minimum balance now: **0.1 NEAR**. Later: Phase 3 locks **~1 NEAR per 100 KB** of contract wasm as storage (refundable if the contract is deleted), plus ~0.03 NEAR of gas per MPC signature request (unused gas is refunded). We'll print the exact figure after building the contract.

---

## 6. NEAR Intents 1Click

- **`INTENTS_1CLICK_BASE_URL`**: keep `https://1click.chaindefuser.com`.
- **`INTENTS_1CLICK_JWT`**: optional. Without it, quotes work but include an extra fee. To get one, follow **docs.near-intents.org** → 1Click API → Authentication (partner JWT request form).

1Click enforces per-route minimum swap sizes. We'll quote the real minimum for the USDC → ZEC → USDC round trip at the start of Phase 3, before you fund anything for stealth tests.

---

## 7. Zcash (Phase 3, leave blank now)

The stealth route needs a shielded wallet we control, one z-address per route: a synced `zallet` (or `zcashd`) with its JSON-RPC exposed privately to the API. Values: `ZCASH_WALLET_RPC_URL`, `ZCASH_WALLET_RPC_USER`, `ZCASH_WALLET_RPC_PASSWORD`. We'll set this up at the start of Phase 3.

---

## 8. GitHub (optional)

The code lives at **github.com/AlexSkidanov/vexa-finance**. Pushing from your machine works with a normal `gh auth login`, so `GITHUB_TOKEN` is only needed if you want `check-env` to confirm repo access or a script to call the GitHub API.

1. **`GITHUB_TOKEN`**: **github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
   - Repository access: **Only select repositories → vexa-finance**.
   - Permissions: **Contents**, **Pull requests**, **Actions**, **Secrets** and **Workflows**, all read/write.
2. CI itself doesn't need this. GitHub Actions uses its built-in `secrets.GITHUB_TOKEN`, and the deploy and chain credentials go into **repo → Settings → Secrets and variables → Actions**.

---

## 9. Railway (deploy only)

1. **railway.com** → **New Project** → **Empty project**. Name it `vexa`.
2. **`RAILWAY_TOKEN`**: project → **Settings** → **Tokens** → **Create token**, environment **production** (or a `staging` environment for devnet). Copy it.
3. Later the API service gets every non-CI variable from this file via **Service → Variables → Raw Editor**.

---

## 10. Stubs

`CARD_ISSUER_API_KEY` and `KYC_PROVIDER_API_KEY` stay empty. Cards (Lithic/Rain) and KYC (Persona/Sumsub) are interface-only with mock implementations.

---

## 11. Deploying the vault

```bash
pnpm build:vault      # cargo build-sbf → target/deploy/vault.so
pnpm deploy:vault     # dry run: prints the plan and the exact SOL the admin needs
pnpm deploy:vault --execute
```

The dry run reads rent prices from the cluster and compares them against the admin balance. Almost all of the cost is the program's rent deposit (about 0.0051 SOL per KB of `vault.so`), which is refunded if the program is ever closed with `solana program close`.

`--execute` deploys with the admin key as upgrade authority, then creates the cUSDC mint and initializes the vault in one transaction, and writes `VAULT_PROGRAM_ID` and `CUSDC_MINT` into `.env`. It's safe to rerun: finished steps are skipped. Afterwards, `pnpm check-env` verifies the program and the mint on-chain.

The program keypair lives at `target/deploy/vault-keypair.json` (gitignored). Keep a backup: losing it doesn't affect the deployed program, but it's needed to redeploy to the same address from scratch.

---

## Checklist

```
[ ] API_KEY_ENCRYPTION_KEY / WEBHOOK_SIGNING_SECRET / VIEW_KEY_ENCRYPTION_KEY generated
[ ] Supabase: URL, anon, service role, DB URL (session pooler), JWT secret if legacy
[ ] Supabase: email OTP template, confirm email on
[ ] Alchemy: mainnet RPC URL, webhook signing key (+ webhook ID, auth token)
[ ] Solana: fee payer (0.05 SOL) and admin (0.02 SOL) keypairs, funded on mainnet
[ ] NEAR: vexa-deployer.near + full-access private key, 0.1 NEAR
[ ] GitHub: AlexSkidanov/vexa-finance exists
[ ] Railway: project + token
[ ] pnpm check-env -> Result: PASS
[ ] pnpm db:migrate
[ ] pnpm build:vault && pnpm deploy:vault --execute
```
