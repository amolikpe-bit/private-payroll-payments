/**
 * Compliance hold tests: fail-closed parsing, reason mapping, and the payroll
 * blocking gate. A malformed or unknown hold must always block.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ComplianceHoldBlockedError,
  HOLD_SCOPE_PRIORITY,
  activeHoldsFor,
  assertPayrollActionAllowed,
  explainHold,
  getHoldReasonLabel,
  holdReasonFromCode,
  holdReasonToCode,
  isHoldBlocking,
  isPayrollActionBlocked,
  listSupportedHoldReasons,
  parseHoldEntry,
  parseHoldReason,
  parseHoldStatus,
  parseHoldStatusOrNull,
} from "../src/compliance/index.js";
import type { HoldEntry } from "../src/types.js";

function contractHold(overrides: Partial<HoldEntry> = {}): HoldEntry {
  return {
    employer: "acme.near",
    scope: "Employer",
    scope_id: "acme.near",
    reason_code: "KycReviewPending",
    state: "Active",
    placed_by: "auditor.near",
    placed_at: 1_700_000_000,
    released_by: null,
    released_at: null,
    release_reason: null,
    ...overrides,
  };
}

describe("parseHoldStatus", () => {
  it("parses a contract HoldEntry", () => {
    const hold = parseHoldStatus(contractHold(), "hold-1");

    assert.equal(hold.holdId, "hold-1");
    assert.equal(hold.employer, "acme.near");
    assert.equal(hold.scope, "Employer");
    assert.equal(hold.scopeId, "acme.near");
    assert.equal(hold.state, "active");
    assert.equal(hold.reasonCode, "KYC_REVIEW_PENDING");
    assert.equal(hold.placedBy, "auditor.near");
    assert.equal(hold.placedAt, 1_700_000_000);
    assert.equal(hold.valid, true);
    assert.equal(isHoldBlocking(hold), true);
  });

  it("parses a released hold with its release metadata", () => {
    const hold = parseHoldStatus(
      contractHold({
        state: "Released",
        released_by: "owner.near",
        released_at: 1_700_000_100,
        release_reason: "ManualReviewRequested",
      }),
      "hold-2"
    );

    assert.equal(hold.state, "released");
    assert.equal(hold.releasedBy, "owner.near");
    assert.equal(hold.releasedAt, 1_700_000_100);
    assert.equal(hold.releaseReasonCode, "MANUAL_REVIEW_REQUESTED");
    assert.equal(isHoldBlocking(hold), false);
  });

  it("parses camelCase backend payloads", () => {
    const hold = parseHoldStatus({
      holdId: "hold-3",
      employer: "acme.near",
      scope: "Employee",
      scopeId: "alice.near",
      state: "Active",
      reasonCode: "SANCTIONS_SCREENING",
      placedBy: "auditor.near",
      placedAt: 10,
    });

    assert.equal(hold.holdId, "hold-3");
    assert.equal(hold.scope, "Employee");
    assert.equal(hold.scopeId, "alice.near");
    assert.equal(hold.reasonCode, "SANCTIONS_SCREENING");
    assert.equal(hold.valid, true);
  });

  it("fails closed on an unrecognized state", () => {
    for (const state of ["Frozen", "ACTIVE?", "", 42, undefined]) {
      const hold = parseHoldStatus(contractHold({ state: state as HoldEntry["state"] }), "hold-4");
      assert.equal(hold.state, "unknown", String(state));
      assert.equal(hold.valid, false);
      assert.equal(isHoldBlocking(hold), true);
    }
  });

  it("fails closed when scope, scope id, or employer is missing", () => {
    for (const raw of [
      contractHold({ scope: "Global" as unknown as HoldEntry["scope"] }),
      contractHold({ scope_id: "" }),
      contractHold({ employer: "" }),
      {},
      null,
      "not-an-object",
    ]) {
      const hold = parseHoldStatus(raw, "hold-5");
      assert.equal(hold.state, "unknown");
      assert.equal(hold.valid, false);
      assert.equal(isHoldBlocking(hold), true);
    }
  });

  it("normalizes scope spellings and unknown reasons", () => {
    const lower = parseHoldStatus(
      contractHold({ scope: "period" as unknown as HoldEntry["scope"] })
    );
    assert.equal(lower.scope, "Period");

    const unknownReason = parseHoldStatus(
      contractHold({ reason_code: "SomethingElse" as unknown as HoldEntry["reason_code"] })
    );
    assert.equal(unknownReason.reasonCode, "OTHER");
  });

  it("treats a null contract response as a definite no-hold", () => {
    assert.equal(parseHoldStatusOrNull(null), null);
    assert.equal(parseHoldStatusOrNull(undefined), null);
    assert.equal(parseHoldStatusOrNull(contractHold(), "hold-6")?.holdId, "hold-6");
  });

  it("parses a typed HoldEntry with the queried id", () => {
    const parsed = parseHoldEntry("hold-7", contractHold({ scope: "Batch", scope_id: "batch-9" }));
    assert.equal(parsed.holdId, "hold-7");
    assert.equal(parsed.scope, "Batch");
    assert.equal(parsed.scopeId, "batch-9");
  });
});

describe("hold reason mapping", () => {
  it("maps both spellings for all seven reasons", () => {
    const definitions = listSupportedHoldReasons();
    assert.equal(definitions.length, 7);
    for (const definition of definitions) {
      assert.equal(holdReasonToCode(definition.contractReason), definition.code);
      assert.equal(holdReasonFromCode(definition.code), definition.contractReason);
      assert.equal(parseHoldReason(definition.code), definition.code);
      assert.equal(parseHoldReason(definition.contractReason), definition.code);
      assert.equal(getHoldReasonLabel(definition.code), definition.label);
    }
  });

  it("maps unknown reasons to OTHER", () => {
    assert.equal(parseHoldReason("not_a_reason"), "OTHER");
    assert.equal(parseHoldReason(undefined), "OTHER");
    assert.equal(holdReasonToCode("Unknown" as unknown as HoldEntry["reason_code"]), "OTHER");
  });
});

describe("activeHoldsFor and blocking", () => {
  const employerHold = parseHoldStatus(contractHold(), "hold-employer");
  const periodHold = parseHoldStatus(
    contractHold({ scope: "Period", scope_id: "2026-06" }),
    "hold-period"
  );
  const batchHold = parseHoldStatus(
    contractHold({ scope: "Batch", scope_id: "batch-1" }),
    "hold-batch"
  );
  const employeeHold = parseHoldStatus(
    contractHold({ scope: "Employee", scope_id: "alice.near" }),
    "hold-employee"
  );
  const releasedHold = parseHoldStatus(
    contractHold({ state: "Released", scope: "Employee", scope_id: "alice.near" }),
    "hold-released"
  );
  const unknownHold = parseHoldStatus(
    { employer: "acme.near", scope: "Period", scope_id: "2026-06", state: "Mystery" },
    "hold-unknown"
  );
  const otherEmployer = parseHoldStatus(
    contractHold({ employer: "other.near", scope_id: "other.near" }),
    "hold-other"
  );
  const holds = [
    employeeHold,
    batchHold,
    periodHold,
    employerHold,
    releasedHold,
    otherEmployer,
  ];

  it("orders applying holds from broadest to narrowest scope", () => {
    const active = activeHoldsFor(
      { employer: "acme.near", period: "2026-06", batch: "batch-1", employee: "alice.near" },
      holds
    );
    assert.deepEqual(
      active.map((hold) => hold.holdId),
      ["hold-employer", "hold-period", "hold-batch", "hold-employee"]
    );
    assert.deepEqual(HOLD_SCOPE_PRIORITY, ["Employer", "Period", "Batch", "Employee"]);
  });

  it("applies only holds whose scope id matches", () => {
    const scoped = [periodHold, batchHold, employeeHold, releasedHold, otherEmployer];
    assert.deepEqual(activeHoldsFor({ employer: "acme.near", employee: "bob.near" }, scoped), []);
    assert.deepEqual(activeHoldsFor({ employer: "acme.near", period: "2026-07" }, scoped), []);
    assert.deepEqual(activeHoldsFor({ employer: "third.near" }, scoped), []);
    assert.deepEqual(
      activeHoldsFor({ employer: "acme.near", period: "2026-06" }, scoped).map(
        (hold) => hold.holdId
      ),
      ["hold-period"]
    );
  });

  it("treats a released hold as non-blocking", () => {
    const result = isPayrollActionBlocked({ employer: "acme.near", employee: "alice.near" }, [
      releasedHold,
    ]);
    assert.equal(result.blocked, false);
  });

  it("treats unknown holds as blocking regardless of scope", () => {
    assert.equal(isHoldBlocking(unknownHold), true);

    const result = isPayrollActionBlocked({ employer: "acme.near", period: "1999-01" }, [
      unknownHold,
    ]);
    assert.equal(result.blocked, true);
    assert.equal(result.hold?.holdId, "hold-unknown");
    assert.match(result.explanation, /could not be determined/);
  });

  it("blocks with an explanation that never includes free-text notes", () => {
    const result = isPayrollActionBlocked(
      { employer: "acme.near", employee: "alice.near" },
      holds
    );
    assert.equal(result.blocked, true);
    assert.equal(result.hold?.holdId, "hold-employer");
    assert.match(result.explanation, /KYC/);
    assert.ok(!result.explanation.includes("investigation detail"));
  });

  it("throws a typed error from the assert helper", () => {
    assert.throws(
      () => assertPayrollActionAllowed({ employer: "acme.near" }, holds),
      (error: unknown) => {
        assert.ok(error instanceof ComplianceHoldBlockedError);
        assert.equal(error.code, "COMPLIANCE_HOLD_BLOCKED");
        assert.equal(error.hold.holdId, "hold-employer");
        return true;
      }
    );

    assert.doesNotThrow(() =>
      assertPayrollActionAllowed({ employer: "other.near" }, [releasedHold])
    );
  });

  it("explains each hold state without leaking scope ids into reason codes", () => {
    assert.match(explainHold(employerHold), /scope: employer "acme.near"/);
    assert.match(explainHold(releasedHold), /was released/);
  });
});
