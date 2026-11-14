// Consolidated crypto, settlement receipt, and redaction/privacy suite.
import assert from "node:assert/strict";
import { describe, it, test } from "node:test";

import {
  COMMITMENT_DOMAIN,
  CommitmentEncodingError,
  REGISTRATION_DOMAIN,
  buildCommitmentPreimage,
  buildRegistrationPreimage,
  bytesToHex,
  commitmentHash,
  hexToBytes,
  isHex64,
  registrationHash,
  sha256Hex,
  verifyCommitment,
  verifyRegistrationCommitment,
} from "../src/crypto/hashUtils.js";
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
import {
  DEFAULT_REDACTION_REPLACEMENT,
  getDefaultSensitiveFields,
  redactDeep,
  redactError,
  redactObject,
} from "../src/redaction/index.js";
import {
  REDACTED_REPLACEMENT,
  SafeCredentialAuditor,
  SafeCredentialHandlingError,
  assertSafeCredentialUsage,
  maskCredential,
  redactAmount,
  redactIdentifier,
  sanitizeForPersistence,
  validateSafeCredentialUsage,
} from "../src/privacy/index.js";

describe("crypto preimages and hex helpers", () => {
  const VECTOR = {
    employer: "subrosa.testnet",
    employee: "alice.testnet",
    token: "usdc.tokens.testnet",
    cycleId: 7n,
    amount: "123456789012345678901234567890",
    salt: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  } as const;

  // Hard-coded from the byte layout in CONSTANTS.md §3; the Rust contract must
  // produce the same digest for the same inputs.
  const EXPECTED_PREIMAGE_HEX =
    "737562726f73612f636f6d6d69742f76310f000000737562726f73612e746573746e65740d000000616c6963652e746573746e657413000000757364632e746f6b656e732e746573746e65740700000000000000d20a3f4eeee073c3f60fe98e0100000020000000000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
  const EXPECTED_COMMITMENT = "2352e17857723f925f4774a0eb12ffbe51f1f7d81c7ce075ed69927db9ce0485";
  const EXPECTED_REGISTRATION_PREIMAGE_HEX =
    "737562726f73612f7265672f76310f000000737562726f73612e746573746e65740d000000616c6963652e746573746e657413000000757364632e746f6b656e732e746573746e65740000000000000000d20a3f4eeee073c3f60fe98e0100000020000000000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
  const EXPECTED_REGISTRATION = "3baa071c027b571a8c8c379bae696b1fc0ec8064d83ab746f496a80e2b24c6c6";

  test("commitment preimage matches the documented Borsh layout", () => {
    assert.equal(COMMITMENT_DOMAIN, "subrosa/commit/v1");
    const preimage = buildCommitmentPreimage(VECTOR);
    assert.equal(bytesToHex(preimage), EXPECTED_PREIMAGE_HEX);
  });

  test("commitment hash vector is stable across languages", () => {
    assert.equal(commitmentHash(VECTOR), EXPECTED_COMMITMENT);
    assert.equal(sha256Hex(hexToBytes(EXPECTED_PREIMAGE_HEX)), EXPECTED_COMMITMENT);
  });

  test("registration preimage uses cycle zero and its own domain", () => {
    assert.equal(REGISTRATION_DOMAIN, "subrosa/reg/v1");
    const preimage = buildRegistrationPreimage(VECTOR);
    assert.equal(bytesToHex(preimage), EXPECTED_REGISTRATION_PREIMAGE_HEX);
    assert.equal(registrationHash(VECTOR), EXPECTED_REGISTRATION);
    assert.notEqual(EXPECTED_REGISTRATION, EXPECTED_COMMITMENT);
    assert.notDeepEqual(buildRegistrationPreimage(VECTOR), buildCommitmentPreimage(VECTOR));
  });

  test("verifyCommitment recomputes and compares in constant time", () => {
    assert.equal(verifyCommitment(VECTOR, EXPECTED_COMMITMENT), true);
    assert.equal(verifyCommitment(VECTOR, EXPECTED_COMMITMENT.toUpperCase()), true);
    assert.equal(verifyCommitment({ ...VECTOR, amount: "1" }, EXPECTED_COMMITMENT), false);
    assert.equal(verifyRegistrationCommitment(VECTOR, EXPECTED_REGISTRATION), true);
    assert.equal(verifyRegistrationCommitment(VECTOR, EXPECTED_COMMITMENT), false);
  });

  test("malformed salts are rejected before hashing", () => {
    const invalidSalts = ["", "0", "abc", "0x00ff", "zz", "gg", "00 11"];
    for (const salt of invalidSalts) {
      assert.throws(
        () => buildCommitmentPreimage({ ...VECTOR, salt }),
        (error: unknown) =>
          error instanceof CommitmentEncodingError &&
          (error.code === "INVALID_SALT" || error.code === "INVALID_SALT_HEX"),
        `salt ${JSON.stringify(salt)} should be rejected`,
      );
    }
    const tooLong = "00".repeat(65);
    assert.throws(
      () => buildCommitmentPreimage({ ...VECTOR, salt: tooLong }),
      (error: unknown) => error instanceof CommitmentEncodingError && error.code === "INVALID_SALT",
    );
  });

  test("malformed expected hashes are rejected", () => {
    for (const hash of ["", "abc", "zz".repeat(32), "a".repeat(63), "a".repeat(65)]) {
      assert.throws(
        () => verifyCommitment(VECTOR, hash),
        (error: unknown) => error instanceof CommitmentEncodingError && error.code === "INVALID_HASH",
      );
    }
    assert.equal(isHex64(EXPECTED_COMMITMENT), true);
    assert.equal(isHex64(EXPECTED_COMMITMENT.toUpperCase()), true);
    assert.equal(isHex64("0x" + EXPECTED_COMMITMENT), false);
  });

  test("amounts and cycle ids enforce unsigned integer ranges", () => {
    assert.throws(
      () => buildCommitmentPreimage({ ...VECTOR, amount: "-1" }),
      (error: unknown) => error instanceof CommitmentEncodingError && error.code === "INVALID_AMOUNT",
    );
    assert.throws(
      () => buildCommitmentPreimage({ ...VECTOR, amount: "1.5" }),
      (error: unknown) => error instanceof CommitmentEncodingError && error.code === "INVALID_AMOUNT",
    );
    assert.throws(
      () => buildCommitmentPreimage({ ...VECTOR, amount: (2n ** 128n).toString() }),
      (error: unknown) => error instanceof CommitmentEncodingError && error.code === "INVALID_AMOUNT",
    );
    assert.throws(
      () => buildCommitmentPreimage({ ...VECTOR, cycleId: 2n ** 64n }),
      (error: unknown) => error instanceof CommitmentEncodingError && error.code === "INVALID_CYCLE_ID",
    );
    assert.throws(
      () => buildCommitmentPreimage({ ...VECTOR, cycleId: Number.MAX_SAFE_INTEGER + 1 }),
      (error: unknown) => error instanceof CommitmentEncodingError && error.code === "INVALID_CYCLE_ID",
    );
    assert.throws(
      () => buildCommitmentPreimage({ ...VECTOR, employer: "" }),
      (error: unknown) => error instanceof CommitmentEncodingError && error.code === "INVALID_STRING",
    );
  });

  test("hex helpers round-trip bytes and reject malformed input", () => {
    const bytes = Uint8Array.of(0x00, 0x0f, 0xff, 0xa5);
    assert.equal(bytesToHex(bytes), "000fffa5");
    assert.deepEqual(hexToBytes("000fffa5"), bytes);
    assert.deepEqual(hexToBytes("000FFFA5"), bytes);
    assert.throws(
      () => hexToBytes("0"),
      (error: unknown) => error instanceof CommitmentEncodingError && error.code === "INVALID_HEX",
    );
    assert.throws(
      () => hexToBytes("0g"),
      (error: unknown) => error instanceof CommitmentEncodingError && error.code === "INVALID_HEX",
    );
  });
});

