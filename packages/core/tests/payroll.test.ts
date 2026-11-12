import { test } from "node:test";
import assert from "node:assert/strict";
import { commitmentHash } from "../src/crypto/hashUtils.js";
import {
  IdempotencyKeyConflictError,
  IdempotencyRegistry,
} from "../src/core/idempotency.js";
import { ValidationError } from "../src/core/errors.js";
import {
  DestinationValidationError,
  resetDestinationValidationHook,
  setDestinationValidationHook,
} from "../src/settlement/destination.js";
import {
  PayrollService,
  type PayrollPaymentRequest,
  type PayrollPaymentResult,
  type PayrollPayoutExecutor,
} from "../src/payroll.js";
import type { CommitmentEntry, EmployeeEntry, HoldEntry, PendingPayout } from "../src/types.js";

const employer = "employer.near";
const employee = "alice.near";
const token = "usdc.testnet";
const salt = "deadbeef";
const amount = 1_000_000n;
const cycleId = 3;
const asset = "nep141:usdc.testnet";
const expectedCommitment = commitmentHash({ employer, employee, token, cycleId, amount, salt });

const activeRegistration: EmployeeEntry = {
  salary_commitment: expectedCommitment,
  token,
  metadata: "",
  active: true,
  created_at: 1,
  updated_at: 1,
};

function baseRequest(overrides: Partial<PayrollPaymentRequest> = {}): PayrollPaymentRequest {
  return {
    employer,
    employee,
    payoutId: 9,
    cycleId,
    commitmentHash: expectedCommitment,
    amount,
    salt,
    token,
    asset,
    memo: "November salary",
    ...overrides,
  };
}

function holdEntry(overrides: Partial<HoldEntry> = {}): HoldEntry {
  return {
    employer,
    scope: "Employer",
    scope_id: employer,
    reason_code: "Other",
    state: "Active",
    placed_by: employer,
    placed_at: 1,
    released_by: null,
    released_at: null,
    release_reason: null,
    ...overrides,
  };
}

interface FakeCalls {
  registry: string[];
  commitmentReads: number;
  holdReads: string[];
  settled: Array<{ payoutId: number; intentHash: string }>;
  executed: PendingPayout[];
}

interface FakeOptions {
  registration?: EmployeeEntry | null;
  commitment?: CommitmentEntry | null;
  holds?: Record<string, HoldEntry | Error>;
  markSettledError?: Error;
  executorError?: Error;
  intentHash?: string;
  idempotency?: IdempotencyRegistry<PayrollPaymentResult>;
  blockedEmployees?: Set<string>;
}

function makeService(options: FakeOptions = {}) {
  const calls: FakeCalls = {
    registry: [],
    commitmentReads: 0,
    holdReads: [],
    settled: [],
    executed: [],
  };

  const executor: PayrollPayoutExecutor = {
    async executePendingPayout(entry: PendingPayout) {
      calls.executed.push(entry);
      if (options.executorError) throw options.executorError;
      return { intentHash: options.intentHash ?? "intent-abc123" };
    },
  };

  const service = new PayrollService({
    registry: {
      async getEmployee(_employer, requestedEmployee) {
        calls.registry.push(requestedEmployee);
        if (options.blockedEmployees?.has(requestedEmployee)) return null;
        return options.registration === undefined ? activeRegistration : options.registration;
      },
    },
    commitments: {
      async getCommitment(_employer, requestedEmployee, requestedCycle) {
        calls.commitmentReads += 1;
        if (options.commitment !== undefined) return options.commitment;
        return {
          commitment_hash: commitmentHash({
            employer,
            employee: requestedEmployee,
            token,
            cycleId: requestedCycle,
            amount,
            salt,
          }),
          token,
          created_at: 1,
        };
      },
      verifyCommitment(args, expected) {
        return commitmentHash(args) === expected;
      },
    },
    holds: {
      async getAuditHold(holdId) {
        calls.holdReads.push(holdId);
        const value =
          options.holds && Object.hasOwn(options.holds, holdId)
            ? options.holds[holdId]
            : undefined;
        if (value instanceof Error) throw value;
        return value ?? null;
      },
    },
    payouts: {
      async markSettled(payoutId, intentHash) {
        calls.settled.push({ payoutId, intentHash });
        if (options.markSettledError) throw options.markSettledError;
      },
    },
    executor,
    idempotency: options.idempotency,
  });

  return { service, calls };
}

test("processPayment orchestrates registration, commitment verify, payout, and settlement", async () => {
  const { service, calls } = makeService();

  const result = await service.processPayment(baseRequest());

  assert.deepEqual(result, {
    payoutId: 9,
    intentHash: "intent-abc123",
    commitmentHash: expectedCommitment,
  });
  assert.deepEqual(calls.registry, [employee]);
  assert.equal(calls.commitmentReads, 1);
  assert.deepEqual(calls.executed, [
    {
      employer,
      payout_id: 9,
      employee,
      amount: amount.toString(),
      salt,
      asset,
      memo: "November salary",
      commitment_hash: expectedCommitment,
    },
  ]);
  assert.deepEqual(calls.settled, [{ payoutId: 9, intentHash: "intent-abc123" }]);
});

