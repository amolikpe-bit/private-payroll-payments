/**
 * Settlement receipts for Confidential Intents payouts.
 *
 * A payout settles off chain. The reference recorded on a receipt is therefore
 * the 1Click `intentHash` (base58), never a public swap transaction hash:
 * `nearTxHashes` only cover shield/unshield legs. `SUCCESS` maps to `settled`,
 * `metadataDigest` carries the employee commitment hash, and no viewing-key id
 * exists because NEAR's confidential rail has no viewing-key primitive.
 */

import type { HoldEntry } from "../types.js";
import { sha256Hex } from "../crypto/hashUtils.js";

/** Receipt settlement status. */
export type ReceiptSettlementStatus = "settled" | "confirmed" | "pending" | "rejected" | "unknown";

/** Transaction reference attached to a receipt. */
export interface ReceiptTransactionReference {
  /** The base58 1Click intent hash. */
  txHash: string;
  network?: string;
  submittedAt?: number | string;
  confirmedAt?: number | string;
}

/** Public receipt shape; contains no amount, salt, deposit address or view key. */
export interface PayrollReceipt {
  receiptId: string;
  payrollId: string;
  settlementStatus: ReceiptSettlementStatus;
  transactionReference: ReceiptTransactionReference;
  /** Employee commitment hash (64 hex). */
  metadataDigest: string;
  /** Hash over the audit hold set, when one exists. */
  complianceHash?: string;
  /** `ed25519:`-prefixed base58 receipt signature. */
  signature?: string;
  /** `ed25519:`-prefixed base58 signer public key. */
  signerPublicKey?: string;
  issuedAt: number | string;
  settledAt?: number | string;
}

/** A hold together with the storage key it is addressed by. */
export interface AuditHoldRef {
  holdId: string;
  hold: HoldEntry;
}

/** Stable machine-readable receipt failures. */
export const ReceiptErrorCode = {
  SHAPE_INVALID: "RECEIPT_SHAPE_INVALID",
  RECEIPT_ID_INVALID: "RECEIPT_ID_INVALID",
  PAYROLL_ID_INVALID: "RECEIPT_PAYROLL_ID_INVALID",
  STATUS_INVALID: "RECEIPT_STATUS_INVALID",
  INTENT_HASH_INVALID: "RECEIPT_INTENT_HASH_INVALID",
  METADATA_DIGEST_INVALID: "RECEIPT_METADATA_DIGEST_INVALID",
  COMPLIANCE_HASH_INVALID: "RECEIPT_COMPLIANCE_HASH_INVALID",
  COMPLIANCE_HASH_MISMATCH: "RECEIPT_COMPLIANCE_HASH_MISMATCH",
  SIGNATURE_INVALID: "RECEIPT_SIGNATURE_INVALID",
  SIGNATURE_PAIR_REQUIRED: "RECEIPT_SIGNATURE_PAIR_REQUIRED",
  UNSUPPORTED_SIGNATURE: "RECEIPT_UNSUPPORTED_SIGNATURE",
  TIMESTAMP_INVALID: "RECEIPT_TIMESTAMP_INVALID",
  VIEW_KEY_UNSUPPORTED: "RECEIPT_VIEW_KEY_UNSUPPORTED",
} as const;

export type ReceiptErrorCode = (typeof ReceiptErrorCode)[keyof typeof ReceiptErrorCode];

export class ReceiptError extends Error {
  readonly code: ReceiptErrorCode;

  constructor(code: ReceiptErrorCode, message: string) {
    super(message);
    this.name = "ReceiptError";
    this.code = code;
  }
}

export interface ReceiptSignature {
  signature: string;
  signerPublicKey: string;
}

export interface CreateReceiptParams {
  receiptId: string;
  payrollId: string;
  /** 1Click `intentHash` (base58) or a 64-hex hash. */
  intentHash: string;
  /** Employee commitment hash; becomes `metadataDigest`. */
  commitmentHash: string;
  /** Raw 1Click status, `SUCCESS`, or an already-mapped receipt status. */
  status: string;
  issuedAt?: number | string;
  settledAt?: number | string;
  network?: string;
  /** Audit hold set to hash into `complianceHash`. */
  holds?: readonly AuditHoldRef[];
  /** Precomputed hold/audit hash; must agree with `holds` when both are given. */
  complianceHash?: string;
  signature?: ReceiptSignature;
}

