# subrosa

License: MIT (see `LICENSE`, which retains the origin copyright notice, and `ATTRIBUTION.md`). Tracks: `privacy`, `realworld`. Baseline: tag `pre-hackathon` marks the imported upstream tree (`zkpayroll/zk-payroll-sdk`) at `b7bafa5`; full accounting under "Baseline and disclosure" below. Q-015 (second project on the same email): **krater** (AMM pool, tracks `defi`).

```mermaid
sequenceDiagram
    accTitle: subrosa runtime flow
    accDescr: Employer registers workers, commits hashed salaries, verifies proofs, then pays out privately and settles payout state.
    autonumber
    participant C as Contract
    participant R as Relayer
    participant S as SDK
    participant O as 1Click session
    participant N as near-social
    Note over R,C: PHASE 1 - register worker
    S->>R: signedDelegate, register_employee
    R->>R: policy check, one FunctionCall, 100 TGas cap
    R->>+C: relay meta tx, deposit 567 B plus metadata
    C-->>-S: EmployeeRegistered
    Note over S,C: PHASE 2 - commit salary batch
    S->>S: Borsh preimage 186 B, sha256 hash
    S->>+C: relay commit_salary, exact 374 B deposit
    C-->>-S: SalaryCommitted (hash stored, no amount; 2.348758401541 TGas gross)
    Note over S,C: PHASE 3 - recompute and compare the commitment; reject on change, no proof
    opt Groth16 verifier enabled
        S->>+C: verify_proof
        C-->>-S: ProofVerified
    end
    Note over S,O: PHASE 4 - private payout: hold gate, destination gate, dry quote
    alt no User-Session
        O-->>S: 401 gate, fail closed
    else session present
        S->>+O: /v0/auth/authenticate, /v0/submit-intent, /v0/status
        O-->>-S: SUCCESS or FAILED or REFUNDED
    end
    Note over S,C,N: PHASE 5 - settle payout: SocialDB audit entry, hashes only
    alt SUCCESS
        S->>R: mark_settled
    else FAILED or REFUNDED
        S->>R: mark_failed
    end
    C-->>S: PayoutStateChanged
```

## What is built

| Slice | Location | Contents |
| --- | --- | --- |
| Contract | `contract/` (`subrosa-contract`) | Employer/employee registry. Salary commitments. Scheduled payouts. Audit holds. Auditor roles. One global pause. NEP-297 events. Optional Groth16 verifier. Storage-deposit checks on every write |
| SDK | `packages/core/` (`near-subrosa-core`) | Typed contract clients. 1Click Confidential Intents client. Confidential payout and payout-flow orchestration. User-Session client. Auditor CSV export. SocialDB hash-only audit trail. NEP-297 event cursor. Batch resume tokens. Redaction and privacy analysis |
| Relayer | `relayer/` (`near-subrosa-relayer`) | NEP-366 meta transactions: an employer with zero NEAR can register and commit. Employees need no NEAR account |
| Entry points | `scripts/`, `examples/`, `testdata/` | Zero-funds demo, measured numbers, OpenAPI field check, two dry-run examples, pinned 1Click OpenAPI 0.1.10 snapshot |

Contract surface: `new`; enrolment via `register_employee`, `update_employee`, `deactivate_employee`, plus paginated views; `commit_salary` and `batch_commit_salaries` take 1-50 items; payouts: `schedule_payout`, `cancel_payout`, `mark_settled`, `mark_failed`, `expire_payout`, `is_payout_due`.

Holds and governance: `create_audit_hold`, `release_audit_hold`, `grant_auditor`, `revoke_auditor`, owner-only `set_pause`, verification keys, and Groth16 `verify_proof`. Events use NEP-297 standard `subrosa` (`1.0.0`): `EmployeeRegistered`, `EmployeeUpdated`, `SalaryCommitted`, `AuditorChanged`, `PayoutScheduled`, `PayoutStateChanged`, `AuditHoldChanged`, `ProofVerified`.

`PayrollService.processPayment` enforces every gate.

## Quickstart: do this, see that

