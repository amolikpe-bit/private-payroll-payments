/**
 * Chunk validated payroll entries into contract-sized batches.
 *
 * Every entry is validated first; a single invalid entry returns errors and no
 * chunks, so a partially-valid payroll can never be submitted. Validation
 * messages are privacy-safe (no amounts, salts, or account ids).
 */

import {
  validateBatchPayload,
  type BatchPaymentEntry,
  type BatchValidationError,
} from "./BatchPayloadBuilder.js";

/** Chunking configuration. */
export interface ChunkingOptions {
  /** Maximum number of entries per batch chunk. Must be a positive integer. */
  maxBatchSize: number;
}

/** Result of {@link chunkPayoutBatches}. */
export interface ChunkedBatchResult {
  /** Chunks of entries. Empty when validation fails. */
  chunks: BatchPaymentEntry[][];
  /** Privacy-safe validation errors, if any entry failed validation. */
  errors: BatchValidationError[];
}

/**
 * Validates entries and splits them into chunks of at most `maxBatchSize`.
 *
 * @param entries - The payout lines to chunk.
 * @param options - Chunk size configuration.
 * @throws {Error} when `maxBatchSize` is not a positive integer.
 */
export function chunkPayoutBatches(
  entries: readonly BatchPaymentEntry[],
  options: ChunkingOptions
): ChunkedBatchResult {
  if (!Number.isInteger(options.maxBatchSize) || options.maxBatchSize <= 0) {
    throw new Error("Invalid maxBatchSize: must be a positive integer.");
  }

  if (entries.length === 0) {
    return {
      chunks: [],
      errors: [
        {
          code: "EMPTY_BATCH",
          message: "Batch must contain at least one payment entry",
          field: "entries",
        },
      ],
    };
  }

  const errors = validateBatchPayload(entries);
  if (errors.length > 0) {
    return { chunks: [], errors };
  }

  const chunks: BatchPaymentEntry[][] = [];
  for (let index = 0; index < entries.length; index += options.maxBatchSize) {
    chunks.push(entries.slice(index, index + options.maxBatchSize));
  }

  return { chunks, errors: [] };
}
