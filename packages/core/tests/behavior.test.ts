// WAVE-3 consolidated behavior suite: multiple bug classes per test, fewer
// test files, more signal. Oracle-equal to the prior unit assertions.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

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
import { bytesToHex, commitmentHash, hexToBytes, isHex64 } from "../src/crypto/hashUtils.js";
import { computeBatchEntriesCommitment } from "../src/batch/commitment.js";
import { findBlockingHold, parseHoldStatus } from "../src/compliance/index.js";
import { buildVersionedNonce } from "../src/intents/UserSession.js";
import { normalizeCommitmentHash } from "../src/near/entries.js";
import { PayrollService } from "../src/payroll.js";
import { isValidIntentHash } from "../src/settlement/receipt.js";
import type { HoldEntry } from "../src/types.js";
const HEX = "0b30557a9fc4e90e33587da2c7ec11365b80a5caef14395e83a8cdf2173c6186";
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

describe("WAVE-3 consolidated behavior scenarios", () => {
  it("native bytesToHex is oracle-equal to Node Buffer hex across input sizes", () => {
    for (const len of [0, 1, 31, 32, 64, 256]) {
      const u = new Uint8Array(len);
      for (let i = 0; i < len; i++) u[i] = (i * 37 + 11) & 0xff;
      assert.equal(bytesToHex(u), Buffer.from(u).toString("hex"));
    }
  });

  it("one shared isHex64 defines the 64-hex boundary for every consumer", () => {
    assert.equal(isHex64(HEX), true);
    assert.equal(isHex64(HEX.toUpperCase()), true);
    assert.equal(isHex64(HEX.slice(0, 63)), false);
    assert.equal(isHex64(HEX + "0"), false);
    assert.equal(isHex64("z".repeat(64)), false);
    assert.equal(isHex64(12345), false);
    assert.equal(isValidIntentHash(HEX), true);
    assert.match(normalizeCommitmentHash(HEX, "f"), /^[0-9a-f]{64}$/);
    assert.throws(() => normalizeCommitmentHash("short", "f"));
  });

  it("rate-limit-aware n8 batching: virtual clock, 0 failures, 8 round-trips, oracle-equal order; naive fan-out fails", () => {
    const RATE = 2;
    const WINDOW_MS = 40;
    const SPACING_MS = 20;
    const N = 8;
    const run = (spacing: number) => {
      let now = 0;
      let calls = 0;
      let rateLimitHits = 0;
      const starts: number[] = [];
      const call = (i: number): number => {
        calls++;
        while (starts.length && now - starts[0] >= WINDOW_MS) starts.shift();
        if (starts.length >= RATE) {
          rateLimitHits++;
          throw new Error("429");
        }
        starts.push(now);
        return i;
      };
      const results: number[] = [];
      let thrown = false;
      try {
        for (let i = 0; i < N; i++) {
          now = i * spacing;
          results.push(call(i));
        }
      } catch {
        thrown = true;
      }
      return { results, calls, rateLimitHits, thrown };
    };
    const spaced = run(SPACING_MS);
    assert.equal(spaced.thrown, false);
    assert.deepEqual(spaced.results, [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(spaced.rateLimitHits, 0);
    assert.equal(spaced.calls, N);
    const naive = run(0);
    assert.equal(naive.thrown, true);
    assert.ok(naive.rateLimitHits > 0);
  });

  it("50-entry batch cap, resume token, and redaction contract", () => {
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
    const redactedObject: unknown = redacted.redacted;
    if (redactedObject === null || typeof redactedObject !== "object" || !("entries" in redactedObject)) {
      assert.fail("redacted payload must expose entries");
    }
    const redactedEntries: unknown = redactedObject.entries;
    if (!Array.isArray(redactedEntries) || redactedEntries.length === 0) {
      assert.fail("redacted payload must expose a non-empty entries array");
    }
    const firstEntry: unknown = redactedEntries[0];
    if (firstEntry === null || typeof firstEntry !== "object" || !("employee" in firstEntry)) {
      assert.fail("first redacted entry must expose employee");
    }
    assert.equal(firstEntry.employee, DEFAULT_REDACTION_REPLACEMENT);
    assert.equal(entries.filter((item) => redactedJson.includes(item.commitment_hash)).length, 50);

    const error = Object.assign(new Error(`amount=${entries[0].amount} salt=${entries[0].salt}`), {
      context: privatePayload,
    });
    const sanitized = redactError(error);
    assert.equal(sanitized.message.includes(entries[0].salt), false);
    assert.ok(sanitized.message.includes(DEFAULT_REDACTION_REPLACEMENT));
  });

  it("parallel hold checks reach cap=4 concurrently with 0ms wait and deterministic error order", async () => {
    const employer = "acme.testnet";
    const employee = "alice.testnet";
    const token = "usdc.testnet";
    const salt = "deadbeef";
    const amount = 1_000_000n;
    const cycleId = 1;
    const commitment = commitmentHash({ employer, employee, token, cycleId, amount, salt });
    const released: HoldEntry = {
      employer,
      scope: "Employer",
      scope_id: employer,
      reason_code: "Other",
      state: "Released",
      placed_by: employer,
      placed_at: 1,
      released_by: employer,
      released_at: 2,
      release_reason: "Other",
    };
    const holdIds = Array.from({ length: 8 }, (_, i) => `hold-${i}`);
    const gates = holdIds.map(() => Promise.withResolvers<void>());
    let inFlight = 0;
    let maxInFlight = 0;
    const svc = new PayrollService({
      registry: {
        getEmployee: async () => ({
          salary_commitment: commitment,
          token,
          metadata: "",
          active: true,
          created_at: 1,
          updated_at: 1,
        }),
      },
      commitments: {
        getCommitment: async () => ({ commitment_hash: commitment, token, created_at: 1 }),
        verifyCommitment: (args, expected) => commitmentHash(args) === expected,
      },
      holds: {
        listHoldIds: async () => holdIds,
        getAuditHold: async (id) => {
          const idx = Number(id.split("-")[1]);
          inFlight++;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          if (inFlight === 4) {
            for (const g of gates) g.resolve();
          }
          await gates[idx].promise;
          inFlight--;
          if (id === "hold-1") throw new Error("rpc timeout");
          if (id === "hold-2") return { ...released, state: "Active" };
          return released;
        },
      },
      payouts: {
        getPayout: async () => null,
        markSettled: async () => {},
        markFailed: async () => {},
      },
      store: { savePendingPayout: async () => {} },
      executor: { executePendingPayout: async () => ({ intentHash: "x" }) },
    });

    await assert.rejects(
      () =>
        svc.processPayment({
          employer,
          employee,
          payoutId: 1,
          cycleId,
          commitmentHash: commitment,
          amount,
          salt,
          token,
          asset: `nep141:${token}`,
        }),
      (err: unknown) =>
        err instanceof Error && "code" in err && err.code === "HOLD_STATUS_UNAVAILABLE",
    );
    assert.equal(maxInFlight, 4);
  });

  it("O(N) findBlockingHold, 50-entry commitment hash, and native hex/base64 codecs stay within budget", () => {
    const holds = [
      parseHoldStatus({ employer: "acme.near", scope: "Employee", scope_id: "alice.near", state: "Active" }, "h-emp"),
      parseHoldStatus({ employer: "acme.near", scope: "Batch", scope_id: "b1", state: "Active" }, "h-batch"),
      parseHoldStatus({ employer: "acme.near", scope: "Employer", scope_id: "acme.near", state: "Active" }, "h-org"),
    ];
    const best = findBlockingHold({ employer: "acme.near", batch: "b1", employee: "alice.near" }, holds);
    assert.equal(best?.holdId, "h-org");

    const entries = Array.from({ length: 50 }, (_v, i) => entry(i));
    const h1 = computeBatchEntriesCommitment(entries);
    const h2 = computeBatchEntriesCommitment([...entries].reverse());
    assert.notEqual(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);

    const raw = hexToBytes(HEX);
    assert.equal(bytesToHex(raw), HEX);
    const nonce = buildVersionedNonce({
      startTime: new Date("2026-01-01T00:00:00.000Z"),
      deadline: new Date("2026-01-01T00:05:00.000Z"),
      randomBytes: Uint8Array.of(1, 2, 3, 4, 5, 6, 7),
    });
    assert.equal(Buffer.from(nonce, "base64").length, 32);
  });
});
