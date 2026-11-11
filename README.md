# subrosa

Private payroll on NEAR. Employers register employees, publish salary
commitments instead of amounts, and settle payouts through Confidential Intents
so the public ledger carries neither the amount nor the payer-to-payee link.

This repository is the executable specification for the port. W1 lands the
scaffold; the contract method surface and the SDK clients land in later waves.

## Status

| Wave | Contents | State |
| --- | --- | --- |
| W1 | Workspace layout, pinned dependencies, contract state and events, SDK network config | landed |
| W2 | Contract methods (registry, commitments, payouts, holds, auditor roles, pause) and SDK clients | not started |
| W3 | End-to-end flows, sandbox tests, demo scripts | not started |
| W4 | Measured numbers and final README | not started |

W1 claims no performance numbers and ships no runnable demo.

## Target layout

```
contract/          Rust crate `subrosa-contract`
  src/lib.rs       contract state, entry types, storage prefixes, `new`
  src/events.rs    NEP-297 events, standard `subrosa`, version 1.0.0
  tests/           near-workspaces sandbox tests (W3)
packages/core/     TypeScript SDK `near-subrosa-core`
  src/config.ts    network presets and environment resolution
  src/index.ts     package entry point
  tests/
relayer/           NEP-366 meta-transaction relayer (W3)
examples/          runnable flows (W3)
scripts/           demo and measurement entry points (W4)
```

`contract/` and the config slice of `packages/core` are the only code in W1.

## Pinned prerequisites

| Tool | Version |
| --- | --- |
| near-sdk | 5.30.1 (MSRV 1.95, edition 2024) |
| near-sdk-contract-tools | 4.0.0 |
| near-workspaces | 0.24.0 |
| Rust | 1.95 or newer |
| Node.js | >= 22.22.2 |
| npm | >= 10.4.1 (the repo pins npm@10.8.2 through `packageManager`) |
| cargo-near | 0.23.0 |
| near-cli-rs | 0.31.1 |
| nearcore sandbox | 2.14.0 (2.14.1 is a security-only patch) |

The TypeScript SDK pins its dependencies exactly, without ranges, in
`packages/core/package.json`: near-api-js 7.5.3,
@defuse-protocol/one-click-sdk-typescript 0.1.26,
@defuse-protocol/intents-sdk 0.96.0, near-social-js 2.0.4,
@hot-labs/near-connect 0.12.0, snarkjs 0.7.6, and axios 1.21.1.

## Commands

The repository wires up these commands:

```bash
# Contract crate for the wasm target.
cargo check --target wasm32-unknown-unknown --manifest-path contract/Cargo.toml

# SDK workspace.
npm install
npm run typecheck
```

Run them on a machine with the pinned toolchains installed. Sandbox tests,
`cargo near build`, and the demo entry points arrive with W3 and W4.

## Origin and clean-room statement

<!-- origin-disclosure:start -->
This port starts from the MIT-licensed `zkpayroll/zk-payroll-sdk`
(https://github.com/zkpayroll/zk-payroll-sdk). The origin's default branch is
`dev` (HEAD `a3166417082436901aa2b66618fdaf9c6c08ae17`, 1,050 files); the
committed baseline `b7bafa51c1262bbe4322391584e3212d26c37b9a` is the codeload
`dev` snapshot used for this port, kept unmodified under the port. See
`ATTRIBUTION.md`.
<!-- origin-disclosure:end -->

The Rust contract is a clean-room implementation: no contract source was
copied. W1 defines the documented state, entry types, storage prefixes, and
NEP-297 events; the method surface lands in W2.

## Out of scope

- On-chain amount-reveal and commitment-check entry points. NEAR state is
  public, so commitments are checked client-side against the published hash and
  disclosure is export-only (CSV or statement).
- Atomic on-chain payout and balance entry points. Settlement runs off chain
  over Confidential Intents and is reported back through the payout lifecycle.
- The origin's per-category pause and delegated-approver flows. The port keeps a
  single global pause and employer-owned rows.
- Companion contracts from the origin. Their license metadata is `NOASSERTION`
  and they are not copied.
- KYC or sanctions vendor integrations, and a chain indexer.
- On-chain Groth16 verification. It stays optional and is not wired in W1.
- Any benchmark or gas number that has not been measured on the pinned
  toolchain.

## License

MIT. See `LICENSE` (retains the origin copyright notice) and `ATTRIBUTION.md`.
