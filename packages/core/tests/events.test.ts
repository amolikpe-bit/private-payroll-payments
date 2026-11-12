/**
 * NEP-297 event parser tests: all eight `subrosa` variants, lossless u64
 * decoding, and strict rejection of unknown standards, versions, names, and
 * malformed payloads.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EVENT_JSON_PREFIX,
  EventParseError,
  SUBROSA_EVENT_NAMES,
  SUBROSA_EVENT_WIRE_NAMES,
  isSubrosaEventName,
  parseSubrosaEventLog,
  parseSubrosaEventLogs,
  type ParsedSubrosaEvent,
  type SubrosaEvent,
} from "../src/events/index.js";

const HASH = "a".repeat(64);
const AT_NS = "1712345678901234567";

function eventLog(event: string, data: unknown[]): string {
  return `${EVENT_JSON_PREFIX}${JSON.stringify({
    standard: "subrosa",
    version: "1.0.0",
    event,
    data,
  })}`;
}

function codeOf(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
}

function messageOf(error: unknown): string {
  return error !== null && typeof error === "object" && "message" in error
    ? String(error.message)
    : "";
}

/** Asserts the event name and narrows the payload for field access. */
function expectEvent<E extends SubrosaEvent["event"]>(
  parsed: ParsedSubrosaEvent,
  name: E
): Extract<SubrosaEvent, { event: E }> {
  assert.equal(parsed.event.event, name);
  if (parsed.event.event !== name) {
    throw new Error(`expected ${name}, received ${parsed.event.event}`);
  }
  return parsed.event as Extract<SubrosaEvent, { event: E }>;
}

describe("parseSubrosaEventLog", () => {
  it("parses EmployeeRegistered", () => {
    const parsed = parseSubrosaEventLog(
      eventLog("EmployeeRegistered", [
        {
          employer: "acme.near",
          employee: "alice.near",
          token: "usdc.near",
          commitment_hash: HASH,
          at_ns: AT_NS,
        },
      ]),
      3
    );

    assert.equal(parsed.logIndex, 3);
    assert.equal(parsed.standard, "subrosa");
    assert.equal(parsed.version, "1.0.0");
    const event = expectEvent(parsed, "EmployeeRegistered");
    assert.deepEqual(event.data[0], {
      employer: "acme.near",
      employee: "alice.near",
      token: "usdc.near",
      commitment_hash: HASH,
      at_ns: 1712345678901234567n,
    });
  });

  it("parses EmployeeUpdated", () => {
    const parsed = parseSubrosaEventLog(
      eventLog("EmployeeUpdated", [
        {
          employer: "acme.near",
          employee: "alice.near",
          commitment_hash: HASH,
          active: false,
          at_ns: AT_NS,
        },
      ])
    );
    const event = expectEvent(parsed, "EmployeeUpdated");
    assert.equal(event.data[0].active, false);
    assert.equal(event.data[0].at_ns, 1712345678901234567n);
  });

  it("parses SalaryCommitted", () => {
    const parsed = parseSubrosaEventLog(
      eventLog("SalaryCommitted", [
        {
          employer: "acme.near",
          employee: "alice.near",
          cycle_id: 42,
          commitment_hash: HASH,
          at_ns: AT_NS,
        },
      ])
    );
    const event = expectEvent(parsed, "SalaryCommitted");
    assert.equal(event.data[0].cycle_id, 42n);
    assert.equal(event.data[0].commitment_hash, HASH);
  });

  it("parses AuditorChanged", () => {
    const parsed = parseSubrosaEventLog(
      eventLog("AuditorChanged", [
        { employer: "acme.near", auditor: "auditor.near", granted: true },
      ])
    );
    const event = expectEvent(parsed, "AuditorChanged");
    assert.equal(event.data[0].auditor, "auditor.near");
    assert.equal(event.data[0].granted, true);
  });

  it("parses PayoutScheduled", () => {
    const parsed = parseSubrosaEventLog(
      eventLog("PayoutScheduled", [
        { employer: "acme.near", payout_id: 7, asset: "usdc.near", execute_at_ns: AT_NS },
      ])
    );
    const event = expectEvent(parsed, "PayoutScheduled");
    assert.equal(event.data[0].payout_id, 7n);
    assert.equal(event.data[0].asset, "usdc.near");
    assert.equal(event.data[0].execute_at_ns, 1712345678901234567n);
  });

  it("parses PayoutStateChanged with null and non-null intent hashes", () => {
    const settled = parseSubrosaEventLog(
      eventLog("PayoutStateChanged", [
        { employer: "acme.near", payout_id: 7, state: "Executed", intent_hash: "5J7bq1" },
      ])
    );
    const settledEvent = expectEvent(settled, "PayoutStateChanged");
    assert.equal(settledEvent.data[0].state, "Executed");
    assert.equal(settledEvent.data[0].intent_hash, "5J7bq1");

    const pending = parseSubrosaEventLog(
      eventLog("PayoutStateChanged", [
        { employer: "acme.near", payout_id: 8, state: "Pending", intent_hash: null },
      ])
    );
    assert.equal(expectEvent(pending, "PayoutStateChanged").data[0].intent_hash, null);
  });

  it("parses AuditHoldChanged", () => {
    const parsed = parseSubrosaEventLog(
      eventLog("AuditHoldChanged", [
        {
          hold_id: "hold-1",
          employer: "acme.near",
          scope: "Employee",
          state: "Active",
          by: "auditor.near",
        },
      ])
    );
    const event = expectEvent(parsed, "AuditHoldChanged");
    assert.equal(event.data[0].hold_id, "hold-1");
    assert.equal(event.data[0].scope, "Employee");
    assert.equal(event.data[0].state, "Active");
  });

  it("parses ProofVerified", () => {
    const parsed = parseSubrosaEventLog(
      eventLog("ProofVerified", [{ vk_id: 3, nullifier: HASH }])
    );
    const event = expectEvent(parsed, "ProofVerified");
    assert.equal(event.data[0].vk_id, 3);
    assert.equal(event.data[0].nullifier, HASH);
  });

  it("decodes raw large u64 values without precision loss", () => {
    const rawTimestamp = `${EVENT_JSON_PREFIX}{"standard":"subrosa","version":"1.0.0","event":"SalaryCommitted","data":[{"employer":"acme.near","employee":"alice.near","cycle_id":9007199254740993,"commitment_hash":"${HASH}","at_ns":1712345678901234567}]}`;
    const committed = parseSubrosaEventLog(rawTimestamp);
    const event = expectEvent(committed, "SalaryCommitted");
    assert.equal(event.data[0].cycle_id, 9007199254740993n);
    assert.equal(event.data[0].at_ns, 1712345678901234567n);
  });

  it("merges multiple payload entries in one event", () => {
    const parsed = parseSubrosaEventLog(
      eventLog("AuditorChanged", [
        { employer: "acme.near", auditor: "auditor1.near", granted: true },
        { employer: "acme.near", auditor: "auditor2.near", granted: false },
      ])
    );
    const event = expectEvent(parsed, "AuditorChanged");
    assert.equal(event.data.length, 2);
    assert.equal(event.data[1].auditor, "auditor2.near");
  });
});

