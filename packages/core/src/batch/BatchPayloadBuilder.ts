/**
 * NEAR batch payload validation.
 *
 * A `BatchPaymentEntry` is one confidential payroll line: the on-chain
 * commitment (`employee`, `commitment_hash`, `cycle_id`) plus the private
 * witness fields (`amount`, `salt`) and settlement metadata (`asset`, `memo`)
 * that only ever live in the private store and in the in-memory payout request.
 *
 * Validation is synchronous and never echoes a rejected value: account ids,
 * amounts, and salts are reported through stable codes and generic messages,
 * so a validation error is safe to log or return to a dashboard.
 */

import { SubrosaError } from "../core/errors.js";
import { validateNearAccountId } from "../settlement/destination.js";

/** Maximum value of a `u128` amount (smallest token units). */
export const U128_MAX = (1n << 128n) - 1n;

/** Maximum accepted salt length in bytes (the contract stores `Vec<u8>`). */
export const MAX_SALT_BYTES = 64;

/** One payout line ready for batch commit and confidential settlement. */
export interface BatchPaymentEntry {
  /** Employee NEAR account id (implicit 64-hex accounts are valid ids too). */
  employee: string;
  /** Commitment hash as a 64-character hex string (on-chain value). */
  commitment_hash: string;
  /** Salary cycle id (`u64`; must stay within the safe-integer range). */
  cycle_id: number;
  /** Amount in the asset's smallest units, `0 < amount <= u128::MAX`. */
  amount: bigint;
  /** Commitment salt, hex encoded (1–64 bytes). Never leaves the private store. */
  salt: string;
  /** NEP-141 contract account id, or an Intents asset id (`nep141:`/`nep245:`). */
  asset: string;
  /** On-chain memo; may be empty. */
  memo: string;
}

/** Validated batch plus the aggregate amount. */
export interface BatchPayload {
  entries: BatchPaymentEntry[];
  totalAmount: bigint;
}

/** Stable validation codes; safe to branch on in callers. */
export type BatchErrorCode =
  | "EMPTY_BATCH"
  | "INVALID_EMPLOYEE"
  | "INVALID_COMMITMENT_HASH"
  | "INVALID_CYCLE_ID"
  | "INVALID_AMOUNT"
  | "INVALID_SALT"
  | "MISSING_ASSET"
  | "INVALID_ASSET"
  | "INVALID_MEMO"
  | "DUPLICATE_COMMITMENT"
  | "DUPLICATE_EMPLOYEE_CYCLE";

/** One privacy-safe validation problem. */
export interface BatchValidationError {
  code: BatchErrorCode;
  message: string;
  field: string;
  index?: number;
}

/** Thrown by {@link BatchPayloadBuilder.build} when any entry is invalid. */
export class BatchValidationFailedError extends SubrosaError {
  constructor(public readonly validationErrors: BatchValidationError[]) {
    super(
      `Batch validation failed with ${validationErrors.length} error(s)`,
      "BATCH_VALIDATION_FAILED"
    );
    this.name = "BatchValidationFailedError";
  }
}

/** Intents asset-id prefixes accepted alongside plain NEP-141 account ids. */
const INTENTS_ASSET_PREFIXES: readonly string[] = ["nep141:", "nep245:"];

const COMMITMENT_HASH_PATTERN = /^[0-9a-fA-F]{64}$/;
const HEX_PATTERN = /^[0-9a-fA-F]+$/;

/**
 * True when the value is a NEAR account id or an Intents asset id
 * (`nep141:<account>` / `nep245:<account>`). Intents ids come from
 * `GET /v0/tokens`, never hand-constructed.
 */
export function isValidNearAssetId(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const prefix = INTENTS_ASSET_PREFIXES.find((candidate) => value.startsWith(candidate));
  const accountPart = prefix === undefined ? value : value.slice(prefix.length);
  return validateNearAccountId(accountPart).ok;
}

function normalizeSalt(salt: unknown): string | undefined {
  if (typeof salt !== "string" || salt.length === 0 || salt.length % 2 !== 0) {
    return undefined;
  }
  if (!HEX_PATTERN.test(salt)) return undefined;
  return salt.length <= MAX_SALT_BYTES * 2 ? salt : undefined;
}

/**
 * Validates an array of batch entries.
 *
 * @returns Structured errors; an empty array means the batch is valid.
 */
export function validateBatchPayload(entries: readonly BatchPaymentEntry[]): BatchValidationError[] {
  const builder = new BatchPayloadBuilder();
  builder.addMany(entries);
  return builder.validate();
}

/**
 * Fluent builder for composing and validating confidential payroll batches.
 *
 * @example
 * const payload = new BatchPayloadBuilder()
 *   .add({ employee: "alice.near", commitment_hash, cycle_id: 1, amount: 100n,
 *          salt, asset: "usdc.near", memo: "June" })
 *   .build(); // throws BatchValidationFailedError when invalid
 */
