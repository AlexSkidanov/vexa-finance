# Vexa

A private neobank on Solana.

You sign up with an email and a passkey, get a wallet and a handle like `@alex.vexa`, and hold USDC. The difference from every other crypto account is that nobody watching the chain can see how much you have or how much you sent. Balances and transfer amounts are encrypted on-chain using Solana's Token-2022 confidential transfers, and the zero-knowledge proofs that keep them honest are generated on your device, not on our servers.

On top of that:

- **Agent accounts.** Give an AI agent its own sub-account with a spending policy: daily limit, per-payment cap, allowed recipients. The policy is enforced by a smart contract on NEAR, which only signs the agent's Solana transactions through NEAR chain signatures when the rules pass. The agent never holds a private key.
- **Stealth transfers.** For payments that need to be unlinkable, not just private, funds take a detour through the Zcash shielded pool via NEAR Intents and come back out at a fresh address.
- **View keys.** Hand an auditor or accountant read access to a specific date range, and revoke it whenever you want.

## Status

Under active development, built in the open. This repository is the backend: the API, the on-chain programs, the NEAR policy contract and the TypeScript SDK.

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Environment and secrets audit | Done |
| 1 | Monorepo, API skeleton, Supabase schema, auth, handles, vault program | In progress |
| 2 | Deposits, confidential transfers, withdrawals, fees, webhooks | Planned |
| 3 | Agent accounts and policies, x402 payments, stealth mode, view keys, $VEXA | Planned |

Everything targets Solana mainnet.

## Running it locally

You need Node 20+, pnpm and the Solana CLI.

```bash
cp .env.example .env
pnpm install
pnpm check-env
```

`check-env` validates every setting and probes each service Vexa depends on (Supabase, Solana RPC, NEAR, NEAR Intents), then prints a pass/fail table. [docs/SETUP.md](docs/SETUP.md) walks through getting each value.

## License

[Apache-2.0](LICENSE)