describe("strict rejection", () => {
  it("rejects non-event log lines", () => {
    assert.throws(
      () => parseSubrosaEventLog("hello"),
      (error: unknown) => codeOf(error) === "NOT_AN_EVENT"
    );
  });

  it("rejects unknown standards and versions", () => {
    assert.throws(
      () =>
        parseSubrosaEventLog(
          `${EVENT_JSON_PREFIX}${JSON.stringify({
            standard: "nep141",
            version: "1.0.0",
            event: "FtTransfer",
            data: [{}],
          })}`
        ),
      (error: unknown) => codeOf(error) === "UNKNOWN_STANDARD"
    );

    assert.throws(
      () =>
        parseSubrosaEventLog(
          `${EVENT_JSON_PREFIX}${JSON.stringify({
            standard: "subrosa",
            version: "1.0.1",
            event: "ProofVerified",
            data: [{ vk_id: 1, nullifier: HASH }],
          })}`
        ),
      (error: unknown) => codeOf(error) === "UNSUPPORTED_VERSION"
    );
  });

  it("rejects unknown event names", () => {
    assert.throws(
      () => parseSubrosaEventLog(eventLog("SalaryRevealed", [])),
      (error: unknown) => codeOf(error) === "UNKNOWN_EVENT"
    );
  });

  it("rejects malformed JSON envelopes", () => {
    assert.throws(
      () => parseSubrosaEventLog(`${EVENT_JSON_PREFIX}{not json`),
      (error: unknown) => codeOf(error) === "MALFORMED_ENVELOPE"
    );
    assert.throws(
      () => parseSubrosaEventLog(`${EVENT_JSON_PREFIX}[]`),
      (error: unknown) => codeOf(error) === "MALFORMED_ENVELOPE"
    );
    assert.throws(
      () => parseSubrosaEventLog(`${EVENT_JSON_PREFIX}{"version":"1.0.0"}`),
      (error: unknown) => codeOf(error) === "MALFORMED_ENVELOPE"
    );
  });

  it("rejects missing and unexpected payload fields", () => {
    assert.throws(
      () =>
        parseSubrosaEventLog(
          eventLog("EmployeeRegistered", [
            { employer: "acme.near", employee: "alice.near", commitment_hash: HASH, at_ns: AT_NS },
          ])
        ),
      (error: unknown) => {
        assert.equal(codeOf(error), "INVALID_PAYLOAD");
        assert.match(messageOf(error), /token/);
        return true;
      }
    );

    assert.throws(
      () =>
        parseSubrosaEventLog(
          eventLog("AuditorChanged", [
            { employer: "acme.near", auditor: "auditor.near", granted: true, extra: 1 },
          ])
        ),
      (error: unknown) => {
        assert.equal(codeOf(error), "INVALID_PAYLOAD");
        assert.match(messageOf(error), /extra/);
        return true;
      }
    );
  });

  it("rejects invalid account ids, hashes, and enums", () => {
    const cases: Array<[string, unknown[]]> = [
      [
        "EmployeeRegistered",
        [
          {
            employer: "Acme.near",
            employee: "alice.near",
            token: "usdc.near",
            commitment_hash: HASH,
            at_ns: AT_NS,
          },
        ],
      ],
      [
        "SalaryCommitted",
        [
          {
            employer: "acme.near",
            employee: "alice.near",
            cycle_id: 1,
            commitment_hash: "not-hex",
            at_ns: AT_NS,
          },
        ],
      ],
      [
        "PayoutStateChanged",
        [{ employer: "acme.near", payout_id: 1, state: "Frozen", intent_hash: null }],
      ],
      [
        "AuditHoldChanged",
        [
          {
            hold_id: "hold-1",
            employer: "acme.near",
            scope: "Global",
            state: "Active",
            by: "auditor.near",
          },
        ],
      ],
    ];

    for (const [event, data] of cases) {
      assert.throws(
        () => parseSubrosaEventLog(eventLog(event, data)),
        (error: unknown) => codeOf(error) === "INVALID_PAYLOAD",
        event
      );
    }
  });

  it("rejects a non-array data field and an empty object payload", () => {
    assert.throws(
      () =>
        parseSubrosaEventLog(
          `${EVENT_JSON_PREFIX}{"standard":"subrosa","version":"1.0.0","event":"AuditorChanged","data":{}}`
        ),
      (error: unknown) => codeOf(error) === "INVALID_PAYLOAD"
    );

    assert.throws(
      () => parseSubrosaEventLog(eventLog("AuditorChanged", [{}])),
      (error: unknown) => codeOf(error) === "INVALID_PAYLOAD"
    );
  });
});

