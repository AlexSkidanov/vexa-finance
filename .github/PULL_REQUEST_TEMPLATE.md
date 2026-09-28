## What

<!-- One or two sentences on what this PR changes. -->

## Why

<!-- The problem it solves, or a link to the issue. -->

## How it was tested

<!-- Commands run, networks used, anything a reviewer should reproduce. -->

## Checklist

- [ ] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass
- [ ] On-chain changes: `anchor test` / `cargo test` pass
- [ ] No plaintext amounts or secrets are logged, stored or returned by the API
- [ ] New create endpoints require an idempotency key
- [ ] Docs updated (`docs/API.md`, `docs/ARCHITECTURE.md`, `CHANGELOG.md`)