test("destination validation runs before registration and payout", async () => {
  const { service, calls } = makeService();
  await assert.rejects(
    () => service.processPayment(baseRequest({ employee: "Alice" })),
    (error: unknown) =>
      error instanceof DestinationValidationError && error.code === "DESTINATION_UPPERCASE",
  );
  assert.equal(calls.registry.length, 0);
  assert.equal(calls.executed.length, 0);
});

test("a rejecting destination hook blocks the payout", async () => {
  const { service, calls } = makeService();
  setDestinationValidationHook(() => ({
    ok: false,
    code: "DESTINATION_NOT_ALLOWLISTED",
    message: "Destination is not allowlisted.",
  }));
  try {
    await assert.rejects(
      () => service.processPayment(baseRequest()),
      (error: unknown) =>
        error instanceof DestinationValidationError &&
        error.code === "DESTINATION_NOT_ALLOWLISTED",
    );
  } finally {
    resetDestinationValidationHook();
  }
  assert.equal(calls.executed.length, 0);
});

test("an inactive or missing registration blocks the payout", async () => {
  const inactive = makeService({ registration: { ...activeRegistration, active: false } });
  await assert.rejects(
    () => inactive.service.processPayment(baseRequest()),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "EMPLOYEE_NOT_REGISTERED",
  );
  assert.equal(inactive.calls.executed.length, 0);

  const missing = makeService({ registration: null });
  await assert.rejects(
    () => missing.service.processPayment(baseRequest()),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "EMPLOYEE_NOT_REGISTERED",
  );
});

test("an active matching hold blocks the payout", async () => {
  const holds: Record<string, HoldEntry> = {
    "hold-1": holdEntry({ scope: "Employee", scope_id: employee }),
  };
  const { service, calls } = makeService({ holds });
  await assert.rejects(
    () => service.processPayment(baseRequest({ holdIds: ["hold-1"] })),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "HOLD_ACTIVE",
  );
  assert.deepEqual(calls.holdReads, ["hold-1"]);
  assert.equal(calls.executed.length, 0);
});

test("hold scope matching follows employer/period/batch/employee ids", async () => {
  const periodHold = holdEntry({ scope: "Period", scope_id: "2" });
  const batchHold = holdEntry({ scope: "Batch", scope_id: "batch-7" });
  const otherEmployer = holdEntry({ employer: "other.near", scope: "Employer" });

  for (const [hold, request] of [
    [periodHold, baseRequest({ holdIds: ["h"], cycleId: 3 })],
    [batchHold, baseRequest({ holdIds: ["h"], batchId: "batch-8" })],
    [otherEmployer, baseRequest({ holdIds: ["h"] })],
  ] as const) {
    const { service, calls } = makeService({ holds: { h: hold } });
    const result = await service.processPayment(request);
    assert.equal(result.intentHash, "intent-abc123");
    assert.equal(calls.executed.length, 1);
  }

  const matchingBatch = makeService({
    holds: { h: holdEntry({ scope: "Batch", scope_id: "batch-7" }) },
  });
  await assert.rejects(
    () =>
      matchingBatch.service.processPayment(baseRequest({ holdIds: ["h"], batchId: "batch-7" })),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "HOLD_ACTIVE",
  );
});

test("released holds pass and unknown or unreadable holds fail closed", async () => {
  const released = makeService({
    holds: { h: holdEntry({ state: "Released", released_by: employer, released_at: 2 }) },
  });
  assert.equal((await released.service.processPayment(baseRequest({ holdIds: ["h"] }))).payoutId, 9);

  const unknown = makeService({ holds: {} });
  await assert.rejects(
    () => unknown.service.processPayment(baseRequest({ holdIds: ["missing"] })),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "HOLD_STATUS_UNKNOWN",
  );
  assert.equal(unknown.calls.executed.length, 0);

  const unreadable = makeService({ holds: { h: new Error("rpc down") } });
  await assert.rejects(
    () => unreadable.service.processPayment(baseRequest({ holdIds: ["h"] })),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "HOLD_STATUS_UNAVAILABLE",
  );
  assert.equal(unreadable.calls.executed.length, 0);
});

test("missing commitments and hash/preimage mismatches block the payout", async () => {
  const missing = makeService({ commitment: null });
  await assert.rejects(
    () => missing.service.processPayment(baseRequest()),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "COMMITMENT_NOT_FOUND",
  );

  const wrongExpected = makeService();
  await assert.rejects(
    () => wrongExpected.service.processPayment(baseRequest({ commitmentHash: "cd".repeat(32) })),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "COMMITMENT_MISMATCH",
  );

  const wrongAmount = makeService();
  await assert.rejects(
    () => wrongAmount.service.processPayment(baseRequest({ amount: amount + 1n })),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "COMMITMENT_MISMATCH",
  );

  for (const setup of [missing, wrongExpected, wrongAmount]) {
    assert.equal(setup.calls.executed.length, 0);
  }
});

