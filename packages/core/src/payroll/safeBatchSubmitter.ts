/**
 * Safe sequential batch submission.
 *
 * Submits confidential-payout entries in size-bounded batches with structured
 * progress callbacks and guarded retries. Every value that reaches a progress
 * event, checkpoint, or error detail is privacy-safe: batches are counted, not
 * echoed, and thrown errors pass through the redaction engine first.
 *
 * The injected `submitBatchFn` performs the actual confidential payout
 * (`executePendingPayout` per entry, or a single signed intent for the batch);
 * this module owns ordering, retry classification, cancellation, and resume.
 */

import { assertValidPageSize, iterateBatches } from "../batch/paginate.js";
import { classifyError, RetryCategory } from "../core/retry.js";
import { redactError } from "../redaction/RedactionEngine.js";
import type { PendingPayout } from "../types.js";
import { createBatchResumeToken, resolveResumeStart } from "./batchResumeToken.js";

/** Stages of the sequential batch submission lifecycle. */
export type SafeBatchProgressStage =
  | "validating"
  | "batch_starting"
  | "batch_submitting"
  | "batch_retrying"
  | "batch_completed"
  | "completed"
  | "failed";

/** Structured, privacy-safe progress event. */
export interface SafeBatchProgressEvent {
  stage: SafeBatchProgressStage;
  /** Zero-based index of the current batch. */
  batchIndex: number;
  totalBatches: number;
  /** Items successfully processed so far across all batches. */
  itemsProcessed: number;
  totalItems: number;
  /** Overall completion percentage from 0 to 100. */
  percentage: number;
  /** Sanitized status message. */
  message: string;
  /** ISO timestamp for event ordering. */
  timestamp: string;
  /** 1-based retry attempt when in `batch_retrying`. */
  retryAttempt?: number;
  /** Maximum retries allowed for the batch. */
  maxRetries?: number;
}

/** Actionable error details for a failed batch submission. */
export interface SafeBatchErrorDetail {
  /** Sanitized error message (redaction already applied). */
  message: string;
  /** Stable error code. */
  code: string;
  /** Zero-based index of the batch that failed. */
  failedBatchIndex: number;
  /** Batches that succeeded before the failure. */
  batchesSucceeded: number;
  /** Items successfully processed before the failure. */
  itemsSucceeded: number;
  /** Operator-facing remediation guidance. */
  actionableGuidance: string;
  /**
   * Opaque resume token to pass back via
   * {@link SafeBatchSubmissionOptions.resumeToken}. Omitted when no batch
   * completed successfully before the failure.
   */
  resumeToken?: string;
}

/** Result of one confidential payout, as returned by the injected submitter. */
export interface ConfidentialPayoutResult {
  intentHash: string;
}

/**
 * Executes one batch.
 *
 * The optional `idempotencyKey` is derived from
 * {@link SafeBatchSubmissionOptions.idempotencyKeyPrefix} and the batch index,
 * so a retried batch reuses the caller's own request key.
 */
export type BatchSubmitFn<T, R> = (
  batchItems: T[],
  batchIndex: number,
  idempotencyKey?: string
) => Promise<R[]>;

