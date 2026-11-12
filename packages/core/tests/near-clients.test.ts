import { test } from "node:test";
import assert from "node:assert/strict";
import { nearToYocto, teraToGas, type SerializedReturnValue } from "near-api-js";
import { NearConfigPresets } from "../src/config.js";
import {
  NearContractWrapper,
  type NearCallAccount,
  type NearCallFunctionParams,
  type NearContractWrapperOptions,
  type NearViewFunctionParams,
  type NearViewProvider,
} from "../src/near/NearContractWrapper.js";
import { RegistryClient } from "../src/near/RegistryClient.js";
import { CommitmentClient } from "../src/near/CommitmentClient.js";
import { PayoutClient } from "../src/near/PayoutClient.js";
import { HoldClient } from "../src/near/HoldClient.js";
import { VerificationKeyClient } from "../src/near/VerificationKeyClient.js";
import { commitmentHash } from "../src/crypto/hashUtils.js";
import {
  RetryBudgetExhaustedError,
  RetryOperationType,
  withRetryBudget,
} from "../src/core/retry-budget.js";
import { RetryCategory, classifyError } from "../src/core/retry.js";
import {
  IdempotencyKeyConflictError,
  IdempotencyRegistry,
  createPaymentIdempotencyKey,
} from "../src/core/idempotency.js";
import {
  ContractErrorCode,
  ContractExecutionError,
  RpcTimeoutError,
  ValidationError,
} from "../src/core/errors.js";

class FakeAccount implements NearCallAccount {
  readonly accountId = "payer.testnet";
  readonly calls: NearCallFunctionParams[] = [];
  readonly firstCall: Promise<void>;
  private resolveFirstCall!: () => void;
  result: unknown = null;
  error?: Error;
  gate?: Promise<unknown>;

  constructor() {
    this.firstCall = new Promise<void>((resolve) => {
      this.resolveFirstCall = resolve;
    });
  }

  async callFunction<T extends SerializedReturnValue>(params: NearCallFunctionParams): Promise<T> {
    this.calls.push(params);
    this.resolveFirstCall();
    if (this.error) throw this.error;
    const value = this.gate ? await this.gate : this.result;
    return value as T;
  }
}

class FakeProvider implements NearViewProvider {
  readonly calls: NearViewFunctionParams[] = [];
  queue: Array<unknown | Error> = [null];

  async callFunction<T extends SerializedReturnValue>(
    params: NearViewFunctionParams,
  ): Promise<T | undefined> {
    this.calls.push(params);
    const next = this.queue.length > 1 ? this.queue.shift() : this.queue[0];
    if (next instanceof Error) throw next;
    return next as T | undefined;
  }
}

function makeWrapper(
  account: FakeAccount = new FakeAccount(),
  provider: FakeProvider = new FakeProvider(),
  options: NearContractWrapperOptions = {},
) {
  const wrapper = new NearContractWrapper(
    NearConfigPresets.testnet(),
    { account, provider },
    { callTimeoutMs: 1_000, ...options },
  );
  return { wrapper, account, provider };
}

const HASH = "ab".repeat(32);

function argsOf(call: NearCallFunctionParams): Record<string, unknown> {
  if (call.args === undefined || call.args instanceof Uint8Array) {
    throw new Error("expected JSON object args");
  }
  return call.args;
}

test("wrapper.view uses the v7 provider shape with final blockQuery", async () => {
  const provider = new FakeProvider();
  provider.queue = [{ employer: "employer.near" }];
  const { wrapper } = makeWrapper(new FakeAccount(), provider);

  const result = await wrapper.view<{ employer: string }>("get_employee", {
    employer: "employer.near",
    employee: "alice.near",
  });

  assert.deepEqual(result, { employer: "employer.near" });
  assert.deepEqual(provider.calls, [
    {
      contractId: "subrosa.testnet",
      method: "get_employee",
      args: { employer: "employer.near", employee: "alice.near" },
      blockQuery: { finality: "final" },
    },
  ]);
});

test("wrapper.view maps an empty provider result to null", async () => {
  const provider = new FakeProvider();
  provider.queue = [undefined];
  const { wrapper } = makeWrapper(new FakeAccount(), provider);
  assert.equal(await wrapper.view<unknown>("get_commitment", {}), null);
});

