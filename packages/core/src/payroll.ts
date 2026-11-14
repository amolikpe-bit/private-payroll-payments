/**
 * Payroll orchestration for confidential NEAR payouts.
 *
 * `processPayment` is the single enforcement point for the off-chain payout
 * path: destination gate -> fail-closed audit-hold gate -> client-side
 * commitment verification -> confidential payout -> on-chain settlement
 * record. Amount and salt stay in memory and never enter contract args,
 * logs, or error messages.
 */

import { chunkPayoutBatches } from "./batch/chunking.js";
import { BatchValidationFailedError, type BatchPaymentEntry } from "./batch/BatchPayloadBuilder.js";
import { SubrosaError, ValidationError } from "./core/errors.js";
import {
  IdempotencyRegistry,
  createPaymentIdempotencyKey,
} from "./core/idempotency.js";
import { assertHexSalt, assertPositiveU128 } from "./crypto/hashUtils.js";
import type { CommitmentClient } from "./near/CommitmentClient.js";
import type { HoldClient } from "./near/HoldClient.js";
import type { PayoutClient } from "./near/PayoutClient.js";
import type { RegistryClient } from "./near/RegistryClient.js";
import {
  assertSafeU64,
  normalizeCommitmentHash,
  requireAccountId,
  requireAssetId,
} from "./near/entries.js";
import {
  submitSequentialPayrollBatches,
  type SafeBatchSubmissionOptions,
  type SafeBatchSubmissionResult,
} from "./payroll/safeBatchSubmitter.js";
import { redactError } from "./redaction/RedactionEngine.js";
import {
  DestinationValidationError,
  getRegisteredDestinationValidationHook,
  resetDestinationValidationHook,
  setDestinationValidationHook,
  validateNearDestination,
  type DestinationValidationHook,
  type DestinationWorkflowValidation,
} from "./settlement/destination.js";
import type { PrivateStore } from "./store/PrivateStore.js";
import type { HoldEntry, PendingPayout } from "./types.js";

/** Contract batch cap shared by commitment and payout chunking. */
const PAYROLL_BATCH_SIZE = 50;

/** Confidential-payout adapter injected into the payroll service. */
export interface PayrollPayoutExecutor {
  executePendingPayout(entry: PendingPayout): Promise<{ intentHash: string }>;
}

export interface PayrollServiceDeps {
  registry: Pick<RegistryClient, "getEmployee">;
  commitments: Pick<CommitmentClient, "getCommitment" | "verifyCommitment">;
  holds: Pick<HoldClient, "getAuditHold" | "listHoldIds">;
  payouts: Pick<PayoutClient, "markSettled" | "markFailed" | "getPayout">;
  store: Pick<PrivateStore, "savePendingPayout">;
  executor: PayrollPayoutExecutor;
  idempotency?: IdempotencyRegistry<PayrollPaymentResult>;
}

/**
 * One payout request. `commitmentHash` is the caller's expected value; it must
 * match both the on-chain commitment and the locally recomputed preimage.
 */
export interface PayrollPaymentRequest {
  employer: string;
  employee: string;
  payoutId: number;
  cycleId: number;
  commitmentHash: string;
  /** Salary amount in the commitment token's smallest units (u128). */
  amount: bigint;
  /** Hex-encoded commitment salt (1..64 bytes, even-length hex). */
  salt: string;
  /** Token account id used in the commitment preimage. */
  token: string;
  /** Settlement asset id (`nep141:<account>`, `nep245:<account>`, or account id). */
  asset: string;
  memo?: string;
  /**
   * Hold ids relevant to this payout (employer/period/batch/employee). Every
   * listed hold is fetched; an active matching hold or an unknown/failed
   * status blocks the payout.
   */
  holdIds?: string[];
  /** Period scope id used to match `Period` holds (defaults to cycleId). */
  periodId?: string;
  /** Batch scope id used to match `Batch` holds. */
  batchId?: string;
  idempotencyKey?: string;
}

export interface PayrollPaymentResult {
  payoutId: number;
  intentHash: string;
  commitmentHash: string;
}

