// Consolidated destination gate and compliance-hold gate suite.
import assert from "node:assert/strict";
import { describe, it, test } from "node:test";

import {
  DestinationValidationError,
  assertNearAccountId,
  getRegisteredDestinationValidationHook,
  resetDestinationValidationHook,
  setDestinationValidationHook,
  validateNearAccountId,
  validateNearDestination,
  type DestinationValidationHook,
} from "../src/settlement/destination.js";
import { ValidationError } from "../src/core/errors.js";
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

describe("destination gate", () => {
  const VALID_ACCOUNTS = [
    "aa",
    "a1",
    "alice.near",
    "subrosa.testnet",
    "a-b",
    "a_b",
    "a.b",
    "a-b_c.d",
    "wrap.testnet",
    "0123456789abcdef".repeat(4), // 64-char implicit account
  ];

  const INVALID_ACCOUNTS: Array<{ value: unknown; code: string }> = [
    { value: undefined, code: "DESTINATION_TYPE" },
    { value: 42, code: "DESTINATION_TYPE" },
    { value: {}, code: "DESTINATION_TYPE" },
    { value: "", code: "DESTINATION_EMPTY" },
    { value: "a", code: "DESTINATION_LENGTH" },
    { value: "a".repeat(65), code: "DESTINATION_LENGTH" },
    { value: "Alice", code: "DESTINATION_UPPERCASE" },
    { value: "alice.NEAR", code: "DESTINATION_UPPERCASE" },
    { value: "alice near", code: "DESTINATION_CHARSET" },
    { value: "alice!", code: "DESTINATION_CHARSET" },
    { value: "alice/team", code: "DESTINATION_CHARSET" },
    { value: ".alice", code: "DESTINATION_SEPARATOR" },
    { value: "alice.", code: "DESTINATION_SEPARATOR" },
    { value: "-alice", code: "DESTINATION_SEPARATOR" },
    { value: "alice_", code: "DESTINATION_SEPARATOR" },
    { value: "alice..bob", code: "DESTINATION_SEPARATOR" },
    { value: "alice--bob", code: "DESTINATION_SEPARATOR" },
    { value: "alice__bob", code: "DESTINATION_SEPARATOR" },
    { value: "alice.-bob", code: "DESTINATION_SEPARATOR" },
    { value: "alice_.bob", code: "DESTINATION_SEPARATOR" },
  ];

  test("validateNearAccountId accepts NEAR account-id shapes", () => {
    for (const account of VALID_ACCOUNTS) {
      assert.deepEqual(validateNearAccountId(account), {
        ok: true,
        destination: account,
        kind: "near_account",
      });
    }
  });

  test("validateNearAccountId rejects invalid shapes with stable codes", () => {
    for (const { value, code } of INVALID_ACCOUNTS) {
      const result = validateNearAccountId(value);
      assert.equal(result.ok, false, `expected rejection for ${String(value)}`);
      if (result.ok) continue;
      assert.equal(result.code, code, `unexpected code for ${String(value)}`);
      if (typeof value === "string" && value.length > 2) {
        assert.ok(
          !result.message.includes(value),
          "rejection message must not echo the rejected destination",
        );
      }
    }
  });

  test("there is no legacy address-format exemption", () => {
    // 56-character legacy-style key: valid length, but uppercase is rejected.
    const result = validateNearAccountId(`G${"A".repeat(55)}`);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "DESTINATION_UPPERCASE");
    }
  });

  test("assertNearAccountId throws a ValidationError with the stable code", () => {
    assert.equal(assertNearAccountId("alice.near", "employee"), "alice.near");
    assert.throws(
      () => assertNearAccountId("Alice", "employee"),
      (error: unknown) =>
        error instanceof ValidationError &&
        error.field === "employee" &&
        error.code === "DESTINATION_UPPERCASE",
    );
  });

  test("validateNearDestination passes without a hook and is async", async () => {
    const result = await validateNearDestination("alice.near");
    assert.deepEqual(result, {
      ok: true,
      destination: "alice.near",
      kind: "near_account",
      state: "validated",
    });
  });

  test("validateNearDestination rejects built-in failures before invoking the hook", async () => {
    let called = 0;
    const hook: DestinationValidationHook = () => {
      called += 1;
      return { ok: true };
    };
    const result = await validateNearDestination("Alice", { hook });
    assert.equal(called, 0);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.state, "rejected");
      assert.equal(result.code, "DESTINATION_UPPERCASE");
    }
  });

  test("a hook can add policy and its kind is preserved", async () => {
    const result = await validateNearDestination("alice.near", {
      hook: () => ({ ok: true, kind: "internal_employee" }),
    });
    assert.deepEqual(result, {
      ok: true,
      destination: "alice.near",
      kind: "internal_employee",
      state: "validated",
    });
  });

  test("a rejecting hook returns its code, message, and retryable flag", async () => {
    const result = await validateNearDestination("alice.near", {
      hook: () => ({
        ok: false,
        code: "DESTINATION_NOT_ALLOWLISTED",
        message: "Destination is not on the employer allowlist.",
        retryable: false,
      }),
    });
    assert.deepEqual(result, {
      ok: false,
      code: "DESTINATION_NOT_ALLOWLISTED",
      message: "Destination is not on the employer allowlist.",
      state: "rejected",
      retryable: false,
    });
  });

  test("a throwing hook fails closed as unavailable", async () => {
    const result = await validateNearDestination("alice.near", {
      hook: () => {
        throw new Error("allowlist backend down");
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.state, "unavailable");
      assert.equal(result.code, "DESTINATION_VALIDATION_UNAVAILABLE");
      assert.ok(!result.message.includes("allowlist backend down"));
    }
  });

  test("undefined or malformed hook results fail closed", async () => {
    const undefinedHook = (() => undefined) as unknown as DestinationValidationHook;
    const nullHook = (() => null) as unknown as DestinationValidationHook;
    const malformed = (() => ({ allowed: true })) as unknown as DestinationValidationHook;
    const wrongOk = (() => ({ ok: "yes" })) as unknown as DestinationValidationHook;

    for (const hook of [undefinedHook, nullHook, malformed, wrongOk]) {
      const result = await validateNearDestination("alice.near", { hook });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.state, "unavailable");
      }
    }
  });

  test("a throwing resolveHook fails closed", async () => {
    const result = await validateNearDestination("alice.near", {
      resolveHook: () => {
        throw new Error("resolver error");
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.state, "unavailable");
  });

  test("process-wide hook registration is used, overridable per call, and resettable", async () => {
    const globalHook: DestinationValidationHook = () => ({
      ok: false,
      code: "DESTINATION_GLOBAL_BLOCK",
      message: "Blocked by global policy.",
    });
    setDestinationValidationHook(globalHook);
    try {
      assert.equal(getRegisteredDestinationValidationHook(), globalHook);
      const blocked = await validateNearDestination("alice.near");
      assert.equal(blocked.ok, false);
      if (!blocked.ok) assert.equal(blocked.code, "DESTINATION_GLOBAL_BLOCK");

      const perCall = await validateNearDestination("alice.near", { hook: () => ({ ok: true }) });
      assert.equal(perCall.ok, true);

      const disabled = await validateNearDestination("alice.near", { hook: null });
      assert.equal(disabled.ok, true);
    } finally {
      resetDestinationValidationHook();
    }
    assert.equal(getRegisteredDestinationValidationHook(), undefined);
  });

  test("null clears the process-wide hook", () => {
    setDestinationValidationHook(() => ({ ok: true }));
    setDestinationValidationHook(null);
    assert.equal(getRegisteredDestinationValidationHook(), undefined);
  });

  test("DestinationValidationError.fromResult preserves code/state/retryable", () => {
    const error = DestinationValidationError.fromResult({
      ok: false,
      code: "DESTINATION_REJECTED",
      message: "Rejected.",
      state: "rejected",
      retryable: true,
    });
    assert.ok(error instanceof DestinationValidationError);
    assert.equal(error.code, "DESTINATION_REJECTED");
    assert.equal(error.state, "rejected");
    assert.equal(error.retryable, true);
  });
});

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
