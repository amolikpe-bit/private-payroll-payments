/**
 * Compliance hold reason mapping.
 *
 * The contract stores the seven closed `HoldReason` variants in PascalCase
 * (`KycReviewPending`); SDK-facing code uses the uppercase `HoldReasonCode`
 * spelling (`KYC_REVIEW_PENDING`). Both are stable, non-identifying codes —
 * never free text — so a hold status is safe to log and display.
 */

import type { HoldReason, HoldReasonCode } from "../types.js";

/** Category classification for compliance holds. */
export type HoldReasonCategory =
  | "identity"
  | "screening"
  | "tax"
  | "legal"
  | "fraud"
  | "operational"
  | "other";

/** Metadata for one supported hold reason. */
export interface HoldReasonDefinition {
  /** SDK spelling (`KYC_REVIEW_PENDING`). */
  code: HoldReasonCode;
  /** Contract JSON spelling (`KycReviewPending`). */
  contractReason: HoldReason;
  label: string;
  shortDescription: string;
  category: HoldReasonCategory;
}

/** Canonical reason definitions, in contract declaration order. */
export const SUPPORTED_HOLD_REASONS: readonly HoldReasonDefinition[] = Object.freeze([
  {
    code: "KYC_REVIEW_PENDING",
    contractReason: "KycReviewPending",
    label: "KYC Review Pending",
    shortDescription: "Identity verification or AML documentation review is in progress.",
    category: "identity",
  },
  {
    code: "SANCTIONS_SCREENING",
    contractReason: "SanctionsScreening",
    label: "Sanctions Screening",
    shortDescription: "Watchlist or sanctions compliance check required prior to disbursement.",
    category: "screening",
  },
  {
    code: "TAX_WITHHOLDING_DISCREPANCY",
    contractReason: "TaxWithholdingDiscrepancy",
    label: "Tax Withholding Discrepancy",
    shortDescription: "Discrepancy identified in required tax calculations or withholdings.",
    category: "tax",
  },
  {
    code: "REGULATORY_INVESTIGATION",
    contractReason: "RegulatoryInvestigation",
    label: "Regulatory Investigation",
    shortDescription: "Pending review under applicable financial or labor regulations.",
    category: "legal",
  },
  {
    code: "DUPLICATE_PAYMENT_SUSPECTED",
    contractReason: "DuplicatePaymentSuspected",
    label: "Duplicate Payment Suspected",
    shortDescription: "Potential duplicate disbursement or overlapping batch detected.",
    category: "fraud",
  },
  {
    code: "MANUAL_REVIEW_REQUESTED",
    contractReason: "ManualReviewRequested",
    label: "Manual Review Requested",
    shortDescription: "Manual compliance officer review requested before execution.",
    category: "operational",
  },
  {
    code: "OTHER",
    contractReason: "Other",
    label: "Other Compliance Reason",
    shortDescription: "Hold placed for administrative or miscellaneous compliance requirements.",
    category: "other",
  },
] satisfies HoldReasonDefinition[]);

const BY_CODE: ReadonlyMap<HoldReasonCode, HoldReasonDefinition> = new Map(
  SUPPORTED_HOLD_REASONS.map((definition) => [definition.code, definition] as const)
);

const BY_CONTRACT_REASON: ReadonlyMap<string, HoldReasonDefinition> = new Map(
  SUPPORTED_HOLD_REASONS.map((definition) => [definition.contractReason, definition] as const)
);

/** Human-readable, safe-to-display explanation per reason code. */
export const HOLD_REASON_EXPLANATIONS: Record<HoldReasonCode, string> = Object.freeze({
  KYC_REVIEW_PENDING:
    "Payroll is on hold pending identity verification (KYC) review for the affected party.",
  SANCTIONS_SCREENING: "Payroll is on hold while sanctions/watchlist screening is completed.",
  TAX_WITHHOLDING_DISCREPANCY:
    "Payroll is on hold due to a discrepancy in required tax withholding.",
  REGULATORY_INVESTIGATION: "Payroll is on hold as part of an active regulatory investigation.",
  DUPLICATE_PAYMENT_SUSPECTED: "Payroll is on hold because a duplicate payment is suspected.",
  MANUAL_REVIEW_REQUESTED: "Payroll is on hold pending manual review by a compliance officer.",
  OTHER: "Payroll is on hold for a compliance reason not covered by a standard code.",
});

/** Maps a contract `HoldReason` to its SDK code. */
export function holdReasonToCode(reason: HoldReason): HoldReasonCode {
  return BY_CONTRACT_REASON.get(reason)?.code ?? "OTHER";
}

/** Maps an SDK code to the contract `HoldReason`. */
export function holdReasonFromCode(code: HoldReasonCode): HoldReason {
  return BY_CODE.get(code)?.contractReason ?? "Other";
}

/**
 * Normalizes a raw reason value from a contract response or backend payload.
 * Accepts either spelling; anything unrecognized becomes `"OTHER"` so a hold
 * is never dropped just because its reason string changed.
 */
export function parseHoldReason(value: unknown): HoldReasonCode {
  if (typeof value !== "string") return "OTHER";
  const trimmed = value.trim();
  return BY_CODE.get(trimmed as HoldReasonCode)?.code ?? BY_CONTRACT_REASON.get(trimmed)?.code ?? "OTHER";
}

/** Type guard for a supported SDK reason code. */
export function isSupportedHoldReasonCode(code: unknown): code is HoldReasonCode {
  return typeof code === "string" && BY_CODE.has(code as HoldReasonCode);
}

/** Full definition for a reason code or either raw spelling. */
export function getHoldReasonDefinition(
  code: HoldReasonCode | HoldReason | string
): HoldReasonDefinition | undefined {
  return BY_CODE.get(code as HoldReasonCode) ?? BY_CONTRACT_REASON.get(code);
}

/** Display label, falling back to the raw value for unknown codes. */
export function getHoldReasonLabel(code: HoldReasonCode | string): string {
  return getHoldReasonDefinition(code)?.label ?? String(code);
}

/** Short description, falling back to a neutral sentence. */
export function getHoldReasonShortDescription(code: HoldReasonCode | string): string {
  return (
    getHoldReasonDefinition(code)?.shortDescription ??
    "Unrecognized compliance hold reason code."
  );
}

/** All supported definitions (contract order). */
export function listSupportedHoldReasons(): readonly HoldReasonDefinition[] {
  return SUPPORTED_HOLD_REASONS;
}

/** Options for a dashboard reason picker. */
export function listHoldReasonSelectOptions(): Array<{ value: HoldReasonCode; label: string }> {
  return SUPPORTED_HOLD_REASONS.map((definition) => ({
    value: definition.code,
    label: definition.label,
  }));
}

/** Explanation text for an active hold's reason code. */
export function explainHoldReason(code: HoldReasonCode): string {
  return HOLD_REASON_EXPLANATIONS[code] ?? HOLD_REASON_EXPLANATIONS.OTHER;
}
