import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  DelegateAction,
  KeyPair,
  Signature,
  SignedDelegate,
  actions as nearActions,
  encodeDelegateAction,
} from "near-api-js";

import type { AccessKeyPermissionView } from "../src/nearTypes.js";

import {
  COMMITMENT_RECORD_BYTES,
  EMPLOYEE_RECORD_BYTES,
  SUBROSA_TESTNET_CONTRACT,
  TGAS,
  YOCTO_PER_BYTE,
} from "../src/constants.js";
import {
  decodeSignedDelegateBase64,
  encodeSignedDelegateBase64,
} from "../src/delegate.js";
import { RelayerError, type RelayerErrorCode } from "../src/errors.js";
import {
  DEFAULT_METHODS,
  validateDelegate,
  validateInnerAccessKey,
  verifyDelegateSignature,
  type DelegatePolicy,
} from "../src/policy.js";
import { SubrosaRelayer, type RelayReceipt, type RelayerChain } from "../src/relayer.js";

const RELAYER = "relayer.testnet";
const SENDER = "alice.testnet";
const CURRENT_HEIGHT = 1_000n;

const BASE_POLICY: DelegatePolicy = {
  network: "testnet",
  contractId: SUBROSA_TESTNET_CONTRACT,
  relayerAccountId: RELAYER,
  currentBlockHeight: CURRENT_HEIGHT,
  maxTtlBlocks: 600,
  methods: DEFAULT_METHODS,
};

interface DelegateOptions {
  senderId?: string;
  receiverId?: string;
  methodName?: string;
  args?: unknown;
  deposit?: bigint;
  gas?: bigint;
  maxBlockHeight?: bigint;
  nonce?: bigint;
  keyPair?: KeyPair;
  actions?: DelegateAction["actions"];
}

function makeSignedDelegate(options: DelegateOptions = {}): SignedDelegate {
  const keyPair = options.keyPair ?? KeyPair.fromRandom("ed25519");
  const args = new TextEncoder().encode(JSON.stringify(options.args ?? {}));
  const actions =
    options.actions ??
    [
      nearActions.functionCall(
        options.methodName ?? "register_employee",
        args,
        options.gas ?? 100n * TGAS,
        options.deposit ?? EMPLOYEE_RECORD_BYTES * YOCTO_PER_BYTE,
      ),
    ];
  const delegateAction = new DelegateAction({
    senderId: options.senderId ?? SENDER,
    receiverId: options.receiverId ?? SUBROSA_TESTNET_CONTRACT,
    actions,
    nonce: options.nonce ?? 1n,
    maxBlockHeight: options.maxBlockHeight ?? CURRENT_HEIGHT + 100n,
    publicKey: keyPair.getPublicKey(),
  });
  const digest = new Uint8Array(
    createHash("sha256").update(encodeDelegateAction(delegateAction)).digest(),
  );
  const signed = keyPair.sign(digest);
  return new SignedDelegate({
    delegateAction,
    signature: new Signature({
      keyType: keyPair.getPublicKey().keyType,
      data: signed.signature,
    }),
  });
}

const EMPLOYEE_ARGS = {
  employee: "alice.testnet",
  salary_commitment: "a".repeat(64),
  token: "usdc.testnet",
  metadata: "",
};

function expectCode(fn: () => unknown, code: RelayerErrorCode): void {
  assert.throws(
    fn,
    (error: unknown) => error instanceof RelayerError && error.code === code,
    `expected RelayerError ${code}`,
  );
}

test("accepts a zero-NEAR register_employee delegate with the exact storage deposit", () => {
  const signed = makeSignedDelegate({ methodName: "register_employee", args: EMPLOYEE_ARGS });
  const validated = validateDelegate(signed, BASE_POLICY);
  assert.equal(validated.senderId, SENDER);
  assert.equal(validated.method, "register_employee");
  assert.equal(validated.depositYocto, EMPLOYEE_RECORD_BYTES * YOCTO_PER_BYTE);
  verifyDelegateSignature(signed);
});

test("charges register_employee for metadata bytes as well as the record", () => {
  const metadata = "x".repeat(10);
  const withMetadata = makeSignedDelegate({
    args: { ...EMPLOYEE_ARGS, metadata },
    deposit: (EMPLOYEE_RECORD_BYTES + 10n) * YOCTO_PER_BYTE,
  });
  assert.equal(
    validateDelegate(withMetadata, BASE_POLICY).depositYocto,
    (EMPLOYEE_RECORD_BYTES + 10n) * YOCTO_PER_BYTE,
  );

  const underpaid = makeSignedDelegate({
    args: { ...EMPLOYEE_ARGS, metadata },
    deposit: EMPLOYEE_RECORD_BYTES * YOCTO_PER_BYTE,
  });
  expectCode(() => validateDelegate(underpaid, BASE_POLICY), "DEPOSIT_MISMATCH");

  const tooLong = makeSignedDelegate({
    args: { ...EMPLOYEE_ARGS, metadata: "x".repeat(257) },
    deposit: (EMPLOYEE_RECORD_BYTES + 256n) * YOCTO_PER_BYTE,
  });
  expectCode(() => validateDelegate(tooLong, BASE_POLICY), "INVALID_ARGS");
});

