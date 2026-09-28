# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `pnpm check-env`: validates every setting in `.env` and probes Supabase, Solana RPC,
  NEAR RPC and the NEAR Intents 1Click API, including whether the ZK ElGamal proof
  program is live on the target cluster.
- Environment setup guide for mainnet in `docs/SETUP.md`.