export type SettlementReceiptValidation =
  | { ok: true }
  | { ok: false; code: ReceiptErrorCode; message: string };

/**
 * Map a 1Click execution status onto a receipt status.
 * Unrecognized states fail closed to `unknown`.
 */
export function mapExecutionStatus(status: string): ReceiptSettlementStatus {
  if (typeof status !== "string") {
    return "unknown";
  }
  switch (status.trim().toUpperCase()) {
    case "SUCCESS":
      return "settled";
    case "FAILED":
    case "REFUNDED":
    case "INCOMPLETE_DEPOSIT":
      return "rejected";
    case "PROCESSING":
    case "PENDING_DEPOSIT":
    case "KNOWN_DEPOSIT_TX":
      return "pending";
    default:
      return "unknown";
  }
}

/** Build a receipt from a 1Click intent outcome. Never adds a view-key field. */
export function createSettlementReceipt(params: CreateReceiptParams): PayrollReceipt {
  if (typeof params !== "object" || params === null) {
    throw new ReceiptError(ReceiptErrorCode.SHAPE_INVALID, "Receipt parameters must be an object.");
  }
  assertReceiptId(params.receiptId);
  assertPayrollId(params.payrollId);
  assertIntentHash(params.intentHash);
  const metadataDigest = normalizeHash64(params.commitmentHash, ReceiptErrorCode.METADATA_DIGEST_INVALID, "commitmentHash");

  const issuedAt = params.issuedAt === undefined ? new Date().toISOString() : params.issuedAt;
  assertTimestamp(issuedAt, "issuedAt");
  if (params.settledAt !== undefined) {
    assertTimestamp(params.settledAt, "settledAt");
  }

  let complianceHash: string | undefined;
  if (params.holds !== undefined) {
    complianceHash = computeComplianceHash(params.holds);
  }
  if (params.complianceHash !== undefined) {
    const provided = normalizeHash64(
      params.complianceHash,
      ReceiptErrorCode.COMPLIANCE_HASH_INVALID,
      "complianceHash",
    );
    if (complianceHash !== undefined && complianceHash !== provided) {
      throw new ReceiptError(
        ReceiptErrorCode.COMPLIANCE_HASH_MISMATCH,
        "complianceHash does not match the supplied audit hold set.",
      );
    }
    complianceHash = provided;
  }

  let signature: string | undefined;
  let signerPublicKey: string | undefined;
  if (params.signature !== undefined) {
    assertSignaturePair(params.signature.signature, params.signature.signerPublicKey);
    signature = params.signature.signature;
    signerPublicKey = params.signature.signerPublicKey;
  }

  const receipt: PayrollReceipt = {
    receiptId: params.receiptId,
    payrollId: params.payrollId,
    settlementStatus: normalizeReceiptStatus(params.status),
    transactionReference: {
      txHash: params.intentHash,
      ...(params.network === undefined ? {} : { network: params.network }),
    },
    metadataDigest,
    issuedAt,
    ...(params.settledAt === undefined ? {} : { settledAt: params.settledAt }),
    ...(complianceHash === undefined ? {} : { complianceHash }),
    ...(signature === undefined ? {} : { signature }),
    ...(signerPublicKey === undefined ? {} : { signerPublicKey }),
  };
  return receipt;
}