/** Configuration for safe sequential batch submission. */
export interface SafeBatchSubmissionOptions<_T = PendingPayout, R = ConfidentialPayoutResult> {
  /** Number of items per batch (default: 50). */
  batchSize?: number;
  /** Maximum retry attempts per batch on transient errors (default: 3). */
  maxRetries?: number;
  /** Initial backoff delay in milliseconds (default: 100). */
  initialDelayMs?: number;
  /** Maximum backoff delay in milliseconds (default: 2000). */
  maxDelayMs?: number;
  /** Exponential backoff multiplier (default: 2). */
  backoffFactor?: number;
  /** Cancels remaining submissions between and during batches. */
  signal?: AbortSignal;
  /** Stop immediately on the first failed batch (default: true). */
  stopOnFirstFailure?: boolean;
  /** Prefix for per-batch idempotency keys handed to the submit function. */
  idempotencyKeyPrefix?: string;
  /** Resume token from a previous interrupted call for this exact entries collection. */
  resumeToken?: string;
  /** Progress callback invoked at each milestone. */
  onProgress?: (event: SafeBatchProgressEvent) => void;
  /** Invoked after each batch succeeds with a fresh resume token. */
  onCheckpoint?: (resumeToken: string) => void;
  /** Invoked when a single batch completes successfully. */
  onBatchSuccess?: (batchIndex: number, results: R[]) => void;
  /** Invoked when a batch fails (before retry or final failure). */
  onBatchError?: (batchIndex: number, error: Error, willRetry: boolean) => void;
  /** Injectable sleep for deterministic testing. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable clock for deterministic testing. */
  now?: () => number;
}

/** Result of sequential batch submission. */
export interface SafeBatchSubmissionResult<R = ConfidentialPayoutResult> {
  /** True only when every batch succeeded. */
  success: boolean;
  /** Batches that succeeded. */
  batchesProcessed: number;
  /** Batches in the full plan. */
  totalBatches: number;
  /** Items processed across all successful batches. */
  itemsProcessed: number;
  /** Items submitted in the input collection. */
  totalItems: number;
  /** Ordered results from all successful batches. */
  results: R[];
  /** Zero-based index of the first failed batch, if any. */
  failedBatchIndex?: number;
  /** Error detail for the first failure, if any. */
  error?: SafeBatchErrorDetail;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 2000;
const DEFAULT_BACKOFF_FACTOR = 2;

/** Default abortable sleep. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Batch submission was cancelled via AbortSignal."));
      return;
    }
    const cleanup = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("Batch submission was cancelled via AbortSignal."));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Submits an ordered collection of confidential payout entries in sequential,
 * size-bounded batches with progress tracking and guarded retries.
 *
 * @param entries - Payout entries to process (amount and salt stay in memory).
 * @param submitBatchFn - Executes one batch and returns its per-entry results.
 * @param options - Batching, retry, cancellation, and callback configuration.
 */
export async function submitSequentialPayrollBatches<
  T = PendingPayout,
  R = ConfidentialPayoutResult,
>(
  entries: readonly T[],
  submitBatchFn: BatchSubmitFn<T, R>,
  options: SafeBatchSubmissionOptions<T, R> = {}
): Promise<SafeBatchSubmissionResult<R>> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  assertValidPageSize(batchSize);

  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const initialDelay = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelay = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const backoffFactor = options.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;
  const stopOnFirstFailure = options.stopOnFirstFailure ?? true;
  const sleepImpl = options.sleep ?? defaultSleep;
  const signal = options.signal;
  const now = options.now ?? Date.now;

  const totalItems = entries.length;

  if (totalItems === 0) {
    options.onProgress?.({
      stage: "completed",
      batchIndex: 0,
      totalBatches: 0,
      itemsProcessed: 0,
      totalItems: 0,
      percentage: 100,
      message: "Batch submission completed: no entries to process.",
      timestamp: new Date(now()).toISOString(),
    });
    return {
      success: true,
      batchesProcessed: 0,
      totalBatches: 0,
      itemsProcessed: 0,
      totalItems: 0,
      results: [],
    };
  }

  const batches = Array.from(iterateBatches(entries, batchSize));
  const totalBatches = batches.length;

  let startBatchIndex = 0;
  let initialItemsProcessed = 0;
  if (options.resumeToken) {
    const resumePoint = resolveResumeStart(entries, batchSize, options.resumeToken);
    startBatchIndex = resumePoint.startBatchIndex;
    initialItemsProcessed = resumePoint.itemsAlreadyProcessed;
  }