test("accepts an in-window batch commit with a per-item deposit", () => {
  const items = Array.from({ length: 3 }, (_, index) => ({
    employee: `employee${index}.testnet`,
    commitment_hash: "b".repeat(64),
    cycle_id: 1,
  }));
  const signed = makeSignedDelegate({
    methodName: "batch_commit_salaries",
    args: { items },
    deposit: BigInt(items.length) * COMMITMENT_RECORD_BYTES * YOCTO_PER_BYTE,
    gas: 300n * TGAS,
  });
  const validated = validateDelegate(signed, BASE_POLICY);
  assert.equal(validated.method, "batch_commit_salaries");
});

test("rejects a batch whose deposit does not equal items x record size", () => {
  const items = Array.from({ length: 3 }, (_, index) => ({
    employee: `employee${index}.testnet`,
    commitment_hash: "b".repeat(64),
    cycle_id: 1,
  }));
  const signed = makeSignedDelegate({
    methodName: "batch_commit_salaries",
    args: { items },
    deposit: 2n * COMMITMENT_RECORD_BYTES * YOCTO_PER_BYTE,
    gas: 300n * TGAS,
  });
  expectCode(() => validateDelegate(signed, BASE_POLICY), "DEPOSIT_MISMATCH");
});

test("rejects more than 50 batch items", () => {
  const items = Array.from({ length: 51 }, (_, index) => ({
    employee: `employee${index}.testnet`,
    commitment_hash: "b".repeat(64),
    cycle_id: 1,
  }));
  const signed = makeSignedDelegate({
    methodName: "batch_commit_salaries",
    args: { items },
    deposit: 50n * COMMITMENT_RECORD_BYTES * YOCTO_PER_BYTE,
    gas: 300n * TGAS,
  });
  expectCode(() => validateDelegate(signed, BASE_POLICY), "INVALID_ARGS");
});

test("rejects a mainnet receiver", () => {
  const signed = makeSignedDelegate({
    receiverId: "subrosa.near",
    methodName: "register_employee",
    args: EMPLOYEE_ARGS,
  });
  expectCode(() => validateDelegate(signed, BASE_POLICY), "RECEIVER_NOT_ALLOWED");
});

test("rejects methods outside the allowlist", () => {
  const signed = makeSignedDelegate({
    methodName: "schedule_payout",
    args: {},
    deposit: 1n,
  });
  expectCode(() => validateDelegate(signed, BASE_POLICY), "METHOD_NOT_ALLOWED");
});

test("rejects multiple inner actions", () => {
  const keyPair = KeyPair.fromRandom("ed25519");
  const call = (methodName: string) =>
    nearActions.functionCall(
      methodName,
      new TextEncoder().encode("{}"),
      100n * TGAS,
      EMPLOYEE_RECORD_BYTES * YOCTO_PER_BYTE,
    );
  const signed = makeSignedDelegate({
    keyPair,
    actions: [call("register_employee"), call("commit_salary")],
  });
  expectCode(() => validateDelegate(signed, BASE_POLICY), "MULTIPLE_ACTIONS_NOT_ALLOWED");
});

test("rejects a non-function-call action", () => {
  const keyPair = KeyPair.fromRandom("ed25519");
  const signed = makeSignedDelegate({
    keyPair,
    actions: [nearActions.transfer(1n)],
  });
  expectCode(() => validateDelegate(signed, BASE_POLICY), "ACTION_NOT_ALLOWED");
});

test("rejects an underfunded deposit", () => {
  const signed = makeSignedDelegate({
    methodName: "commit_salary",
    args: { employee: "alice.testnet", commitment_hash: "a".repeat(64), cycle_id: 1 },
    deposit: COMMITMENT_RECORD_BYTES * YOCTO_PER_BYTE - 1n,
  });
  expectCode(() => validateDelegate(signed, BASE_POLICY), "DEPOSIT_MISMATCH");
});

test("rejects an over-cap gas budget", () => {
  const signed = makeSignedDelegate({
    args: EMPLOYEE_ARGS,
    gas: 101n * TGAS,
  });
  expectCode(() => validateDelegate(signed, BASE_POLICY), "GAS_CAP_EXCEEDED");
});