describe("settlement receipts", () => {
  const VIEW_KEY_FIELD = ["view", "Key", "Id"].join("");


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
});

const NEAR_SECRET = `ed25519:${"A".repeat(43)}`;
const COMMITMENT = "a".repeat(64);

describe("redactObject", () => {
  it("replaces sensitive fields and records what was stripped", () => {
    const { redacted, fieldsRedacted } = redactObject({
      employee: "alice.near",
      amount: 500n,
      salt: "deadbeef",
      asset: "usdc.near",
      commitment_hash: COMMITMENT,
      memo: "june",
    });

    assert.deepEqual(redacted, {
      employee: DEFAULT_REDACTION_REPLACEMENT,
      amount: DEFAULT_REDACTION_REPLACEMENT,
      salt: DEFAULT_REDACTION_REPLACEMENT,
      asset: "usdc.near",
      commitment_hash: COMMITMENT,
      memo: "june",
    });
    assert.deepEqual(fieldsRedacted, ["employee", "amount", "salt"]);
  });

  it("supports mask and remove modes plus custom fields", () => {
    const masked = redactObject({ employee: "alice.near", amount: 123456n }, { mode: "mask" });
    assert.equal(masked.redacted.employee, "al******ar");
    assert.equal(masked.redacted.amount, "12**56");

    const removed = redactObject({ employee: "alice.near", asset: "usdc.near" }, { mode: "remove" });
    assert.deepEqual(removed.redacted, { asset: "usdc.near" });

    const custom = redactObject(
      { asset: "usdc.near", payout_id: 7 },
      { additionalFields: ["payout_id"] }
    );
    assert.equal(custom.redacted.payout_id, DEFAULT_REDACTION_REPLACEMENT);
  });

  it("redacts recursively while preserving public hashes", () => {
    const { redacted, fieldsRedacted } = redactDeep({
      employer: "acme.near",
      batches: [{ employee: "alice.near", amount: 10n, commitment_hash: COMMITMENT }],
      nested: { salt: "ab", depositAddress: "0xsecret" },
    });

    assert.deepEqual(redacted, {
      employer: "acme.near",
      batches: [
        {
          employee: DEFAULT_REDACTION_REPLACEMENT,
          amount: DEFAULT_REDACTION_REPLACEMENT,
          commitment_hash: COMMITMENT,
        },
      ],
      nested: {
        salt: DEFAULT_REDACTION_REPLACEMENT,
        depositAddress: DEFAULT_REDACTION_REPLACEMENT,
      },
    });
    assert.deepEqual(fieldsRedacted, ["employee", "amount", "salt", "depositAddress"]);
  });
});

