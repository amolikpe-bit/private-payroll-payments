/**
 * Human-readable explanations for parsed compliance holds.
 *
 * Explanations use only the closed reason code, scope, and hold id. Free-text
 * notes and investigation detail are never part of the parsed record and can
 * never leak through this path.
 */

import { explainHoldReason, getHoldReasonLabel } from "./holdReasons.js";
import type { ParsedHoldStatus } from "./types.js";

/** Explanation for one parsed hold, safe to display to a dashboard user. */
export function explainHold(hold: ParsedHoldStatus): string {
  const scopeLabel = `${hold.scope.toLowerCase()} "${hold.scopeId || "unknown"}"`;
  const reasonLabel = getHoldReasonLabel(hold.reasonCode);

  switch (hold.state) {
    case "active":
      return `${explainHoldReason(hold.reasonCode)} (${reasonLabel}; scope: ${scopeLabel}, hold ${hold.holdId})`;
    case "released":
      return `The hold on ${scopeLabel} (hold ${hold.holdId}) was released${
        hold.releasedBy ? ` by ${hold.releasedBy}` : ""
      } and no longer blocks payroll.`;
    case "unknown":
    default:
      return `The status of hold ${hold.holdId} on ${scopeLabel} could not be determined. Treating payroll as blocked until the hold status is confirmed.`;
  }
}
