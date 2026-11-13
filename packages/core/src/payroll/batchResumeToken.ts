/**
 * Opaque, privacy-safe resume tokens for interrupted batch submissions.
 *
 * A token carries a deterministic commitment of the exact entries collection
 * plus positional bookkeeping (next batch index, item counts, batch size) and
 * a corruption checksum. It never contains account ids, amounts, salts, or
 * memos — only a non-reversible hash and numbers.
 *
 * The checksum is an integrity check against accidental corruption, not a
 * MAC: tokens are local state. Every field is range-checked and cross-checked
 * (batch count, processed count) before a checkpoint is trusted to skip work.
 */

import { computeBatchEntriesCommitment } from "../batch/commitment.js";
import { assertValidPageSize, iterateBatches } from "../batch/paginate.js";
import { ValidationError } from "../core/errors.js";
import { sha256Hex } from "../crypto/hashUtils.js";

/** Current resume-token schema version. */
export const RESUME_TOKEN_VERSION = 1 as const;

/** Token prefix: `sbbr1.<base64url payload>.<checksum>`. */
export const RESUME_TOKEN_PREFIX = "sbbr1";

/** Stable error codes for resume-token failures. */
export const RESUME_TOKEN_ERROR_CODE = {
  MALFORMED: "BATCH_RESUME_TOKEN_MALFORMED",
  ENTRIES_MISMATCH: "BATCH_RESUME_TOKEN_ENTRIES_MISMATCH",
  BATCH_SIZE_MISMATCH: "BATCH_RESUME_TOKEN_BATCH_SIZE_MISMATCH",
  OUT_OF_RANGE: "BATCH_RESUME_TOKEN_OUT_OF_RANGE",
  INCONSISTENT: "BATCH_RESUME_TOKEN_INCONSISTENT",
} as const;

export type ResumeTokenErrorCode =
  (typeof RESUME_TOKEN_ERROR_CODE)[keyof typeof RESUME_TOKEN_ERROR_CODE];

/** Decoded, privacy-safe checkpoint state. */
export interface BatchResumeCheckpoint {
  version: typeof RESUME_TOKEN_VERSION;
  /** Zero-based index of the next batch to submit. */
  nextBatchIndex: number;
  /** Items successfully processed before this checkpoint. */
  itemsProcessed: number;
  /** Items in the original submission. */
  totalItems: number;
  /** Batches in the original submission plan. */
  totalBatches: number;
  /** Batch size used for the original plan. */
  batchSize: number;
  /** Deterministic, non-reversible commitment of the entries collection. */
  entriesCommitment: string;
  /** Epoch milliseconds when the checkpoint was created. */
  createdAt: number;
}

/** Result of validating a token against a fresh entries collection. */
export interface ResumeStartPoint {
  startBatchIndex: number;
  itemsAlreadyProcessed: number;
  checkpoint: BatchResumeCheckpoint;
}

/** Options for token creation/decoding (injectable clock for tests). */
export interface ResumeTokenOptions {
  now?: () => number;
}

const COMMITMENT_PATTERN = /^[0-9a-f]{64}$/;

function checksumPayload(payload: string): string {
  return sha256Hex(payload).slice(0, 16);
}