describe("parseSubrosaEventLogs", () => {
  it("collects events, ignores debug logs, and reports event errors by index", () => {
    const logs = [
      "debug: entering method",
      eventLog("AuditorChanged", [
        { employer: "acme.near", auditor: "auditor.near", granted: true },
      ]),
      `${EVENT_JSON_PREFIX}{broken`,
      eventLog("ProofVerified", [{ vk_id: 1, nullifier: HASH }]),
    ];

    const { events, errors } = parseSubrosaEventLogs(logs);
    assert.equal(events.length, 2);
    assert.equal(events[0].logIndex, 1);
    assert.equal(events[1].logIndex, 3);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "MALFORMED_ENVELOPE");
    assert.equal(errors[0].context.logIndex, 2);
  });

  it("exposes every event name and a type guard", () => {
    assert.equal(SUBROSA_EVENT_NAMES.length, 8);
    for (const name of SUBROSA_EVENT_NAMES) {
      assert.equal(isSubrosaEventName(name), true, name);
    }
    assert.equal(isSubrosaEventName("SalaryRevealed"), false);
    assert.equal(isSubrosaEventName(undefined), false);
  });

  it("uses EventParseError for every failure mode", () => {
    assert.throws(
      () => parseSubrosaEventLog("plain"),
      (error: unknown) => error instanceof EventParseError && error.code === "NOT_AN_EVENT"
    );
  });

  it("parses the snake_case names emitted by near-sdk", () => {
    for (const wire of SUBROSA_EVENT_WIRE_NAMES) {
      assert.equal(isSubrosaEventName(wire), true, wire);
    }
    const parsed = parseSubrosaEventLog(
      eventLog("employee_registered", [
        {
          employer: "acme.near",
          employee: "alice.near",
          token: "usdc.near",
          commitment_hash: HASH,
          at_ns: AT_NS,
        },
      ]),
      0,
    );
    assert.equal(parsed.event.event, "EmployeeRegistered");
  });
});
