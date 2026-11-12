import { test } from "node:test";
import assert from "node:assert/strict";
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
