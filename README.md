# subrosa

Private payroll on NEAR. Employers register workers, publish salary
commitments instead of amounts, and settle payouts through **Confidential
Intents**, so the public ledger carries neither the amount nor the
payer-to-payee link.

The contract is an attestation and coordination layer: it records commitment
hashes, payout lifecycle, audit holds, and auditor roles. Money never moves
through it. Settlement runs off chain over the 1Click Confidential Intents API
and is reported back with `mark_settled` or `mark_failed`.

## At a glance

- One salary commitment: **374 B = 0.00374 NEAR** of storage and
  **2.353357561394 TGas** gross, measured from a sandbox capture.
- Zero-funds demo: `npm run demo` — nine stages, dry quotes only,
  `fundsMoved=0`.
- Quickstart: `npm install && npm run build && node examples/private-payroll-simulation.ts`.

## What is built

| Slice | Location | Contents |
| --- | --- | --- |
| Contract | `contract/` (`subrosa-contract`) | Employer/employee registry, salary commitments, scheduled payouts, audit holds, auditor roles, one global pause, NEP-297 events, optional Groth16 verifier, storage-deposit checks on every write |
| SDK | `packages/core/` (`near-subrosa-core`) | Typed contract clients, 1Click Confidential Intents client, confidential payout and payout-flow orchestration, User-Session client, auditor CSV export, SocialDB hash-only audit trail, NEP-297 event cursor, batch resume tokens, redaction and privacy analysis |
| Relayer | `relayer/` (`near-subrosa-relayer`) | NEP-366 meta transactions: an employer with zero NEAR can register and commit; employees need no NEAR account |
| Entry points | `scripts/`, `examples/`, `testdata/` | Zero-funds demo, measured numbers, OpenAPI field check, two dry-run examples, pinned 1Click OpenAPI 0.1.10 snapshot |

Contract surface: `new`; registry `register_employee`, `update_employee`,
`deactivate_employee` plus paginated views; commitments `commit_salary` and
`batch_commit_salaries` (1-50 items); payouts `schedule_payout`,
`cancel_payout`, `mark_settled`, `mark_failed`, `expire_payout`,
`is_payout_due`; holds `create_audit_hold`, `release_audit_hold`; auditors
`grant_auditor`, `revoke_auditor`; owner-only `set_pause` and
verification-key management; Groth16 `verify_proof`. Events use the NEP-297
standard `subrosa`, version `1.0.0`: `EmployeeRegistered`, `EmployeeUpdated`,
`SalaryCommitted`, `AuditorChanged`, `PayoutScheduled`, `PayoutStateChanged`,
`AuditHoldChanged`, `ProofVerified`.

The end-to-end path is: register -> commit -> schedule (`PrivatePayoutFlow`)
-> audit-hold gate -> destination gate -> client-side commitment verification
-> confidential quote -> NEP-413 signature -> `/v0/submit-intent` -> status
polling -> `mark_settled` on `SUCCESS`, `mark_failed` on `FAILED`/`REFUNDED`.
`PayrollService.processPayment` is the single enforcement point. Amounts and
salts stay in memory and never reach contract arguments, logs, or error text.

## Quickstart: do this, see that

Node.js 26.0.0 or newer, then:

```bash
npm install
npm run build
node examples/private-payroll-simulation.ts
```

The example needs network access to `https://1click.chaindefuser.com` and
nothing else: no wallet, no API key, no deposit, no transaction. Expected
output ends with:

```text
confidential quote: gated=401 User-Session-required; requests validated locally
public quote: dry=true recipientType=INTENTS depositAddress=none signature=present
simulation complete: commitments=1 verified=1 confidential=gated publicDryQuotes=1 fundsMoved=0
```

`node examples/payroll-execution.ts` runs a two-employee batch through the same
dry preflight path and ends with `dry preflight gated: payouts=2/2 validated=local fundsMoved=0`
while the User-Session gate is active.

## Zero-funds demo (PIN 3)

```bash
npm run demo
```

It builds the SDK first, needs network access to 1Click, and needs nothing
else: no wallet, no key, no funds.

