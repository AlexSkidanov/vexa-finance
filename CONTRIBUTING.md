# Contributing to Vexa

Thanks for your interest in contributing. Bug reports, reviews, docs fixes and code
are all welcome.

## Code of Conduct

We keep an open and welcoming environment. Please review our
[code of conduct](CODE_OF_CONDUCT.md).

## Repository layout

| Path                    | What lives there                                     |
| ----------------------- | ---------------------------------------------------- |
| `apps/api`              | Hono REST API, webhooks and background workers       |
| `packages/core`         | Shared types, zod schemas and crypto helpers         |
| `packages/sdk`          | `@vexa/sdk`, the typed client                        |
| `programs/vault`        | Anchor program wrapping USDC into confidential cUSDC |
| `contracts/near-policy` | NEAR contract enforcing agent spend policies         |
| `supabase/migrations`   | Postgres schema and row-level security policies      |

## Development

### Setup

```bash
corepack enable
pnpm install
cp .env.example .env   # see docs/SETUP.md
pnpm check-env
```

On-chain work also needs Rust, the Solana CLI and Anchor. Exact versions are pinned
in `rust-toolchain.toml` and `Anchor.toml`.

### Commits

Use descriptive commit messages and PR titles. We follow
[conventional commits](https://www.conventionalcommits.org/en/v1.0.0/) with a scope
where one fits:

```
feat(api): add handle resolution endpoint
fix(vault): reject deposits into accounts from a foreign mint
docs: explain the stealth routing timeouts
```

PRs are squash-merged, so the PR title becomes the commit on `main`.

### Before opening a PR

- `pnpm lint`, `pnpm typecheck` and `pnpm test` pass.
- On-chain changes: `cargo fmt`, `cargo clippy` and `anchor test` pass.
- New endpoints are documented in `docs/API.md` and covered by tests.
- New create endpoints require an idempotency key.
- **No plaintext amounts server-side.** Nothing under `apps/api` may log, store or
  return a decrypted amount. If a feature seems to need one, raise it in the PR
  description first.
- New migrations enable row-level security on every table they create.

### Security issues

Please don't file security issues publicly. See [SECURITY.md](SECURITY.md).
