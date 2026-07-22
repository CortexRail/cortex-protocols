# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases version the whole monorepo (frontend, backend, and contracts) together;
see `.github/CONTRIBUTING.md` for the release process.

## [Unreleased]

### Added

- Stream dashboard UI at `/streams` for viewing active payment streams with
  live progress, status filters, and volume stat tiles (frontend)
- `GET /health/contracts` deep health check reporting Soroban RPC / Horizon
  reachability and on-ledger deployment status of each configured contract
  (backend)
- Contract upgrade mechanism for the marketplace: owner-only `upgrade`
  entrypoint, `version` / `get_owner` queries, and a
  `contract/scripts/upgrade.sh` helper that uploads new WASM and invokes the
  upgrade in place (contract)
- `CHANGELOG.md`, a tag-driven GitHub release workflow, and a
  `scripts/release.sh` version-bump helper

## [0.1.0] - 2026-07-22

### Added

- Soroban smart contracts: marketplace (asset listing, licensing, purchases,
  asset version history), micropayments (payment streaming with withdrawals),
  and agent registry (identity & reputation)
- Backend API (Express) with PostgreSQL persistence: assets, agents, licenses,
  streams, reports, and event-log repositories with migrations and integration
  tests
- Stellar integration: transaction building/simulation via Soroban RPC,
  Horizon account and fee queries, contract event listener
- Frontend (Next.js): marketplace browsing and listing flows, agent directory
  with leaderboard and registration, wallet page with Freighter integration,
  light/dark theming
- Contract deployment script with retry, address manifest, and backend `.env`
  sync (`contract/scripts/deploy.sh`)
- CI workflows for backend, frontend, contracts, and contract deployment
- Contributing guide with Conventional Commits convention

[Unreleased]: https://github.com/CortexRail/cortex-protocols/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/CortexRail/cortex-protocols/releases/tag/v0.1.0