/** Structural + field validation for a receipt arriving from storage or an API. */
export function validateSettlementReceipt(receipt: unknown): SettlementReceiptValidation {
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) {
    return invalid(ReceiptErrorCode.SHAPE_INVALID, "Settlement receipt must be an object.");
  }
  const record = receipt as Record<string, unknown>;
  if ("viewKeyId" in record) {
    return invalid(
      ReceiptErrorCode.VIEW_KEY_UNSUPPORTED,
      "Settlement receipts do not support view-key identifiers.",
    );
  }
  if (!isValidReceiptId(record.receiptId)) {
    return invalid(ReceiptErrorCode.RECEIPT_ID_INVALID, "Settlement receipt id is invalid.");
  }
  if (typeof record.payrollId !== "string" || record.payrollId.trim().length === 0) {
    return invalid(ReceiptErrorCode.PAYROLL_ID_INVALID, "Settlement receipt is missing its payroll id.");
  }
  if (
    record.settlementStatus !== "settled" &&
    record.settlementStatus !== "confirmed" &&
    record.settlementStatus !== "pending" &&
    record.settlementStatus !== "rejected" &&
    record.settlementStatus !== "unknown"
  ) {
    return invalid(ReceiptErrorCode.STATUS_INVALID, "Settlement receipt status is invalid.");
  }
  const reference = record.transactionReference;
  const txHash =
    typeof reference === "string"
      ? reference
      : typeof reference === "object" && reference !== null && "txHash" in reference
        ? reference.txHash
        : undefined;
  if (!isValidIntentHash(txHash)) {
    return invalid(
      ReceiptErrorCode.INTENT_HASH_INVALID,
      "Settlement receipt reference must be a base58 intent hash.",
    );
  }
  if (!isHex64(record.metadataDigest)) {
    return invalid(
      ReceiptErrorCode.METADATA_DIGEST_INVALID,
      "Settlement receipt metadata digest must be a 64-character hexadecimal string.",
    );
  }
  if (record.complianceHash !== undefined && !isHex64(record.complianceHash)) {
    return invalid(
      ReceiptErrorCode.COMPLIANCE_HASH_INVALID,
      "Settlement receipt compliance hash must be a 64-character hexadecimal string.",
    );
  }
  if ((record.signature === undefined) !== (record.signerPublicKey === undefined)) {
    return invalid(
      ReceiptErrorCode.SIGNATURE_PAIR_REQUIRED,
      "Settlement receipt must carry both a signature and its signer public key.",
    );
  }
  const signature = record.signature;
  const signerPublicKey = record.signerPublicKey;
  if (signature !== undefined && signerPublicKey !== undefined) {
    if (
      typeof signature !== "string" ||
      typeof signerPublicKey !== "string" ||
      !isEd25519(signature, 64) ||
      !isEd25519(signerPublicKey, 32)
    ) {
      return invalid(
        ReceiptErrorCode.SIGNATURE_INVALID,
        "Settlement receipt signature fields must be ed25519 base58 values.",
      );
    }
  }
  if (!isValidTimestamp(record.issuedAt)) {
    return invalid(ReceiptErrorCode.TIMESTAMP_INVALID, "Settlement receipt issuedAt is invalid.");
  }
  if (record.settledAt !== undefined && !isValidTimestamp(record.settledAt)) {
    return invalid(ReceiptErrorCode.TIMESTAMP_INVALID, "Settlement receipt settledAt is invalid.");
  }
  return { ok: true };
}

export function isSettlementReceiptValid(receipt: unknown): boolean {
  return validateSettlementReceipt(receipt).ok;
}

/**
 * Deterministic hash over an audit hold set, sorted by hold id. Used as the
 * receipt `complianceHash`; contains no amounts or salary data.
 */
export function computeComplianceHash(holds: readonly AuditHoldRef[]): string {
  if (!Array.isArray(holds)) {
    throw new ReceiptError(ReceiptErrorCode.SHAPE_INVALID, "Audit hold set must be an array.");
  }
  const seen = new Set<string>();
  const rows: unknown[][] = [];
  for (const ref of holds) {
    if (typeof ref !== "object" || ref === null) {
      throw new ReceiptError(ReceiptErrorCode.SHAPE_INVALID, "Audit hold reference must be an object.");
    }
    assertHoldId(ref.holdId);
    if (seen.has(ref.holdId)) {
      throw new ReceiptError(ReceiptErrorCode.COMPLIANCE_HASH_INVALID, "Audit hold ids must be unique.");
    }
    seen.add(ref.holdId);
    const hold = ref.hold;
    if (typeof hold !== "object" || hold === null) {
      throw new ReceiptError(ReceiptErrorCode.SHAPE_INVALID, "Audit hold entry must be an object.");
    }
    rows.push([
      ref.holdId,
      hold.employer,
      hold.scope,
      hold.scope_id,
      hold.reason_code,
      hold.state,
      hold.placed_by,
      hold.placed_at,
      hold.released_by,
      hold.released_at,
      hold.release_reason,
    ]);
  }
  rows.sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  return sha256Hex(JSON.stringify(rows));
}

