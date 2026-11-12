/**
 * Typed client for audit holds, auditor roles, and the global pause switch.
 *
 * Holds are scoped to an employer, a payroll period, a batch, or one employee.
 * The payroll workflow treats any active matching hold - and any indeterminate
 * hold status - as blocking. Release authorization is an on-chain role check
 * (employer or granted auditor), so no bearer token crosses this API.
 */

import type { HoldEntry, HoldReason, HoldReasonCode, HoldScope } from "../types.js";
import type { NearContractWrapper, NearContractCallOptions } from "./NearContractWrapper.js";
import {
  assertNonEmptyString,
  parseHoldEntry,
  requireAccountId,
} from "./entries.js";
import { ValidationError } from "../core/errors.js";

const HOLD_SCOPES: readonly HoldScope[] = ["Employer", "Period", "Batch", "Employee"];

/** Contract spelling -> origin uppercase code accepted by the contract arg. */
const HOLD_REASON_TO_CODE: Record<HoldReason, HoldReasonCode> = {
  KycReviewPending: "KYC_REVIEW_PENDING",
  SanctionsScreening: "SANCTIONS_SCREENING",
  TaxWithholdingDiscrepancy: "TAX_WITHHOLDING_DISCREPANCY",
  RegulatoryInvestigation: "REGULATORY_INVESTIGATION",
  DuplicatePaymentSuspected: "DUPLICATE_PAYMENT_SUSPECTED",
  ManualReviewRequested: "MANUAL_REVIEW_REQUESTED",
  Other: "OTHER",
};

const HOLD_REASON_CODES = Object.values(HOLD_REASON_TO_CODE) as readonly HoldReasonCode[];

/** Normalize either spelling of a hold reason to the uppercase contract arg. */
export function normalizeHoldReasonCode(
  value: HoldReason | HoldReasonCode,
  field: string,
): HoldReasonCode {
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a hold reason code.`, field);
  }
  if (Object.hasOwn(HOLD_REASON_TO_CODE, value)) {
    return HOLD_REASON_TO_CODE[value as HoldReason];
  }
  if ((HOLD_REASON_CODES as readonly string[]).includes(value)) {
    return value as HoldReasonCode;
  }
  throw new ValidationError(`${field} is not one of the seven closed hold reasons.`, field);
}

function assertHoldScope(value: unknown, field: string): HoldScope {
  if (typeof value !== "string" || !(HOLD_SCOPES as readonly string[]).includes(value)) {
    throw new ValidationError(`${field} must be one of Employer, Period, Batch, Employee.`, field);
  }
  return value as HoldScope;
}

export interface CreateAuditHoldArgs {
  holdId: string;
  employer: string;
  scope: HoldScope;
  scopeId: string;
  reasonCode: HoldReasonCode | HoldReason;
}

export class HoldClient {
  constructor(private readonly near: NearContractWrapper) {}

  async createAuditHold(args: CreateAuditHoldArgs, opts?: NearContractCallOptions): Promise<void> {
    await this.near.call<null>(
      "create_audit_hold",
      {
        hold_id: assertNonEmptyString(args.holdId, "holdId"),
        employer: requireAccountId(args.employer, "employer"),
        scope: assertHoldScope(args.scope, "scope"),
        scope_id: assertNonEmptyString(args.scopeId, "scopeId"),
        reason_code: normalizeHoldReasonCode(args.reasonCode, "reasonCode"),
      },
      opts,
    );
  }

  async getAuditHold(holdId: string): Promise<HoldEntry | null> {
    const result = await this.near.view<HoldEntry | null>("get_audit_hold", {
      hold_id: assertNonEmptyString(holdId, "holdId"),
    });
    return parseHoldEntry(result);
  }

  async releaseAuditHold(
    holdId: string,
    releaseReason: HoldReasonCode | HoldReason,
    opts?: NearContractCallOptions,
  ): Promise<void> {
    await this.near.call<null>(
      "release_audit_hold",
      {
        hold_id: assertNonEmptyString(holdId, "holdId"),
        release_reason: normalizeHoldReasonCode(releaseReason, "releaseReason"),
      },
      opts,
    );
  }

  /** Grant an auditor scope for one employer (employer or contract owner only). */
  async grantAuditor(
    employer: string,
    auditor: string,
    opts?: NearContractCallOptions,
  ): Promise<void> {
    await this.near.call<null>(
      "grant_auditor",
      {
        employer: requireAccountId(employer, "employer"),
        auditor: requireAccountId(auditor, "auditor"),
      },
      opts,
    );
  }

  async revokeAuditor(
    employer: string,
    auditor: string,
    opts?: NearContractCallOptions,
  ): Promise<void> {
    await this.near.call<null>(
      "revoke_auditor",
      {
        employer: requireAccountId(employer, "employer"),
        auditor: requireAccountId(auditor, "auditor"),
      },
      opts,
    );
  }

  /** Owner-only global pause. */
  async setPause(paused: boolean, opts?: NearContractCallOptions): Promise<void> {
    if (typeof paused !== "boolean") {
      throw new ValidationError("paused must be a boolean.", "paused");
    }
    await this.near.call<null>("set_pause", { paused }, opts);
  }
}
