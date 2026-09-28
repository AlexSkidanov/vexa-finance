# Security Policy

Vexa holds user funds on Solana mainnet and signs transactions on behalf of AI agents
through NEAR chain signatures. We treat every report as potentially critical.

This document describes how to report a vulnerability and what happens after you do.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report privately through GitHub:
[Security → Report a vulnerability](https://github.com/AlexSkidanov/vexa-finance/security/advisories/new).
Only the maintainers can see these reports.

A good report includes:

- The component affected: the API, the SDK, the vault program, the NEAR policy
  contract, or the stealth router.
- Steps to reproduce, ideally a script or a failing test.
- What an attacker gains, e.g. moving funds, reading an encrypted amount, bypassing
  an agent spend policy, or linking a stealth transfer to its sender.

We acknowledge reports within 72 hours.

## Scope

In scope:

- `programs/vault`: the USDC ↔ cUSDC wrapper.
- `contracts/near-policy`: agent spend policies and chain-signature gating.
- `apps/api`: authentication, API keys, webhooks, idempotency, and anything that could
  leak a plaintext amount or a key.
- `packages/sdk` and `packages/core`: client-side key handling and proof generation.

Out of scope: vulnerabilities in Solana, Token-2022, the ZK ElGamal proof program,
NEAR, the NEAR MPC network or NEAR Intents themselves. Please report those upstream.
If one of them affects Vexa in a specific way, we still want to hear about it.

## Handling & disclosure process

1. The report is assigned to a maintainer, who coordinates evaluation, the fix and
   disclosure.
2. We confirm the issue, assess severity and identify affected components and
   deployments. We also look for similar issues elsewhere in the codebase.
3. A fix is prepared privately. For on-chain programs this may include pausing the
   vault or revoking agent policies until an upgrade is deployed.
4. The fix is deployed, and the advisory is published on GitHub with credit to the
   reporter, unless they prefer to stay anonymous.

We aim to publish advisories within 90 days of the initial report, sooner when a fix
ships sooner.

## Security model notes

Some properties are by design, not bugs:

- **Deposit and withdrawal amounts are public.** USDC entering or leaving the vault is
  an ordinary SPL transfer. Confidentiality covers balances and transfers *inside*
  cUSDC.
- **The API never sees plaintext amounts or private keys.** Zero-knowledge proofs are
  generated in the SDK with the user's ElGamal key. If you find a code path where the
  server receives, logs or stores a plaintext amount, that is a vulnerability. Please
  report it.