export type PayrollErrorCode =
  | "INVALID_PAYMENT"
  | "EMPLOYEE_NOT_REGISTERED"
  | "COMMITMENT_NOT_FOUND"
  | "COMMITMENT_MISMATCH"
  | "HOLD_ACTIVE"
  | "HOLD_STATUS_UNKNOWN"
  | "HOLD_STATUS_UNAVAILABLE"
  | "PAYOUT_NOT_FOUND"
  | "PAYOUT_NOT_PENDING"
  | "PAYOUT_MISMATCH"
  | "PAYOUT_EXECUTION_FAILED"
  | "PAYOUT_SETTLEMENT_FAILED"
  | "PAYOUT_SETTLEMENT_RECORD_FAILED";

/** SDK-level payroll failure carrying a stable code and a sanitized message. */
export class PayrollError extends SubrosaError {
  constructor(
    message: string,
    code: PayrollErrorCode,
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, code, context, cause);
    this.name = "PayrollError";
  }
}


/** Convert an SDK error to an Error so redaction can inspect its message. */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function redactedMessage(prefix: string, error: unknown): string {
  return `${prefix}: ${redactError(asError(error)).message}`;
}

type TerminalPayoutStatus = "FAILED" | "REFUNDED" | "INCOMPLETE_DEPOSIT";

function terminalPayoutStatus(error: unknown): TerminalPayoutStatus | undefined {
  if (error !== null && typeof error === "object" && "terminalStatus" in error) {
    const status = error.terminalStatus;
    if (status === "FAILED" || status === "REFUNDED" || status === "INCOMPLETE_DEPOSIT") {
      return status;
    }
  }
  return undefined;
}

export class PayrollService {
  private readonly idempotency: IdempotencyRegistry<PayrollPaymentResult>;

  constructor(private readonly deps: PayrollServiceDeps) {
    this.idempotency =
      deps.idempotency ?? new IdempotencyRegistry<PayrollPaymentResult>();
  }

  /**
   * Run one confidential payout. Validation order is deliberate: destination
   * syntax/policy, holds, commitment proof, then funds movement.
   */
  async processPayment(request: PayrollPaymentRequest): Promise<PayrollPaymentResult> {
    const key = request.idempotencyKey?.trim();
    if (!key) {
      return this.processPaymentInternal(request);
    }

    const fingerprint = JSON.stringify({
      employer: request.employer,
      employee: request.employee,
      payoutId: request.payoutId,
      cycleId: request.cycleId,
      commitmentHash: request.commitmentHash,
      amount: request.amount.toString(),
      asset: request.asset,
    });

    return this.idempotency.execute(key, () => this.processPaymentInternal(request), {
      fingerprint,
    });
  }

  /**
   * Validate and submit entries in order-preserving batches with checkpoints,
   * progress, and guarded retries. Pre-validation failures throw a
   * `BatchValidationFailedError` before any payout is submitted.
   */
  async processBatchPayments(
    entries: PayrollPaymentRequest[],
    options: SafeBatchSubmissionOptions<PayrollPaymentRequest, PayrollPaymentResult> = {},
  ): Promise<SafeBatchSubmissionResult<PayrollPaymentResult>> {
    const batchEntries: BatchPaymentEntry[] = entries.map((entry) => ({
      employee: entry.employee,
      commitment_hash: entry.commitmentHash,
      cycle_id: entry.cycleId,
      amount: entry.amount,
      salt: entry.salt,
      asset: entry.asset,
      memo: entry.memo ?? "",
    }));

    const chunked = chunkPayoutBatches(batchEntries, {
      maxBatchSize: PAYROLL_BATCH_SIZE,
    });
    if (chunked.errors.length > 0) {
      throw new BatchValidationFailedError(chunked.errors);
    }

    const prefix = options.idempotencyKeyPrefix;

    return submitSequentialPayrollBatches(
      entries,
      async (batchItems, batchIndex, batchKey) => {
        const results: PayrollPaymentResult[] = [];
        for (let index = 0; index < batchItems.length; index++) {
          const item = batchItems[index];
          const batchLevelKey = batchKey?.trim();
          const derivedKey =
            item.idempotencyKey?.trim() ??
            (batchLevelKey
              ? `${batchLevelKey}:${index}`
              : prefix
                ? `${prefix}:${batchIndex}:${index}`
                : undefined);
          results.push(
            await this.processPayment(
              derivedKey ? { ...item, idempotencyKey: derivedKey } : item,
            ),
          );
        }
        return results;
      },
      {
        batchSize: PAYROLL_BATCH_SIZE,
        ...options,
      },
    );
  }

