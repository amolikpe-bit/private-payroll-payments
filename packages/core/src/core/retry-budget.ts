/**
 * Operation-aware retry budgets.
 *
 * Idempotent reads/polls may retry with bounded exponential backoff; writes
 * are non-idempotent and are capped at one attempt unless the caller supplies
 * an idempotency key. When a key is present, the optional registry dedupes
 * concurrent retries of the same operation so it is never submitted twice.
 */

import { SubrosaError, type ErrorContext } from "./errors.js";
import { IdempotencyRegistry } from "./idempotency.js";
import { classifyError, RetryCategory, type RetryDecision } from "./retry.js";

export const RetryOperationType = {
  READ: "read",
  WRITE: "write",
  POLL: "poll",
} as const;

export type RetryOperationType = (typeof RetryOperationType)[keyof typeof RetryOperationType];

export interface RetryBackoffConfig {
  initialDelayMs: number;
  backoffFactor: number;
  maxDelayMs: number;
  jitterMs: number;
}

export interface RetryBudgetConfig extends RetryBackoffConfig {
  /** Total attempts including the first (1 disables retrying). */
  maxAttempts: number;
  /** Overall deadline measured from the first attempt. */
  timeoutMs?: number;
  /** Retrying requires an idempotency key; otherwise the budget is one attempt. */
  idempotencyRequired: boolean;
}

export type RetryBudgetByOperation = {
  read?: Partial<RetryBudgetConfig>;
  write?: Partial<RetryBudgetConfig>;
  poll?: Partial<RetryBudgetConfig>;
};

/** Public configuration shape for per-operation retry policy overrides. */
export interface RetryPolicyConfig {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  jitterMs?: number;
  timeoutMs?: number;
}

/** Public configuration shape for per-operation retry budgets. */
export interface RetryBudgetsConfig {
  read?: RetryPolicyConfig;
  write?: RetryPolicyConfig;
  poll?: RetryPolicyConfig;
}

export const DEFAULT_RETRY_BUDGETS: RetryBudgetByOperation = {
  read: {
    maxAttempts: 3,
    initialDelayMs: 100,
    backoffFactor: 2,
    maxDelayMs: 1_600,
    jitterMs: 0,
    idempotencyRequired: false,
  },
  poll: {
    maxAttempts: 3,
    initialDelayMs: 100,
    backoffFactor: 2,
    maxDelayMs: 1_600,
    jitterMs: 0,
    idempotencyRequired: false,
  },
  write: {
    maxAttempts: 1,
    initialDelayMs: 100,
    backoffFactor: 2,
    maxDelayMs: 1_600,
    jitterMs: 0,
    idempotencyRequired: true,
  },
};

/** Merge defaults, per-operation overrides, and per-call overrides in that order. */
export function resolveRetryBudget(
  operationType: RetryOperationType,
  input: { budgets?: RetryBudgetByOperation; overrides?: Partial<RetryBudgetConfig> } = {},
): RetryBudgetConfig {
  return {
    ...(DEFAULT_RETRY_BUDGETS[operationType] ?? {}),
    ...(input.budgets?.[operationType] ?? {}),
    ...(input.overrides ?? {}),
  } as RetryBudgetConfig;
}

/** Deterministic exponential backoff with optional injected jitter. */
export function computeBackoffDelay(
  attempt: number,
  budget: Pick<RetryBackoffConfig, "initialDelayMs" | "backoffFactor" | "maxDelayMs" | "jitterMs">,
  random: () => number = Math.random,
): number {
  const attemptIndex = Math.max(1, attempt);
  const exponentialDelay = budget.initialDelayMs * Math.pow(budget.backoffFactor, attemptIndex - 1);
  const cappedDelay = Math.min(exponentialDelay, budget.maxDelayMs);
  const jitter = budget.jitterMs > 0 ? Math.floor(random() * (budget.jitterMs + 1)) : 0;
  return cappedDelay + jitter;
}

export const RETRY_BUDGET_EXHAUSTED_CODE = "RETRY_BUDGET_EXHAUSTED";
export const RETRY_CANCELLED_CODE = "RETRY_CANCELLED";

/** Thrown when a retry budget is exhausted or refuses to retry for safety. */
export class RetryBudgetExhaustedError extends SubrosaError {
  constructor(
    message: string,
    public readonly operationType: RetryOperationType,
    public readonly attempts: number,
    public readonly maxAttempts: number,
    /** True when retries were refused because a write lacked an idempotency key. */
    public readonly retryRefused: boolean,
    public readonly deadlineExceeded: boolean,
    context: ErrorContext = {},
    cause?: unknown,
  ) {
    super(message, RETRY_BUDGET_EXHAUSTED_CODE, context, cause);
    this.name = "RetryBudgetExhaustedError";
  }
}

