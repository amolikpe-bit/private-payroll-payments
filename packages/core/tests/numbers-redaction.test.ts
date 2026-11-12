import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  BatchPayloadBuilder,
  DEFAULT_REDACTION_REPLACEMENT,
  MAX_BATCH_SIZE,
  createBatchResumeToken,
  decodeBatchResumeToken,
  redactDeep,
  redactError,
  resolveResumeStart,
  splitPayoutBatchByContractLimit,
  validateSafeCredentialUsage,
  type BatchPaymentEntry,
} from "../src/index.js";

const NEAR_SECRET_KEY = `ed25519:${"A".repeat(43)}`;

function entry(index: number): BatchPaymentEntry {
  return {
    employee: `employee-${index.toString().padStart(2, "0")}.testnet`,
    commitment_hash: createHash("sha256").update(`commitment/${index}`).digest("hex"),
    cycle_id: index + 1,
    amount: 1_000_000_000_000n + BigInt(index),
    salt: createHash("sha256").update(`salt/${index}`).digest("hex"),
    asset: "usdc.testnet",
    memo: `cycle-${index}`,
  };
}

test("50-entry batch cap, resume token, and redaction contract", () => {
  assert.equal(MAX_BATCH_SIZE, 50);
  const entries = Array.from({ length: 50 }, (_value, index) => entry(index));
  const payload = new BatchPayloadBuilder().addMany(entries).build();
  assert.equal(payload.entries.length, 50);

  const atCap = splitPayoutBatchByContractLimit(entries);
  assert.deepEqual(atCap.chunks.map((chunk) => chunk.length), [50]);
  const split = splitPayoutBatchByContractLimit(entries.concat(entry(50)));
  assert.deepEqual(split.chunks.map((chunk) => chunk.length), [50, 1]);

  const token = createBatchResumeToken(entries, 2, 20, 5, 10);
  const checkpoint = decodeBatchResumeToken(token);
  assert.equal(checkpoint.totalItems, 50);
  assert.equal(checkpoint.totalBatches, 5);
  const start = resolveResumeStart(entries, 10, token);
  assert.equal(start.startBatchIndex, 2);
  assert.equal(start.itemsAlreadyProcessed, 20);

  const privatePayload = {
    employer: "acme.testnet",
    entries,
    meta: { witnessSecret: "witness-secret-material", privateKey: NEAR_SECRET_KEY },
  };
  const privateValues = [
    NEAR_SECRET_KEY,
    privatePayload.meta.witnessSecret,
    ...entries.flatMap((item) => [item.employee, item.amount.toString(), item.salt]),
  ];

  assert.equal(validateSafeCredentialUsage(privatePayload, { context: "logging" }).safe, false);
  const redacted = redactDeep(privatePayload);
  const redactedJson = JSON.stringify(redacted.redacted);
  for (const value of privateValues) {
    assert.equal(redactedJson.includes(value), false);
  }
  assert.equal(
    (redacted.redacted as { entries: Array<{ employee: string; amount: string; salt: string }> })
      .entries[0].employee,
    DEFAULT_REDACTION_REPLACEMENT,
  );
  assert.equal(entries.filter((item) => redactedJson.includes(item.commitment_hash)).length, 50);

  const error = Object.assign(new Error(`amount=${entries[0].amount} salt=${entries[0].salt}`), {
    context: privatePayload,
  });
  const sanitized = redactError(error);
  assert.equal(sanitized.message.includes(entries[0].salt), false);
  assert.ok(sanitized.message.includes(DEFAULT_REDACTION_REPLACEMENT));
});