test("wrapper.call uses the v7 account shape, FINAL wait, and yocto/TGas helpers", async () => {
  const account = new FakeAccount();
  account.result = 7;
  const { wrapper } = makeWrapper(account);

  const result = await wrapper.call<number>("schedule_payout", { employee: "alice.near" });
  assert.equal(result, 7);
  assert.deepEqual(account.calls, [
    {
      contractId: "subrosa.testnet",
      methodName: "schedule_payout",
      args: { employee: "alice.near" },
      gas: teraToGas("30"),
      deposit: nearToYocto("0"),
      waitUntil: "FINAL",
    },
  ]);
});

test("wrapper.call honours explicit gas and deposit as decimal strings", async () => {
  const account = new FakeAccount();
  const { wrapper } = makeWrapper(account);

  await wrapper.call("register_employee", {}, { gas: "100", deposit: "1.5" });
  assert.equal(account.calls[0].gas, teraToGas("100"));
  assert.equal(account.calls[0].deposit, nearToYocto("1.5"));
});

test("wrapper rejects malformed gas/deposit before submitting", async () => {
  const account = new FakeAccount();
  const { wrapper } = makeWrapper(account);

  await assert.rejects(
    () => wrapper.call("m", {}, { gas: "abc" }),
    (error: unknown) => error instanceof ValidationError && error.field === "gas",
  );
  await assert.rejects(
    () => wrapper.call("m", {}, { deposit: "-1" }),
    (error: unknown) => error instanceof ValidationError && error.field === "deposit",
  );
  assert.equal(account.calls.length, 0);
});

test("wrapper.view retries transient read failures under the read budget", async () => {
  const provider = new FakeProvider();
  provider.queue = [new Error("ECONNRESET"), { ok: true }];
  const { wrapper } = makeWrapper(new FakeAccount(), provider, {
    retryBudgets: { read: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0, backoffFactor: 1 } },
    sleep: async () => {},
  });

  const result = await wrapper.view<{ ok: boolean }>("employee_exists", {});
  assert.deepEqual(result, { ok: true });
  assert.equal(provider.calls.length, 2);
});

test("wrapper.view does not retry non-retryable validation failures", async () => {
  const provider = new FakeProvider();
  provider.queue = [new ValidationError("bad input", "employee")];
  const { wrapper } = makeWrapper(new FakeAccount(), provider, { sleep: async () => {} });

  await assert.rejects(
    () => wrapper.view("get_employee", {}),
    (error: unknown) => error instanceof ValidationError,
  );
  assert.equal(provider.calls.length, 1);
});

test("wrapper.call maps a submission failure to ContractExecutionError", async () => {
  const account = new FakeAccount();
  account.error = new Error("boom");
  const { wrapper } = makeWrapper(account);

  await assert.rejects(
    () => wrapper.call("register_employee", {}),
    (error: unknown) =>
      error instanceof ContractExecutionError &&
      error.code === ContractErrorCode.TRANSACTION_SUBMISSION_FAILED &&
      error.cause === account.error,
  );
  assert.equal(account.calls.length, 1);
});

test("wrapper.call bounds the FINAL wait and surfaces RpcTimeoutError", async () => {
  const account = new FakeAccount();
  account.gate = new Promise(() => {});
  const { wrapper } = makeWrapper(account, new FakeProvider(), { callTimeoutMs: 5 });

  await assert.rejects(
    () => wrapper.call("register_employee", {}),
    (error: unknown) =>
      error instanceof RpcTimeoutError && error.code === ContractErrorCode.TRANSACTION_TIMEOUT,
  );
});

test("wrapper.call deduplicates concurrent submissions with the same key", async () => {
  const account = new FakeAccount();
  let release!: (value: unknown) => void;
  account.gate = new Promise((resolve) => {
    release = resolve;
  });
  const { wrapper } = makeWrapper(account);

  const first = wrapper.call<number>("mark_settled", { payout_id: 1 }, { idempotencyKey: "k1" });
  const second = wrapper.call<number>("mark_settled", { payout_id: 1 }, { idempotencyKey: "k1" });
  await account.firstCall;
  assert.equal(account.calls.length, 1);

  release(9);
  assert.deepEqual(await Promise.all([first, second]), [9, 9]);
});