function abortableSleep(
  ms: number,
  signal: AbortSignal | undefined,
  operationType: RetryOperationType,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(
        new RetryCancelledError(
          "Retry sequence for " + operationType + " was cancelled during the backoff delay",
          operationType,
          signal?.reason,
        ),
      );
    };

    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      reject(
        new RetryCancelledError(
          "Retry sequence for " + operationType + " was cancelled before the backoff delay elapsed",
          operationType,
          signal.reason,
        ),
      );
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;
function runAttemptWithTimeout<T>(
  invoke: () => Promise<T>,
  attemptTimeoutMs: number | undefined,
  sleep: SleepFn,
  signal: AbortSignal | undefined,
  operationType: RetryOperationType,
): Promise<AttemptResult<T>> {
  if (attemptTimeoutMs === undefined) {
    return invoke().then((value) => ({ timedOut: false as const, value }));
  }

  return new Promise<AttemptResult<T>>((resolve, reject) => {
    let settled = false;

    const settle = (result: AttemptResult<T>, error?: unknown) => {
      if (settled) return;
      settled = true;
      if (error !== undefined) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    invoke().then(
      (value) => settle({ timedOut: false as const, value }),
      (error: unknown) => settle({ timedOut: false as const, value: undefined as never }, error),
    );

    sleep(attemptTimeoutMs, signal).then(
      () => settle({ timedOut: true as const }),
      (error: unknown) => settle({ timedOut: false as const, value: undefined as never }, error),
    );
  });
}


const TIMED_OUT_RETRY_DECISION: RetryDecision = {
  category: RetryCategory.RETRYABLE,
  retryable: true,
  reason: "Attempt exceeded its per-attempt timeout; the call may still be in flight",
};

/**
 * Run `fn` under the retry budget for `operationType`.
 *
 * NON_RETRYABLE failures are rethrown immediately. RETRYABLE/UNKNOWN failures
 * consume budget and surface as {@link RetryBudgetExhaustedError} when the
 * budget or deadline runs out. A non-idempotent write without an idempotency
 * key gets exactly one attempt (`retryRefused: true` on failure).
 */
export async function withRetryBudget<T>(
  fn: () => Promise<T>,
  options: WithRetryBudgetOptions<T> = {},
): Promise<T> {
  const operationType = options.operationType ?? RetryOperationType.READ;
  const budget = resolveRetryBudget(operationType, {
    budgets: options.budgets,
    overrides: options.budget,
  });

  const hasIdempotencyKey = Boolean(options.idempotencyKey?.trim());
  const retryRefused = budget.idempotencyRequired && !hasIdempotencyKey;
  const maxAttempts = retryRefused ? 1 : Math.max(1, budget.maxAttempts);

  const now = options.now ?? Date.now;
  const sleepImpl: SleepFn =
    options.sleep ?? ((ms: number, sig?: AbortSignal) => abortableSleep(ms, sig, operationType));
  const random = options.random ?? Math.random;
  const signal = options.signal;
  const startedAt = now();

  const invokeAttempt = (): Promise<T> => {
    if (options.registry && hasIdempotencyKey) {
      return options.registry.execute(options.idempotencyKey!, fn, { ttlMs: 0 });
    }
    return fn();
  };

  const cancelled = (stage: string): RetryCancelledError =>
    new RetryCancelledError(
      "Retry sequence for " + operationType + " was cancelled " + stage,
      operationType,
      signal?.reason,
    );

  const exhausted = (
    attempts: number,
    deadlineExceeded: boolean,
    cause?: unknown,
  ): RetryBudgetExhaustedError => {
    const lastMessage =
      cause instanceof Error
        ? cause.message
        : cause === undefined
          ? "no attempt completed"
          : String(cause);

    let message: string;
    if (retryRefused) {
      message =
        "Retry budget for " +
        operationType +
        " refused to retry after " +
        attempts +
        " attempt(s): non-idempotent operations require an idempotency key/nonce before they can be retried safely (last error: " +
        lastMessage +
        ")";
    } else if (deadlineExceeded) {
      message =
        "Retry budget for " +
        operationType +
        " exceeded its " +
        budget.timeoutMs +
        "ms deadline after " +
        attempts +
        " attempt(s) (max " +
        maxAttempts +
        ") - giving up (last error: " +
        lastMessage +
        ")";
    } else {
      message =
        "Retry budget for " +
        operationType +
        " exhausted after " +
        attempts +
        " attempt(s) (max " +
        maxAttempts +
        ") - giving up (last error: " +
        lastMessage +
        ")";
    }

    return new RetryBudgetExhaustedError(
      message,
      operationType,
      attempts,
      maxAttempts,
      retryRefused,
      deadlineExceeded,
      { operationType },
      cause,
    );
  };

  if (signal?.aborted) {
    throw cancelled("before the first attempt");
  }

  let lastError: unknown;
  let lastDecision: RetryDecision | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw cancelled("before attempt " + attempt);
    }

    if (budget.timeoutMs !== undefined && now() - startedAt >= budget.timeoutMs) {
      throw exhausted(attempt - 1, true, lastError);
    }

    let attemptError: unknown;
    let timedOut = false;

    try {
      const result = await runAttemptWithTimeout(
        invokeAttempt,
        options.attemptTimeoutMs,
        sleepImpl,
        signal,
        operationType,
      );
      if (!result.timedOut) {
        return result.value;
      }
      timedOut = true;
      const timeoutError = new Error(
        "Attempt " +
          attempt +
          " of " +
          operationType +
          " did not complete within " +
          options.attemptTimeoutMs +
          "ms",
      );
      timeoutError.name = "RetryAttemptTimeoutError";
      attemptError = timeoutError;
    } catch (err) {
      if (signal?.aborted) {
        throw cancelled("after attempt " + attempt);
      }
      attemptError = err;
    }

    lastError = attemptError;

    if (attempt === maxAttempts) break;

    if (!timedOut) {
      const retryDecision = classifyError(attemptError);
      lastDecision = retryDecision;
      if (retryDecision.category === RetryCategory.NON_RETRYABLE) {
        throw attemptError;
      }
    }

    options.onRetry?.(
      attempt,
      attemptError,
      timedOut ? TIMED_OUT_RETRY_DECISION : (lastDecision as RetryDecision),
    );

    const backoffMs = computeBackoffDelay(attempt, budget, random);
    if (budget.timeoutMs !== undefined && now() - startedAt + backoffMs >= budget.timeoutMs) {
      throw exhausted(attempt, true, lastError);
    }

    try {
      await sleepImpl(backoffMs, signal);
    } catch (err) {
      if (signal?.aborted) {
        throw cancelled("during the backoff delay");
      }
      throw err;
    }
  }

  throw exhausted(maxAttempts, false, lastError);
}
