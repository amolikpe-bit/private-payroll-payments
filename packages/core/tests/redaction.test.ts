/**
 * Redaction and privacy tests.
 *
 * The error-string assertions are exact snapshots: if a message ever starts
 * leaking an amount, salt, account id, or credential, these fail.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

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
