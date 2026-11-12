/**
 * Batch layer tests: payload builder, chunking, contract limit, pagination,
 * deduplication, resumable state machine, resume tokens, and the safe batch
 * submitter. No network or chain access.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BatchPayloadBuilder,
  BatchValidationFailedError,
  MAX_BATCH_SIZE,
  ResumableBatchManager,
  chunkPayoutBatches,
  computeBatchEntriesCommitment,
  detectDuplicates,
  formatDeduplicationSummary,
  getBatchPage,
  iterateBatches,
  splitPayoutBatchByContractLimit,
  validateBatchPayload,
  type BatchPaymentEntry,
  type DeduplicationResult,
} from "../src/batch/index.js";
import {
  RESUME_TOKEN_ERROR_CODE,
  createBatchResumeToken,
  decodeBatchResumeToken,
  resolveResumeStart,
} from "../src/payroll/batchResumeToken.js";
import { submitSequentialPayrollBatches } from "../src/payroll/safeBatchSubmitter.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const SALT = "11".repeat(32);
function codeOf(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
}

function entry(overrides: Partial<BatchPaymentEntry> = {}): BatchPaymentEntry {
  return {
    employee: "alice.near",
    commitment_hash: HASH_A,
    cycle_id: 1,
    amount: 1_000n,
    salt: SALT,
    asset: "usdc.near",
    memo: "",
    ...overrides,
  };
}

function uniqueEntries(count: number): BatchPaymentEntry[] {
  return Array.from({ length: count }, (_, index) =>
    entry({
      employee: `employee${index}.near`,
      commitment_hash: index.toString(16).padStart(64, "0"),
      cycle_id: index,
      amount: BigInt(index + 1) * 10n,
      salt: (index + 1).toString(16).padStart(64, "0"),
    })
  );
}

describe("BatchPayloadBuilder", () => {
  it("accepts a valid NEAR batch and sums the total amount", () => {
    const payload = new BatchPayloadBuilder()
      .add(entry({ amount: 500n }))
      .add(
        entry({
          employee: "bob.testnet",
          commitment_hash: HASH_B,
          amount: 250n,
          asset: "nep141:usdc.near",
        })
      )
      .build();

    assert.equal(payload.entries.length, 2);
    assert.equal(payload.totalAmount, 750n);
    assert.equal(validateBatchPayload(payload.entries).length, 0);
  });

  it("rejects an empty batch", () => {
    const errors = validateBatchPayload([]);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "EMPTY_BATCH");
  });

  it("rejects invalid employee account ids without echoing them", () => {
    for (const employee of ["Alice.near", "alice..near", "alice near", "a"]) {
      const errors = validateBatchPayload([entry({ employee })]);
      assert.equal(errors[0].code, "INVALID_EMPLOYEE", employee);
      assert.equal(errors[0].field, "employee");
      if (employee.length > 2) {
        assert.ok(!errors[0].message.includes(employee));
      }
    }

    const empty = validateBatchPayload([entry({ employee: "" })]);
    assert.equal(empty[0].code, "INVALID_EMPLOYEE");
  });

  it("accepts implicit 64-hex employee accounts", () => {
    const implicit = "c".repeat(64);
    assert.deepEqual(validateBatchPayload([entry({ employee: implicit })]), []);
  });

  it("rejects malformed commitment hashes", () => {
    for (const commitmentHash of ["abc", HASH_A.slice(1), `${HASH_A}0`, "zz".repeat(32)]) {
      const errors = validateBatchPayload([entry({ commitment_hash: commitmentHash })]);
      assert.equal(errors[0].code, "INVALID_COMMITMENT_HASH");
      assert.ok(!errors[0].message.includes(commitmentHash));
    }
  });

  it("rejects invalid cycle ids and amounts", () => {
    assert.equal(
      validateBatchPayload([entry({ cycle_id: -1 })])[0].code,
      "INVALID_CYCLE_ID"
    );
    assert.equal(
      validateBatchPayload([entry({ cycle_id: 1.5 })])[0].code,
      "INVALID_CYCLE_ID"
    );
    assert.equal(validateBatchPayload([entry({ amount: 0n })])[0].code, "INVALID_AMOUNT");
    assert.equal(validateBatchPayload([entry({ amount: -5n })])[0].code, "INVALID_AMOUNT");
    assert.equal(
      validateBatchPayload([entry({ amount: 1n << 128n })])[0].code,
      "INVALID_AMOUNT"
    );
  });

  it("rejects malformed salts", () => {
    for (const salt of ["", "abc", "zz", "1".repeat(130)]) {
      const errors = validateBatchPayload([entry({ salt })]);
      assert.equal(errors[0].code, "INVALID_SALT", salt);
    }
  });

  it("validates NEAR and Intents asset ids", () => {
    assert.equal(validateBatchPayload([entry({ asset: "" })])[0].code, "MISSING_ASSET");
    assert.equal(validateBatchPayload([entry({ asset: "USDC" })])[0].code, "INVALID_ASSET");
    assert.equal(
      validateBatchPayload([entry({ asset: "nep141:USDC.near" })])[0].code,
      "INVALID_ASSET"
    );
    assert.deepEqual(validateBatchPayload([entry({ asset: "nep245:v2_1.omni.hot.tg" })]), []);
    assert.deepEqual(validateBatchPayload([entry({ asset: "wrap.near" })]), []);
  });

  it("rejects a non-string memo", () => {
    const bad = entry() as unknown as BatchPaymentEntry;
    (bad as unknown as Record<string, unknown>).memo = 42;
    assert.equal(validateBatchPayload([bad])[0].code, "INVALID_MEMO");
  });

  it("rejects duplicate commitments and duplicate employee/cycle pairs", () => {
    const duplicateCommitment = validateBatchPayload([entry(), entry({ cycle_id: 2 })]);
    assert.ok(duplicateCommitment.some((error) => error.code === "DUPLICATE_COMMITMENT"));

    const duplicateCycle = validateBatchPayload([
      entry({ commitment_hash: HASH_A }),
      entry({ commitment_hash: HASH_B }),
    ]);
    assert.ok(duplicateCycle.some((error) => error.code === "DUPLICATE_EMPLOYEE_CYCLE"));
  });

  it("throws BatchValidationFailedError from build()", () => {
    assert.throws(
      () => new BatchPayloadBuilder().add(entry({ employee: "NOPE" })).build(),
      (error: unknown) => {
        assert.ok(error instanceof BatchValidationFailedError);
        assert.equal(error.code, "BATCH_VALIDATION_FAILED");
        assert.ok(error.validationErrors.length > 0);
        return true;
      }
    );
  });
});

describe("chunkPayoutBatches", () => {
  it("splits at exact boundaries and keeps order", () => {
    const entries = uniqueEntries(5);
    const { chunks, errors } = chunkPayoutBatches(entries, { maxBatchSize: 2 });
    assert.deepEqual(errors, []);
    assert.deepEqual(
      chunks.map((chunk) => chunk.length),
      [2, 2, 1]
    );
    assert.deepEqual(chunks.flat(), entries);

    const exact = chunkPayoutBatches(uniqueEntries(4), { maxBatchSize: 2 });
    assert.deepEqual(
      exact.chunks.map((chunk) => chunk.length),
      [2, 2]
    );
  });

  it("returns no chunks when any entry is invalid", () => {
    const result = chunkPayoutBatches([entry(), entry({ employee: "BAD" })], {
      maxBatchSize: 1,
    });
    assert.equal(result.chunks.length, 0);
    assert.ok(result.errors.some((error) => error.code === "INVALID_EMPLOYEE"));
  });

  it("reports an empty batch and rejects invalid sizes", () => {
    const empty = chunkPayoutBatches([], { maxBatchSize: 10 });
    assert.equal(empty.chunks.length, 0);
    assert.equal(empty.errors[0].code, "EMPTY_BATCH");

    assert.throws(() => chunkPayoutBatches([entry()], { maxBatchSize: 0 }), /maxBatchSize/);
    assert.throws(() => chunkPayoutBatches([entry()], { maxBatchSize: 1.5 }), /maxBatchSize/);
  });
});

describe("contract batch limit", () => {
  it("splits above the contract cap and leaves smaller batches intact", () => {
    const big = splitPayoutBatchByContractLimit(uniqueEntries(120));
    assert.equal(MAX_BATCH_SIZE, 50);
    assert.equal(big.wasSplit, true);
    assert.deepEqual(
      big.chunks.map((chunk) => chunk.length),
      [50, 50, 20]
    );

    const small = splitPayoutBatchByContractLimit(uniqueEntries(50));
    assert.equal(small.wasSplit, false);
    assert.equal(small.chunks.length, 1);
  });

  it("returns validation errors instead of chunks", () => {
    const result = splitPayoutBatchByContractLimit([entry({ salt: "nope" })]);
    assert.deepEqual(result.chunks, []);
    assert.equal(result.errors[0].code, "INVALID_SALT");
  });
});

describe("pagination", () => {
  it("pages without duplicating or skipping records", () => {
    const items = Array.from({ length: 7 }, (_, index) => index);
    const pages = Array.from(iterateBatches(items, 3));

    assert.deepEqual(
      pages.map((page) => page.items),
      [
        [0, 1, 2],
        [3, 4, 5],
        [6],
      ]
    );
    assert.deepEqual(pages.flatMap((page) => page.items), items);
    assert.equal(pages[0].hasNext, true);
    assert.equal(pages[2].hasNext, false);

    const second = getBatchPage(items, 3, 1);
    assert.deepEqual(second.items, [3, 4, 5]);
    assert.equal(second.offset, 3);
  });

  it("rejects invalid page sizes and indexes", () => {
    assert.throws(() => getBatchPage([1, 2, 3], 0), /Invalid page size/);
    assert.throws(() => getBatchPage([1, 2, 3], 1.5), /Invalid page size/);
    assert.throws(() => getBatchPage([1, 2, 3], 2, -1), /Invalid batch index/);
    assert.throws(() => Array.from(iterateBatches([1, 2, 3], -2)), /Invalid page size/);
  });

  it("treats an empty collection as one empty page", () => {
    const pages = Array.from(iterateBatches([], 10));
    assert.equal(pages.length, 1);
    assert.deepEqual(pages[0].items, []);
  });
});

describe("deduplication", () => {
  it("detects duplicate commitments and masks values in summaries", () => {
    const entries = [entry({ amount: 123_456n }), entry({ employee: "bob.near" })];
    const result = detectDuplicates(entries, ["commitment_hash"]);
    assert.equal(result.hasDuplicates, true);
    assert.deepEqual(result.duplicates[0].indices, [0, 1]);

    const summary = formatDeduplicationSummary(result);
    assert.ok(!summary.includes("123456"));
    assert.ok(!summary.includes("alice.near"));
  });

  it("detects duplicate amounts without exposing them", () => {
    const entries = [entry(), entry({ employee: "bob.near", commitment_hash: HASH_B })];
    const result = detectDuplicates(entries, ["amount"]);
    assert.equal(result.hasDuplicates, true);
    assert.ok(summaryDoesNotLeakAmount(result));
  });

  it("rejects unknown keys and empty input", () => {
    assert.throws(() => detectDuplicates([], ["commitment_hash"]), /empty/);
    assert.throws(
      () => detectDuplicates([entry()], ["employee", "nope" as never]),
      /Invalid deduplication key/
    );
  });

  function summaryDoesNotLeakAmount(result: DeduplicationResult): boolean {
    const summary = formatDeduplicationSummary(result);
    return !summary.includes("1000") && summary.includes("[redacted amount]");
  }
});

describe("ResumableBatchManager", () => {
  it("walks the PENDING → IN_PROGRESS → PAUSED → IN_PROGRESS → COMPLETED states", () => {
    const manager = new ResumableBatchManager({ now: () => new Date(0) });
    const initial = manager.initializeBatch("batch-1", [{ id: "a" }, { id: "b" }]);
    assert.equal(initial.status, "PENDING");

    const progress = manager.updateProgress("batch-1", 1, "a");
    assert.equal(progress.status, "IN_PROGRESS");
    assert.deepEqual(progress.processedIds, ["a"]);

    assert.equal(manager.pauseBatch("batch-1").status, "PAUSED");
    assert.equal(manager.resumeBatch("batch-1").status, "IN_PROGRESS");

    const completed = manager.completeBatch("batch-1");
    assert.equal(completed.status, "COMPLETED");
    assert.equal(manager.isTerminal("batch-1"), true);
    assert.throws(() => manager.updateProgress("batch-1", 2), /terminal status/);
  });

  it("supports the FAILED transition and rejects invalid transitions", () => {
    const manager = new ResumableBatchManager();
    manager.initializeBatch("batch-2", [{ id: "a" }]);
    assert.equal(manager.failBatch("batch-2").status, "FAILED");
    assert.throws(() => manager.completeBatch("batch-2"), /failed batch/);
    assert.throws(() => manager.pauseBatch("batch-2"), /failed batch/);

    assert.throws(() => manager.initializeBatch("batch-2", [{ id: "a" }]), /already exists/);
    assert.throws(() => manager.initializeBatch("batch-3", []), /non-empty/);
    assert.throws(
      () => manager.initializeBatch("batch-4", [{ id: "a" }, { id: "a" }]),
      /Duplicate batch item id/
    );
    assert.throws(() => manager.getCheckpoint("missing"), /not found/);
  });
});

describe("batch resume tokens", () => {
  const items = uniqueEntries(5);

  it("round-trips a checkpoint and contains no payroll data", () => {
    const token = createBatchResumeToken(items, 2, 4, 3, 2);
    const checkpoint = decodeBatchResumeToken(token);

    assert.equal(checkpoint.nextBatchIndex, 2);
    assert.equal(checkpoint.itemsProcessed, 4);
    assert.equal(checkpoint.totalItems, 5);
    assert.equal(checkpoint.totalBatches, 3);
    assert.equal(checkpoint.batchSize, 2);
    assert.equal(checkpoint.entriesCommitment, computeBatchEntriesCommitment(items));

    const payload = Buffer.from(token.split(".")[1], "base64url").toString("utf8");
    assert.deepEqual(Object.keys(JSON.parse(payload)).sort(), [
      "batchSize",
      "createdAt",
      "entriesCommitment",
      "itemsProcessed",
      "nextBatchIndex",
      "totalBatches",
      "totalItems",
      "version",
    ]);
    const checkpointRecord = JSON.parse(payload) as Record<string, unknown>;
    for (const forbidden of ["employee", "amount", "salt", "asset", "memo"]) {
      assert.equal(forbidden in checkpointRecord, false, forbidden);
    }
    for (const item of items) {
      assert.ok(!payload.includes(item.employee));
      assert.ok(!payload.includes(item.salt));
    }
  });

  it("resolves a valid resume point", () => {
    const token = createBatchResumeToken(items, 1, 2, 3, 2);
    const start = resolveResumeStart(items, 2, token);
    assert.equal(start.startBatchIndex, 1);
    assert.equal(start.itemsAlreadyProcessed, 2);
  });

  it("resolves a completed token to the total batch count", () => {
    const token = createBatchResumeToken(items, 3, 5, 3, 2);
    assert.equal(resolveResumeStart(items, 2, token).startBatchIndex, 3);
  });

  it("rejects changed entries without echoing them", () => {
    const token = createBatchResumeToken(items, 1, 2, 3, 2);
    const mutated = [...items];
    mutated[0] = { ...mutated[0], amount: 999_999n };

    assert.throws(
      () => resolveResumeStart(mutated, 2, token),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(codeOf(error), RESUME_TOKEN_ERROR_CODE.ENTRIES_MISMATCH);
        assert.ok(!error.message.includes("999999"));
        return true;
      }
    );
  });

  it("rejects a different batch size and malformed/tampered tokens", () => {
    const token = createBatchResumeToken(items, 1, 2, 3, 2);
    assert.throws(
      () => resolveResumeStart(items, 1, token),
      (error: unknown) => codeOf(error) === RESUME_TOKEN_ERROR_CODE.BATCH_SIZE_MISMATCH
    );

    const tampered = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
    for (const bad of ["", "nope", "sbbr1.e30.deadbeef", tampered]) {
      assert.throws(() => decodeBatchResumeToken(bad), /resume token/i);
    }
  });

  it("refuses to create a token with inconsistent counters", () => {
    assert.throws(
      () => createBatchResumeToken(items, 2, 3, 3, 2),
      (error: unknown) => codeOf(error) === RESUME_TOKEN_ERROR_CODE.INCONSISTENT
    );
    assert.throws(
      () => createBatchResumeToken(items, 1, 2, 9, 2),
      (error: unknown) => codeOf(error) === RESUME_TOKEN_ERROR_CODE.INCONSISTENT
    );
  });
});

describe("submitSequentialPayrollBatches", () => {
  interface Item {
    id: string;
    amount: string;
  }

  const makeItems = (count: number): Item[] =>
    Array.from({ length: count }, (_, index) => ({ id: `item-${index}`, amount: `${index + 1}00` }));

  it("submits every batch in order and checkpoints each one", async () => {
    const seen: number[] = [];
    const checkpoints: string[] = [];
    const stages: string[] = [];
    const items = makeItems(5);

    const result = await submitSequentialPayrollBatches<Item, { intentHash: string }>(
      items,
      async (batchItems, batchIndex, idempotencyKey) => {
        seen.push(batchIndex);
        assert.equal(idempotencyKey, `run:batch:${batchIndex}`);
        return batchItems.map((item) => ({ intentHash: `intent-${item.id}` }));
      },
      {
        batchSize: 2,
        idempotencyKeyPrefix: "run",
        sleep: async () => {},
        now: () => 0,
        onProgress: (event) => stages.push(event.stage),
        onCheckpoint: (token) => checkpoints.push(token),
      }
    );

    assert.equal(result.success, true);
    assert.equal(result.totalBatches, 3);
    assert.equal(result.batchesProcessed, 3);
    assert.equal(result.itemsProcessed, 5);
    assert.deepEqual(seen, [0, 1, 2]);
    assert.equal(checkpoints.length, 3);
    assert.equal(decodeBatchResumeToken(checkpoints[2]).nextBatchIndex, 3);
    assert.ok(stages.includes("validating"));
    assert.ok(stages.includes("batch_submitting"));
    assert.ok(stages.includes("batch_completed"));
    assert.equal(stages.at(-1), "completed");
  });

  it("retries transient failures and reports the redacted error", async () => {
    let attempts = 0;
    const retryEvents: boolean[] = [];

    const result = await submitSequentialPayrollBatches<Item, { intentHash: string }>(
      makeItems(2),
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("network timeout while submitting");
        }
        return [{ intentHash: "ok" }];
      },
      {
        batchSize: 50,
        maxRetries: 1,
        initialDelayMs: 1,
        sleep: async () => {},
        now: () => 0,
        onBatchError: (_index, _error, willRetry) => retryEvents.push(willRetry),
      }
    );

    assert.equal(result.success, true);
    assert.equal(attempts, 2);
    assert.deepEqual(retryEvents, [true]);
  });

  it("does not retry non-retryable validation failures and redacts secrets", async () => {
    let attempts = 0;
    const result = await submitSequentialPayrollBatches<Item, { intentHash: string }>(
      makeItems(1),
      async () => {
        attempts += 1;
        throw new Error("validation failed for employee=alice.near amount=123456 salt=deadbeef");
      },
      { batchSize: 50, maxRetries: 3, sleep: async () => {}, now: () => 0 }
    );

    assert.equal(attempts, 1);
    assert.equal(result.success, false);
    assert.equal(result.failedBatchIndex, 0);
    assert.equal(result.error?.code, "BATCH_SUBMISSION_FAILED");
    const message = result.error?.message ?? "";
    assert.ok(!message.includes("alice.near"));
    assert.ok(!message.includes("123456"));
    assert.ok(!message.includes("deadbeef"));
  });

  it("returns a resume token after a partial failure and skips completed batches", async () => {
    const items = makeItems(5);
    const firstRunBatches: number[] = [];
    const first = await submitSequentialPayrollBatches<Item, { intentHash: string }>(
      items,
      async (_batchItems, batchIndex) => {
        firstRunBatches.push(batchIndex);
        if (batchIndex === 1) throw new Error("permanent failure");
        return [{ intentHash: `intent-${batchIndex}` }];
      },
      { batchSize: 2, maxRetries: 0, sleep: async () => {}, now: () => 0 }
    );

    assert.equal(first.success, false);
    assert.deepEqual(firstRunBatches, [0, 1]);
    assert.ok(first.error?.resumeToken);

    const secondRunBatches: number[] = [];
    const second = await submitSequentialPayrollBatches<Item, { intentHash: string }>(
      items,
      async (_batchItems, batchIndex) => {
        secondRunBatches.push(batchIndex);
        return [{ intentHash: `intent-${batchIndex}` }];
      },
      {
        batchSize: 2,
        resumeToken: first.error?.resumeToken,
        sleep: async () => {},
        now: () => 0,
      }
    );

    assert.deepEqual(secondRunBatches, [1, 2]);
    assert.equal(second.success, true);
    assert.equal(second.batchesProcessed, 3);
  });

  it("honours a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await submitSequentialPayrollBatches<Item, { intentHash: string }>(
      makeItems(3),
      async () => [{ intentHash: "never" }],
      { batchSize: 1, signal: controller.signal, sleep: async () => {}, now: () => 0 }
    );

    assert.equal(result.success, false);
    assert.equal(result.error?.code, "BATCH_SUBMISSION_CANCELLED");
    assert.equal(result.itemsProcessed, 0);
  });

  it("keeps running with stopOnFirstFailure=false but reports failure", async () => {
    const completed: number[] = [];
    const result = await submitSequentialPayrollBatches<Item, { intentHash: string }>(
      makeItems(4),
      async (_batchItems, batchIndex) => {
        if (batchIndex === 0) throw new Error("invalid batch");
        completed.push(batchIndex);
        return [{ intentHash: `intent-${batchIndex}` }];
      },
      {
        batchSize: 2,
        stopOnFirstFailure: false,
        maxRetries: 0,
        sleep: async () => {},
        now: () => 0,
      }
    );

    assert.deepEqual(completed, [1]);
    assert.equal(result.success, false);
    assert.equal(result.failedBatchIndex, 0);
    assert.equal(result.batchesProcessed, 1);
    assert.equal(result.results.length, 1);
  });

  it("completes an empty submission immediately", async () => {
    const result = await submitSequentialPayrollBatches<Item, { intentHash: string }>(
      [],
      async () => {
        throw new Error("must not be called");
      },
      {}
    );
    assert.equal(result.success, true);
    assert.equal(result.totalBatches, 0);
  });
});