  const emitProgress = (
    stage: SafeBatchProgressStage,
    batchIndex: number,
    itemsProcessed: number,
    message: string,
    retryAttempt?: number
  ) => {
    const percentage = Math.min(100, Math.round((itemsProcessed / totalItems) * 100));
    options.onProgress?.({
      stage,
      batchIndex,
      totalBatches,
      itemsProcessed,
      totalItems,
      percentage,
      message,
      timestamp: new Date(now()).toISOString(),
      retryAttempt,
      maxRetries: maxRetries > 0 ? maxRetries : undefined,
    });
  };

  emitProgress(
    "validating",
    startBatchIndex,
    initialItemsProcessed,
    options.resumeToken
      ? `Resuming submission of ${totalItems} payroll item(s) from batch ${startBatchIndex + 1} of ${totalBatches}...`
      : `Validating ${totalItems} payroll item(s) across ${totalBatches} batch(es)...`
  );

  if (startBatchIndex >= totalBatches) {
    emitProgress(
      "completed",
      totalBatches - 1,
      initialItemsProcessed,
      `Resume token indicates all ${totalBatches} batch(es) already completed (${initialItemsProcessed}/${totalItems} items).`
    );
    return {
      success: true,
      batchesProcessed: totalBatches,
      totalBatches,
      itemsProcessed: initialItemsProcessed,
      totalItems,
      results: [],
    };
  }

  const allResults: R[] = [];
  let itemsProcessedCount = initialItemsProcessed;
  let batchesSucceededCount = startBatchIndex;
  let firstFailureIndex: number | undefined;
  let firstFailureDetail: SafeBatchErrorDetail | undefined;

  const makeResumeToken = (nextBatchIndex: number): string =>
    createBatchResumeToken(
      entries,
      nextBatchIndex,
      itemsProcessedCount,
      totalBatches,
      batchSize,
      { now }
    );

  const failureDetail = (
    batchIndex: number,
    message: string,
    code: string,
    guidance: string
  ): SafeBatchErrorDetail => ({
    message,
    code,
    failedBatchIndex: batchIndex,
    batchesSucceeded: batchesSucceededCount,
    itemsSucceeded: itemsProcessedCount,
    actionableGuidance: guidance,
    // A resume token can only represent contiguous progress from the start;
    // with stopOnFirstFailure=false earlier failures create holes.
    resumeToken:
      batchesSucceededCount > 0 && batchesSucceededCount === batchIndex
        ? makeResumeToken(batchIndex)
        : undefined,
  });

  for (const batch of batches.slice(startBatchIndex)) {
    if (signal?.aborted) {
      const detail = failureDetail(
        batch.index,
        "Batch submission was cancelled via AbortSignal.",
        "BATCH_SUBMISSION_CANCELLED",
        batchesSucceededCount > 0
          ? `Submission cancelled. ${batchesSucceededCount} of ${totalBatches} batches succeeded (${itemsProcessedCount} items). Resume from batch index ${batch.index}.`
          : `Submission cancelled before batch ${batch.index} started. No items were submitted.`
      );
      emitProgress("failed", batch.index, itemsProcessedCount, detail.message);
      return {
        success: false,
        batchesProcessed: batchesSucceededCount,
        totalBatches,
        itemsProcessed: itemsProcessedCount,
        totalItems,
        results: allResults,
        failedBatchIndex: batch.index,
        error: detail,
      };
    }

    emitProgress(
      "batch_starting",
      batch.index,
      itemsProcessedCount,
      `Starting batch ${batch.index + 1} of ${totalBatches} (${batch.count} item(s))...`
    );

    let batchSuccess = false;
    let batchResults: R[] = [];
    let lastError: Error | null = null;
    const maxAttempts = Math.max(1, maxRetries + 1);
    const idempotencyKey =
      options.idempotencyKeyPrefix !== undefined
        ? `${options.idempotencyKeyPrefix}:batch:${batch.index}`
        : undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) {
        lastError = new Error("Batch submission was cancelled via AbortSignal.");
        break;
      }

