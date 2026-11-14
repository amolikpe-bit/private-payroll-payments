# SUBMISSION-PREP — subrosa (LOCAL DRAFT, NOT SUBMITTED)

Track: `privacy` (spec `p0-privacy.md`). Deadline 2026-11-14T23:59:00Z.
No push, no remote, no tags, no X post, no submit. Local commit only.

## Judge quickstart (do X → see Y), MEASURED pre-Celesto-only

```
npm run typecheck              -> EXIT 0 (TS 7.0.2)
npm test                       -> 199 tests / 199 pass / 0 fail / 22 suites
npm run build                  -> EXIT 0
node scripts/demo.ts           -> EXIT 0, 9/9, fundsMoved=0
node scripts/w4-dry-run.ts     -> EXIT 0, 10/10, secretHits=0
node scripts/check-oneclick-schema.ts -> EXIT 0, 6/6
npm run test:relayer           -> EXIT 0
cargo near check --clippy                                         -> EXIT 0
cargo near build non-reproducible-wasm                            -> EXIT 0 (276,150 B)
cargo test --lib -p subrosa-contract                              -> 46 passed / 0 failed
cargo test -p subrosa-contract --test sandbox                     -> 4 passed / 0 failed
git diff --check                                                  -> clean
```

Windows `cargo test` needs `NEAR_SANDBOX_BIN_PATH` or WSL2 linux-x86_64 (both
46/46). Borsh layout, domain separators, error codes, `[redacted]` and RPC wire
are golden-vector protected.

## Recordable demo outline (human records, human posts)

1. Register a worker, publish a salary commitment (hash only, no amount).
2. Settle a payout through Confidential Intents; show the public ledger carries
   no amount and no payer-to-payee link.
3. Show the auditor hold / release path. One moment, visible result.
Q-012 video required when judges cannot open the demo. Tags @NEARProtocol,
#NEARHackathon. Main writes no post.

## Payload fields — ALL EMPTY, human supplies every value

| Field | Rule | Value |
|---|---|---|
| requestId | UUID, generated ONCE, reused on 400/503 | EMPTY |
| projectName | 2-80 chars | EMPTY |
| leadName | 2-80 chars | EMPTY |
| email | valid, <=160, max 2 submissions per address (Q-015) | EMPTY |
| size | `1` / `2 - 4` / `4 - 6` / `6 - 8` / `8+` | EMPTY |
| tracks | >=1 track id, each once; `privacy` fits | EMPTY |
| nearAddress | 2-64 lowercase mainnet account the team creates | EMPTY |
| projectUrl | http(s), <=300, public repo, unique | EMPTY |
| demoUrl | http(s), <=300, published X post | EMPTY |
| idea | 20-2000 chars | EMPTY |
| consent | `true` only after verbatim notice + human yes | EMPTY |

Never add `website`. Print full JSON, wait for explicit yes. 201 saved;
400 fix `fields` + same requestId; 403 stop; 409 stop; 413 shorten; 503 retry
same requestId.

## Rules checklist

- Q-003: 10 pre-existing tags, none of `pre-hackathon` /
  `hackathon-submission`, no README diff link. **Not satisfied**; local tags
  deliberately not created.
- Q-012 video required when judges cannot open the demo.
- Q-014 `LICENSE` present. Q-017 README "Quickstart: do this, see that" at
  line 48 and "Zero-funds demo" at line 72.
- Q-015 second project on same email must be named in README. Unresolved.
- W8 verdict is CORRECTED/BOUNDED: core nearcore UPHELD for that state only;
  dRPC gateway N<=3 oracle-equal, N>=4 HTTP 400 code 31. No 20.67x / N=20 /
  FALSIFIED claims.

## Blockers (do not block submission)

No build or test blockers remain.
Celesto Box B passed `cargo fmt --check`, `cargo clippy`, `cargo near check --clippy`, and `cargo near build`.
It also passed `cargo test` (46 unit + 4 sandbox).
It also passed `oxlint` (0/0) and all Node/TS gates.
HELD: 64 ABI-distinct cargo major-version pairs. BoxLite §6 MEASURED `uScD0lurFrem`.

## Attestation

Nothing published, pushed, tagged, or submitted. No payload value invented.