  /** Deterministic payment key for callers that do not supply one. */
  static createIdempotencyKey(
    params: Pick<PayrollPaymentRequest, "employee" | "amount" | "asset">,
  ): string {
    return createPaymentIdempotencyKey({
      recipient: params.employee,
      amount: params.amount,
      asset: params.asset,
    });
  }

  /** Register the process-wide destination validation hook. */
  static setDestinationValidationHook(hook?: DestinationValidationHook | null): void {
    setDestinationValidationHook(hook);
  }

  static resetDestinationValidationHook(): void {
    resetDestinationValidationHook();
  }

  static getDestinationValidationHook(): DestinationValidationHook | undefined {
    return getRegisteredDestinationValidationHook();
  }

  /** Run the destination gate without submitting a payment. */
  async validateDestination(value: unknown): Promise<DestinationWorkflowValidation> {
    return validateNearDestination(value);
  }

  private async processPaymentInternal(
    request: PayrollPaymentRequest,
  ): Promise<PayrollPaymentResult> {
    const destination = await validateNearDestination(request.employee);
    if (!destination.ok) {
      throw DestinationValidationError.fromResult(destination);
    }
    const employee = destination.destination;

    const employer = requireAccountId(request.employer, "employer");
    const token = requireAccountId(request.token, "token");
    const asset = requireAssetId(request.asset, "asset");
    const payoutId = assertSafeU64(request.payoutId, "payoutId");
    const cycleId = assertSafeU64(request.cycleId, "cycleId");
    const amount = assertPositiveU128(request.amount);
    const salt = assertHexSalt(request.salt);

    const registration = await this.deps.registry.getEmployee(employer, employee);
    if (registration === null || !registration.active) {
      throw new PayrollError(
        "Employee is not registered or is inactive for this employer.",
        "EMPLOYEE_NOT_REGISTERED",
      );
    }

    await this.assertNoBlockingHolds({
      employer,
      employee,
      holdIds: request.holdIds,
      periodId: request.periodId ?? String(cycleId),
      batchId: request.batchId,
    });

    const commitment = await this.deps.commitments.getCommitment(
      employer,
      employee,
      cycleId,
    );
    if (commitment === null) {
      throw new PayrollError(
        "No salary commitment exists for this employee and cycle.",
        "COMMITMENT_NOT_FOUND",
      );
    }

    const expectedHash = normalizeCommitmentHash(request.commitmentHash, "commitmentHash");
    if (expectedHash !== commitment.commitment_hash) {
      throw new PayrollError(
        "The expected commitment hash does not match the on-chain commitment.",
        "COMMITMENT_MISMATCH",
      );
    }

    const verified = this.deps.commitments.verifyCommitment(
      { employer, employee, token, cycleId, amount, salt },
      commitment.commitment_hash,
    );
    if (!verified) {
      throw new PayrollError(
        "The commitment preimage does not match the on-chain commitment hash.",
        "COMMITMENT_MISMATCH",
      );
    }
    const payout = await this.deps.payouts.getPayout(employer, payoutId);
    if (payout === null) {
      throw new PayrollError("Payout is not scheduled on chain.", "PAYOUT_NOT_FOUND", {
        payoutId,
      });
    }
    if (payout.state !== "Pending") {
      throw new PayrollError(
        "Payout is not pending; refusing to settle an already-final payout.",
        "PAYOUT_NOT_PENDING",
        { payoutId, state: payout.state },
      );
    }
    if (
      payout.employee !== employee ||
      payout.commitment_hash !== commitment.commitment_hash
    ) {
      throw new PayrollError(
        "Payout row does not match the requested employee/commitment.",
        "PAYOUT_MISMATCH",
        { payoutId },
      );
    }

    // Amount and salt exist only in this in-memory record; contract args carry
    // the public commitment hash and the settlement metadata.
    const pending: PendingPayout = {
      employer,
      payout_id: payoutId,
      employee,
      amount: amount.toString(),
      salt,
      asset,
      memo: request.memo ?? "",
      commitment_hash: commitment.commitment_hash,
    };
    await this.deps.store.savePendingPayout(pending);

    let intentHash: string;
    try {
      const executed = await this.deps.executor.executePendingPayout(pending);
      intentHash = executed.intentHash;
    } catch (error) {
      const terminalStatus = terminalPayoutStatus(error);
      if (terminalStatus === "FAILED" || terminalStatus === "REFUNDED") {
        try {
          await this.deps.payouts.markFailed(payoutId, terminalStatus);
        } catch (markError) {
          throw new PayrollError(
            redactedMessage("Confidential payout failed and mark_failed failed", markError),
            "PAYOUT_SETTLEMENT_RECORD_FAILED",
            { payoutId, terminalStatus },
            markError,
          );
        }
      }
      throw new PayrollError(
        redactedMessage("Confidential payout failed", error),
        "PAYOUT_SETTLEMENT_FAILED",
        { payoutId, ...(terminalStatus === undefined ? {} : { terminalStatus }) },
        error,
      );
    }

    try {
      await this.deps.payouts.markSettled(payoutId, intentHash);
    } catch (error) {
      throw new PayrollError(
        redactedMessage("Payout settled off-chain but mark_settled failed", error),
        "PAYOUT_SETTLEMENT_RECORD_FAILED",
        { payoutId },
        error,
      );
    }

    return { payoutId, intentHash, commitmentHash: commitment.commitment_hash };
  }

