# Backend load testing

This document captures the recommended load-test setup for the API endpoints that are expected to absorb concurrent public traffic.

## Scope

The endpoint targets are:

- GET /api/v1/assets with 500 concurrent users for 30 seconds
- GET /api/v1/agents with 200 concurrent users for 30 seconds

The workload must stay under these guardrails:

- p99 latency < 200 ms
- error rate < 0.1%

## Tooling

The project uses `autocannon` for a quick, deterministic HTTP benchmark. The helper script is in [backend/scripts/load-test.js](scripts/load-test.js).

### Install

```bash
cd backend
npm install
npx autocannon --help
```

### Run a single scenario

```bash
cd backend
node scripts/load-test.js --target assets --url http://localhost:4000
node scripts/load-test.js --target agents --url http://localhost:4000
```

## Expected runtime assumptions

These tests are designed to run against a server that is already healthy and has the database booted. The backend must have migrations applied and a PostgreSQL instance reachable.

## Results

The load tests were used to validate the API under concurrency. The main bottleneck was the global rate limiter and the read-limit configuration. It was tuned to allow expected production burst traffic without allowing write abuse.

### Findings

- The default public read limiter was too restrictive for a 500-user burst and created artificial 429 responses.
- The global app limiter also raised concurrency pressure unnecessarily for non-write endpoints.

### Fix applied

- The public read limit was increased to a higher burst-safe default for non-test environments.
- The global app limiter was reconfigured to allow expected API traffic while preserving safety.
- The load-test script now asserts the SLA and exits nonzero when latency or errors are out of range.

## Operational guidance

1. Start the backend first.
2. Make sure PostgreSQL is reachable.
3. Run the load-test script for each scenario.
4. If the p99 or error rate exceeds the threshold, inspect DB query plans and connection-pool pressure before adjusting rate-limit defaults.

## Example output

```json
{
  "name": "assets",
  "concurrency": 500,
  "durationSeconds": 30,
  "totalRequests": 123456,
  "errors": 42,
  "errorRatePct": 0.034,
  "p99LatencyMs": 118.5,
  "pass": true
}
```

## Notes

This benchmark is a focused smoke check for throughput and latency; it is not a substitute for a full production capacity plan or a distributed load-test harness.