test("wrapper.call submits once even with a larger write budget when no key is supplied", async () => {
  const account = new FakeAccount();
  account.error = new Error("ECONNRESET");
  const { wrapper } = makeWrapper(account, new FakeProvider(), {
    retryBudgets: { write: { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0, backoffFactor: 1 } },
    sleep: async () => {},
  });

  await assert.rejects(
    () => wrapper.call("register_employee", {}),
    (error: unknown) =>
      error instanceof ContractExecutionError &&
      error.code === ContractErrorCode.TRANSACTION_SUBMISSION_FAILED,
  );
  assert.equal(account.calls.length, 1);
});

test("RegistryClient maps register/update/deactivate/view args", async () => {
  const account = new FakeAccount();
  const provider = new FakeProvider();
  const { wrapper } = makeWrapper(account, provider);
  const client = new RegistryClient(wrapper);

  await client.registerEmployee({
    employee: "alice.near",
    salaryCommitment: HASH,
    token: "usdc.testnet",
  });
  assert.deepEqual(account.calls[0].args, {
    employee: "alice.near",
    salary_commitment: HASH,
    token: "usdc.testnet",
    metadata: "",
  });

  await client.updateEmployee({ employee: "alice.near", salaryCommitment: HASH });
  assert.deepEqual(account.calls[1].args, {
    employee: "alice.near",
    salary_commitment: HASH,
  });

  await client.deactivateEmployee("alice.near");
  assert.deepEqual(account.calls[2].args, { employee: "alice.near" });

  provider.queue = [null];
  assert.equal(await client.getEmployee("employer.near", "alice.near"), null);
  assert.deepEqual(provider.calls[0].args, {
    employer: "employer.near",
    employee: "alice.near",
  });

  provider.queue = [3];
  assert.equal(await client.getEmployeeCount("employer.near"), 3);
  assert.deepEqual(provider.calls[1].args, { employer: "employer.near" });

  provider.queue = [["alice.near", "bob.near"]];
  assert.deepEqual(await client.getEmployees("employer.near", 0, 2), ["alice.near", "bob.near"]);
  assert.deepEqual(provider.calls[2].args, { employer: "employer.near", from_index: 0, limit: 2 });

  provider.queue = [true];
  assert.equal(await client.employeeExists("employer.near", "alice.near"), true);
});

test("clients reject invalid account-id arguments before any RPC call", async () => {
  const account = new FakeAccount();
  const provider = new FakeProvider();
  const { wrapper } = makeWrapper(account, provider);
  const client = new RegistryClient(wrapper);

  await assert.rejects(
    () => client.registerEmployee({ employee: "Alice", salaryCommitment: HASH, token: "usdc.testnet" }),
    (error: unknown) => error instanceof ValidationError,
  );
  await assert.rejects(
    () => client.getEmployeeCount("employer..near"),
    (error: unknown) => error instanceof ValidationError,
  );
  assert.equal(account.calls.length, 0);
  assert.equal(provider.calls.length, 0);
});

test("CommitmentClient maps commit args and chunks batch commits at 50 with deposits", async () => {
  const account = new FakeAccount();
  const { wrapper } = makeWrapper(account);
  const client = new CommitmentClient(wrapper);

  await client.commitSalary({ employee: "alice.near", commitmentHash: HASH, cycleId: 4 });
  assert.deepEqual(account.calls[0].args, {
    employee: "alice.near",
    commitment_hash: HASH,
    cycle_id: 4,
  });

  const items = Array.from({ length: 120 }, (_, index) => ({
    employee: `user${index}.near`,
    commitment_hash: HASH,
    cycle_id: index,
  }));
  const result = await client.batchCommit(items);
  assert.deepEqual(result, { chunks: 3, itemsCommitted: 120 });

  const batchCalls = account.calls.slice(1);
  assert.equal(batchCalls.length, 3);
  assert.deepEqual(
    batchCalls.map((call) => {
      const items = argsOf(call).items;
      assert.ok(Array.isArray(items));
      return items.length;
    }),
    [50, 50, 20],
  );
  assert.deepEqual(
    batchCalls.map((call) => call.deposit),
    [nearToYocto("0.187"), nearToYocto("0.187"), nearToYocto("0.0748")],
  );
  for (const call of batchCalls) {
    assert.equal(call.methodName, "batch_commit_salaries");
  }
});

