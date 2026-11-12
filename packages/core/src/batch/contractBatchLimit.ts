/**
 * Contract batch limit.
 *
 * `batch_commit_salaries` accepts at most 50 items per call. The limit is
 * storage-bound, not gas-bound: 50 commitments cost roughly 0.091 NEAR in
 * storage deposit (~182 B per record at 1e19 yoctoNEAR/byte). Keeping the SDK
 * split at the same cap means a batch produced here is never rejected on-chain
 * for size.
 *
 * Messages contain aggregate counts only — never salaries, amounts, or ids.
 */

import {
  validateBatchPayload,
  type BatchPaymentEntry,
  type BatchValidationError,
} from "./BatchPayloadBuilder.js";

/** Maximum payout/commit entries accepted by one contract call. */
export const CONTRACT_MAX_PAYOUT_BATCH_SIZE = 50;

/** Options for {@link splitPayoutBatchByContractLimit}. */
export interface ContractBatchLimitOptions {
  /** Maximum entries per sub-batch; defaults to {@link CONTRACT_MAX_PAYOUT_BATCH_SIZE}. */
  maxBatchSize?: number;
}

/** Result of splitting a payout batch against the contract limit. */
export interface ContractBatchSplitResult {
  /** Sub-batches, each at most `maxBatchSize` entries long. */
  chunks: BatchPaymentEntry[][];
  /** `true` when the input was larger than `maxBatchSize` and got split. */
  wasSplit: boolean;
  /** Number of payout entries in the input. */
  totalEntries: number;
  /** The limit that was applied. */
  maxBatchSize: number;
  /** Privacy-safe validation errors if the input failed validation. */
  errors: BatchValidationError[];
}

/** Thrown when the configured contract batch limit is not usable. */
export class ContractBatchLimitError extends Error {
  readonly code = "INVALID_CONTRACT_BATCH_SIZE";

  constructor(maxBatchSize: number) {
    super(
      `Invalid contract batch limit: ${maxBatchSize}. maxBatchSize must be a positive integer.`
    );
    this.name = "ContractBatchLimitError";
  }
}

/**
 * Validates a payout batch and splits it into contract-sized sub-batches.
 *
 * @throws {ContractBatchLimitError} when `maxBatchSize` is not a positive integer.
 */
export function splitPayoutBatchByContractLimit(
  entries: readonly BatchPaymentEntry[],
  options: ContractBatchLimitOptions = {}
): ContractBatchSplitResult {
  const maxBatchSize = options.maxBatchSize ?? CONTRACT_MAX_PAYOUT_BATCH_SIZE;

  if (!Number.isInteger(maxBatchSize) || maxBatchSize <= 0) {
    throw new ContractBatchLimitError(maxBatchSize);
  }

  if (entries.length === 0) {
    return {
      chunks: [],
      wasSplit: false,
      totalEntries: 0,
      maxBatchSize,
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
    return {
      chunks: [],
      wasSplit: false,
      totalEntries: entries.length,
      maxBatchSize,
      errors,
    };
  }

  const chunks: BatchPaymentEntry[][] = [];
  for (let index = 0; index < entries.length; index += maxBatchSize) {
    chunks.push(entries.slice(index, index + maxBatchSize));
  }

  return {
    chunks,
    wasSplit: chunks.length > 1,
    totalEntries: entries.length,
    maxBatchSize,
    errors: [],
  };
}

/** Whether a payout batch exceeds the contract limit and must be split. */
export function exceedsContractBatchLimit(
  entryCount: number,
  maxBatchSize: number = CONTRACT_MAX_PAYOUT_BATCH_SIZE
): boolean {
  return entryCount > maxBatchSize;
}
