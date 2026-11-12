/**
 * In-memory idempotency helper.
 *
 * Duplicate keys share the same in-flight promise, and successful results can
 * optionally be replayed for a short TTL. Keys carry no payroll values; callers
 * derive them from stable identifiers (recipient/amount/asset or business
 * context) and may bind them to a fingerprint so a reused key with a changed
 * payload is rejected instead of silently replaying the wrong operation.
 */

export interface IdempotencyExecuteOptions {
  /** How long successful results stay cached for replay; 0 dedupes in-flight only. */
  ttlMs?: number;
  /** Cache rejected results too. Defaults to false so transient failures retry. */
  cacheErrors?: boolean;
  /** Opaque digest of the request payload bound to this key. */
  fingerprint?: string;
}

interface IdempotencyEntry<T> {
  promise: Promise<T>;
  expiresAt: number | null;
  fingerprint?: string;
}

/** Raised when a key is reused for a different request payload. */
export class IdempotencyKeyConflictError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED" as const;

  constructor() {
    super("This idempotency key is already bound to a different request.");
    this.name = "IdempotencyKeyConflictError";
  }
}

/** Raised when a replay-safe operation is invoked without a usable key. */
export class IdempotencyKeyRequiredError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REQUIRED" as const;

  constructor() {
    super("A non-empty idempotency key is required for replay-safe submission.");
    this.name = "IdempotencyKeyRequiredError";
  }
}

export class IdempotencyRegistry<T> {
  private readonly entries = new Map<string, IdempotencyEntry<T>>();

  constructor(private readonly defaultTtlMs = 5 * 60 * 1000) {}

  async execute(
    key: string,
    fn: () => Promise<T>,
    options: IdempotencyExecuteOptions = {},
  ): Promise<T> {
    const normalizedKey = normalizeIdempotencyKey(key);
    if (!normalizedKey) {
      throw new Error("Idempotency key must not be empty");
    }

    this.pruneExpired();

    const existing = this.entries.get(normalizedKey);
    if (existing) {
      if (options.fingerprint !== undefined && existing.fingerprint !== options.fingerprint) {
        throw new IdempotencyKeyConflictError();
      }
      return existing.promise;
    }

    const ttlMs = Math.max(0, options.ttlMs ?? this.defaultTtlMs);
    const cacheErrors = options.cacheErrors ?? false;

    const promise = fn();
    this.entries.set(normalizedKey, {
      promise,
      expiresAt: ttlMs > 0 ? Date.now() + ttlMs : null,
      fingerprint: options.fingerprint,
    });

    try {
      return await promise;
    } catch (error) {
      if (!cacheErrors) {
        this.entries.delete(normalizedKey);
      }
      throw error;
    } finally {
      if (ttlMs === 0) {
        this.entries.delete(normalizedKey);
      }
    }
  }

  clear(): void {
    this.entries.clear();
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries.entries()) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}

export interface PaymentIdempotencyKeyInput {
  recipient: string;
  amount: bigint;
  asset: string;
}

/**
 * Deterministic payment idempotency key. Append a UI/request nonce when
 * identical repeat payments must be treated as distinct operations.
 */
export function createPaymentIdempotencyKey(input: PaymentIdempotencyKeyInput): string {
  const recipient = input.recipient.trim().toLowerCase();
  const asset = input.asset.trim().toLowerCase();
  return `pay:${recipient}:${input.amount.toString()}:${asset}`;
}

export function normalizeIdempotencyKey(key: string): string {
  return key.trim();
}

export interface PayrollIdempotencyKeyInput {
  companyId: string;
  payrollPeriod: string;
  commitmentHash: string;
  asset: string;
  treasuryContext: string;
}

/** Deterministic batch/payroll submission key carrying business context. */
export function createPayrollIdempotencyKey(input: PayrollIdempotencyKeyInput): string {
  const companyId = input.companyId.trim();
  const payrollPeriod = input.payrollPeriod.trim();
  const commitmentHash = input.commitmentHash.trim().toLowerCase();
  const asset = input.asset.trim().toLowerCase();
  const treasuryContext = input.treasuryContext.trim();

  return `payroll:${companyId}:${payrollPeriod}:${commitmentHash}:${asset}:${treasuryContext}`;
}