function totalBatchesFor(totalItems: number, batchSize: number): number {
  return totalItems === 0 ? 0 : Math.ceil(totalItems / batchSize);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Creates an opaque resume token for a sequential batch submission.
 *
 * @throws {ValidationError} when the counters are not consistent with the
 *   entries collection and batch size.
 */
export function createBatchResumeToken<T>(
  entries: readonly T[],
  nextBatchIndex: number,
  itemsProcessed: number,
  totalBatches: number,
  batchSize: number,
  options: ResumeTokenOptions = {}
): string {
  assertValidPageSize(batchSize);

  const totalItems = entries.length;
  const expectedBatches = totalBatchesFor(totalItems, batchSize);
  const expectedItemsProcessed = Math.min(nextBatchIndex * batchSize, totalItems);

  if (
    !isNonNegativeSafeInteger(nextBatchIndex) ||
    !isNonNegativeSafeInteger(itemsProcessed) ||
    nextBatchIndex > expectedBatches ||
    itemsProcessed !== expectedItemsProcessed ||
    totalBatches !== expectedBatches
  ) {
    throw new ValidationError(
      "Batch resume checkpoint counters are inconsistent with the entries and batch size.",
      "resumeToken",
      RESUME_TOKEN_ERROR_CODE.INCONSISTENT
    );
  }

  const checkpoint: BatchResumeCheckpoint = {
    version: RESUME_TOKEN_VERSION,
    nextBatchIndex,
    itemsProcessed,
    totalItems,
    totalBatches,
    batchSize,
    entriesCommitment: computeBatchEntriesCommitment(entries),
    createdAt: (options.now ?? Date.now)(),
  };

  const payload = JSON.stringify(checkpoint);
  return `${RESUME_TOKEN_PREFIX}.${Buffer.from(payload, "utf8").toString("base64url")}.${checksumPayload(payload)}`;
}

/**
 * Decodes and structurally validates a resume token without checking it
 * against any entries collection.
 *
 * @throws {ValidationError} when the token is malformed, tampered with,
 *   from an unsupported version, or internally inconsistent.
 */
export function decodeBatchResumeToken(token: string): BatchResumeCheckpoint {
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new ValidationError(
      "Batch resume token must be a non-empty string.",
      "resumeToken",
      RESUME_TOKEN_ERROR_CODE.MALFORMED
    );
  }

  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== RESUME_TOKEN_PREFIX) {
    throw new ValidationError(
      "Batch resume token is malformed or from an unsupported version.",
      "resumeToken",
      RESUME_TOKEN_ERROR_CODE.MALFORMED
    );
  }

  const [, encoded, checksum] = parts;

  let payload: string;
  try {
    payload = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    throw new ValidationError(
      "Batch resume token could not be decoded.",
      "resumeToken",
      RESUME_TOKEN_ERROR_CODE.MALFORMED
    );
  }

  if (checksumPayload(payload) !== checksum) {
    throw new ValidationError(
      "Batch resume token failed integrity verification and may be corrupted or tampered with.",
      "resumeToken",
      RESUME_TOKEN_ERROR_CODE.MALFORMED
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new ValidationError(
      "Batch resume token could not be parsed.",
      "resumeToken",
      RESUME_TOKEN_ERROR_CODE.MALFORMED
    );
  }

  const checkpoint = parsed as Partial<BatchResumeCheckpoint>;
  const {
    version,
    nextBatchIndex,
    itemsProcessed,
    totalItems,
    totalBatches,
    batchSize,
    entriesCommitment,
    createdAt,
  } = checkpoint;
  const structurallyValid =
    version === RESUME_TOKEN_VERSION &&
    isNonNegativeSafeInteger(nextBatchIndex) &&
    isNonNegativeSafeInteger(itemsProcessed) &&
    isNonNegativeSafeInteger(totalItems) &&
    isNonNegativeSafeInteger(totalBatches) &&
    isNonNegativeSafeInteger(batchSize) &&
    batchSize > 0 &&
    typeof entriesCommitment === "string" &&
    COMMITMENT_PATTERN.test(entriesCommitment) &&
    isNonNegativeSafeInteger(createdAt);

  if (!structurallyValid) {
    throw new ValidationError(
      "Batch resume token is missing required fields or from an unsupported version.",
      "resumeToken",
      RESUME_TOKEN_ERROR_CODE.MALFORMED
    );
  }

  const valid = checkpoint as BatchResumeCheckpoint;
  const expectedBatches = totalBatchesFor(valid.totalItems, valid.batchSize);

  if (
    valid.totalBatches !== expectedBatches ||
    valid.nextBatchIndex > valid.totalBatches ||
    valid.itemsProcessed !== Math.min(valid.nextBatchIndex * valid.batchSize, valid.totalItems)
  ) {
    throw new ValidationError(
      "Batch resume token counters are internally inconsistent; the token cannot be trusted.",
      "resumeToken",
      RESUME_TOKEN_ERROR_CODE.INCONSISTENT
    );
  }

  return valid;
}

/**
 * Validates a resume token against the entries collection and batch size the
 * caller is about to submit, returning the batch index/items count to resume
 * from.
 *
 * @throws {ValidationError} when the entries changed, the batch size differs,
 *   or the checkpoint is out of range.
 */
export function resolveResumeStart<T>(
  entries: readonly T[],
  batchSize: number | undefined,
  token: string
): ResumeStartPoint {
  assertValidPageSize(batchSize);
  const checkpoint = decodeBatchResumeToken(token);

  const currentCommitment = computeBatchEntriesCommitment(entries);
  if (currentCommitment !== checkpoint.entriesCommitment) {
    throw new ValidationError(
      "Batch resume token does not match the provided entries. Resume tokens are only valid " +
        "for the exact entries collection the original submission was created for; verify you " +
        "are resuming with the same (unmodified) payroll batch.",
      "resumeToken",
      RESUME_TOKEN_ERROR_CODE.ENTRIES_MISMATCH
    );
  }

  if (checkpoint.totalItems !== entries.length) {
    throw new ValidationError(
      "Batch resume token was created for a different number of entries.",
      "resumeToken",
      RESUME_TOKEN_ERROR_CODE.ENTRIES_MISMATCH
    );
  }

  const effectiveBatchSize = batchSize ?? entries.length;
  if (effectiveBatchSize !== checkpoint.batchSize) {
    throw new ValidationError(
      `Batch resume token was created with batchSize=${checkpoint.batchSize}, but resume was ` +
        `attempted with batchSize=${effectiveBatchSize}. Resume using the original batch size.`,
      "resumeToken",
      RESUME_TOKEN_ERROR_CODE.BATCH_SIZE_MISMATCH
    );
  }

  const totalBatches = Array.from(iterateBatches(entries, batchSize)).length;
  if (checkpoint.nextBatchIndex < 0 || checkpoint.nextBatchIndex > totalBatches) {
    throw new ValidationError(
      "Batch resume token references a batch index outside the current submission plan.",
      "resumeToken",
      RESUME_TOKEN_ERROR_CODE.OUT_OF_RANGE
    );
  }

  return {
    startBatchIndex: checkpoint.nextBatchIndex,
    itemsAlreadyProcessed: checkpoint.itemsProcessed,
    checkpoint,
  };
}