  private async assertNoBlockingHolds(input: {
    employer: string;
    employee: string;
    holdIds?: string[];
    periodId: string;
    batchId?: string;
  }): Promise<void> {
    let holdIds = input.holdIds;
    if (holdIds === undefined) {
      try {
        holdIds = await this.deps.holds.listHoldIds(input.employer, 0, 500);
      } catch (error) {
        throw new PayrollError(
          "Audit hold index could not be read; failing closed and not submitting the payout.",
          "HOLD_STATUS_UNAVAILABLE",
          {},
          error,
        );
      }
    }
    if (!Array.isArray(holdIds)) {
      throw new ValidationError("holdIds must be an array when provided.", "holdIds");
    }
    if (holdIds.length === 0) return;
    for (const holdId of holdIds) {
      if (typeof holdId !== "string" || holdId.trim().length === 0) {
        throw new ValidationError("holdIds must contain non-empty strings.", "holdIds");
      }
    }

    const outcomes = Array.from<{ hold: HoldEntry | null; error?: unknown }>({ length: holdIds.length });
    if (holdIds.length === 1) {
      try {
        outcomes[0] = { hold: await this.deps.holds.getAuditHold(holdIds[0]) };
      } catch (error) {
        outcomes[0] = { hold: null, error };
      }
    } else {
      const concurrency = Math.min(4, holdIds.length);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < holdIds.length) {
          const idx = next++;
          try {
            outcomes[idx] = { hold: await this.deps.holds.getAuditHold(holdIds[idx]) };
          } catch (error) {
            outcomes[idx] = { hold: null, error };
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    }

    for (let i = 0; i < holdIds.length; i++) {
      const holdId = holdIds[i];
      const outcome = outcomes[i];
      if (outcome.error !== undefined) {
        throw new PayrollError(
          "Audit hold status could not be read; failing closed and not submitting the payout.",
          "HOLD_STATUS_UNAVAILABLE",
          { holdId },
          outcome.error,
        );
      }
      const hold = outcome.hold;
      if (hold === null) {
        throw new PayrollError(
          "Audit hold status is unknown; failing closed and not submitting the payout.",
          "HOLD_STATUS_UNKNOWN",
          { holdId },
        );
      }
      if (hold.state === "Released" || hold.employer !== input.employer) continue;
      const blocks =
        hold.scope === "Employer" ||
        (hold.scope === "Period" && hold.scope_id === input.periodId) ||
        (hold.scope === "Batch" &&
          input.batchId !== undefined &&
          hold.scope_id === input.batchId) ||
        (hold.scope === "Employee" && hold.scope_id === input.employee);
      if (blocks) {
        throw new PayrollError(
          "An active audit hold blocks this payout.",
          "HOLD_ACTIVE",
          { scope: hold.scope },
        );
      }
    }
  }
}
