# Examples

Both examples are **dry-run only**: they need no wallet, no API key, no deposit,
and never sign or submit a transaction. They call the public 1Click API for
tokens and `dry:true` quotes, so they do need network access.

Build the SDK first:

```bash
npm install
npm run build
```

## payroll-execution.ts

Validates a two-employee payroll batch, then runs every payout through
`ConfidentialPayout.preflightPayout` (a confidential `dry:true` quote) via the
safe sequential batch submitter.

```bash
node examples/payroll-execution.ts
```

When 1Click issues confidential quotes anonymously, output ends with:

```
dry preflight complete: payouts=2/2 batches=1 fundsMoved=0
```

## private-payroll-simulation.ts

Builds salary commitments, verifies one locally, and exercises the confidential
quote path. Fails closed if a quote is not dry, carries a deposit address, or is
unsigned.

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

The examples therefore assert that exact gate, validate the confidential quote
requests locally with `validateQuoteRequest`, and (for the simulation) run a
public same-asset dry quote to exercise the wire format. They never fabricate a
confidential quote. If the gate is ever lifted, the same code takes the real
preflight path automatically.

Why dry quotes: there is no public Confidential Intents testnet. `dry:true`
exercises the request/response schema — assets, recipient pair, slippage,
deadline, signature — without generating a deposit address or moving funds. A
non-dry quote would require funding; the examples reject one.