`scripts/demo.ts` prints nine stages, then exits non-zero if anything unexpected
happens. Three representative lines:

```text
[1/9] config: network=testnet contract=subrosa.testnet oneclick=1click.chaindefuser.com apiKey=none funds=0 session=none
[5/9] confidential-quote: gated=401 User-Session-required; preflight=fail-closed (no key or funds in demo)
[9/9] summary: commitments=3 confidentialDryQuotes=0 publicDryQuotes=1 confidential=gated resumed=1 secretsLeaked=0 fundsMoved=0
```

The stages are config, asset resolution from `/v0/tokens`, three commitment
hashes, batch validation, the confidential quote (gated or live), a public
same-asset dry quote, an interrupted batch resumed from its opaque token,
redaction, and the summary.

It proves, without funds: commitment hashes are built from client-side amounts
and salts; the batch payload validates; the confidential quote request is
validated against the live schema and the 401 gate is asserted rather than
faked; a public same-asset dry quote exercises the wire format end to end; an
interrupted batch resumes from an opaque token; and redaction keeps amounts,
salts, employees, recipients, and deposit addresses out of output. It fails
closed on a non-dry quote, a quote carrying a deposit address, an unexpected
error, a rejected session token, or any secret in printed text.

## Confidential Intents (PIN 2)

The settlement primitive is **Confidential Intents**: the 1Click API's private
shard, requested with the wire value `CONFIDENTIAL_INTENTS` as `recipientType`,
`depositType`, and `refundType`. The SDK keeps these in plain JSON strings so no
nested private-intents type crosses the client boundary.

- `OneClickClient` covers the fourteen documented paths, including
  `/v0/generate-intent` and `/v0/submit-intent`, plus `/v0/quote`,
  `/v0/status`, `/v0/auth/authenticate`, balances, and history.
- `confidentiality` selects `public`, `basic`, or `advanced` shielding.
- `ConfidentialPayout` owns quote -> sign -> submit -> poll, and maps the
  terminal statuses `SUCCESS`, `FAILED`, `REFUNDED`, `INCOMPLETE_DEPOSIT`.
- The partner JWT travels only in the `X-API-Key` header; it is never placed in
  a URL, an error message, or a returned object.

There is no public Confidential Intents testnet, so every quote in this
repository is `dry: true`. A dry quote exercises the full request/response
schema - assets, recipient pair, slippage, deadline, signature - without
generating a deposit address or moving funds.

## D20: the User-Session gate (PIN 3 in practice)

1Click rejects confidential quotes without a User-Session token:

```text
HTTP 401 "User authentication is required for confidential intent quotes"
```

A User-Session is obtained by proving ownership of a registered wallet key
(sign an empty `intents: []` payload with NEP-413, then exchange it at
`/v0/auth/authenticate`). That requires a human-held wallet key, so a
zero-credential confidential dry quote is impossible today. This is a
human-gated requirement, not a code defect: the demo and both examples assert
the exact 401 and validate the confidential request locally instead of
fabricating a response. When a human supplies a real session, set
`ONECLICK_USER_SESSION` and the same code takes the live confidential dry-quote
path; a rejected token fails closed rather than falling back. PIN 3 is
therefore a dry run: dry quotes only, no deposit address, no signature
submission, no funds.

## Headline number (PIN 4)

One salary commitment costs **374 B = 0.00374 NEAR** of storage and burns
**2.353357561394 TGas** gross. The storage figure is the measured
`storage_usage` delta of one `commit_salary` write at the protocol price of
1e19 yoctoNEAR per byte, and the exact deposit the contract requires
(`COMMITMENT_RECORD_BYTES`, asserted on chain); the gas figure is the measured
`total_gas_burnt` of the same write. A full 50-item batch reserves 0.187 NEAR of
storage deposit.

Reproduce both from a clean checkout:

```bash
# 1. capture one real write on the pinned sandbox
(cd contract && cargo near build non-reproducible-wasm)
mkdir -p target/numbers
cargo +1.95.0 test -p subrosa-contract --test sandbox sandbox_registry_commitments_and_pause \
  -- --test-threads=1 --nocapture 2>&1 | tee target/numbers/capture.log

# 2. reduce the capture to the two numbers above
npm run numbers -- --capture target/numbers/capture.log
```

