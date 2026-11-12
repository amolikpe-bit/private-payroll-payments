/** Shared JSON shapes for the subrosa contract and private SDK stores. */

export interface EmployeeEntry {
  salary_commitment: string;
  token: string;
  metadata: string;
  active: boolean;
  created_at: number;
  updated_at: number;
}

export interface CommitmentEntry {
  commitment_hash: string;
  token: string;
  created_at: number;
}

export type PayoutState = "Pending" | "Executed" | "Cancelled" | "Expired" | "Failed";

export interface PayoutEntry {
  employer: string;
  employee: string;
  commitment_hash: string;
  asset: string;
  memo: string;
  execute_at: number;
  created_at: number;
  state: PayoutState;
  intent_hash: string | null;
}

export type HoldScope = "Employer" | "Period" | "Batch" | "Employee";
export type HoldState = "Active" | "Released";

/** Contract JSON spelling of the seven closed hold reasons. */
export type HoldReason =
  | "KycReviewPending"
  | "SanctionsScreening"
  | "TaxWithholdingDiscrepancy"
  | "RegulatoryInvestigation"
  | "DuplicatePaymentSuspected"
  | "ManualReviewRequested"
  | "Other";

/** Origin/SDK spelling of the same seven codes. */
export type HoldReasonCode =
  | "KYC_REVIEW_PENDING"
  | "SANCTIONS_SCREENING"
  | "TAX_WITHHOLDING_DISCREPANCY"
  | "REGULATORY_INVESTIGATION"
  | "DUPLICATE_PAYMENT_SUSPECTED"
  | "MANUAL_REVIEW_REQUESTED"
  | "OTHER";

export interface HoldEntry {
  employer: string;
  scope: HoldScope;
  scope_id: string;
  reason_code: HoldReason;
  state: HoldState;
  placed_by: string;
  placed_at: number;
  released_by: string | null;
  released_at: number | null;
  release_reason: HoldReason | null;
}

export interface VerificationKeyInfo {
  /** Raw verification-key bytes, hex encoded for JSON. */
  key: string;
  description: string;
}

export interface CommitItem {
  employee: string;
  commitment_hash: string;
  cycle_id: number;
}

/** Amount and salt never go on chain; this lives only in the private store. */
export interface PendingPayout {
  employer: string;
  payout_id: number;
  employee: string;
  amount: string;
  salt: string;
  asset: string;
  memo: string;
  commitment_hash: string;
}

export interface PreflightResult {
  canProceed: boolean;
  findings: string[];
}

export interface SignedIntentMessage {
  publicKey: string;
  signature: string;
}

export interface IntentSigner {
  readonly signerId: string;
  readonly publicKey: string;
  signMessage(message: string): Promise<SignedIntentMessage>;
}
