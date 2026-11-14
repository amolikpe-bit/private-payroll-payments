# NUMBERS — measured commitment claim (W4, PIN 4)

One `commit_salary` call on the pinned sandbox wasm, measured from the
transaction outcome and the contract account's `storage_usage` delta.

**Gross gas: `2,353,357,561,394` gas = `2.353357561394` TGas.**
**Storage: `374` B = `0.00374` NEAR at the sandbox price of `1e19`
yoctoNEAR/byte.**

Both values come from the capture line printed by
`contract/tests/sandbox.rs` on `sandbox_registry_commitments_and_pause`; they are
not estimates. Gas is **gross**: there is no 30% developer rebate. HSP-027
removed it in nearcore 2.14.0 (PV87 `RemoveGasRewards`); 2.14.1 is a
security-only patch. The claim therefore budgets the full burnt amount.

## Units and accounting

| Quantity | Value | Unit |
| --- | --- | --- |
| Gross gas burnt | `2,353,357,561,394` | gas |
| Gross gas burnt | `2.353357561394` | TGas (`1 TGas = 1e12 gas`) |
| Commitment storage delta | `374` | bytes |
| Storage price (sandbox) | `1e19` | yoctoNEAR per byte |
| Storage cost | `3,740,000,000,000,000,000,000` | yoctoNEAR |
| Storage cost | `0.00374` | NEAR (`1 NEAR = 1e24 yoctoNEAR`) |
| Gas rebate | none | gross claim |

The 374 B is the measured delta and the model used by
`COMMITMENT_RECORD_BYTES` in `contract/src/lib.rs`. It supersedes the earlier
182 B estimate in `p0-privacy.md` Step 14. A 50-item `batch_commit_salaries`
call therefore requires `50 × 374 B = 18,700 B = 0.187 NEAR` of storage
deposit; that batch deposit is arithmetic, not a second measurement.

Gas is reported in gas units/TGas, not in NEAR: the gas price is a runtime
parameter and would make a NEAR-denominated "gas cost" non-reproducible. The
storage price is the sandbox constant `1e19` yoctoNEAR/byte.

## Reproduction

The capture is produced first, then consumed. The script never runs cargo and
never invents a value: it fails closed if the capture is absent or invalid.

```bash
cd ~/work/subrosa

# Prerequisites: Rust 1.95.0, Node >= 26.0.0, npm install.
# The sandbox test needs a wasm build; build it with cargo-near 0.23.0:
cargo near build non-reproducible-wasm
# (or point SUBROSA_CONTRACT_WASM at an existing artifact)

mkdir -p target/numbers
cargo +1.95.0 test -p subrosa-contract --test sandbox \
  sandbox_registry_commitments_and_pause -- --test-threads=1 --nocapture \
  2>&1 | tee target/numbers/capture.log

npm run numbers -- --capture target/numbers/capture.log
```

`npm run numbers` is `npm run build && node scripts/numbers.ts`, so the SDK
build is included. Expected tail of a successful run:

```text
OK: capture matches the pinned claim in NUMBERS.md.
```

For a stable machine-readable report (for rerun diffing):

```bash
npm run numbers -- --capture target/numbers/capture.log --json
```

The script exits non-zero when `--capture` is omitted, the file is missing or
empty, the marker line is malformed or conflicting, the JSON shape/price is
invalid, the storage delta is not 374 B, or the gas is not the pinned value.
The 50-entry batch/redaction checks live in
`packages/core/tests/behavior.test.ts` (consolidated behavior suite) and run with `npm test`.

### Rerun proof

Run the capture and report twice, keeping the first report:

```bash
mkdir -p target/numbers
cargo +1.95.0 test -p subrosa-contract --test sandbox \
  sandbox_registry_commitments_and_pause -- --test-threads=1 --nocapture \
  2>&1 | tee target/numbers/capture.log
npm run numbers -- --capture target/numbers/capture.log --json \
  > target/numbers/report-first.json

# rerun the cargo command above into target/numbers/capture.log, then:
npm run numbers -- --capture target/numbers/capture.log --json \
  > target/numbers/report-second.json
diff -u target/numbers/report-first.json target/numbers/report-second.json
```

A clean rerun produces an empty diff: the text capture carries no timestamp, tx
hash, or other volatile metadata. If the second run differs, the claim is not
reproducible on that box and `NUMBERS.md` must not be updated to the new value
until the difference is explained.

## Capture prerequisite and schema

### Text form (the cargo test log)

The capture file may contain any cargo output. The script requires exactly one
distinct marker line:

```text
W4_CAPTURE commitment_gas_burnt=<u64> commitment_storage_delta=<u64>
```

The current values are:

```text
W4_CAPTURE commitment_gas_burnt=2353357561394 commitment_storage_delta=374
```

- `commitment_gas_burnt` is `ExecutionFinalResult.total_gas_burnt.as_gas()` for
  the single `commit_salary` call: the transaction outcome plus every receipt
  outcome, i.e. gross gas for the call.
- `commitment_storage_delta` is
  `view_account(contract).storage_usage` after minus before, in bytes.
- The test emits the line with `eprintln!`; redirect stderr into the log
  (`2>&1 | tee ...`) because `--nocapture` alone shows it on the terminal but
  does not save it.
- Duplicate marker lines with identical values are accepted; conflicting lines
  are rejected so two runs cannot be mixed silently.

### JSON form

```json
{
  "schema": "subrosa/numbers-capture/v1",
  "network": "sandbox",
  "nearcore": "2.14.0",
  "captured_at": "2026-11-12T00:00:00Z",
  "tx_hash": "<base58 transaction hash>",
  "storage_byte_cost_yocto": "10000000000000000000",
  "commitment_gas_burnt": "2353357561394",
  "commitment_storage_delta": 374
}
```

Required: `commitment_gas_burnt` and `commitment_storage_delta`, as decimal
strings or non-negative JSON integers. Optional fields are validated when
present: `schema` must be `subrosa/numbers-capture/v1`, `network` must be
`sandbox`, and `storage_byte_cost_yocto` must equal `1e19`. `nearcore`,
`captured_at`, and `tx_hash` are printed but not asserted.

## 50-entry batch: chunk, resume, and redaction

Step 14(c) asks for a 50-entry batch chunk/resume with zero sensitive values in
errors. The assertion is local and needs no chain or keys; it lives in
`packages/core/tests/numbers-redaction.test.ts` and runs with `npm test`:

1. Builds 50 valid payout entries (unique employee/cycle pairs, 64-hex
   commitment hashes, positive u128 amounts, 32-byte hex salts).
2. Asserts the contract cap: 50 entries fit one chunk; 51 entries split
   `50 + 1`; the SDK `MAX_BATCH_SIZE` is 50.
3. Creates a resume token for the 50 entries at batch size 10 (5 batches), then
   resolves a checkpoint at batch 2 / 20 items and asserts it resumes exactly
   there.
4. Scans the raw payload: amounts and salts produce warnings; salts and
   `witnessSecret`/`privateKey` produce errors, so the raw batch is unsafe.
5. Redacts with the default replacement mode: no employee id, amount, salt, or
   credential survives; the public commitment hashes and asset/memo fields
   remain; the redacted entry has the expected snapshot shape.
6. Redacts with `mode: "remove"`: no sensitive key or value remains and
   `validateSafeCredentialUsage` reports zero findings.
7. Redacts a synthetic submit error whose message, stack, and `context` carry a
   50-entry batch plus a NEAR secret key: the snapshot contains
   `[redacted]`, the source error is not mutated, and no private value leaks.
8. Asserts the resume token itself contains no private value.

The assertion exits non-zero on any leak; a successful run prints the finding
counts and `0` leak counts.

## Origin comparison

The origin ships `tests/benchmarks/performance-baseline.json` (at the port
baseline, `packages/core/tests/benchmarks/performance-baseline.json`). Its rows
measure Node-side microbenchmarks in milliseconds (witness encoding, cache
hit/miss, draft creation, aggregation, idempotency tracking); it contains no
on-chain gas or contract-storage rows. **No row is comparable** to this pin, so
this document makes no speedup claim against the origin. The comparison stops
at the units: milliseconds of local JS work versus gas/burned bytes on a
sandbox chain.

## Limits

- Sandbox only (`nearcore 2.14.0`, near-workspaces 0.24.0); not a testnet or
  mainnet fee quote. Gas can change with the wasm build, protocol version, or
  the number of bytes written; the pinned value is tied to the pinned build.
- One `commit_salary` call for one employee and cycle on a freshly deployed
  contract. It is not a batch, payout, hold, or Groth16 verification number.
- Gas includes the transaction outcome and all receipt outcomes (gross call
  cost), with no rebate. Storage cost assumes the sandbox price `1e19`
  yoctoNEAR/byte.
- No wallet, key, RPC endpoint, or funded account is used. The script reads one
  local capture file only; the moved batch/redaction checks run in `npm test`.