test("rejects an expired delegate", () => {
  const signed = makeSignedDelegate({
    args: EMPLOYEE_ARGS,
    maxBlockHeight: CURRENT_HEIGHT,
  });
  expectCode(() => validateDelegate(signed, BASE_POLICY), "DELEGATE_EXPIRED");
});

test("rejects a delegate validity window beyond the TTL cap", () => {
  const signed = makeSignedDelegate({
    args: EMPLOYEE_ARGS,
    maxBlockHeight: CURRENT_HEIGHT + 601n,
  });
  expectCode(() => validateDelegate(signed, BASE_POLICY), "DELEGATE_TTL_TOO_LONG");
});

test("rejects a forged signature", () => {
  const signed = makeSignedDelegate({ args: EMPLOYEE_ARGS });
  signed.signature.data[0] ^= 0xff;
  expectCode(() => verifyDelegateSignature(signed), "INVALID_SIGNATURE");
});

test("rejects a non-testnet policy", () => {
  const signed = makeSignedDelegate({ args: EMPLOYEE_ARGS });
  const policy = { ...BASE_POLICY, network: "mainnet" as never };
  expectCode(() => validateDelegate(signed, policy), "NETWORK_NOT_ALLOWED");
});

test("accepts FullAccess and contract-scoped FunctionCall inner keys", () => {
  assert.doesNotThrow(() => validateInnerAccessKey("FullAccess", "commit_salary", SUBROSA_TESTNET_CONTRACT));
  assert.doesNotThrow(() =>
    validateInnerAccessKey(
      {
        FunctionCall: {
          receiver_id: SUBROSA_TESTNET_CONTRACT,
          method_names: ["commit_salary", "register_employee"],
          allowance: "1",
        },
      },
      "commit_salary",
      SUBROSA_TESTNET_CONTRACT,
    ),
  );
});

test("rejects a FunctionCall inner key scoped elsewhere or to other methods", () => {
  expectCode(
    () =>
      validateInnerAccessKey(
        {
          FunctionCall: {
            receiver_id: "other.testnet",
            method_names: [],
            allowance: null,
          },
        },
        "commit_salary",
        SUBROSA_TESTNET_CONTRACT,
      ),
    "INNER_KEY_SCOPE_MISMATCH",
  );
  expectCode(
    () =>
      validateInnerAccessKey(
        {
          FunctionCall: {
            receiver_id: SUBROSA_TESTNET_CONTRACT,
            method_names: ["schedule_payout"],
            allowance: null,
          },
        },
        "commit_salary",
        SUBROSA_TESTNET_CONTRACT,
      ),
    "INNER_KEY_SCOPE_MISMATCH",
  );
});

test("rejects gas keys as inner signers (DelegateV2 removed in protocol 87)", () => {
  expectCode(
    () =>
      validateInnerAccessKey(
        { GasKeyFullAccess: { balance: "1", num_nonces: 1 } },
        "commit_salary",
        SUBROSA_TESTNET_CONTRACT,
      ),
    "INNER_KEY_GAS_KEY_REJECTED",
  );
  expectCode(
    () =>
      validateInnerAccessKey(
        {
          GasKeyFunctionCall: {
            balance: "1",
            num_nonces: 1,
            receiver_id: SUBROSA_TESTNET_CONTRACT,
            method_names: [],
            allowance: null,
          },
        },
        "commit_salary",
        SUBROSA_TESTNET_CONTRACT,
      ),
    "INNER_KEY_GAS_KEY_REJECTED",
  );
  expectCode(
    () => validateInnerAccessKey(null, "commit_salary", SUBROSA_TESTNET_CONTRACT),
    "INNER_KEY_NOT_FOUND",
  );
});

test("round-trips the base64 Borsh wire format and rejects garbage", () => {
  const signed = makeSignedDelegate({ args: EMPLOYEE_ARGS });
  const decoded = decodeSignedDelegateBase64(encodeSignedDelegateBase64(signed));
  assert.equal(decoded.delegateAction.senderId, SENDER);
  expectCode(() => decodeSignedDelegateBase64("not base64!"), "INVALID_SIGNED_DELEGATE");
  expectCode(() => decodeSignedDelegateBase64("AAAA"), "INVALID_SIGNED_DELEGATE");
});

class FakeChain implements RelayerChain {
  readonly calls: string[] = [];
  readonly permission: AccessKeyPermissionView | null;
  readonly receipt: RelayReceipt = { txHash: "11111111111111111111111111111111", status: "success" };
  readonly views = new Map<string, unknown>();

  constructor(permission: AccessKeyPermissionView | null = "FullAccess") {
    this.permission = permission;
  }

  async currentBlockHeight(): Promise<bigint> {
    this.calls.push("height");
    return CURRENT_HEIGHT;
  }

