/**
 * NEP-297 `EVENT_JSON:` parser for the `subrosa` contract events.
 *
 * Envelope: `EVENT_JSON:{"standard":"subrosa","version":"1.0.0","event":"…","data":[…]}`.
 * Every variant is versioned `1.0.0` on-chain and its `data` is an array of
 * payload structs (all times in nanoseconds, amounts as integers).
 *
 * Strictness is deliberate: unknown standards, versions, event names, missing
 * fields, and extra fields are reported as typed errors. An indexer must never
 * silently drop an event it does not understand.
 *
 * u64 values are parsed losslessly. `serde` emits them as JSON numbers, which
 * would lose precision in `JSON.parse` (nanosecond timestamps exceed
 * `Number.MAX_SAFE_INTEGER`), so integer literals outside strings are quoted
 * before parsing and returned as `bigint`.
 */

import { SubrosaError } from "../core/errors.js";
import { validateNearAccountId } from "../settlement/destination.js";
import type { HoldScope, HoldState, PayoutState } from "../types.js";
import { isHex64 } from "../crypto/hashUtils.js";

/** Event standard emitted by the contract. */
export const SUBROSA_EVENT_STANDARD = "subrosa";

/** Version every `subrosa` variant is emitted with. */
export const SUBROSA_EVENT_VERSION = "1.0.0";

/** Log prefix required by NEP-297. */
export const EVENT_JSON_PREFIX = "EVENT_JSON:";

/** The eight event names emitted by the contract. */
export const SUBROSA_EVENT_NAMES = [
  "EmployeeRegistered",
  "EmployeeUpdated",
  "SalaryCommitted",
  "AuditorChanged",
  "PayoutScheduled",
  "PayoutStateChanged",
  "AuditHoldChanged",
  "ProofVerified",
] as const;

/** Wire names emitted by near-sdk's event macro (snake_case). */
export const SUBROSA_EVENT_WIRE_NAMES = [
  "employee_registered",
  "employee_updated",
  "salary_committed",
  "auditor_changed",
  "payout_scheduled",
  "payout_state_changed",
  "audit_hold_changed",
  "proof_verified",
] as const;

export type SubrosaEventWireName = (typeof SUBROSA_EVENT_WIRE_NAMES)[number];

function canonicalEventName(value: unknown): SubrosaEventName | undefined {
  if (typeof value !== "string") return undefined;
  if (SUBROSA_EVENT_NAMES.includes(value as SubrosaEventName)) {
    return value as SubrosaEventName;
  }
  const index = SUBROSA_EVENT_WIRE_NAMES.indexOf(value as SubrosaEventWireName);
  return index >= 0 ? SUBROSA_EVENT_NAMES[index] : undefined;
}

export type SubrosaEventName = (typeof SUBROSA_EVENT_NAMES)[number];

/** `EmployeeRegistered(Vec<EmployeeRegisteredData>)`. */
export interface EmployeeRegisteredData {
  employer: string;
  employee: string;
  token: string;
  commitment_hash: string;
  at_ns: bigint;
}

/** `EmployeeUpdated(Vec<EmployeeUpdatedData>)`. */
export interface EmployeeUpdatedData {
  employer: string;
  employee: string;
  commitment_hash: string;
  active: boolean;
  at_ns: bigint;
}

/** `SalaryCommitted(Vec<SalaryCommittedData>)`. */
export interface SalaryCommittedData {
  employer: string;
  employee: string;
  cycle_id: bigint;
  commitment_hash: string;
  at_ns: bigint;
}

/** `AuditorChanged(Vec<AuditorChangedData>)`. */
export interface AuditorChangedData {
  employer: string;
  auditor: string;
  granted: boolean;
}

/** `PayoutScheduled(Vec<PayoutScheduledData>)`. */
export interface PayoutScheduledData {
  employer: string;
  payout_id: bigint;
  asset: string;
  execute_at_ns: bigint;
}

