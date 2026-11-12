const VIEW_KEY_FIELD = ["view", "Key", "Id"].join("");
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ReceiptError,
  computeComplianceHash,
  createSettlementReceipt,
  isValidIntentHash,
  mapExecutionStatus,
  validateSettlementReceipt,
  type AuditHoldRef,
  type PayrollReceipt,
} from "../src/settlement/receipt.js";
import type { HoldEntry } from "../src/types.js";

const INTENT_HASH = "44XpLRAuZKoVGs9T4qbSNv33MDKMePPAibA52geVLWFw";
const COMMITMENT = "2352e17857723f925f4774a0eb12ffbe51f1f7d81c7ce075ed69927db9ce0485";
const SIGNATURE =
  "ed25519:2AXDGYSE4f2sz7tvMMzyHvUfcoJmxudvdhBcmiUSo6ijwfYmfZYsKRxboQMPh3R4kUhXRVdtSXFXMheka4Rc4P2";
const PUBLIC_KEY = "ed25519:8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";

const HOLD_A: HoldEntry = {
  employer: "subrosa.testnet",
  scope: "Employee",
  scope_id: "alice.testnet",
  reason_code: "KycReviewPending",
  state: "Active",
  placed_by: "subrosa.testnet",
  placed_at: 1_700_000_000_000_000_000,
  released_by: null,
  released_at: null,
  release_reason: null,
};

const HOLD_B: HoldEntry = {
  employer: "subrosa.testnet",
  scope: "Period",
  scope_id: "2026-01",
  reason_code: "SanctionsScreening",
  state: "Released",
  placed_by: "auditor.testnet",
  placed_at: 1_700_000_100_000_000_000,
  released_by: "subrosa.testnet",
  released_at: 1_700_000_200_000_000_000,
  release_reason: "Other",
};

function baseReceiptParams() {
  return {
    receiptId: "rcpt_2026_01",
    payrollId: "payroll:subrosa.testnet:7",
    intentHash: INTENT_HASH,
    commitmentHash: COMMITMENT,
    status: "SUCCESS",
    issuedAt: "2026-01-01T00:00:00.000Z",
    settledAt: "2026-01-01T00:00:01.000Z",
    network: "testnet",
  } as const;
}

test("1Click statuses map onto receipt statuses", () => {
  assert.equal(mapExecutionStatus("SUCCESS"), "settled");
  assert.equal(mapExecutionStatus("FAILED"), "rejected");
  assert.equal(mapExecutionStatus("REFUNDED"), "rejected");
  assert.equal(mapExecutionStatus("INCOMPLETE_DEPOSIT"), "rejected");
  assert.equal(mapExecutionStatus("PROCESSING"), "pending");
  assert.equal(mapExecutionStatus("PENDING_DEPOSIT"), "pending");
  assert.equal(mapExecutionStatus("KNOWN_DEPOSIT_TX"), "pending");
  assert.equal(mapExecutionStatus("SOMETHING_NEW"), "unknown");
  assert.equal(mapExecutionStatus(""), "unknown");
});