export class BatchPayloadBuilder {
  private readonly entries: BatchPaymentEntry[] = [];

  /** Appends a single payment entry. */
  add(entry: BatchPaymentEntry): this {
    this.entries.push({ ...entry });
    return this;
  }

  /** Appends multiple payment entries. */
  addMany(entries: readonly BatchPaymentEntry[]): this {
    for (const entry of entries) {
      this.add(entry);
    }
    return this;
  }

  /** Validates all entries without building. */
  validate(): BatchValidationError[] {
    const errors: BatchValidationError[] = [];

    if (this.entries.length === 0) {
      errors.push({
        code: "EMPTY_BATCH",
        message: "Batch must contain at least one payment entry",
        field: "entries",
      });
      return errors;
    }

    const seenCommitments = new Map<string, number>();
    const seenEmployeeCycles = new Map<string, number>();

    for (let index = 0; index < this.entries.length; index++) {
      const entry = this.entries[index];

      const employeeCheck = validateNearAccountId(entry.employee);
      if (!employeeCheck.ok) {
        errors.push({
          code: "INVALID_EMPLOYEE",
          message: `Employee account id is invalid (${employeeCheck.code}).`,
          field: "employee",
          index,
        });
      }

      if (typeof entry.commitment_hash !== "string" || !COMMITMENT_HASH_PATTERN.test(entry.commitment_hash)) {
        errors.push({
          code: "INVALID_COMMITMENT_HASH",
          message: "Commitment hash must be a 64-character hex string.",
          field: "commitment_hash",
          index,
        });
      } else {
        const normalized = entry.commitment_hash.toLowerCase();
        const firstIndex = seenCommitments.get(normalized);
        if (firstIndex !== undefined) {
          errors.push({
            code: "DUPLICATE_COMMITMENT",
            message: `Commitment hash duplicates the entry at index ${firstIndex}. A commitment must never be submitted twice in one batch.`,
            field: "commitment_hash",
            index,
          });
        } else {
          seenCommitments.set(normalized, index);
        }
      }

      if (
        typeof entry.cycle_id !== "number" ||
        !Number.isSafeInteger(entry.cycle_id) ||
        entry.cycle_id < 0
      ) {
        errors.push({
          code: "INVALID_CYCLE_ID",
          message: "Cycle id must be a non-negative safe integer (u64 range).",
          field: "cycle_id",
          index,
        });
      } else if (employeeCheck.ok) {
        const cycleKey = `${employeeCheck.destination}\u0000${entry.cycle_id}`;
        const firstIndex = seenEmployeeCycles.get(cycleKey);
        if (firstIndex !== undefined) {
          errors.push({
            code: "DUPLICATE_EMPLOYEE_CYCLE",
            message: `Employee already has a commitment for this cycle at index ${firstIndex}. Two commitments for one cycle would overwrite on-chain state.`,
            field: "cycle_id",
            index,
          });
        } else {
          seenEmployeeCycles.set(cycleKey, index);
        }
      }

      if (typeof entry.amount !== "bigint" || entry.amount <= 0n || entry.amount > U128_MAX) {
        errors.push({
          code: "INVALID_AMOUNT",
          message: "Amount must be a positive bigint in smallest units, at most u128::MAX.",
          field: "amount",
          index,
        });
      }

      if (normalizeSalt(entry.salt) === undefined) {
        errors.push({
          code: "INVALID_SALT",
          message: `Salt must be a non-empty even-length hex string of at most ${MAX_SALT_BYTES} bytes.`,
          field: "salt",
          index,
        });
      }

      if (typeof entry.asset !== "string" || entry.asset.trim() === "") {
        errors.push({
          code: "MISSING_ASSET",
          message: "Asset identifier is required.",
          field: "asset",
          index,
        });
      } else if (!isValidNearAssetId(entry.asset)) {
        errors.push({
          code: "INVALID_ASSET",
          message: 'Asset must be a NEAR account id or an Intents asset id ("nep141:" / "nep245:" prefix).',
          field: "asset",
          index,
        });
      }

      if (typeof entry.memo !== "string") {
        errors.push({
          code: "INVALID_MEMO",
          message: "Memo must be a string (use an empty string when there is no memo).",
          field: "memo",
          index,
        });
      }
    }

    return errors;
  }

  /**
   * Validates all entries and returns the immutable payload.
   *
   * @throws {BatchValidationFailedError} when any validation error is present.
   */
  build(): BatchPayload {
    const errors = this.validate();
    if (errors.length > 0) {
      throw new BatchValidationFailedError(errors);
    }

    const totalAmount = this.entries.reduce((sum, entry) => sum + entry.amount, 0n);
    return {
      entries: this.entries.map((entry) => ({ ...entry })),
      totalAmount,
    };
  }
}