/** `PayoutStateChanged(Vec<PayoutStateChangedData>)`. */
export interface PayoutStateChangedData {
  employer: string;
  payout_id: bigint;
  state: PayoutState;
  intent_hash: string | null;
}

/** `AuditHoldChanged(Vec<AuditHoldChangedData>)`. */
export interface AuditHoldChangedData {
  hold_id: string;
  employer: string;
  scope: HoldScope;
  state: HoldState;
  by: string;
}

/** `ProofVerified(Vec<ProofVerifiedData>)`. */
export interface ProofVerifiedData {
  vk_id: number;
  nullifier: string;
}

/** A decoded `subrosa` event with its payload typed per variant. */
export type SubrosaEvent =
  | { event: "EmployeeRegistered"; data: EmployeeRegisteredData[] }
  | { event: "EmployeeUpdated"; data: EmployeeUpdatedData[] }
  | { event: "SalaryCommitted"; data: SalaryCommittedData[] }
  | { event: "AuditorChanged"; data: AuditorChangedData[] }
  | { event: "PayoutScheduled"; data: PayoutScheduledData[] }
  | { event: "PayoutStateChanged"; data: PayoutStateChangedData[] }
  | { event: "AuditHoldChanged"; data: AuditHoldChangedData[] }
  | { event: "ProofVerified"; data: ProofVerifiedData[] };

/** A decoded event together with its position in the receipt log. */
export interface ParsedSubrosaEvent {
  logIndex: number;
  standard: typeof SUBROSA_EVENT_STANDARD;
  version: typeof SUBROSA_EVENT_VERSION;
  event: SubrosaEvent;
}

/** Stable parser error codes. */
export type EventParseErrorCode =
  | "NOT_AN_EVENT"
  | "MALFORMED_ENVELOPE"
  | "UNKNOWN_STANDARD"
  | "UNSUPPORTED_VERSION"
  | "UNKNOWN_EVENT"
  | "INVALID_PAYLOAD";

/** Thrown when an `EVENT_JSON:` line cannot be decoded as a `subrosa` event. */
export class EventParseError extends SubrosaError {
  constructor(
    code: EventParseErrorCode,
    message: string,
    details: { logIndex?: number; event?: string; field?: string } = {}
  ) {
    super(message, code, details);
    this.name = "EventParseError";
  }
}

/** Result of parsing a log collection. */
export interface SubrosaEventParseResult {
  events: ParsedSubrosaEvent[];
  errors: EventParseError[];
}

const PAYOUT_STATES: readonly PayoutState[] = [
  "Pending",
  "Executed",
  "Cancelled",
  "Expired",
  "Failed",
];
const HOLD_SCOPES: readonly HoldScope[] = ["Employer", "Period", "Batch", "Employee"];
const HOLD_STATES: readonly HoldState[] = ["Active", "Released"];

/**
 * Quotes every integer literal outside JSON strings so large u64 values keep
 * full precision through `JSON.parse`.
 */
function quoteIntegerLiterals(json: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < json.length; index++) {
    const char = json[index];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === "-" || (char >= "0" && char <= "9")) {
      let digitStart = index;
      if (char === "-") digitStart += 1;
      let digitEnd = digitStart;
      while (digitEnd < json.length && json[digitEnd] >= "0" && json[digitEnd] <= "9") {
        digitEnd += 1;
      }
      const isInteger = digitEnd > digitStart && !/[.eE]/.test(json[digitEnd] ?? "");
      if (isInteger) {
        output += `"${json.slice(index, digitEnd)}"`;
        index = digitEnd - 1;
        continue;
      }
      output += json.slice(index, digitEnd);
      index = digitEnd - 1;
      continue;
    }

    output += char;
  }

  return output;
}

function requireRecord(value: unknown, field: string, eventName: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EventParseError(
      "INVALID_PAYLOAD",
      `${eventName}.${field} must be an object.`,
      { event: eventName, field }
    );
  }
  return value as Record<string, unknown>;
}