test("receipt uses intentHash as its reference and the commitment as metadata digest", () => {
  const receipt = createSettlementReceipt(baseReceiptParams());
  assert.equal(receipt.receiptId, "rcpt_2026_01");
  assert.equal(receipt.settlementStatus, "settled");
  assert.equal(receipt.transactionReference.txHash, INTENT_HASH);
  assert.equal(receipt.transactionReference.network, "testnet");
  assert.equal(receipt.metadataDigest, COMMITMENT);
  assert.equal(receipt.issuedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(receipt.settledAt, "2026-01-01T00:00:01.000Z");
  assert.equal(VIEW_KEY_FIELD in receipt, false);
  assert.equal("totalAmount" in receipt, false);
  assert.deepEqual(validateSettlementReceipt(receipt), { ok: true });
});

test("receipt status accepts already-mapped statuses and normalizes hashes", () => {
  const confirmed = createSettlementReceipt({
    ...baseReceiptParams(),
    status: "confirmed",
    commitmentHash: COMMITMENT.toUpperCase(),
  });
  assert.equal(confirmed.settlementStatus, "confirmed");
  assert.equal(confirmed.metadataDigest, COMMITMENT);

  const pending = createSettlementReceipt({ ...baseReceiptParams(), status: "PENDING_DEPOSIT" });
  assert.equal(pending.settlementStatus, "pending");

  const unknown = createSettlementReceipt({ ...baseReceiptParams(), status: "brand-new" });
  assert.equal(unknown.settlementStatus, "unknown");
});

test("compliance hash is deterministic over the hold set and order-independent", () => {
  const forward: AuditHoldRef[] = [
    { holdId: "hold-a", hold: HOLD_A },
    { holdId: "hold-b", hold: HOLD_B },
  ];
  const reverse: AuditHoldRef[] = [...forward].reverse();
  const first = computeComplianceHash(forward);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(computeComplianceHash(reverse), first);
  assert.notEqual(
    computeComplianceHash([{ holdId: "hold-a", hold: { ...HOLD_A, state: "Released" } }]),
    computeComplianceHash([{ holdId: "hold-a", hold: HOLD_A }]),
  );

  const receipt = createSettlementReceipt({ ...baseReceiptParams(), holds: forward });
  assert.equal(receipt.complianceHash, first);
  assert.throws(
    () =>
      createSettlementReceipt({
        ...baseReceiptParams(),
        holds: forward,
        complianceHash: "b".repeat(64),
      }),
    (error: unknown) => error instanceof ReceiptError && error.code === "RECEIPT_COMPLIANCE_HASH_MISMATCH",
  );
});

test("receipt supports only paired ed25519 signatures", () => {
  const receipt = createSettlementReceipt({
    ...baseReceiptParams(),
    signature: { signature: SIGNATURE, signerPublicKey: PUBLIC_KEY },
  });
  assert.equal(receipt.signature, SIGNATURE);
  assert.equal(receipt.signerPublicKey, PUBLIC_KEY);
  assert.equal(validateSettlementReceipt(receipt).ok, true);

  assert.throws(
    () =>
      createSettlementReceipt({
        ...baseReceiptParams(),
        signature: {
          signature: `secp256k1:${SIGNATURE.slice("ed25519:".length)}`,
          signerPublicKey: PUBLIC_KEY,
        },
      }),
    (error: unknown) => error instanceof ReceiptError && error.code === "RECEIPT_SIGNATURE_INVALID",
  );

  assert.throws(
    () => createSettlementReceipt({ ...baseReceiptParams(), signature: { signature: SIGNATURE, signerPublicKey: "" } }),
    (error: unknown) => error instanceof ReceiptError && error.code === "RECEIPT_SIGNATURE_INVALID",
  );
});

test("receipt validation rejects a view key, bad references and bad timestamps", () => {
  const receipt = createSettlementReceipt(baseReceiptParams());
  const withViewKey = { ...receipt, [VIEW_KEY_FIELD]: "vk_1" };
  const viewResult = validateSettlementReceipt(withViewKey);
  assert.equal(viewResult.ok, false);
  assert.equal(viewResult.ok ? "" : viewResult.code, "RECEIPT_VIEW_KEY_UNSUPPORTED");

  assert.equal(
    validateSettlementReceipt({ ...receipt, transactionReference: { txHash: "not-a-hash" } }).ok,
    false,
  );
  assert.equal(validateSettlementReceipt({ ...receipt, metadataDigest: "abc" }).ok, false);
  assert.equal(validateSettlementReceipt({ ...receipt, issuedAt: "not-a-date" }).ok, false);
  assert.equal(
    validateSettlementReceipt({ ...receipt, signature: SIGNATURE }).ok,
    false,
  );
});

test("transaction references accept base58 intent hashes and 64-hex", () => {
  assert.equal(isValidIntentHash(INTENT_HASH), true);
  assert.equal(isValidIntentHash(COMMITMENT), true);
  assert.equal(isValidIntentHash("not-a-hash"), false);
  assert.equal(isValidIntentHash(""), false);
  assert.equal(isValidIntentHash(` ${INTENT_HASH}`), false);

  const hexReceipt: PayrollReceipt = createSettlementReceipt({
    ...baseReceiptParams(),
    intentHash: COMMITMENT,
  });
  assert.equal(hexReceipt.transactionReference.txHash, COMMITMENT);
  assert.equal(validateSettlementReceipt(hexReceipt).ok, true);
});