describe("redactError", () => {
  it("redacts labelled payroll values from the message and stack", () => {
    const original = new Error(
      "payout failed for employee=alice.near amount=123456 salt=deadbeef and retry"
    );
    original.stack = `Error: ${original.message}\n    at submit (payroll.ts:1:1)`;

    const sanitized = redactError(original);

    assert.equal(
      sanitized.message,
      "payout failed for employee=[redacted] amount=[redacted] salt=[redacted] and retry"
    );
    assert.ok(sanitized.stack?.includes("employee=[redacted]"));
    assert.ok(!sanitized.stack?.includes("123456"));
    assert.notEqual(sanitized, original);
    assert.equal(original.message.includes("123456"), true, "original is not mutated");
  });

  it("redacts unlabelled NEAR secret keys and sanitizes context", () => {
    const error = Object.assign(new Error(`signing failed for ${NEAR_SECRET}`), {
      context: { amount: 12n, salt: "ab", note: "keep me" },
    });

    const sanitized = redactError(error);

    assert.equal(sanitized.message, "signing failed for [redacted]");
    const context = Object.fromEntries(Object.entries(sanitized)).context;
    assert.deepEqual(context, {
      amount: DEFAULT_REDACTION_REPLACEMENT,
      salt: DEFAULT_REDACTION_REPLACEMENT,
      note: "keep me",
    });
  });

  it("honours a custom replacement", () => {
    const sanitized = redactError(new Error("amount=99"), { replacement: "***" });
    assert.equal(sanitized.message, "amount=***");
  });

  it("handles overlapping fields and repeated messages without cache leakage", () => {
    const message =
      "auth accessToken=abc token=xyz refreshToken=ref amount=99 tokenSecret=hidden";
    const first = redactError(new Error(message)).message;
    const second = redactError(new Error(message)).message;
    assert.equal(first, second);
    assert.ok(!first.includes("abc"));
    assert.ok(!first.includes("xyz"));
    assert.ok(!first.includes("=ref"));
    assert.ok(!first.includes("99"));
    const custom = redactError(new Error("custom=secret token=xyz"), {
      additionalFields: ["custom"],
    });
    assert.equal(custom.message, "custom=[redacted] token=[redacted]");
  });

  it("publishes the default sensitive field list", () => {
    const fields = getDefaultSensitiveFields();
    for (const field of ["employee", "amount", "salt", "witness", "depositAddress", "privateKey"]) {
      assert.ok(fields.includes(field), field);
    }
  });
});