1. `npm install` → workspace dependencies installed, exit 0.
2. `npm run build` → see the `near-subrosa-core` build finish, exit 0.
3. `node examples/private-payroll-simulation.ts` → see output ending with the three literals below.

The example needs network access to `https://1click.chaindefuser.com` and nothing else. No wallet, no API key, no deposit, no transaction. Expected output ends with:

```text
confidential quote: gated=401 User-Session-required; requests validated locally
public quote: dry=true recipientType=INTENTS depositAddress=none signature=present
simulation complete: commitments=1 verified=1 confidential=gated publicDryQuotes=1 fundsMoved=0
```

`node examples/payroll-execution.ts` runs a two-employee batch via dry preflight.
While the User-Session gate holds, it ends with `dry preflight gated: payouts=2/2 validated=local fundsMoved=0`.

## Zero-funds demo

```text
[1/9] config: network=testnet contract=subrosa.testnet oneclick=1click.chaindefuser.com apiKey=none funds=0 session=none
[5/9] confidential-quote: gated=401 User-Session-required; preflight=fail-closed (no key or funds in demo)
[9/9] summary: commitments=3 confidentialDryQuotes=0 publicDryQuotes=1 confidential=gated resumed=1 secretsLeaked=0 fundsMoved=0
```

## Confidential Intents

**Confidential Intents** is the 1Click private shard (`CONFIDENTIAL_INTENTS` for `recipientType`, `depositType`, `refundType`). The SDK keeps these as plain JSON strings so no nested private-intents type crosses the client boundary.

- `OneClickClient` covers all fourteen 1Click paths: `/v0/generate-intent`, `/v0/submit-intent`, `/v0/quote`, `/v0/status`, `/v0/auth/authenticate`, balances, history.
- `ConfidentialPayout` owns quote -> sign -> submit -> poll. It maps `SUCCESS`, `FAILED`, `REFUNDED`, `INCOMPLETE_DEPOSIT`.
- Partner JWT travels only in `X-API-Key`. It never enters a URL, error, or returned object.

## D20: the User-Session gate

```text
HTTP 401 "User authentication is required for confidential intent quotes"
```

Supply `ONECLICK_USER_SESSION` to take the live confidential dry-quote path; invalid tokens fail closed. Dry quotes only: no deposit address, no signature submission, no funds.

## Headline number

One salary commitment costs **374 B = 0.00374 NEAR** of storage and burns **2.348758401541 TGas** gross (measured `total_gas_burnt` for one `commit_salary` write; a 50-item batch reserves 0.187 NEAR).
Storage matches `storage_usage` delta at 1e19 yoctoNEAR/byte (`COMMITMENT_RECORD_BYTES`, asserted on chain).

`scripts/numbers.ts` reduces one capture file to the two deltas above. It fails closed if the capture is missing, malformed, or differs from the pinned claim. A valid run ends with `OK: capture matches the pinned claim in NUMBERS.md.`; `--json` writes machine-readable output for diffing. See `NUMBERS.md` for full accounting, the capture command, and rerun proof.

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

Every method that creates a record is `#[payable]`. Attach at least `record_bytes * env::storage_byte_cost()` or the call fails. Fund the contract account for storage staking before the first write.

## Build and test

| Command | Covers | Recorded result |
| --- | --- | --- |
| `cargo check --manifest-path contract/Cargo.toml --target wasm32-unknown-unknown` | contract compiles for wasm | exit 0 |
| `cargo test --manifest-path contract/Cargo.toml` | 46 Rust unit tests, then 4 `near-workspaces` sandbox tests (after the wasm build below) | 46 + 4 passed |
| `npm run typecheck` | SDK typecheck | exit 0 |
| `npm test` | Node test suite (`node --test`) | 199 passed |
| `npm run test:relayer` | relayer suite | 46 passed |
| `npm run check:oneclick` | 1Click OpenAPI fields against the pinned 0.1.10 snapshot | 6 checks passed |
| `npm run demo` | zero-funds demo | 9/9 stages |
| `npm run numbers -- --capture target/numbers/capture.log` | reduces the sandbox capture to the measured gas and storage deltas | 2.348758401541 TGas / 374 B |

