/** Compliance hold parsing and blocking types, aligned with the contract `HoldEntry`. */

import type { HoldEntry, HoldReasonCode, HoldScope } from "../types.js";

/**
 * Hold state as understood by the SDK.
 *
 * `unknown` means the status could not be determined (malformed/incomplete
 * response). It is treated as blocking everywhere — a payroll must never run
 * under an indeterminate hold.
 */
export type ParsedHoldState = "active" | "released" | "unknown";

/** A hold parsed from a contract response or backend JSON payload. */
export interface ParsedHoldStatus {
  holdId: string;
  employer: string;
  scope: HoldScope;
  scopeId: string;
  state: ParsedHoldState;
  reasonCode: HoldReasonCode;
  placedBy: string;
  placedAt: number;
  releasedBy?: string;
  releasedAt?: number;
  releaseReasonCode?: HoldReasonCode;
  /**
   * `false` when the raw record did not carry a usable scope, scope id,
   * employer, or recognized state. Invalid records are still returned (never
   * silently dropped) and always block.
   */
  valid: boolean;
}

/** The employer/period/batch/employee a payroll action touches. */
export interface HoldQuery {
  employer: string;
  period?: string;
  batch?: string;
  employee?: string;
}

/** Result of checking whether a payroll action is blocked. */
export interface HoldCheckResult {
  blocked: boolean;
  /** The highest-priority blocking hold, when `blocked` is true. */
  hold?: ParsedHoldStatus;
  /** Human-readable, safe-to-display explanation. */
  explanation: string;
}

/** Scope priority: a broad hold outranks a narrow one. */
export const HOLD_SCOPE_PRIORITY: readonly HoldScope[] = Object.freeze([
  "Employer",
  "Period",
  "Batch",
  "Employee",
]);

/** Contract-shaped hold with parsed state; useful for indexers and stores. */
export interface HoldEntryWithParsedState {
  entry: HoldEntry;
  parsed: ParsedHoldStatus;
}