      emitProgress(
        "batch_submitting",
        batch.index,
        itemsProcessedCount,
        `Submitting batch ${batch.index + 1} of ${totalBatches} (attempt ${attempt}/${maxAttempts})...`
      );

      try {
        batchResults = await submitBatchFn(batch.items, batch.index, idempotencyKey);
        batchSuccess = true;
        break;
      } catch (error: unknown) {
        const rawError = error instanceof Error ? error : new Error(String(error));
        // Redact immediately: no amount, salt, or credential may reach a caller.
        const redacted = redactError(rawError);
        lastError = redacted;

        const decision = classifyError(rawError);
        const isNonRetryable =
          decision.category === RetryCategory.NON_RETRYABLE ||
          /validation|invalid|unauthorized|forbidden|signature.*fail|schema/i.test(
            rawError.message
          );
        const willRetry = !isNonRetryable && attempt < maxAttempts && !signal?.aborted;

        options.onBatchError?.(batch.index, redacted, willRetry);

        if (!willRetry) {
          break;
        }

        const delay = Math.min(initialDelay * Math.pow(backoffFactor, attempt - 1), maxDelay);
        emitProgress(
          "batch_retrying",
          batch.index,
          itemsProcessedCount,
          `Batch ${batch.index + 1} failed with a transient error; retrying in ${delay}ms (attempt ${attempt}/${maxRetries})...`,
          attempt
        );

        try {
          await sleepImpl(delay, signal);
        } catch {
          lastError = new Error("Batch submission was cancelled during the backoff delay.");
          break;
        }
      }
    }

    if (batchSuccess) {
      batchesSucceededCount++;
      itemsProcessedCount += batch.count;
      allResults.push(...batchResults);

      options.onBatchSuccess?.(batch.index, batchResults);
      emitProgress(
        "batch_completed",
        batch.index,
        itemsProcessedCount,
        `Batch ${batch.index + 1} of ${totalBatches} completed successfully.`
      );
      if (batchesSucceededCount === batch.index + 1) {
        options.onCheckpoint?.(makeResumeToken(batch.index + 1));
      }
      continue;
    }

    const detail = failureDetail(
      batch.index,
      lastError?.message || "Batch submission failed.",
      "BATCH_SUBMISSION_FAILED",
      batchesSucceededCount > 0
        ? `Batch ${batch.index + 1} failed. ${batchesSucceededCount} previous batch(es) succeeded (${itemsProcessedCount} items). Verify the failure reason and resume from batch index ${batch.index}.`
        : `Batch 1 failed. No items were settled. Verify input parameters and permissions before retrying.`
    );

    emitProgress("failed", batch.index, itemsProcessedCount, detail.message);

    if (firstFailureIndex === undefined) {
      firstFailureIndex = batch.index;
      firstFailureDetail = detail;
    }
    if (stopOnFirstFailure) {
      return {
        success: false,
        batchesProcessed: batchesSucceededCount,
        totalBatches,
        itemsProcessed: itemsProcessedCount,
        totalItems,
        results: allResults,
        failedBatchIndex: batch.index,
        error: detail,
      };
    }
  }

  emitProgress(
    "completed",
    totalBatches - 1,
    itemsProcessedCount,
    firstFailureIndex === undefined
      ? `Successfully processed all ${totalBatches} batch(es) (${itemsProcessedCount}/${totalItems} items).`
      : `Submission finished with failures in ${totalBatches - batchesSucceededCount} batch(es) (${itemsProcessedCount}/${totalItems} items settled).`
  );

  return {
    success: firstFailureIndex === undefined,
    batchesProcessed: batchesSucceededCount,
    totalBatches,
    itemsProcessed: itemsProcessedCount,
    totalItems,
    results: allResults,
    failedBatchIndex: firstFailureIndex,
    error: firstFailureDetail,
  };
}
