/**
 * Runtime parsers for contract JSON results.
 *
 * near-sdk serializes structs with snake_case field names and enums as their
 * variant strings. These parsers validate the wire shape before the SDK hands
 * a value to callers, so a stale deployment or malformed RPC response fails
 * with `INVALID_RESPONSE` instead of propagating a wrong-looking object.
 *
 * u64 timestamps (nanoseconds since epoch) exceed Number.MAX_SAFE_INTEGER;
 * they are accepted as non-negative integers with the documented JS precision
 * loss, while identifiers (cycle/payout ids) must stay safe integers.
 */

import { InvalidResponseError, ValidationError } from "../core/errors.js";
import { assertNearAccountId, validateNearAccountId } from "../settlement/destination.js";
import type {
  CommitmentEntry,
  EmployeeEntry,
  HoldEntry,
  HoldReason,
  HoldScope,
  HoldState,
  PayoutEntry,
  PayoutState,
} from "../types.js";


/** NEAR units used to turn a byte cost into a decimal NEAR string. */
export const YOCTO_PER_NEAR = 10n ** 24n;
/** Protocol storage cost: 1e19 yoctoNEAR per byte. */
export const STORAGE_BYTE_COST_YOCTO = 10n ** 19n;

export function formatNearFromYocto(yocto: bigint): string {
  const whole = yocto / YOCTO_PER_NEAR;
  const fraction = (yocto % YOCTO_PER_NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}

/** Exact decimal NEAR string for `bytes` of new contract storage. */
export function storageDepositNear(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new ValidationError("Storage byte count must be a non-negative safe integer.", "bytes");
  }
  return formatNearFromYocto(BigInt(bytes) * STORAGE_BYTE_COST_YOCTO);
}
const HEX_HASH = /^[0-9a-fA-F]{64}$/;

const HOLD_SCOPES: readonly HoldScope[] = ["Employer", "Period", "Batch", "Employee"];
const HOLD_STATES: readonly HoldState[] = ["Active", "Released"];
const HOLD_REASONS: readonly HoldReason[] = [
  "KycReviewPending",
  "SanctionsScreening",
  "TaxWithholdingDiscrepancy",
  "RegulatoryInvestigation",
  "DuplicatePaymentSuspected",
  "ManualReviewRequested",
  "Other",
];
const PAYOUT_STATES: readonly PayoutState[] = [
  "Pending",
  "Executed",
  "Cancelled",
  "Expired",
  "Failed",
];

function invalid(method: string, detail: string): InvalidResponseError {
  return new InvalidResponseError(`Malformed "${method}" response: ${detail}`, { method });
}

/** Normalize a 64-hex commitment hash; reject anything else. */
export function normalizeCommitmentHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HEX_HASH.test(value.trim())) {
    throw new ValidationError(
      `${field} must be a 64-character hexadecimal commitment hash.`,
      field,
    );
  }
  return value.trim().toLowerCase();
}

/** Validate an intent hash as produced by 1Click (base58 or hex, no whitespace). */
export function assertIntentHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9A-Za-z]{32,88}$/.test(value.trim())) {
    throw new ValidationError(`${field} must be a 32-88 character base58/hex intent hash.`, field);
  }
  return value.trim();
}

export function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${field} must be a non-empty string.`, field);
  }
  return value.trim();
}

/** Input u64 identifier that must round-trip through JSON exactly. */
export function assertSafeU64(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(`${field} must be a non-negative safe integer.`, field);
  }
  return value;
}

/** Input u32. */
export function assertU32(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new ValidationError(`${field} must be an unsigned 32-bit integer.`, field);
  }
  return value;
}

/** Contract pagination limit (`assert 1..=500` on-chain). */
export function assertPageLimit(value: unknown, field = "limit"): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 500) {
    throw new ValidationError(`${field} must be an integer between 1 and 500.`, field);
  }
  return value;
}

/** Timestamp in nanoseconds; may exceed the safe-integer range. */
export function assertTimestampNs(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${field} must be a non-negative integer nanosecond timestamp.`, field);
  }
  return value;
}

function record(value: unknown, method: string): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw invalid(method, "expected an object or null");
  }
  return value as Record<string, unknown>;
}


function hashField(source: Record<string, unknown>, key: string, method: string): string {
  const value = stringField(source, key, method);
  if (!HEX_HASH.test(value)) {
    throw invalid(method, `"${key}" must be a 64-character hexadecimal hash`);
  }
  return value.toLowerCase();
}

function stringField(source: Record<string, unknown>, key: string, method: string): string {
  const value = source[key];
  if (typeof value !== "string") {
    throw invalid(method, `"${key}" must be a string`);
  }
  return value;
}

function numberField(source: Record<string, unknown>, key: string, method: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw invalid(method, `"${key}" must be a non-negative integer`);
  }
  return value;
}

function booleanField(source: Record<string, unknown>, key: string, method: string): boolean {
  const value = source[key];
  if (typeof value !== "boolean") {
    throw invalid(method, `"${key}" must be a boolean`);
  }
  return value;
}