function requireAccountId(record: Record<string, unknown>, field: string, eventName: string): string {
  const value = record[field];
  const check = validateNearAccountId(value);
  if (!check.ok) {
    throw new EventParseError(
      "INVALID_PAYLOAD",
      `${eventName}.${field} is not a valid NEAR account id (${check.code}).`,
      { event: eventName, field }
    );
  }
  return check.destination;
}

function requireHash(record: Record<string, unknown>, field: string, eventName: string): string {
  const value = record[field];
  if (typeof value !== "string" || !isHex64(value)) {
    throw new EventParseError(
      "INVALID_PAYLOAD",
      `${eventName}.${field} must be a 64-character hex string.`,
      { event: eventName, field }
    );
  }
  return value;
}

function requireU64(record: Record<string, unknown>, field: string, eventName: string): bigint {
  const value = record[field];
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) {
    throw new EventParseError(
      "INVALID_PAYLOAD",
      `${eventName}.${field} must be an integer.`,
      { event: eventName, field }
    );
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new EventParseError(
      "INVALID_PAYLOAD",
      `${eventName}.${field} must be an integer.`,
      { event: eventName, field }
    );
  }
  if (parsed < 0n || parsed > (1n << 64n) - 1n) {
    throw new EventParseError(
      "INVALID_PAYLOAD",
      `${eventName}.${field} is outside the u64 range.`,
      { event: eventName, field }
    );
  }
  return parsed;
}

function requireU32(record: Record<string, unknown>, field: string, eventName: string): number {
  const value = record[field];
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new EventParseError(
      "INVALID_PAYLOAD",
      `${eventName}.${field} must be an integer.`,
      { event: eventName, field }
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
    throw new EventParseError(
      "INVALID_PAYLOAD",
      `${eventName}.${field} is outside the u32 range.`,
      { event: eventName, field }
    );
  }
  return parsed;
}

function requireBoolean(record: Record<string, unknown>, field: string, eventName: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    throw new EventParseError(
      "INVALID_PAYLOAD",
      `${eventName}.${field} must be a boolean.`,
      { event: eventName, field }
    );
  }
  return value;
}

function requireString(record: Record<string, unknown>, field: string, eventName: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new EventParseError(
      "INVALID_PAYLOAD",
      `${eventName}.${field} must be a non-empty string.`,
      { event: eventName, field }
    );
  }
  return value;
}

function requireEnum<T extends string>(
  record: Record<string, unknown>,
  field: string,
  eventName: string,
  allowed: readonly T[]
): T {
  const value = record[field];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new EventParseError(
      "INVALID_PAYLOAD",
      `${eventName}.${field} must be one of: ${allowed.join(", ")}.`,
      { event: eventName, field }
    );
  }
  return value as T;
}

function requireNullableString(
  record: Record<string, unknown>,
  field: string,
  eventName: string
): string | null {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new EventParseError(
      "INVALID_PAYLOAD",
      `${eventName}.${field} must be a non-empty string or null.`,
      { event: eventName, field }
    );
  }
  return value;
}

/** Rejects payloads whose field set differs from the 1.0.0 schema. */
function assertExactFields(
  record: Record<string, unknown>,
  expected: readonly string[],
  eventName: string
): void {
  const expectedSet = new Set(expected);
  for (const field of Object.keys(record)) {
    if (!expectedSet.has(field)) {
      throw new EventParseError(
        "INVALID_PAYLOAD",
        `${eventName} has an unexpected field "${field}".`,
        { event: eventName, field }
      );
    }
  }
  for (const field of expected) {
    if (!(field in record)) {
      throw new EventParseError(
        "INVALID_PAYLOAD",
        `${eventName} is missing required field "${field}".`,
        { event: eventName, field }
      );
    }
  }
}