`scripts/numbers.ts` reads the capture rather than a model, prints the gas and
storage deltas, and fails closed if the capture is missing, malformed, or
disagrees with the pinned claim. A matching run ends with
`OK: capture matches the pinned claim in NUMBERS.md.`; `--json` emits a
machine-readable report for rerun diffing. The captured run, its unit
accounting, and the rerun proof are in `NUMBERS.md`.

Gas is budgeted **gross**: the 30% developer gas rebate was removed in protocol
87 (`RemoveGasRewards`, HSP-027), so no rebate offsets it.

## Contract on testnet (optional)

```bash
(cd contract && cargo near build non-reproducible-wasm)
near create-account subrosa.testnet --useFaucet --networkId testnet
near contract deploy subrosa.testnet use-file ./target/near/subrosa_contract.wasm \
  with-init-call new json-args '{"owner":"subrosa.testnet"}' \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
near contract call-function as-read-only subrosa.testnet get_employee_count \
  json-args '{"employer":"subrosa.testnet"}' network-config testnet now
```

Every method that creates a record is `#[payable]`; attach at least
`record_bytes * env::storage_byte_cost()` or the call fails. Fund the contract
account for storage staking before the first write.

## Build and test

| Command | Covers | Recorded result |
| --- | --- | --- |
| `cargo check --manifest-path contract/Cargo.toml --target wasm32-unknown-unknown` | contract compiles for wasm | exit 0 |
| `cargo test --manifest-path contract/Cargo.toml` | 46 Rust unit tests, then 4 `near-workspaces` sandbox tests (after the wasm build below) | 46 + 4 passed |
| `npm run typecheck` | SDK typecheck | exit 0 |
| `npm test` | Node test suite (`node --test`) | 191 passed |
| `npm run test:relayer` | relayer suite | 46 passed |
| `npm run check:oneclick` | 1Click OpenAPI fields against the pinned 0.1.10 snapshot | 6 checks passed |
| `npm run demo` | zero-funds demo | 9/9 stages |
| `npm run numbers -- --capture target/numbers/capture.log` | reduces the sandbox capture to the measured gas and storage deltas | 2.353357561394 TGas / 374 B |

The sandbox tests need the `cargo near build non-reproducible-wasm` artifact
(the test locates `target/near/subrosa_contract.wasm`, or `SUBROSA_CONTRACT_WASM`)
and download the nearcore 2.14.0 sandbox binary on their first run.

`.env.example` documents the runtime variables (`.env` stays git-ignored):
`SUBROSA_NETWORK`, `NEAR_RPC_URL`, `SUBROSA_CONTRACT`, `ONECLICK_BASE_URL`,
`ONECLICK_API_KEY`, `SUBROSA_DEV_KEY`, `SUBROSA_STORE_PATH`.

Pinned toolchain: Rust 1.95 (edition 2024), near-sdk 5.30.2,
near-sdk-contract-tools 4.0.0, near-workspaces 0.24.0, cargo-near 0.23.0,
near-cli-rs 0.31.1, nearcore sandbox 2.14.0, Node.js >= 26.0.0, npm 12.2.1
(`packageManager`). The SDK pins near-api-js 7.5.3, near-social-js 2.0.4 and
`@hot-labs/near-connect` 0.12.0; the root `overrides` entry resolves
`near-kit` to exactly ONE 0.20.2 version. The Groth16 test fixtures were
generated with snarkjs 0.7.6 (see `contract/testdata/groth16/multiplier2/README.md`).

## Limits and out of scope

- **Delegated approver flows.** No `assign`/`get`/`revoke` approval assignment;
  every row is owned by the employer that wrote it.
- **Separation of duties (SoD), approval expiry, multi-signature
  coordination.** No role derivation or policy engine; these stay client-side.
- **5-category pause.** The contract keeps one global pause (`set_pause`,
  owner-only) that blocks every mutating method.
- **Amendments, archive, reconciliation, disputes, webhooks.** Not ported.
- **On-chain amount reveal or commitment-check entry points.** NEAR state is
  public; commitments are verified client-side against the published hash, and
  disclosure is export-only (CSV from `AuditorDisclosureExporter`).
