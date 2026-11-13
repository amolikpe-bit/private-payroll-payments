/**
 * Display redaction for payroll summaries and signature payload inspectors.
 *
 * Unlike the generic deep-walk redactor in `redaction/RedactionEngine.ts`
 * (which sanitizes arbitrary SDK objects for logging), this module knows the
 * exact shape of a payroll summary: it hides amounts entirely and partially
 * masks employee identifiers by default, while leaving public hashes and
 * aggregate metadata visible.
 */

import { sha256Hex } from "../crypto/hashUtils.js";

/** Replacement used for every fully hidden value. */
export const REDACTED_REPLACEMENT = "[REDACTED]";

/** Employee-level fields that must never appear in a signature summary by default. */
export const PRIVATE_EMPLOYEE_FIELDS: readonly string[] = Object.freeze([
  "employeeId",
  "employee",
  "recipient",
  "salary",
  "salaryAmount",
  "amount",
  "salt",
]);

/**
 * Redacts an individual salary/amount value for display.
 *
 * @param reveal - Explicit opt-in for a trusted context (e.g. an admin viewing
 *   their own payload). The default is always safe.
 */
export function redactAmount(value: string | bigint | undefined, reveal = false): string {
  if (reveal) {
    return value === undefined ? REDACTED_REPLACEMENT : value.toString();
  }
  return REDACTED_REPLACEMENT;
}

/**
 * Redacts an employee/recipient identifier for display.
 *
 * When `reveal` is false the value is partially masked rather than fully
 * hidden so an approver can still spot an obviously wrong destination without
 * exposing the full account id in logs or screenshots.
 */
export function redactIdentifier(value: string | undefined, reveal = false): string {
  if (!value) return REDACTED_REPLACEMENT;
  if (reveal) return value;
  if (value.length <= 8) return REDACTED_REPLACEMENT;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** Stable, non-reversible employee reference for exports that need a join key. */
export function hashEmployeeReferenceId(employeeReferenceId: string): string {
  return sha256Hex(employeeReferenceId);
}
