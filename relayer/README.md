# near-subrosa-relayer

NEP-366 meta-transaction relayer for the `subrosa.testnet` payroll contract.
An employer with **zero NEAR** can register workers and commit salary hashes.
The relayer pays gas and storage deposits. The contract reads `predecessor_account_id`, never `signer_account_id`.
Employees need no NEAR account for confidential payouts.

No mainnet path exists. The contract id is `subrosa.testnet` on `testnet`. Any RPC URL naming mainnet is rejected.
## What it accepts

One base64 Borsh [`SignedDelegate`](https://github.com/near/NEPs/blob/master/neps/nep-0366.md) per request:

```http
POST /v1/relay
content-type: application/json

{"signedDelegate":"<base64(borsh(SignedDelegate))>"}
```

Build it with near-api-js:

```ts
const { signedDelegate } = await account.createSignedMetaTransaction({
  receiverId: "subrosa.testnet",
  actions: [/* one FunctionCall */],
  blockHeightTtl: 200,
});
const body = { signedDelegate: Buffer.from(signedDelegate.encode()).toString("base64") };
```

A zero-NEAR client still needs an existing sender account with a valid regular access key.

## Policy (enforced locally, before RPC)

| Check | Rule |
| --- | --- |
| Network | `testnet` only. `subrosa.testnet` only |
| Inner actions | exactly one `FunctionCall` |
| Methods | `register_employee`, `commit_salary`, `batch_commit_salaries` |
| Gas | ≤ 100 TGas (register/commit), ≤ 300 TGas (batch) |
| Deposit | exactly the contract's storage deposit: `567 B + metadata bytes` (register, metadata ≤ 256 B), 374 B (commit), `items × 374 B` (batch, 1–50 items) |
| Validity | `maxBlockHeight` in `(current, current + 600]` |
| Signature | ed25519/secp256k1 over `sha256(borsh(DelegateAction))` |
| Inner signer | a **regular** access key: `FullAccess` or contract-scoped `FunctionCall` |
| Inner gas key | rejected — DelegateV2 (gas-key inner signing) was removed in protocol 87 |

### Why deposits are capped here

NEP-366 ignores the inner function-call key's allowance, so the relayer pays every cost.
An allowance cannot cap a compromised client.
The table above bounds spending, and deposits must match exact storage costs because surpluses stay in the contract.

## Outer transaction signing (NEP-611)

The relayer signs the wrapping transaction with a **full-access gas key**:

- Prepaid gas balance isolates gas spend from liquid balance.
- Up to 1,024 nonce lanes prevent collisions across concurrent relays.
- The near-api-js nonce manager reserves gas-key lanes automatically.

Account liquid balance pays inner storage deposits, not the gas key. Fund both gas key and account.

Startup rejects *function-call* gas keys: `relayMetaTransaction` targets arbitrary `delegateAction.senderId` accounts.
Startup also rejects regular full-access keys because they silently charge gas to liquid balance.
## Retiring a gas key

Deleting a NEP-611 gas key **burns its remaining prepaid balance**. The `retire-gas-key` command therefore withdraws the balance first, in a completed transaction, and only then deletes the key:

```bash
subrosa-relayer retire-gas-key
```

`RELAYER_RETIRE_RESERVE_YOCTO` keeps 0.01 NEAR on the key for withdrawal and deletion fees. Deletion burns any remaining reserve. Protocol rejects deletions burning over 1 NEAR, so reserve caps at 1 NEAR. If withdrawal fails, the key stays intact and deletion never runs.

## Run

```bash
npm install
npm run -w near-subrosa-relayer build

export RELAYER_ACCOUNT_ID=relayer.testnet
export RELAYER_GAS_KEY=ed25519:...          # never commit this
export RELAYER_API_TOKEN=$(openssl rand -hex 32)   # optional but recommended
node relayer/dist/cli.js serve
```

Environment:

| Variable | Required | Default |
| --- | --- | --- |
| `RELAYER_ACCOUNT_ID` | yes | — |
| `RELAYER_GAS_KEY` | yes | — |
| `RELAYER_RPC_URL` | no | `https://rpc.testnet.near.org` |
| `RELAYER_HOST` | no | `127.0.0.1` |
| `RELAYER_PORT` | no | `8787` |
| `RELAYER_API_TOKEN` | no | unset (open relay) |
| `RELAYER_MAX_TTL_BLOCKS` | no | `600` |
| `RELAYER_RETIRE_RESERVE_YOCTO` | no | `10^22` (0.01 NEAR) |

Routes:

- `GET /healthz`: liveness, network, and contract.
- `GET /v1/policy`: public method caps.
- `POST /v1/relay`: relay one signed delegate (bearer token if set).

## Test

```bash
npm run test:relayer
# or: cd relayer && npm test
```

Tests cover delegate caps, policy rejections, signature verification, and inner gas-key rejection. They also verify FCK-allowance bounds, withdraw-before-delete order, and HTTP errors offline.