function nullableStringField(
  source: Record<string, unknown>,
  key: string,
  method: string,
): string | null {
  const value = source[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw invalid(method, `"${key}" must be a string or null`);
  }
  return value;
}

function accountField(source: Record<string, unknown>, key: string, method: string): string {
  const value = stringField(source, key, method);
  if (!validateNearAccountId(value).ok) {
    throw invalid(method, `"${key}" is not a valid NEAR account id`);
  }
  return value;
}

function enumField<T extends string>(
  source: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  method: string,
): T {
  const value = stringField(source, key, method);
  if (!(allowed as readonly string[]).includes(value)) {
    throw invalid(method, `"${key}" has an unknown variant`);
  }
  return value as T;
}

export function parseEmployeeEntry(value: unknown): EmployeeEntry | null {
  const method = "get_employee";
  const source = record(value, method);
  if (source === null) return null;
  return {
    salary_commitment: hashField(source, "salary_commitment", method),
    token: accountField(source, "token", method),
    metadata: stringField(source, "metadata", method),
    active: booleanField(source, "active", method),
    created_at: numberField(source, "created_at", method),
    updated_at: numberField(source, "updated_at", method),
  };
}

export function parseCommitmentEntry(value: unknown): CommitmentEntry | null {
  const method = "get_commitment";
  const source = record(value, method);
  if (source === null) return null;
  return {
    commitment_hash: hashField(source, "commitment_hash", method),
    token: accountField(source, "token", method),
    created_at: numberField(source, "created_at", method),
  };
}

export function parsePayoutEntry(value: unknown): PayoutEntry | null {
  const method = "get_payout";
  const source = record(value, method);
  if (source === null) return null;
  return {
    employer: accountField(source, "employer", method),
    employee: accountField(source, "employee", method),
    commitment_hash: hashField(source, "commitment_hash", method),
    asset: accountField(source, "asset", method),
    memo: stringField(source, "memo", method),
    execute_at: numberField(source, "execute_at", method),
    created_at: numberField(source, "created_at", method),
    state: enumField(source, "state", PAYOUT_STATES, method),
    intent_hash: nullableStringField(source, "intent_hash", method),
  };
}

export function parseAccountIdArray(value: unknown, method: string): string[] {
  if (!Array.isArray(value)) {
    throw invalid(method, "expected an array of account ids");
  }
  return value.map((item, index) => {
    const account = validateNearAccountId(item);
    if (!account.ok) {
      throw invalid(method, `element ${index} is not a valid NEAR account id`);
    }
    return account.destination;
  });
}

export function parsePayoutArray(value: unknown): PayoutEntry[] {
  if (!Array.isArray(value)) {
    throw invalid("get_pending_payouts", "expected an array of payout entries");
  }
  return value.map((item) => {
    const entry = parsePayoutEntry(item);
    if (entry === null) {
      throw invalid("get_pending_payouts", "array element must not be null");
    }
    return entry;
  });
}

export function parseHoldEntry(value: unknown): HoldEntry | null {
  const method = "get_audit_hold";
  const source = record(value, method);
  if (source === null) return null;

  const reason = enumField(source, "reason_code", HOLD_REASONS, method);
  const releaseReasonValue = source.release_reason;
  const releaseReason =
    releaseReasonValue === null || releaseReasonValue === undefined
      ? null
      : enumField(source, "release_reason", HOLD_REASONS, method);

  return {
    employer: accountField(source, "employer", method),
    scope: enumField(source, "scope", HOLD_SCOPES, method),
    scope_id: stringField(source, "scope_id", method),
    reason_code: reason,
    state: enumField(source, "state", HOLD_STATES, method),
    placed_by: accountField(source, "placed_by", method),
    placed_at: numberField(source, "placed_at", method),
    released_by: nullableStringField(source, "released_by", method),
    released_at:
      source.released_at === null || source.released_at === undefined
        ? null
        : numberField(source, "released_at", method),
    release_reason: releaseReason,
  };
}

/** Read a u32 view result (counts, pagination metadata). */
export function parseCount(value: unknown, method: string): number {
  const number = value;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 0) {
    throw invalid(method, "expected a non-negative integer");
  }
  return number;
}

/** Read a boolean view result. */
export function parseBoolean(value: unknown, method: string): boolean {
  if (typeof value !== "boolean") {
    throw invalid(method, "expected a boolean");
  }
  return value;
}

/** Assert helper used by client inputs that are account ids. */
export function requireAccountId(value: unknown, field: string): string {
  return assertNearAccountId(value, field);
}

const ASSET_ID_PATTERN = /^(?:(?:nep141|nep245):)?(.+)$/;

/**
 * Validate a settlement asset id: either a NEAR account id or a
 * `nep141:<account>` / `nep245:<account>` token id.
 */
export function requireAssetId(value: unknown, field: string): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const match = ASSET_ID_PATTERN.exec(trimmed);
    if (match && validateNearAccountId(match[1]).ok) {
      return trimmed;
    }
  }
  throw new ValidationError(
    `${field} must be a NEAR account id or a nep141:/nep245: asset id.`,
    field,
    "INVALID_ASSET",
  );
}