test("CommitmentClient views and local verification delegate to hashUtils", async () => {
  const provider = new FakeProvider();
  const { wrapper } = makeWrapper(new FakeAccount(), provider);
  const client = new CommitmentClient(wrapper);

  provider.queue = [{ commitment_hash: HASH, token: "usdc.testnet", created_at: 5 }];
  const entry = await client.getCommitment("employer.near", "alice.near", 2);
  assert.deepEqual(entry, { commitment_hash: HASH, token: "usdc.testnet", created_at: 5 });
  assert.deepEqual(provider.calls[0].args, {
    employer: "employer.near",
    employee: "alice.near",
    cycle_id: 2,
  });

  provider.queue = [2];
  assert.equal(await client.getCommitmentCount("employer.near", "alice.near"), 2);

  const preimage = {
    employer: "employer.near",
    employee: "alice.near",
    token: "usdc.testnet",
    cycleId: 2,
    amount: 10_000n,
    salt: "deadbeef",
  };
  const expected = commitmentHash(preimage);
  assert.equal(client.verifyCommitment(preimage, expected), true);
  assert.equal(client.verifyCommitment({ ...preimage, amount: 10_001n }, expected), false);
});

test("PayoutClient maps lifecycle args and parses entries", async () => {
  const account = new FakeAccount();
  account.result = 7;
  const provider = new FakeProvider();
  const { wrapper } = makeWrapper(account, provider);
  const client = new PayoutClient(wrapper);

  const executeAt = 1_763_000_000_000_000_000;
  assert.equal(
    await client.schedulePayout({
      employee: "alice.near",
      commitmentHash: HASH,
      asset: "usdc.testnet",
      memo: "salary",
      executeAt,
    }),
    7,
  );
  assert.deepEqual(account.calls[0].args, {
    employee: "alice.near",
    commitment_hash: HASH,
    asset: "usdc.testnet",
    memo: "salary",
    execute_at: executeAt,
  });

  await client.cancelPayout({ payoutId: 3, reasonCode: "compliance_hold" });
  assert.deepEqual(account.calls[1].args, {
    payout_id: 3,
    reason_code: "compliance_hold",
  });

  const intentHash = "5J8mZ9rT2wXc4VbN7kQpL1sD2fGh3Jk4Lm5Np6Qr7St8";
  await client.markSettled(3, intentHash);
  assert.deepEqual(account.calls[2].args, { payout_id: 3, intent_hash: intentHash });

  await client.markFailed(3, "FAILED");
  assert.deepEqual(account.calls[3].args, { payout_id: 3, status: "FAILED" });

  await client.expirePayout(3);
  assert.deepEqual(account.calls[4].args, { payout_id: 3 });

  const payout = {
    employer: "employer.near",
    employee: "alice.near",
    commitment_hash: HASH,
    asset: "usdc.testnet",
    memo: "",
    execute_at: 1,
    created_at: 2,
    state: "Pending",
    intent_hash: null,
  };
  provider.queue = [payout];
  assert.deepEqual(await client.getPayout("employer.near", 3), payout);
  assert.deepEqual(provider.calls[0].args, { employer: "employer.near", payout_id: 3 });

  provider.queue = [[payout]];
  assert.deepEqual(await client.getPendingPayouts("employer.near", 0, 500), [payout]);
  assert.deepEqual(provider.calls[1].args, {
    employer: "employer.near",
    from_index: 0,
    limit: 500,
  });

  provider.queue = [4];
  assert.equal(await client.getPayoutCount("employer.near"), 4);

  provider.queue = [true];
  assert.equal(await client.isPayoutDue("employer.near", 3), true);

  await assert.rejects(
    () => client.getPendingPayouts("employer.near", 0, 501),
    (error: unknown) => error instanceof ValidationError,
  );
});

