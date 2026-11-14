# W4 dry run — zero-funds end-to-end transcript

`scripts/w4-dry-run.ts` is the W4 close demo. It exercises the payroll, commitment, Confidential Intents quote-gate, payout-preflight, receipt and redaction paths.
Run it with **no wallet, no API key, no User-Session, no deposit and no transaction**.
The script fails closed on a credential header or a non-dry quote request or response. It also fails closed on a dry-quote deposit address or any private value that reaches printed output.

The transcript below is the recorded W4 gate run on `cmp_512755789ee1` (2026-11-12). The command reproduces it.
It complements `scripts/demo.ts` (W3 PIN 3) without importing it. W4 adds receipt construction and redaction coverage and keeps the same zero-funds invariants.

## Command

```bash
npm install
npm run build
node scripts/w4-dry-run.ts
```

Prerequisites:

- Node.js `>=26.0.0` runs the `.ts` script directly (the repo engine, with type stripping).
- Network access to `https://1click.chaindefuser.com` is needed for quote requests and the payout preflight's token/quote lookups.
- No environment variables are required. `ONECLICK_API_KEY` and `ONECLICK_USER_SESSION` are ignored. The client uses an empty API key and an anonymous transport.

The settlement asset is the 1Click-published USDC NEP-141 id. No NEAR RPC call is made. The only HTTP calls are `/v0/quote` (confidential and public) plus the payout preflight. The preflight reads `/v0/tokens`. It then requests a dry quote when the asset resolves.

## Expected transcript

```text
[1/10] config: network=testnet contract=subrosa.testnet oneclick=1click.chaindefuser.com wallet=none keys=none session=anonymous funds=0
[2/10] payroll: employer=subrosa.testnet employees=3 cycle=1 destinations=valid batch=valid totalAmount=hidden
[3/10] commitments: 3 commitments cycle=1 hashes=8aaa0547d269,9ef79e91b67f,6e26b573b260
[4/10] proof: preimages=3 verified=3 tamperedAmount=rejected preimageBytes=186
[5/10] quote-gate: anonymousConfidential=gated-401(User-Session-required) publicDry=dry-ok quoteRequests=2
[6/10] payout: stored=3 preflight=blocked-fail-closed signerCalls=0 funds=0
[7/10] resume: interruptedAtBatch=1 resumedBatches=2 processed=3/3 token=verified mode=dry-request-validation
[8/10] receipt: receipts=3 statuses=settled references=deterministic-fixture metadata=commitment viewKey=none signatures=absent
[9/10] redaction: fields=5 receiptLeak=0 errorLeak=0 secretHits=0
[10/10] summary: stages=10 commitments=3 proofs=3 quoteGate=gated publicQuote=ok payoutsStored=3 resumed=3 receipts=3 secretHits=0 wetQuotes=0 fundsMoved=0
```

Stages 1–4, 6–9 and the stage-numbering are deterministic. The live 1Click result is the only variable:

- **Stage 5, `publicDry`.** `dry-ok` when the public same-asset dry quote succeeds. `gated-401(documented)` when 1Click applies the documented 401 gate to the public quote as well. Both are accepted. Any other 1Click status or a non-dry response is a failure.
- **Stage 5, `anonymousConfidential`.** `gated-401(User-Session-required)` is the current live behavior for confidential quotes without a User-Session. If 1Click later accepts the anonymous dry request, the line becomes `dry-ok`. Stage 6 becomes `preflight=dry-ok`. The quote must still be dry and deposit-address free.
- **Stage 6 `preflight`.** `blocked-fail-closed` when the quote gate blocks the dry preflight (the expected path). `dry-ok` only when the anonymous confidential quote was accepted. The payout engine never signs and never requests a non-dry quote.
- **Stage 10 `publicQuote`.** `ok` or `gated`, mirroring stage 5.

`npm run build` is required because the script imports the built `near-subrosa-core` package (the workspace `dist/` output), exactly like `scripts/demo.ts`.

## What each stage proves

| Stage | Proof |
|---|---|
| 1 `config` | Testnet preset, fixed 1Click host, no wallet, no key, no session, zero funds. |
| 2 `payroll` | Three NEAR account ids pass `validateNearDestination`. `BatchPayloadBuilder` accepts the entries and preserves the aggregate. The total is not printed. |
| 3 `commitments` | Per-cycle commitments are derived from private amounts and deterministic 32-byte salts. Only public hash prefixes are printed. |
| 4 `proof` | Each Borsh preimage is rebuilt, hashed and compared with `verifyCommitment`. A one-unit amount change is rejected. This is a commitment-preimage proof, not a Groth16 verifier run (Step 5 is out of scope). |
| 5 `quote-gate` | One anonymous confidential dry quote and one public same-asset dry quote. A 401 is the documented User-Session gate. A 200 must be `dry: true`, signed, echo the request, and carry no deposit address. |
| 6 `payout` | Three pending payouts are written to a temporary `PrivateStore`. `ConfidentialPayout.preflightPayout` fails closed with the refusing signer. No `executePendingPayout`/`shield` call occurs. |
| 7 `resume` | A sequential batch run is interrupted before batch 2, resumes from the opaque checkpoint, and processes all three payouts through local dry-request validation. |
| 8 `receipt` | Three `createSettlementReceipt` receipts validate, map `SUCCESS` to `settled`, carry the commitment digest as `metadataDigest`, and contain no view key. The intent hash is a deterministic fixture because no intent is submitted. |
| 9 `redaction` | `redactDeep` removes employee, amount, salt, deposit address and deposit memo. `redactError` removes the same labels from message and stack. The receipt JSON is scanned for every registered secret. |
| 10 `summary` | Counters close the run: zero secret hits, zero wet quotes, zero funds moved. |

## Failure behavior

A successful run prints all ten stages and exits 0. The process exits non-zero with `w4-dry-run failed [CODE]: <redacted message>` when:

- `SECRET_LEAK` — a registered private value would be printed.
- `NON_DRY_QUOTE_REQUEST` / `QUOTE_NOT_DRY` — a wet quote was attempted or returned.
- `DRY_QUOTE_DEPOSIT_ADDRESS` — a dry quote returned a deposit address.
- `CREDENTIAL_PRESENT` — a request carried `Authorization` or `X-API-Key`.
- `DRY_RUN_WOULD_SIGN` — a code path called the refusing signer.
- `QUOTE_COUNT_UNEXPECTED` — the confidential/public gate did not issue exactly two quote requests.
- Any unexpected 1Click status, network error, receipt-validation error, store error or resume-token error.

The temporary private store is removed in a `finally` block, including on failure.

## Explicit non-claims

- No live settlement happened. Receipts are built from a deterministic fixture intent hash. No `/v0/generate-intent`, `/v0/submit-intent` or `/v0/status` call is made.
- No Groth16 proof is generated or verified on chain. "Proof" here means the client-side commitment preimage recomputation, matching the contract's hash.
- The confidential quote is not fabricated. Without a User-Session the live API returns the documented 401 gate. The script asserts the gate instead of inventing a quote. The local request is still validated field by field.
