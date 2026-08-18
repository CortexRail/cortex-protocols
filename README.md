# Intelligence Rail (Cortex Protocol)

[![Backend CI](https://github.com/JuanVP2/cortex-protocols/actions/workflows/backend.yml/badge.svg)](https://github.com/JuanVP2/cortex-protocols/actions/workflows/backend.yml)
[![Contract CI](https://github.com/JuanVP2/cortex-protocols/actions/workflows/contract.yml/badge.svg)](https://github.com/JuanVP2/cortex-protocols/actions/workflows/contract.yml)
[![Frontend CI](https://github.com/JuanVP2/cortex-protocols/actions/workflows/frontend.yml/badge.svg)](https://github.com/JuanVP2/cortex-protocols/actions/workflows/frontend.yml)

**Open infrastructure for autonomous agents to discover, exchange, and evolve intelligence assets through programmable micropayments.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Built on Stellar](https://img.shields.io/badge/Built%20on-Stellar-black)](https://stellar.org)
[![Soroban](https://img.shields.io/badge/Smart%20Contracts-Soroban-purple)](https://soroban.stellar.org)

## Vision

Building the economic infrastructure for autonomous intelligence.

## Description

Intelligence Rail is an open marketplace and financial infrastructure layer where autonomous AI agents can discover, purchase, execute, remix, and monetize intelligence assets.

Rather than treating prompts as static files, Intelligence Rail introduces a programmable economy for machine intelligence — enabling agents to interact with reusable cognitive components such as prompts, workflows, reasoning chains, datasets, tools, evaluators, memory systems, and model instructions.

Powered by Stellar micropayments, agents can autonomously:
- Acquire specialized capabilities
- Stream payments for usage-based intelligence
- License and monetize derivative assets
- Benchmark performance
- Evolve through composable cognition
- Participate in open AI-native economies

The project explores a future where intelligence itself becomes modular, tradable, and interoperable across autonomous systems.

## Project Structure

See individual README files in each directory for detailed documentation.

```
cortex-protocols/
├── frontend/       # Next.js marketplace UI
├── contract/       # Stellar Soroban smart contracts
│   ├── contracts/marketplace       # Asset listing & licensing
│   ├── contracts/micropayments     # Payment streaming
│   └── contracts/agent_registry    # Agent identity & reputation
└── backend/        # Node.js API — asset indexing, agent discovery
```

## Getting Started

### Prerequisites

- Node.js 20+
- Rust + `wasm32-unknown-unknown` target
- [Stellar CLI](https://developers.stellar.org/docs/tools/stellar-cli)

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### Backend

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

### Contracts

```bash
cd contract
cargo test
cargo build --target wasm32-unknown-unknown --release
```

## Core Focus Areas

- Intelligence asset marketplaces
- Agent wallets and identity
- Programmable licensing
- Composable workflows
- Micropayment infrastructure
- Agent reputation systems
- AI-to-AI commerce
- Autonomous economic coordination

## Roadmap

- [x] Soroban smart contract architecture (marketplace, micropayments, agent registry)
- [x] Backend API with asset/agent indexing and Stellar integration
- [x] Next.js frontend scaffold
- [ ] Deploy contracts to Stellar testnet
- [ ] Connect frontend to backend API
- [ ] Add Freighter wallet integration
- [ ] Agent-to-agent payment flows
- [ ] Usage-based micropayment streaming UI
- [ ] Agent reputation leaderboard
- [ ] Governance and DAO for marketplace parameters

## Contributing

Pull requests are welcome. For major changes please open an issue first to discuss what you would like to change.

## License

MIT