/**
 * Intent hashes are base58 (32-byte digest); 64-hex is also accepted for
 * fixtures and legacy receipts.
 */
export function isValidIntentHash(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    return false;
  }
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return true;
  }
  if (value.length < 32 || value.length > 64) {
    return false;
  }
  try {
    return decodeBase58(value).length === 32;
  } catch {
    return false;
  }
}

function normalizeReceiptStatus(status: string): ReceiptSettlementStatus {
  if (typeof status !== "string" || status.trim().length === 0) {
    throw new ReceiptError(ReceiptErrorCode.STATUS_INVALID, "Receipt status must be a non-empty string.");
  }
  const normalized = status.trim().toLowerCase();
  if (
    normalized === "settled" ||
    normalized === "confirmed" ||
    normalized === "pending" ||
    normalized === "rejected" ||
    normalized === "unknown"
  ) {
    return normalized;
  }
  return mapExecutionStatus(status);
}

function assertReceiptId(value: unknown): asserts value is string {
  if (!isValidReceiptId(value)) {
    throw new ReceiptError(ReceiptErrorCode.RECEIPT_ID_INVALID, "Receipt id must be a safe identifier.");
  }
}

function isValidReceiptId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function assertPayrollId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ReceiptError(ReceiptErrorCode.PAYROLL_ID_INVALID, "Payroll id must be a short printable string.");
  }
}

function assertIntentHash(value: unknown): asserts value is string {
  if (!isValidIntentHash(value)) {
    throw new ReceiptError(
      ReceiptErrorCode.INTENT_HASH_INVALID,
      "Transaction reference must be the base58 intent hash.",
    );
  }
}

function assertHoldId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ReceiptError(ReceiptErrorCode.COMPLIANCE_HASH_INVALID, "Audit hold id is invalid.");
  }
}

function assertSignaturePair(signature: unknown, publicKey: unknown): void {
  if (typeof signature !== "string" || typeof publicKey !== "string") {
    throw new ReceiptError(
      ReceiptErrorCode.SIGNATURE_PAIR_REQUIRED,
      "A receipt signature requires both the signature and its signer public key.",
    );
  }
  if (!isEd25519(signature, 64)) {
    throw new ReceiptError(
      ReceiptErrorCode.SIGNATURE_INVALID,
      "Receipt signature must be an ed25519 base58 value.",
    );
  }
  if (!isEd25519(publicKey, 32)) {
    throw new ReceiptError(
      ReceiptErrorCode.SIGNATURE_INVALID,
      "Receipt signer public key must be an ed25519 base58 value.",
    );
  }
}

function isEd25519(value: string, expectedBytes: 32 | 64): boolean {
  if (!value.startsWith("ed25519:")) {
    return false;
  }
  try {
    return decodeBase58(value.slice("ed25519:".length)).length === expectedBytes;
  } catch {
    return false;
  }
}

function normalizeHash64(value: unknown, code: ReceiptErrorCode, field: string): string {
  if (!isHex64(value)) {
    throw new ReceiptError(code, `${field} must be a 64-character hexadecimal digest.`);
  }
  return value.toLowerCase();
}

function isHex64(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
}

function assertTimestamp(value: unknown, field: string): void {
  if (!isValidTimestamp(value)) {
    throw new ReceiptError(ReceiptErrorCode.TIMESTAMP_INVALID, `${field} must be an ISO string or epoch number.`);
  }
}

function isValidTimestamp(value: unknown): boolean {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return Number.isFinite(Date.parse(value));
  }
  return false;
}

function invalid(code: ReceiptErrorCode, message: string): SettlementReceiptValidation {
  return { ok: false, code, message };
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function decodeBase58(value: string): Uint8Array {
  if (value.length === 0) {
    throw new Error("empty base58");
  }
  let zeros = 0;
  while (zeros < value.length && value[zeros] === "1") {
    zeros += 1;
  }
  let numeric = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) {
      throw new Error("invalid base58");
    }
    numeric = numeric * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (numeric > 0n) {
    bytes.push(Number(numeric & 0xffn));
    numeric >>= 8n;
  }
  bytes.reverse();
  const out = new Uint8Array(zeros + bytes.length);
  out.set(bytes, zeros);
  return out;
}
