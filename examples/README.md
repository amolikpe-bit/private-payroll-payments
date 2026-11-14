# Examples

Both examples are **dry-run only**. They need no wallet, no API key, and no deposit. Neither signs nor submits a transaction.
They call the public 1Click API for tokens and `dry:true` quotes, so network access is required.
Build the SDK first:

```bash
npm install
npm run build
```

## payroll-execution.ts

Validates a two-employee batch. Runs every payout through `ConfidentialPayout.preflightPayout` (`dry:true` quote) via the sequential batch submitter.

```bash
node examples/payroll-execution.ts
```

When 1Click issues confidential quotes anonymously, output ends with:

```
dry preflight complete: payouts=2/2 batches=1 fundsMoved=0
```

## private-payroll-simulation.ts

Builds commitments, verifies one locally, and tests the confidential quote path.
Fails closed if a quote is not dry, carries a deposit address, or lacks a signature.

```bash
node examples/private-payroll-simulation.ts
```

Output ends with:

```
simulation complete: commitments=1 verified=1 confidential=gated publicDryQuotes=1 fundsMoved=0
```

## The live User-Session gate

1Click currently rejects confidential quotes without a User-Session token:

```
HTTP 401 "User authentication is required for confidential intent quotes"
```

Examples assert that 401 gate and validate confidential requests locally via `validateQuoteRequest`.
The simulation also sends one public same-asset dry quote to test the wire format.
Neither example fabricates quotes. When the gate lifts, the same code takes the live preflight path.

No public Confidential Intents testnet exists. `dry:true` tests schema, assets, recipient pair, slippage, deadline, and signature without deposit addresses or funds.
Non-dry quotes require funding and are rejected.