Sandbox tests need `cargo near build non-reproducible-wasm` (`target/near/subrosa_contract.wasm` or `SUBROSA_CONTRACT_WASM`) and download nearcore 2.14.0 on first run.

`.env.example` documents runtime vars (`.env` stays git-ignored): `SUBROSA_NETWORK`, `NEAR_RPC_URL`, `SUBROSA_CONTRACT`, `ONECLICK_BASE_URL`, `ONECLICK_API_KEY`, `SUBROSA_DEV_KEY`, `SUBROSA_STORE_PATH`.

Toolchain: Rust >= 1.95 (tested 1.100.0, edition 2024), near-sdk 5.30.2, near-sdk-contract-tools 4.0.0, near-workspaces 0.24.0, cargo-near 0.23.0, near-cli-rs 0.31.1, nearcore sandbox 2.14.0, Node.js >= 26.0.0, npm 12.2.1. SDK pins near-api-js 7.5.3, near-social-js 2.0.4, `@hot-labs/near-connect` 0.12.0; root `overrides` pin one `near-kit` 0.20.2; Groth16 fixtures come from snarkjs 0.7.6 (`contract/testdata/groth16/multiplier2/README.md`).

## Limits and out of scope

- **Delegated approver flows.** No `assign`/`get`/`revoke` approval assignment. Every row is owned by the employer that wrote it.

## Security limits

- **NEP-413 requires a full-access key.** Intent payloads and backend login challenges are message signatures. A function-call key can never produce one. `Nep413Signer` and `backendAuth` reject it up front with `FULL_ACCESS_KEY_REQUIRED`.
- **Function-call key allowance is not a spend limit.** Receiver, method, and gas allowance bound calls only.
- **Relayer policy.** NEP-366 ignores inner allowance. Relayer enforces one `FunctionCall` (`register_employee`, `commit_salary`, `batch_commit_salaries`), `maxBlockHeight` <= 600 blocks, and 1 NEAR cap.
- **Relayer gas and storage.** Gas caps at 100 TGas (300 TGas batch). Deposits match exact storage.
- **Relayer pays gas and inner storage.** Outer tx uses an NEP-611 gas key (up to 1,024 nonce lanes). Liquid balance pays inner deposits. Fund both.
- **Retained storage deposits.** Contract keeps deposits with no refund path. Attach exact storage: 567 B employee + metadata (<= 256 B).
  Other record sizes: 374 B commitment, 258 B payout + memo, 186 B hold, 73 B proof nullifier.

## Origin, baseline, and status

<!-- origin-disclosure:start -->
This port starts from MIT-licensed `zkpayroll/zk-payroll-sdk` (https://github.com/zkpayroll/zk-payroll-sdk).
Delta to upstream `dev`: https://github.com/zkpayroll/zk-payroll-sdk/compare/a3166417082436901aa2b66618fdaf9c6c08ae17...dev

Origin companion contracts carry `NOASSERTION` license metadata and are excluded. The Rust contract under `contract/` is a clean-room implementation of the documented method surface (see `ATTRIBUTION.md`).
<!-- origin-disclosure:end -->

## Baseline and disclosure

- Baseline: tag `pre-hackathon` marks the imported tree at `b7bafa5`. The upstream project is `zkpayroll/zk-payroll-sdk`.
- Submission: tag `hackathon-submission` marks the submitted state. `git rev-parse --short hackathon-submission` prints it.
- Diff: `git diff pre-hackathon..hackathon-submission`. After publishing, https://github.com/<owner>/<repo>/compare/pre-hackathon...hackathon-submission.
- Libraries, templates and AI-generated code are listed in `ATTRIBUTION.md`.

## License and hackathon

MIT. See `LICENSE` (which retains the origin copyright notice) and `ATTRIBUTION.md`. Tracks: `privacy`, `realworld`. Development ends 2026-11-14T23:59:00Z (UTC).
