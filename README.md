# subrosa

Tracks `privacy`, `realworld` · MIT · baseline `pre-hackathon` at `b7bafa5` (`zkpayroll/zk-payroll-sdk`), diff `git diff pre-hackathon..hackathon-submission` · Q-015 sibling **krater** (AMM pool, tracks `defi`) · NEP-297, NEP-366, NEP-413, NEP-611.

Private payroll on NEAR: an employer commits hashed salaries, verifies a proof against the commitment, and a relayer settles payouts. Workers withdraw privately while the contract tracks state, so a company can pay a team without publishing who earns what.

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

```bash
npm install && npm run build
node examples/private-payroll-simulation.ts
node examples/payroll-execution.ts
cargo check --manifest-path contract/Cargo.toml --target wasm32-unknown-unknown
cargo test --manifest-path contract/Cargo.toml
npm run typecheck && npm test
npm run demo
npm run numbers -- --capture target/numbers/capture.log
```

| Do this | See this | Proves |
| --- | --- | --- |
| `npm install`; `npm run build` | exit 0 | quickstart |
| `npm run demo`; `npm run numbers` | `2.348758401541 TGas` gross | smoke + measure |
| `cargo test`; `npm test` | 199 passed | tests |
| `commit_salary` / `batch_commit_salaries` | `SalaryCommitted` event, hash stored, no amount | salaries stay private |
| `verify_proof` (optional Groth16) | `ProofVerified` event | proof path works |
| `PayrollService.processPayment` | payout scheduled, marked settled/failed, audit holds respected | payout lifecycle |
| `commit_salary`; `verify_proof` | hashed commitments; Groth16 verifier is optional; a function-call key allowance is not a spend limit - receiver, method and gas allowance bound calls only | Limits |

[ATTRIBUTION](ATTRIBUTION.md) · [LICENSE](LICENSE) · https://github.com/zkpayroll/zk-payroll-sdk
