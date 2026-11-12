/**
 * Duplicate detection for confidential payroll batches.
 *
 * Commitments are the strongest identity: two entries with the same
 * `commitment_hash` are a double-submission signal and must be rejected before
 * any settlement. Summaries mask employee ids and never print amounts.
 */

import type { BatchPaymentEntry } from "./BatchPayloadBuilder.js";

/** Fields usable as deduplication identity keys. */
export type DeduplicationKey = "employee" | "commitment_hash" | "asset" | "amount";

/** A group of entries that share one key value. */
export interface DuplicateGroup {
  key: DeduplicationKey;
  value: string | bigint;
  indices: number[];
}

/** Result of duplicate detection. */
export interface DeduplicationResult {
  duplicates: DuplicateGroup[];
  hasDuplicates: boolean;
}

/** Validation problem in the deduplication request itself. */
export interface DeduplicationValidationError {
  code: "INVALID_KEY" | "EMPTY_ENTRIES" | "MISSING_FIELD";
  message: string;
  field?: string;
}

const VALID_KEYS: readonly DeduplicationKey[] = [
  "employee",
  "commitment_hash",
  "asset",
  "amount",
];

/** Validates deduplication configuration and input data. */
export function validateDeduplicationInput(
  entries: readonly BatchPaymentEntry[],
  keys: readonly DeduplicationKey[]
): DeduplicationValidationError | null {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { code: "EMPTY_ENTRIES", message: "Batch entries array is empty or undefined" };
  }

  if (!Array.isArray(keys) || keys.length === 0) {
    return { code: "INVALID_KEY", message: "At least one deduplication key must be provided" };
  }

  for (const key of keys) {
    if (!VALID_KEYS.includes(key)) {
      return {
        code: "INVALID_KEY",
        message: `Invalid deduplication key: ${String(key)}. Valid keys are: ${VALID_KEYS.join(", ")}`,
        field: String(key),
      };
    }
  }

  for (const key of keys) {
    for (let index = 0; index < entries.length; index++) {
      const value = (entries[index] as unknown as Record<string, unknown>)[key];
      if (value === undefined || value === null) {
        return {
          code: "MISSING_FIELD",
          message: `Entry at index ${index} is missing required field: ${key}`,
          field: key,
        };
      }
    }
  }

  return null;
}

/** Masks a value for safe display: amounts are fully hidden, ids partially. */
function redactSensitiveValue(value: string | bigint): string {
  if (typeof value === "bigint") {
    return "[redacted amount]";
  }
  if (value.length <= 8) {
    return "[redacted]";
  }
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/**
 * Detect duplicate groups across the configured identity keys.
 *
 * @throws {Error} when the input fails {@link validateDeduplicationInput}.
 */
export function detectDuplicates(
  entries: readonly BatchPaymentEntry[],
  keys: readonly DeduplicationKey[] = ["commitment_hash"]
): DeduplicationResult {
  const validationError = validateDeduplicationInput(entries, keys);
  if (validationError) {
    throw new Error(`Deduplication validation failed: ${validationError.message}`);
  }

  const duplicates: DuplicateGroup[] = [];

  for (const key of keys) {
    const seen = new Map<string, number[]>();

    for (let index = 0; index < entries.length; index++) {
      const raw = entries[index][key];
      const normalized =
        typeof raw === "bigint" ? raw.toString() : String(raw).toLowerCase();
      const existing = seen.get(normalized);
      if (existing) {
        existing.push(index);
      } else {
        seen.set(normalized, [index]);
      }
    }

    for (const [normalized, indices] of seen) {
      if (indices.length > 1) {
        const raw = entries[indices[0]][key];
        duplicates.push({
          key,
          value: typeof raw === "bigint" ? raw : normalized,
          indices,
        });
      }
    }
  }

  return { duplicates, hasDuplicates: duplicates.length > 0 };
}

/** Privacy-safe summary of duplicate detection results. */
export function formatDeduplicationSummary(result: DeduplicationResult): string {
  if (!result.hasDuplicates) {
    return "No duplicates detected in batch.";
  }

  const summary = result.duplicates.map((duplicate) => {
    return `Duplicate ${duplicate.key}: ${redactSensitiveValue(duplicate.value)} at indices [${duplicate.indices.join(", ")}]`;
  });

  return `Duplicates detected:\n${summary.join("\n")}`;
}