describe("safe credential handling", () => {
  it("detects NEAR secret keys and plaintext compensation", () => {
    const result = validateSafeCredentialUsage({
      signerKey: NEAR_SECRET,
      payout: { amount: "1000", salt: "ab" },
    });

    assert.equal(result.safe, false);
    assert.ok(result.findings.some((finding) => finding.credentialType === "near_secret_key"));
    assert.ok(result.findings.some((finding) => finding.field === "payout.amount"));
  });

  it("does not flag public commitment hashes or 1Click intent hashes", () => {
    const result = validateSafeCredentialUsage({
      commitment_hash: COMMITMENT,
      intentHash: "5J7bq1Zk8w3wV9n2s4j6h8k0m2p4r6t8v0x2z4b6d8f0",
    });
    assert.equal(result.safe, true, JSON.stringify(result.findings));
  });

  it("throws a privacy-safe error from the assert helper", () => {
    assert.throws(
      () => assertSafeCredentialUsage({ privateKey: NEAR_SECRET }),
      (error: unknown) => {
        assert.ok(error instanceof SafeCredentialHandlingError);
        assert.equal(error.code, "SECRET_KEY_DETECTED");
        assert.ok(!error.message.includes(NEAR_SECRET));
        return true;
      }
    );
  });

  it("masks credentials and redacts persistence payloads", () => {
    assert.equal(maskCredential(NEAR_SECRET), `ed25519:${"*".repeat(39)}AAAA`);
    assert.equal(maskCredential("short"), "[REDACTED]");

    const sanitized = sanitizeForPersistence({
      employee: "alice.near",
      amount: "500",
      salt: "ab",
      commitment_hash: COMMITMENT,
      tokenSecret: NEAR_SECRET,
      note: "public",
    });

    assert.deepEqual(sanitized, {
      employee: "alice.near",
      amount: "[REDACTED_COMPENSATION]",
      salt: "[REDACTED_COMPENSATION]",
      commitment_hash: COMMITMENT,
      tokenSecret: "[REDACTED_SECRET_KEY]",
      note: "public",
    });
  });

  it("accumulates auditor findings and clears them", () => {
    const auditor = new SafeCredentialAuditor();
    auditor.auditPayload({ amount: "1" }, "batch");
    assert.equal(auditor.hasViolations(), false, "warnings alone are not violations");

    auditor.auditPayload({ secretKey: NEAR_SECRET }, "signer");
    assert.equal(auditor.hasViolations(), true);
    assert.throws(() => auditor.assertClean("run"), /credential leakage violation/);

    auditor.clear();
    assert.equal(auditor.getViolations().length, 0);
  });
});

describe("display redaction", () => {
  it("hides amounts unless explicitly revealed and masks identifiers", () => {
    assert.equal(redactAmount(123n), REDACTED_REPLACEMENT);
    assert.equal(redactAmount(123n, true), "123");
    assert.equal(redactIdentifier("alice.near"), "alic…near");
    assert.equal(redactIdentifier("alice.near", true), "alice.near");
    assert.equal(redactIdentifier("tiny"), REDACTED_REPLACEMENT);
  });
});
