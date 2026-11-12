import { SubrosaError, type ErrorContext } from "../core/errors.js";
import type { ParsedHoldStatus } from "./types.js";

/**
 * Thrown when a payroll action is blocked by an active or unresolved
 * compliance hold. The message and context contain only the safe, closed-set
 * hold metadata (id, scope, reason code) — never a note or case detail.
 */
export class ComplianceHoldBlockedError extends SubrosaError {
  constructor(
    public readonly hold: ParsedHoldStatus,
    explanation: string,
    context: ErrorContext = {}
  ) {
    super(explanation, "COMPLIANCE_HOLD_BLOCKED", {
      ...context,
      holdId: hold.holdId,
      scope: hold.scope,
      scopeId: hold.scopeId,
      reasonCode: hold.reasonCode,
    });
    this.name = "ComplianceHoldBlockedError";
  }
}