- **Atomic on-chain payout or balance entry points.** Settlement is off chain
  over Confidential Intents; an async outcome cannot be rolled back on chain.
- **Companion contracts from the origin.** Their license metadata is
  `NOASSERTION`; they are not copied and the contract here is clean-room.
- **KYC or sanctions vendor integrations and a hosted chain indexer.** The SDK
  ships an event cursor and an idempotent processor; no indexer service is
  deployed.
- **Hosted relayer, backend, or UI.** The relayer runs locally against testnet
  only; any deployment, recording, or program submission is a human step.

Every number in this file is a pinned protocol constant, a contract constant, or
an output of the commands above.

## Security limits

- **NEP-413 requires a full-access key.** Intent payloads and backend login
  challenges are message signatures. A function-call key can never produce one;
  `Nep413Signer` and `backendAuth` reject it up front with
  `FULL_ACCESS_KEY_REQUIRED`.
- **A function-call key's allowance is not a spend limit.** Receiver, method,
  and gas allowance only bound what a key may call. NEP-366 does not check the
  inner key's allowance at all, so the relayer enforces its own policy: exactly
  one `FunctionCall`, methods `register_employee`, `commit_salary`,
  `batch_commit_salaries`; gas <= 100 TGas for register and commit, <= 300 TGas
  for batch; exact storage deposits; a `maxBlockHeight` inside 600 blocks; and a
  per-sender sponsored-deposit cap of 1 NEAR by default.
- **The relayer pays gas and inner storage.** It signs its outer transaction
  with an NEP-611 gas key (prepaid balance, up to 1,024 nonce lanes) while inner
  deposits come from the account's liquid balance; fund both. Deleting a gas
  key burns its remaining balance, so retirement withdraws first.
- **Storage deposits are retained by the contract.** There is no refund path
  and any surplus is kept, so callers must attach the documented amount and the
  contract account must stay funded. Record sizes: 567 B employee + metadata
  (<= 256 B), 374 B commitment, 258 B payout + memo, 186 B hold, 73 B proof
  nullifier.
- **The deposit address is a correlation secret.** `/v0/status` echoes the
  quote response, so the audit trail stores commitment and intent hashes only,
  never a deposit address, and flow errors are redacted.
- **Settlement is asynchronous.** `mark_settled` is written only on `SUCCESS`;
  `FAILED`/`REFUNDED` map to `mark_failed`; a partially funded
  `INCOMPLETE_DEPOSIT` is surfaced without an on-chain failure write.
- **No gas rebate.** Budget gross gas; the developer rebate is gone in protocol
  87.

## Origin, baseline, and status

<!-- origin-disclosure:start -->
This port starts from the MIT-licensed SDK `zkpayroll/zk-payroll-sdk`
(https://github.com/zkpayroll/zk-payroll-sdk). Its default branch is `dev`;
the HEAD at fetch, `a3166417082436901aa2b66618fdaf9c6c08ae17` (1,050 files),
was downloaded from codeload and committed unmodified as the baseline
`b7bafa51c1262bbe4322391584e3212d26c37b9a`; waves 2-4 build on it. Delta from
the baseline to upstream `dev`:
https://github.com/zkpayroll/zk-payroll-sdk/compare/a3166417082436901aa2b66618fdaf9c6c08ae17...dev

The origin's companion smart contracts carry license metadata `NOASSERTION`.
They are not part of the snapshot and none of their code is used: the Rust
contract under `contract/` is a clean-room implementation of the documented
method surface. See `ATTRIBUTION.md`.
<!-- origin-disclosure:end -->

This repository is production tooling for a port, not a hackathon entry. No
award, prize, ranking, or winner status is claimed for it. Submission,
recording, and hosting are human-only steps; nothing here posts an application
or contacts a program on your behalf.

## License

MIT. See `LICENSE` (which retains the origin copyright notice) and
`ATTRIBUTION.md`.

## Hackathon

Track: `privacy`. Development ends 2026-11-14T23:59:00Z (UTC).
