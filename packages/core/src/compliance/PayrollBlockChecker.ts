/**
 * Payroll hold gate.
 *
 * Resolves every hold that applies to a payroll action (employer, period,
 * batch, employee) and blocks unless all of them are explicitly released.
 * Unknown/unparsed holds always block: settlement is off-chain and has no
 * rollback, so paying under an indeterminate hold is never acceptable.
 */

import type { HoldScope } from "../types.js";
import { ComplianceHoldBlockedError } from "./errors.js";
import { explainHold } from "./explanations.js";
import { isHoldBlocking } from "./HoldStatusParser.js";
import { HOLD_SCOPE_PRIORITY } from "./types.js";
import type { HoldCheckResult, HoldQuery, ParsedHoldStatus } from "./types.js";

const NOT_BLOCKED_EXPLANATION =
  "No active or unresolved compliance holds apply to this payroll action.";

function scopeIdFor(query: HoldQuery, scope: HoldScope): string | undefined {
  switch (scope) {
    case "Employer":
      return query.employer;
    case "Period":
      return query.period;
    case "Batch":
      return query.batch;
    case "Employee":
      return query.employee;
  }
}

function appliesTo(hold: ParsedHoldStatus, query: HoldQuery): boolean {
  // A hold with no readable employer is malformed; fail closed by applying it
  // to every employer rather than skipping it.
  if (hold.employer.length > 0 && hold.employer !== query.employer) {
    return false;
  }
  // An invalid or indeterminate record blocked everything it could cover.
  if (!hold.valid || hold.state === "unknown") {
    return true;
  }
  const scopeId = scopeIdFor(query, hold.scope);
  return scopeId !== undefined && hold.scopeId === scopeId;
}

function priorityOf(hold: ParsedHoldStatus): number {
  if (!hold.valid || hold.state === "unknown") return -1;
  return HOLD_SCOPE_PRIORITY.indexOf(hold.scope);
}

/**
 * Returns every hold that blocks the given payroll action, ordered from
 * broadest to narrowest scope (indeterminate records first).
 */
export function activeHoldsFor(
  query: HoldQuery,
  holds: readonly ParsedHoldStatus[]
): ParsedHoldStatus[] {
  return holds
    .filter((hold) => isHoldBlocking(hold) && appliesTo(hold, query))
    .sort((left, right) => priorityOf(left) - priorityOf(right));
}

/** Returns the highest-priority blocking hold, if any. */
export function findBlockingHold(
  query: HoldQuery,
  holds: readonly ParsedHoldStatus[]
): ParsedHoldStatus | undefined {
  let best: ParsedHoldStatus | undefined;
  let bestPriority = Number.POSITIVE_INFINITY;
  for (const hold of holds) {
    if (!isHoldBlocking(hold) || !appliesTo(hold, query)) continue;
    const priority = priorityOf(hold);
    if (priority < bestPriority) {
      best = hold;
      bestPriority = priority;
      if (priority === -1) break;
    }
  }
  return best;
}

/** Checks a payroll action against a set of candidate holds. */
export function isPayrollActionBlocked(
  query: HoldQuery,
  holds: readonly ParsedHoldStatus[]
): HoldCheckResult {
  const hold = findBlockingHold(query, holds);
  if (!hold) {
    return { blocked: false, explanation: NOT_BLOCKED_EXPLANATION };
  }
  return { blocked: true, hold, explanation: explainHold(hold) };
}

/**
 * Asserts that no hold blocks the payroll action.
 *
 * @throws {ComplianceHoldBlockedError} with a sanitized explanation when any
 *   active or indeterminate hold applies.
 */
export function assertPayrollActionAllowed(
  query: HoldQuery,
  holds: readonly ParsedHoldStatus[]
): void {
  const result = isPayrollActionBlocked(query, holds);
  if (result.blocked && result.hold) {
    throw new ComplianceHoldBlockedError(result.hold, result.explanation);
  }
}