test("HoldClient maps holds, auditor roles, and pause args", async () => {
  const account = new FakeAccount();
  const provider = new FakeProvider();
  const { wrapper } = makeWrapper(account, provider);
  const client = new HoldClient(wrapper);

  await client.createAuditHold({
    holdId: "hold-1",
    employer: "employer.near",
    scope: "Employee",
    scopeId: "alice.near",
    reasonCode: "KYC_REVIEW_PENDING",
  });
  assert.deepEqual(account.calls[0].args, {
    hold_id: "hold-1",
    employer: "employer.near",
    scope: "Employee",
    scope_id: "alice.near",
    reason_code: "KYC_REVIEW_PENDING",
  });

  await client.createAuditHold({
    holdId: "hold-2",
    employer: "employer.near",
    scope: "Employer",
    scopeId: "employer.near",
    reasonCode: "Other",
  });
  assert.equal(argsOf(account.calls[1]).reason_code, "OTHER");

  const hold = {
    employer: "employer.near",
    scope: "Employer",
    scope_id: "employer.near",
    reason_code: "Other",
    state: "Active",
    placed_by: "employer.near",
    placed_at: 1,
    released_by: null,
    released_at: null,
    release_reason: null,
  };
  provider.queue = [hold];
  assert.deepEqual(await client.getAuditHold("hold-2"), hold);

  await client.releaseAuditHold("hold-2", "OTHER");
  assert.deepEqual(account.calls[2].args, {
    hold_id: "hold-2",
    release_reason: "OTHER",
  });

  await client.grantAuditor("employer.near", "auditor.near");
  assert.deepEqual(account.calls[3].args, {
    employer: "employer.near",
    auditor: "auditor.near",
  });

  await client.revokeAuditor("employer.near", "auditor.near");
  assert.deepEqual(account.calls[4].args, {
    employer: "employer.near",
    auditor: "auditor.near",
  });

  await client.setPause(true);
  assert.deepEqual(account.calls[5].args, { paused: true });
});

test("malformed contract results surface as InvalidResponseError", async () => {
  const provider = new FakeProvider();
  const { wrapper } = makeWrapper(new FakeAccount(), provider);
  const commitments = new CommitmentClient(wrapper);
  const registry = new RegistryClient(wrapper);

  provider.queue = [{ commitment_hash: "not-hex", token: "usdc.testnet", created_at: 1 }];
  await assert.rejects(
    () => commitments.getCommitment("employer.near", "alice.near", 0),
    (error: unknown) =>
      error instanceof ContractExecutionError &&
      error.code === ContractErrorCode.INVALID_RESPONSE,
  );

  provider.queue = [{ salary_commitment: HASH, token: "usdc.testnet" }];
  await assert.rejects(
    () => registry.getEmployee("employer.near", "alice.near"),
    (error: unknown) =>
      error instanceof ContractExecutionError &&
      error.code === ContractErrorCode.INVALID_RESPONSE,
  );
});

test("classifyError distinguishes retryable, non-retryable, and unknown failures", () => {
  assert.equal(classifyError(new ValidationError("bad", "x")).category, RetryCategory.NON_RETRYABLE);
  assert.equal(classifyError(new Error("socket hang up")).category, RetryCategory.RETRYABLE);
  assert.equal(
    classifyError(
      new ContractExecutionError("revert", ContractErrorCode.CONTRACT_REVERT),
    ).category,
    RetryCategory.NON_RETRYABLE,
  );
  assert.equal(classifyError(new Error("something odd")).category, RetryCategory.UNKNOWN);
});

