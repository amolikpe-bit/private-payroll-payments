/**
 * Fail-closed parser for compliance hold status responses.
 *
 * Accepts a decoded contract `HoldEntry` (snake_case, PascalCase enums) or a
 * backend JSON payload (camelCase). The parser never throws and never drops a
 * record: anything it cannot confidently classify is returned with
 * `state: "unknown"` and `valid: false`, which every blocking helper treats as
 * active. An indeterminate hold must never be read as "safe to pay".
 */

import type { HoldEntry, HoldScope } from "../types.js";
import { parseHoldReason } from "./holdReasons.js";
import type { ParsedHoldStatus, ParsedHoldState } from "./types.js";

function normalizeScope(value: string): HoldScope | undefined {
  switch (value.toLowerCase()) {
    case "employer":
      return "Employer";
    case "period":
      return "Period";
    case "batch":
      return "Batch";
    case "employee":
      return "Employee";
    default:
      return undefined;
  }
}

function normalizeState(value: string): ParsedHoldState | undefined {
  switch (value.toLowerCase()) {
    case "active":
      return "active";
    case "released":
      return "released";
    default:
      return undefined;
  }
}

function readField(record: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    const value = record[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === "bigint") {
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Parses one raw hold record.
 *
 * @param raw - Decoded contract result or backend payload.
 * @param fallbackHoldId - Identifier to use when the record omits one (e.g.
 *   the `hold_id` map key the caller queried). Never treated as valid on its own.
 */
export function parseHoldStatus(raw: unknown, fallbackHoldId?: string): ParsedHoldStatus {
  const record: Record<string, unknown> =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

  const holdId =
    asNonEmptyString(readField(record, "hold_id", "holdId")) ??
    asNonEmptyString(fallbackHoldId) ??
    "unknown";

  const rawScope = asNonEmptyString(readField(record, "scope"));
  const scope = rawScope === undefined ? undefined : normalizeScope(rawScope);

  const employer = asNonEmptyString(readField(record, "employer")) ?? "";

  const scopeId =
    asNonEmptyString(readField(record, "scope_id", "scopeId", "targetId")) ?? "";

  const rawState = asNonEmptyString(readField(record, "state"));
  const parsedState = rawState === undefined ? undefined : normalizeState(rawState);

  const reasonCode = parseHoldReason(readField(record, "reason_code", "reasonCode", "reason"));

  const placedBy =
    asNonEmptyString(readField(record, "placed_by", "placedBy")) ?? "unknown";
  const placedAt = asNonNegativeInteger(readField(record, "placed_at", "placedAt")) ?? 0;

  // A hold can only be confidently "active" or "released" when the scope, the
  // id within that scope, the employer, and a recognized state are all present.
  const valid =
    scope !== undefined &&
    scopeId.length > 0 &&
    employer.length > 0 &&
    parsedState !== undefined;

  const hold: ParsedHoldStatus = {
    holdId,
    employer,
    // Defaulting an unreadable scope to Employer keeps the record blocking at
    // the broadest scope instead of silently narrowing it.
    scope: scope ?? "Employer",
    scopeId,
    state: valid ? (parsedState as ParsedHoldState) : "unknown",
    reasonCode,
    placedBy,
    placedAt,
    valid,
  };

  if (hold.state === "released") {
    const releasedBy = asNonEmptyString(readField(record, "released_by", "releasedBy"));
    const releasedAt = asNonNegativeInteger(readField(record, "released_at", "releasedAt"));
    const rawReleaseReason = readField(record, "release_reason", "releaseReason");
    if (releasedBy !== undefined) hold.releasedBy = releasedBy;
    if (releasedAt !== undefined) hold.releasedAt = releasedAt;
    if (rawReleaseReason !== undefined && rawReleaseReason !== null) {
      hold.releaseReasonCode = parseHoldReason(rawReleaseReason);
    }
  }

  return hold;
}

/**
 * Parses a `get_audit_hold`-style response: `null`/`undefined` means the
 * contract has no such hold, which is a definite "no hold" rather than an
 * unknown state.
 */
export function parseHoldStatusOrNull(
  raw: unknown,
  fallbackHoldId?: string
): ParsedHoldStatus | null {
  return raw === null || raw === undefined ? null : parseHoldStatus(raw, fallbackHoldId);
}

/**
 * Converts a contract `HoldEntry` into parsed form. The contract keys holds by
 * id, so the caller supplies the id it queried (`get_audit_hold(hold_id)`).
 */
export function parseHoldEntry(holdId: string, entry: HoldEntry): ParsedHoldStatus {
  return parseHoldStatus(entry, holdId);
}

/**
 * True when a hold blocks payroll. `active` and `unknown` both block; only an
 * explicitly `released` hold stops blocking.
 */
export function isHoldBlocking(hold: ParsedHoldStatus): boolean {
  return hold.state !== "released";
}