const PAYLOAD_FIELDS: Record<SubrosaEventName, readonly string[]> = {
  EmployeeRegistered: ["employer", "employee", "token", "commitment_hash", "at_ns"],
  EmployeeUpdated: ["employer", "employee", "commitment_hash", "active", "at_ns"],
  SalaryCommitted: ["employer", "employee", "cycle_id", "commitment_hash", "at_ns"],
  AuditorChanged: ["employer", "auditor", "granted"],
  PayoutScheduled: ["employer", "payout_id", "asset", "execute_at_ns"],
  PayoutStateChanged: ["employer", "payout_id", "state", "intent_hash"],
  AuditHoldChanged: ["hold_id", "employer", "scope", "state", "by"],
  ProofVerified: ["vk_id", "nullifier"],
};

function parsePayload(eventName: SubrosaEventName, raw: unknown, index: number): SubrosaEvent {
  const record = requireRecord(raw, `data[${index}]`, eventName);
  assertExactFields(record, PAYLOAD_FIELDS[eventName], eventName);

  switch (eventName) {
    case "EmployeeRegistered":
      return {
        event: eventName,
        data: [
          {
            employer: requireAccountId(record, "employer", eventName),
            employee: requireAccountId(record, "employee", eventName),
            token: requireAccountId(record, "token", eventName),
            commitment_hash: requireHash(record, "commitment_hash", eventName),
            at_ns: requireU64(record, "at_ns", eventName),
          },
        ],
      };
    case "EmployeeUpdated":
      return {
        event: eventName,
        data: [
          {
            employer: requireAccountId(record, "employer", eventName),
            employee: requireAccountId(record, "employee", eventName),
            commitment_hash: requireHash(record, "commitment_hash", eventName),
            active: requireBoolean(record, "active", eventName),
            at_ns: requireU64(record, "at_ns", eventName),
          },
        ],
      };
    case "SalaryCommitted":
      return {
        event: eventName,
        data: [
          {
            employer: requireAccountId(record, "employer", eventName),
            employee: requireAccountId(record, "employee", eventName),
            cycle_id: requireU64(record, "cycle_id", eventName),
            commitment_hash: requireHash(record, "commitment_hash", eventName),
            at_ns: requireU64(record, "at_ns", eventName),
          },
        ],
      };
    case "AuditorChanged":
      return {
        event: eventName,
        data: [
          {
            employer: requireAccountId(record, "employer", eventName),
            auditor: requireAccountId(record, "auditor", eventName),
            granted: requireBoolean(record, "granted", eventName),
          },
        ],
      };
    case "PayoutScheduled":
      return {
        event: eventName,
        data: [
          {
            employer: requireAccountId(record, "employer", eventName),
            payout_id: requireU64(record, "payout_id", eventName),
            asset: requireAccountId(record, "asset", eventName),
            execute_at_ns: requireU64(record, "execute_at_ns", eventName),
          },
        ],
      };
    case "PayoutStateChanged":
      return {
        event: eventName,
        data: [
          {
            employer: requireAccountId(record, "employer", eventName),
            payout_id: requireU64(record, "payout_id", eventName),
            state: requireEnum(record, "state", eventName, PAYOUT_STATES),
            intent_hash: requireNullableString(record, "intent_hash", eventName),
          },
        ],
      };
    case "AuditHoldChanged":
      return {
        event: eventName,
        data: [
          {
            hold_id: requireString(record, "hold_id", eventName),
            employer: requireAccountId(record, "employer", eventName),
            scope: requireEnum(record, "scope", eventName, HOLD_SCOPES),
            state: requireEnum(record, "state", eventName, HOLD_STATES),
            by: requireAccountId(record, "by", eventName),
          },
        ],
      };
    case "ProofVerified":
      return {
        event: eventName,
        data: [
          {
            vk_id: requireU32(record, "vk_id", eventName),
            nullifier: requireHash(record, "nullifier", eventName),
          },
        ],
      };
  }
}

/**
 * Parses one NEP-297 `EVENT_JSON:` log line.
 *
 * @param log - Raw log line.
 * @param logIndex - Position in the receipt logs, copied into the result.
 * @throws {EventParseError} for every non-`EVENT_JSON:` line and every
 *   malformed, unknown-standard, unsupported-version, unknown-event, or
 *   invalid-payload line. Nothing is silently dropped.
 */
