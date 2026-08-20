# Simulation Harness

End-to-end protocol simulation: boots a local Soroban network, deploys every
contract, and runs a swarm of autonomous synthetic agents through the full
`discover → negotiate → stream → meter → settle` loop against the real backend
and SDK.

## Running it

```bash
npm run simulate                                   # 10 agents, 60s, local network
npm run simulate -- --agents 50 --duration 600     # the nightly shape
npm run simulate:smoke                             # 5 agents, in-memory transport
npm run simulate -- --chaos                        # restart dependencies mid-run
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--agents N` | 10 | Swarm size |
| `--duration S` | 60 | Seconds before agents are asked to wind down |
| `--seed N` | 1 | Every random decision derives from this; a run replays exactly |
| `--max-error-rate F` | 0.05 | Exit non-zero above this error rate |
| `--mock` | off | In-memory transport: no network, no contracts, no database |
| `--smoke` | off | Caps the run at 5 agents / 120s |
| `--chaos` | off | Inject backend restarts and RPC outages mid-run |
| `--skip-network` / `--skip-deploy` | off | Reuse a network or deployment that is already up |
| `--output PATH` | `simulation-report.html` | Where the report is written |

Exit code is non-zero when the error rate exceeds the threshold or the
final-state reconciliation fails, which is what makes it usable as a CI gate.

## Pieces

| File | Responsibility |
| --- | --- |
| `run-simulation.js` | CLI: boot → deploy → swarm → report → verdict |
| `SwarmOrchestrator.js` | Spawns the strategy mix, runs it concurrently, winds it down, reconciles |
| `SyntheticAgent.js` | One agent's journey through the protocol loop |
| `strategies.js` | `GreedyBuyer`, `LoyalBuyer`, `FlakySeller`, `HighVolumeCaller` |
| `ChaosInjector.js` | Restarts the backend or stops the RPC container on a jittered schedule |
| `SimulationMetrics.js` | Latency histograms, throughput, error breakdown |
| `report-generator.js` | Self-contained HTML report — inline SVG, zero external requests |
| `FakeProtocolTransport.js` | In-memory stand-in for `CortexAgentSDK`, used by `--mock` and the tests |
| `rng.js` | Seeded PRNG so a whole run is reproducible |

## Behaviour strategies

- **GreedyBuyer** — always takes the cheapest quote; keeps the cheapest sellers saturated.
- **LoyalBuyer** — prefers sellers it has already bought from, cheapest only as a fallback; its traffic concentrates over time.
- **FlakySeller** — randomly delays (0–2s) and drops (~25%) its own calls. The swarm must still settle every one of its streams.
- **HighVolumeCaller** — no delay between calls and a 200-call budget; this is what pressures the metering engine and the settlement batcher.

Mix weights are relative, not percentages:

```js
{ GreedyBuyer: 4, LoyalBuyer: 3, FlakySeller: 2, HighVolumeCaller: 1 }
```

## Determinism

Every random decision comes from a seeded PRNG derived from `--seed` and the
agent's index, so adding an agent does not reshuffle what the others do. A
failing nightly run replays locally with the same `--seed`.

## Testing

The strategies, metrics, chaos schedule and report generator are unit tested,
and `SwarmOrchestrator.test.js` runs a full 5-agent swarm against
`FakeProtocolTransport` — settlement and reconciliation included — with no
network. That is the smoke variant CI runs on every pull request; the nightly
job runs the same code against a real local network.

```bash
npx jest src/__tests__/simulation
```
