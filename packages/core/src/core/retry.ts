/**
 * Error classification and promise retry loop.
 *
 * `classifyError` decides whether a failure is worth another attempt at all;
 * `withRetry` is the simple bounded loop used where an operation is safe to
 * repeat (reads, REST calls). Non-idempotent writes go through
 * `core/retry-budget.ts` instead, which refuses to retry without a key.
 */

import {
  ContractErrorCode,
  ContractExecutionError,
  NetworkError,
  ProofGenerationError,
  ValidationError,
  SubrosaError,
  type ErrorContext,
} from "./errors.js";
import { BatchValidationFailedError } from "../batch/BatchPayloadBuilder.js";

export const RetryCategory = {
  RETRYABLE: "RETRYABLE",
  NON_RETRYABLE: "NON_RETRYABLE",
  UNKNOWN: "UNKNOWN",
} as const;

export type RetryCategoryType = (typeof RetryCategory)[keyof typeof RetryCategory];

export interface RetryDecision {
  category: RetryCategoryType;
  retryable: boolean;
  reason: string;
}

function decision(category: RetryCategoryType, reason: string): RetryDecision {
  return { category, retryable: category === RetryCategory.RETRYABLE, reason };
}

/** Classify a thrown value into a retry decision without consuming it. */
export function classifyError(error: unknown, _context?: ErrorContext): RetryDecision {
  if (error instanceof NetworkError) {
    return classifyNetworkError(error);
  }

  if (error instanceof ContractExecutionError) {
    return classifyContractError(error);
  }

  if (error instanceof ProofGenerationError) {
    return decision(
      RetryCategory.NON_RETRYABLE,
      "Proof generation errors are not retryable - they indicate a data or circuit issue",
    );
  }

  if (error instanceof ValidationError) {
    return decision(
      RetryCategory.NON_RETRYABLE,
      "Validation errors are not retryable - they indicate invalid input",
    );
  }

  if (error instanceof BatchValidationFailedError) {
    return decision(
      RetryCategory.NON_RETRYABLE,
      "Batch validation errors are not retryable - they indicate invalid input",
    );
  }

  if (error instanceof SubrosaError) {
    return decision(
      RetryCategory.UNKNOWN,
      `Unrecognized SDK error (code=${error.code}) - retry with caution`,
    );
  }

  if (error instanceof Error) {
    return classifyGenericError(error);
  }

  return decision(RetryCategory.UNKNOWN, "Non-Error thrown value - cannot determine retryability");
}

function classifyNetworkError(error: NetworkError): RetryDecision {
  const code = error.statusCode;

  if (code === undefined) {
    return decision(
      RetryCategory.RETRYABLE,
      "Network error without status code - likely a transient connection issue",
    );
  }

  if (code >= 500) {
    return decision(RetryCategory.RETRYABLE, `Server error (HTTP ${code}) - may succeed on retry`);
  }

  if (code === 429) {
    return decision(RetryCategory.RETRYABLE, "Rate limited (HTTP 429) - retry after backoff");
  }

  if (code >= 400) {
    return decision(
      RetryCategory.NON_RETRYABLE,
      `Client error (HTTP ${code}) - request will fail on retry`,
    );
  }

  return decision(RetryCategory.UNKNOWN, `Unexpected HTTP status (${code}) - retry with caution`);
}

function classifyContractError(error: ContractExecutionError): RetryDecision {
  switch (error.code as ContractErrorCodeTypeLike) {
    case ContractErrorCode.SIMULATION_FAILED:
      return decision(
        RetryCategory.RETRYABLE,
        "Simulation failure is often transient - retry may succeed",
      );

    case ContractErrorCode.TRANSACTION_SUBMISSION_FAILED:
      return decision(
        RetryCategory.RETRYABLE,
        "Transaction submission failure is often transient - retry with backoff",
      );

    case ContractErrorCode.TRANSACTION_TIMEOUT:
      return decision(
        RetryCategory.RETRYABLE,
        "Transaction timeout is transient - retry with backoff",
      );

    case ContractErrorCode.INSUFFICIENT_FEE:
      return decision(
        RetryCategory.NON_RETRYABLE,
        "Insufficient fee requires user intervention - not retryable",
      );

    case ContractErrorCode.CONTRACT_REVERT:
    case ContractErrorCode.CONTRACT_PAUSED:
      return decision(
        RetryCategory.NON_RETRYABLE,
        "Contract rejected the invocation - not retryable",
      );

    case ContractErrorCode.UNKNOWN_RPC_ERROR:
    default:
      return decision(
        RetryCategory.UNKNOWN,
        "Unknown RPC error - retry once with caution, then fail",
      );
  }
}

type ContractErrorCodeTypeLike = string;

const NETWORK_ERROR_PATTERNS = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /network/i,
  /timeout/i,
  /timed\s*out/i,
  /connection/i,
  /socket/i,
  /request\s*failed/i,
];

function classifyGenericError(error: Error): RetryDecision {
  const msg = error.message;

  for (const pattern of NETWORK_ERROR_PATTERNS) {
    if (pattern.test(msg)) {
      return decision(
        RetryCategory.RETRYABLE,
        "Generic error matches a network failure pattern - retryable",
      );
    }
  }

  if (error.name === "AbortError" || error.name === "TimeoutError") {
    return decision(RetryCategory.RETRYABLE, "Request aborted or timed out - retryable");
  }

  return decision(
    RetryCategory.UNKNOWN,
    "Generic Error without known retryable markers - retry with caution",
  );
}

export interface RetryOptions {
  attempts?: number;
  delayMs?: number;
  backoffFactor?: number;
  /** Ordered fallback endpoints tried after the primary attempt. */
  fallbackEndpoints?: string[];
  /** Overall deadline measured from the first attempt. */
  timeoutMs?: number;
  /** Called with the attempts already made when another attempt is scheduled. */
  onRetry?: (attempt: number, error: unknown, decision: RetryDecision) => void;
}

/** Thrown when the overall retry deadline expires before any attempt can run. */
export class RetryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Retry deadline of ${timeoutMs}ms exceeded before any attempt completed`);
    this.name = "RetryTimeoutError";
  }
}

/**
 * Run `fn`, retrying failures that {@link classifyError} considers retryable
 * (or unknown). A NON_RETRYABLE failure stops the loop immediately and is
 * rethrown unchanged, regardless of the remaining attempt budget.
 */
export async function withRetry<T>(
  fn: (endpoint?: string) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 100;
  const backoffFactor = options.backoffFactor ?? 2;
  const timeoutMs = options.timeoutMs;
  const fallbackEndpoints = options.fallbackEndpoints ?? [];

  const startedAt = Date.now();
  let currentDelay = delayMs;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (timeoutMs !== undefined && Date.now() - startedAt >= timeoutMs) {
      throw lastError ?? new RetryTimeoutError(timeoutMs);
    }

    const endpoint = attempt === 1 ? undefined : fallbackEndpoints[attempt - 2];

    try {
      return await fn(endpoint);
    } catch (err) {
      lastError = err;

      if (attempt === attempts) break;

      const retryDecision = classifyError(err);
      if (retryDecision.category === RetryCategory.NON_RETRYABLE) {
        throw err;
      }

      options.onRetry?.(attempt, err, retryDecision);

      if (timeoutMs !== undefined && Date.now() - startedAt + currentDelay >= timeoutMs) {
        throw lastError;
      }

      await new Promise((resolve) => setTimeout(resolve, currentDelay));
      currentDelay *= backoffFactor;
    }
  }

  throw lastError;
}