test("payment validation rejects malformed request fields", async () => {
  const { service, calls } = makeService();

  await assert.rejects(
    () => service.processPayment(baseRequest({ amount: 0n })),
    (error: unknown) => error instanceof ValidationError && error.code === "INVALID_AMOUNT",
  );
  await assert.rejects(
    () => service.processPayment(baseRequest({ salt: "xyz" })),
    (error: unknown) => error instanceof ValidationError && error.code === "INVALID_SALT",
  );
  await assert.rejects(
    () => service.processPayment(baseRequest({ asset: "not an asset" })),
    (error: unknown) => error instanceof ValidationError && error.code === "INVALID_ASSET",
  );
  assert.equal(calls.executed.length, 0);
});

test("executor failures are redacted and settlement is not recorded", async () => {
  const { service, calls } = makeService({
    executorError: new Error("transfer failed amount=1000000 salt=deadbeef"),
  });

  await assert.rejects(
    () => service.processPayment(baseRequest()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal("code" in error ? error.code : undefined, "PAYOUT_EXECUTION_FAILED");
      assert.ok(!error.message.includes("1000000"), "amount must be redacted");
      assert.ok(!error.message.includes("deadbeef"), "salt must be redacted");
      assert.ok(error.message.includes("[redacted]"));
      return true;
    },
  );
  assert.equal(calls.settled.length, 0);
});

test("a mark_settled failure surfaces as a dedicated error", async () => {
  const { service } = makeService({ markSettledError: new Error("rpc rejected") });
  await assert.rejects(
    () => service.processPayment(baseRequest()),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "PAYOUT_SETTLEMENT_RECORD_FAILED",
  );
});

test("idempotency keys dedupe concurrent payments and reject payload reuse", async () => {
  const idempotency = new IdempotencyRegistry<PayrollPaymentResult>();
  const { service, calls } = makeService({ idempotency });

  const request = baseRequest({ idempotencyKey: "pay-1" });
  const [first, second] = await Promise.all([
    service.processPayment(request),
    service.processPayment(request),
  ]);
  assert.deepEqual(first, second);
  assert.equal(calls.executed.length, 1);

  await assert.rejects(
    () => service.processPayment({ ...request, amount: amount + 1n }),
    (error: unknown) => error instanceof IdempotencyKeyConflictError,
  );
});

test("batch payments validate first, preserve order, and report progress", async () => {
  const { service, calls } = makeService();

  const entries = ["user0.near", "user1.near", "user2.near"].map((requestedEmployee, index) =>
    baseRequest({
      employee: requestedEmployee,
      payoutId: 10 + index,
      commitmentHash: commitmentHash({
        employer,
        employee: requestedEmployee,
        token,
        cycleId,
        amount,
        salt,
      }),
    }),
  );

  const stages: string[] = [];
  const result = await service.processBatchPayments(entries, {
    batchSize: 2,
    onProgress: (event) => stages.push(event.stage),
  });

  assert.equal(result.success, true);
  assert.equal(result.totalItems, 3);
  assert.equal(result.itemsProcessed, 3);
  assert.deepEqual(
    result.results.map((item) => item.payoutId),
    [10, 11, 12],
  );
  assert.equal(calls.executed.length, 3);
  assert.ok(stages.includes("validating"));
  assert.ok(stages.includes("completed"));
});

test("batch validation failures throw before any payout", async () => {
  const { service, calls } = makeService();
  const duplicate = baseRequest();
  await assert.rejects(
    () => service.processBatchPayments([duplicate, { ...duplicate, commitmentHash: "cd".repeat(32) }]),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "BatchValidationFailedError",
  );
  assert.equal(calls.executed.length, 0);
});

test("batch failures return a safe result instead of throwing", async () => {
  const { service, calls } = makeService({
    blockedEmployees: new Set(["blocked.near"]),
  });
  const entries = ["user0.near", "user1.near", "blocked.near"].map((requestedEmployee, index) =>
    baseRequest({
      employee: requestedEmployee,
      payoutId: 20 + index,
      commitmentHash: commitmentHash({
        employer,
        employee: requestedEmployee,
        token,
        cycleId,
        amount,
        salt,
      }),
    }),
  );

  const result = await service.processBatchPayments(entries, {
    batchSize: 2,
    maxRetries: 0,
    sleep: async () => {},
  });

  assert.equal(result.success, false);
  assert.equal(result.itemsProcessed, 2);
  assert.equal(result.results.length, 2);
  assert.equal(calls.executed.length, 2);
  assert.equal(result.failedBatchIndex, 1);
});

test("processBatchPayments rejects an empty batch", async () => {
  const { service, calls } = makeService();
  await assert.rejects(
    () => service.processBatchPayments([]),
    (error: unknown) => error instanceof Error && error.name === "BatchValidationFailedError",
  );
  assert.equal(calls.executed.length, 0);
});