test("withRetryBudget retries reads, refuses unsafe writes, and allows keyed writes", async () => {
  let reads = 0;
  const read = await withRetryBudget(
    async () => {
      reads += 1;
      if (reads === 1) throw new Error("ETIMEDOUT");
      return 1;
    },
    {
      operationType: RetryOperationType.READ,
      budget: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0, backoffFactor: 1 },
      sleep: async () => {},
    },
  );
  assert.equal(read, 1);
  assert.equal(reads, 2);

  let writes = 0;
  await assert.rejects(
    () =>
      withRetryBudget(
        async () => {
          writes += 1;
          throw new Error("offline");
        },
        {
          operationType: RetryOperationType.WRITE,
          budget: { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0, backoffFactor: 1 },
          sleep: async () => {},
        },
      ),
    (error: unknown) =>
      error instanceof RetryBudgetExhaustedError && error.retryRefused === true,
  );
  assert.equal(writes, 1);

  let keyed = 0;
  const keyedValue = await withRetryBudget(
    async () => {
      keyed += 1;
      if (keyed === 1) throw new Error("socket closed");
      return "done";
    },
    {
      operationType: RetryOperationType.WRITE,
      idempotencyKey: "write-1",
      budget: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0, backoffFactor: 1 },
      sleep: async () => {},
    },
  );
  assert.equal(keyedValue, "done");
  assert.equal(keyed, 2);
});

test("IdempotencyRegistry dedupes concurrent calls, replays results, and rejects fingerprint conflicts", async () => {
  const registry = new IdempotencyRegistry<number>(60_000);
  let calls = 0;

  const [first, second] = await Promise.all([
    registry.execute("key", async () => {
      calls += 1;
      return 5;
    }),
    registry.execute("key", async () => {
      calls += 1;
      return 5;
    }),
  ]);
  assert.deepEqual([first, second], [5, 5]);
  assert.equal(calls, 1);

  const replay = await registry.execute("key", async () => {
    calls += 1;
    return 6;
  });
  assert.equal(replay, 5);
  assert.equal(calls, 1);

  await assert.rejects(
    () => registry.execute("key", async () => 7, { fingerprint: "different" }),
    (error: unknown) => error instanceof IdempotencyKeyConflictError,
  );

  registry.clear();
  const afterClear = await registry.execute("key", async () => {
    calls += 1;
    return 8;
  });
  assert.equal(afterClear, 8);
  assert.equal(calls, 2);

  await assert.rejects(() => registry.execute("   ", async () => 1));
  assert.equal(createPaymentIdempotencyKey({ recipient: " ALICE.NEAR ", amount: 10n, asset: "USDC" }), "pay:alice.near:10:usdc");
});


test("VerificationKeyClient maps byte arrays, ids, and proof verification", async () => {
  const account = new FakeAccount();
  account.result = 3;
  const provider = new FakeProvider();
  const { wrapper } = makeWrapper(account, provider);
  const client = new VerificationKeyClient(wrapper);

  assert.equal(await client.addVerificationKey("aabb", "groth16 vk"), 3);
  assert.deepEqual(account.calls[0].args, {
    vk_bytes: [170, 187],
    description: "groth16 vk",
  });

  provider.queue = [[1, 2, 255]];
  assert.equal(await client.getVerificationKey(0), "0102ff");

  provider.queue = [{ key: [1, 2], description: "vk" }];
  assert.deepEqual(await client.getVerificationKeyInfo(1), { key: "0102", description: "vk" });

  await client.setActiveVerificationKey(2);
  assert.deepEqual(account.calls[1].args, { id: 2 });

  provider.queue = [4];
  assert.equal(await client.getActiveVerificationKeyId(), 4);
  assert.equal(await client.getVerificationKeyCount(), 4);

  account.result = true;
  assert.equal(await client.verifyProof("00ff", ["1", "42"], 2), true);
  assert.deepEqual(account.calls[2].args, {
    proof_bytes: [0, 255],
    public_inputs: ["1", "42"],
    verification_key_id: 2,
  });

  await assert.rejects(
    () => client.verifyProof("00ff", ["01"], 2),
    (error: unknown) => error instanceof ValidationError,
  );
  await assert.rejects(
    () => client.getVerificationKey(0x1_0000_0000),
    (error: unknown) => error instanceof ValidationError,
  );
});
test("NearContractWrapper validates the configured contract id", () => {
  assert.throws(
    () =>
      new NearContractWrapper(
        { ...NearConfigPresets.testnet(), contractId: "Not a contract" },
        { account: new FakeAccount(), provider: new FakeProvider() },
      ),
    (error: unknown) => error instanceof ValidationError && error.field === "contractId",
  );
});
