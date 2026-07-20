# Contract fuzzing

This isolated Cargo package contains `cargo-fuzz` targets for the Soroban
marketplace and micropayments contracts.

## Setup

A nightly Rust toolchain and a C++ compiler are required. Install `cargo-fuzz`
with:

```bash
cargo +nightly install cargo-fuzz
```

Run all commands below from `contract/fuzz`.

## Targets and 30-minute runs

The available targets are `list_asset`, `purchase_license`, `publish_update`,
and `open_stream`.

```bash
cargo +nightly fuzz run list_asset -- -max_total_time=1800
cargo +nightly fuzz run purchase_license -- -max_total_time=1800
cargo +nightly fuzz run publish_update -- -max_total_time=1800
cargo +nightly fuzz run open_stream -- -max_total_time=1800
```

## Corpora and artifacts

During local fuzz runs, libFuzzer may create per-target corpus directories
under `contract/fuzz/corpus/`. These generated corpus inputs are ignored by Git
and should not be committed unless maintainers explicitly request a minimized
regression case.

Generated crash and diagnostic artifacts are stored under
`contract/fuzz/artifacts/<target>/`. Reproduce a saved artifact from
`contract/fuzz` with:

```bash
cargo +nightly fuzz run <target> artifacts/<target>/<artifact-file>
```

## Methodology

Each input creates a fresh Soroban environment, registers the relevant
contract and token test contract, generates addresses within that environment,
and uses generated try-style contract methods so expected rejections return to
the harness. Successful calls check contract state and token-balance invariants;
rejected calls check rollback where the public API permits it.

The `list_asset` harness covers representative empty, short, boundary-sized,
medium, and large strings. The marketplace currently defines no
application-level maximum name or description length, so these cases exercise
useful boundaries without claiming they are production limits.

The `publish_update` harness mixes authorized, unauthorized, existing, and
missing-asset updates. It verifies successful version increments, rollback on
rejection, current-description consistency, and the five-version history bound.

## Completed runs

Each target completed a 30-minute run:

| Target | Duration | Executions | Average exec/s | Final coverage | Peak RSS | Crash artifacts |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| `list_asset` | 1801 s | 115064 | 63 | `cov 4099, ft 4348` | 455 MB | 0 |
| `purchase_license` | 1801 s | 28857 | 16 | `cov 6430, ft 9984` | 466 MB | 0 |
| `open_stream` | 1801 s | 45190 | 25 | `cov 6195, ft 10289` | 466 MB | 0 |

## Behavioral finding

During the initial `purchase_license` smoke run, a zero-price input showed
that a zero-priced asset can currently be listed and purchased successfully.
The unused marketplace `errors.rs` file describes `InvalidPrice` as “Price must
be greater than zero,” but that module is not connected to the active contract.

This was recorded as a behavioral finding, not a contract crash. No contract
business logic was changed as part of issue #42. The harness accepts a
successful zero-price purchase while continuing to treat any successful
negative-price purchase as an invariant failure.
