# near-subrosa-relayer

NEP-366 meta-transaction relayer for the `subrosa.testnet` payroll contract.
It lets an employer with **zero NEAR** register an employee and commit salary
hashes: the relayer pays gas *and* the inner action's storage deposit, then the
contract identifies the employer by `predecessor_account_id` (never the
relayer's `signer_account_id`). Employees need no NEAR account at all for the
confidential payout path.

There is no mainnet path. The contract id is fixed to `subrosa.testnet`, the
network is `testnet`, and any RPC URL whose hostname names mainnet is rejected.

## What it accepts

One base64 Borsh [`SignedDelegate`](https://github.com/near/NEPs/blob/master/neps/nep-0366.md)
per request:

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

A client with no NEAR ever needs: the delegate sender's account must exist and
hold the regular access key that signed it.

## Policy (enforced locally, before RPC)

| Check | Rule |
| --- | --- |
| Network | `testnet` only; `subrosa.testnet` only |
| Inner actions | exactly one `FunctionCall` |
| Methods | `register_employee`, `commit_salary`, `batch_commit_salaries` |
| Gas | ≤ 100 TGas (register/commit), ≤ 300 TGas (batch) |
| Deposit | exactly the contract's storage deposit: `267 B + metadata bytes` (register, metadata ≤ 256 B), 182 B (commit), `items × 182 B` (batch, 1–50 items) |
| Validity | `maxBlockHeight` in `(current, current + 600]` |
| Signature | ed25519/secp256k1 over `sha256(borsh(DelegateAction))` |
| Inner signer | a **regular** access key: `FullAccess` or contract-scoped `FunctionCall` |
| Inner gas key | rejected — DelegateV2 (gas-key inner signing) was removed in protocol 87 |

### Why deposits are capped here

NEP-366 does not check the inner function-call key's **allowance**: the relayer
pays every cost. An allowance therefore cannot bound what a compromised or
malicious client spends. The table above is the spending bound, and the deposit
must match the contract's exact storage requirement because the contract retains
any surplus.

## Outer transaction signing (NEP-611)

The relayer signs the wrapping transaction with a **full-access gas key**:

- prepaid gas balance isolates gas spend from the account's liquid balance;
- up to 1,024 nonce lanes eliminate nonce collisions between concurrent relays;
- near-api-js's nonce manager detects the gas-key permission and reserves a lane
  automatically.

Inner attached deposits (the storage deposits capped below) are paid from the
relayer account's **liquid** balance, not the gas key. Fund both: gas on the gas
key, deposit headroom on the account.

A *function-call* gas key is rejected at startup: `relayMetaTransaction` targets
`delegateAction.senderId` (an arbitrary user account), which a contract-scoped
key cannot sign. A regular full-access key is also rejected — it would work
technically but silently move gas spend onto the account balance.

## Retiring a gas key

Deleting a NEP-611 gas key **burns its remaining prepaid balance**. The
`retire-gas-key` command therefore withdraws the balance first, in a completed
transaction, and only then deletes the key:

```bash
subrosa-relayer retire-gas-key
```

A 0.01 NEAR reserve stays on the key to pay for the withdrawal and deletion
transactions (`RELAYER_RETIRE_RESERVE_YOCTO`). Any reserve left after those
transactions is burned by deletion; the protocol rejects deleting a gas key that
would burn more than 1 NEAR, so the reserve is capped at 1 NEAR. If withdrawal
fails, the key is left intact; deletion is never attempted.

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

- `GET /healthz` — liveness, network and contract
- `GET /v1/policy` — public method caps
- `POST /v1/relay` — relay one signed delegate (bearer token when configured)

## Test

```bash
npm run test:relayer
# or: cd relayer && npm test
```

The suite covers delegate caps, receiver/method/deposit/gas/expiry rejection,
signature verification, inner gas-key rejection, the FCK-allowance-bypass bound,
withdraw-before-delete ordering, and the HTTP error surface. No network access is
required.