  async getAccessKey(accountId: string, publicKey: string): Promise<AccessKeyPermissionView | null> {
    this.calls.push(`key:${accountId}:${publicKey}`);
    return this.permission;
  }

  async viewFunction<T>(_contractId: string, method: string, args: Record<string, unknown>): Promise<T> {
    this.calls.push(`view:${method}:${String(args.employee)}`);
    return (this.views.get(String(args.employee)) ?? null) as T;
  }

  async relay(): Promise<RelayReceipt> {
    this.calls.push("relay");
    return this.receipt;
  }
}

test("relayer checks locally before touching the chain, then relays", async () => {
  const chain = new FakeChain();
  const relayer = new SubrosaRelayer({ relayerAccountId: RELAYER, chain });
  const receipt = await relayer.relay(makeSignedDelegate({ args: EMPLOYEE_ARGS }));
  assert.equal(receipt.txHash, chain.receipt.txHash);
  assert.deepEqual(chain.calls[0], "height");
  assert.match(chain.calls[1], /^key:alice\.testnet:ed25519:/);
  assert.match(chain.calls[2], /^view:get_employee:alice\.testnet$/);
  assert.equal(chain.calls[3], "relay");
});

test("relayer rejects a registration whose employee already exists", async () => {
  const chain = new FakeChain();
  chain.views.set("alice.testnet", { active: true });
  const relayer = new SubrosaRelayer({ relayerAccountId: RELAYER, chain });
  await assert.rejects(
    relayer.relay(makeSignedDelegate({ args: EMPLOYEE_ARGS })),
    (error: unknown) => error instanceof RelayerError && error.code === "INNER_WILL_FAIL",
  );
  assert.equal(chain.calls.includes("relay"), false);
});

test("relayer rejects a commitment for an unregistered employee", async () => {
  const chain = new FakeChain();
  const relayer = new SubrosaRelayer({ relayerAccountId: RELAYER, chain });
  await assert.rejects(
    relayer.relay(
      makeSignedDelegate({
        methodName: "commit_salary",
        args: { employee: "alice.testnet", commitment_hash: "a".repeat(64), cycle_id: 1 },
        deposit: COMMITMENT_RECORD_BYTES * YOCTO_PER_BYTE,
      }),
    ),
    (error: unknown) => error instanceof RelayerError && error.code === "INNER_WILL_FAIL",
  );
  assert.equal(chain.calls.includes("relay"), false);
});

test("relayer enforces the per-sender sponsored-deposit cap", async () => {
  const chain = new FakeChain();
  const relayer = new SubrosaRelayer({
    relayerAccountId: RELAYER,
    chain,
    maxSponsoredDepositPerSenderYocto: 0n,
  });
  await assert.rejects(
    relayer.relay(makeSignedDelegate({ args: EMPLOYEE_ARGS })),
    (error: unknown) => error instanceof RelayerError && error.code === "SPONSOR_BUDGET_EXCEEDED",
  );
  assert.equal(chain.calls.includes("relay"), false);
});

test("relayer never submits when local policy rejects the delegate", async () => {
  const chain = new FakeChain();
  const relayer = new SubrosaRelayer({ relayerAccountId: RELAYER, chain });
  await assert.rejects(
    relayer.relay(makeSignedDelegate({ methodName: "schedule_payout", args: {}, deposit: 1n })),
    (error: unknown) => error instanceof RelayerError && error.code === "METHOD_NOT_ALLOWED",
  );
  assert.deepEqual(chain.calls, []);
});

test("relayer verifies the signature before any RPC call", async () => {
  const chain = new FakeChain();
  const relayer = new SubrosaRelayer({ relayerAccountId: RELAYER, chain });
  const signed = makeSignedDelegate({ args: EMPLOYEE_ARGS });
  signed.signature.data[0] ^= 0xff;
  await assert.rejects(
    relayer.relay(signed),
    (error: unknown) => error instanceof RelayerError && error.code === "INVALID_SIGNATURE",
  );
  assert.deepEqual(chain.calls, []);
});

test("relayer rejects a gas-key inner signer before submitting", async () => {
  const chain = new FakeChain({ GasKeyFullAccess: { balance: "1", num_nonces: 1 } });
  const relayer = new SubrosaRelayer({ relayerAccountId: RELAYER, chain });
  await assert.rejects(
    relayer.relay(makeSignedDelegate({ args: EMPLOYEE_ARGS })),
    (error: unknown) => error instanceof RelayerError && error.code === "INNER_KEY_GAS_KEY_REJECTED",
  );
  assert.equal(chain.calls.includes("relay"), false);
});

test("relayer refuses to construct with mainnet", () => {
  expectCode(
    () => new SubrosaRelayer({ relayerAccountId: RELAYER, chain: new FakeChain(), network: "mainnet" }),
    "NETWORK_NOT_ALLOWED",
  );
});