export function parseSubrosaEventLog(log: string, logIndex = 0): ParsedSubrosaEvent {
  if (typeof log !== "string" || !log.startsWith(EVENT_JSON_PREFIX)) {
    throw new EventParseError(
      "NOT_AN_EVENT",
      "Log line is not an EVENT_JSON event.",
      { logIndex }
    );
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(quoteIntegerLiterals(log.slice(EVENT_JSON_PREFIX.length).trim()));
  } catch {
    throw new EventParseError("MALFORMED_ENVELOPE", "EVENT_JSON payload is not valid JSON.", {
      logIndex,
    });
  }

  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new EventParseError("MALFORMED_ENVELOPE", "EVENT_JSON payload must be an object.", {
      logIndex,
    });
  }

  const record = envelope as Record<string, unknown>;
  const standard = record.standard;
  if (typeof standard !== "string") {
    throw new EventParseError("MALFORMED_ENVELOPE", "EVENT_JSON payload is missing `standard`.", {
      logIndex,
    });
  }
  if (standard !== SUBROSA_EVENT_STANDARD) {
    throw new EventParseError(
      "UNKNOWN_STANDARD",
      `Unsupported event standard "${standard}"; expected "${SUBROSA_EVENT_STANDARD}".`,
      { logIndex }
    );
  }

  const version = record.version;
  if (typeof version !== "string") {
    throw new EventParseError("MALFORMED_ENVELOPE", "EVENT_JSON payload is missing `version`.", {
      logIndex,
    });
  }
  if (version !== SUBROSA_EVENT_VERSION) {
    throw new EventParseError(
      "UNSUPPORTED_VERSION",
      `Unsupported event version "${version}"; expected "${SUBROSA_EVENT_VERSION}".`,
      { logIndex }
    );
  }

  const wireName = record.event;
  const eventName = canonicalEventName(wireName);
  if (eventName === undefined) {
    throw new EventParseError(
      "UNKNOWN_EVENT",
      `Unknown subrosa event "${String(wireName)}".`,
      { logIndex, event: typeof wireName === "string" ? wireName : undefined }
    );
  }

  const data = record.data;
  if (!Array.isArray(data)) {
    throw new EventParseError("INVALID_PAYLOAD", `${eventName}.data must be an array.`, {
      logIndex,
      event: eventName,
    });
  }

  const mergedData: unknown[] = [];
  data.forEach((item, index) => {
    mergedData.push(...parsePayload(eventName as SubrosaEventName, item, index).data);
  });

  return {
    logIndex,
    standard: SUBROSA_EVENT_STANDARD,
    version: SUBROSA_EVENT_VERSION,
    event: { event: eventName as SubrosaEventName, data: mergedData } as SubrosaEvent,
  };
}

/**
 * Parses every `EVENT_JSON:` line in a receipt's logs.
 *
 * Ordinary debug logs are ignored; any event line that fails validation is
 * returned in `errors` with its log index. Callers should treat a non-empty
 * `errors` array as a signal to re-sync rather than ignore it.
 */
export function parseSubrosaEventLogs(logs: readonly string[]): SubrosaEventParseResult {
  const events: ParsedSubrosaEvent[] = [];
  const errors: EventParseError[] = [];

  logs.forEach((log, logIndex) => {
    if (typeof log !== "string" || !log.startsWith(EVENT_JSON_PREFIX)) {
      return;
    }
    try {
      events.push(parseSubrosaEventLog(log, logIndex));
    } catch (error: unknown) {
      errors.push(
        error instanceof EventParseError
          ? error
          : new EventParseError("MALFORMED_ENVELOPE", "EVENT_JSON parsing failed.", { logIndex })
      );
    }
  });

  return { events, errors };
}

/** Type-narrowing helper for indexers switching on an event name. */
export function isSubrosaEventName(value: unknown): value is SubrosaEventName {
  return canonicalEventName(value) !== undefined;
}
