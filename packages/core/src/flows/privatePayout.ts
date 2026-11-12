/**
 * End-to-end private payout orchestration.
 *
 * `ConfidentialPayout` owns quote -> sign -> submit -> poll. This flow adds the
 * durable scheduling/resume boundary the payroll workflow needs:
 *
 * - scheduling binds the private amount/salt to the new on-chain payout id;
 * - execution loads that binding, refuses to run unless the on-chain row is
 *   still `Pending` and matches it, and maps the terminal 1Click status onto
 *   `mark_settled` / `mark_failed`;
 * - an existing receipt for the payout prevents a second submission after a
 *   crash, timeout, or process restart;
 * - `resume` polls by an externally-held deposit reference or reconciles an
 *   already-terminal receipt. It never quotes, signs, or submits again.
 *
 * `INCOMPLETE_DEPOSIT` is surfaced as an explicit failure but is not written
 * with `mark_failed`: the contract accepts only FAILED/REFUNDED, and silently
 * marking a partially funded payout failed would lose the operator's recovery
 * path. Amounts, salts, and deposit addresses never appear in flow errors.
 */

import { SubrosaError, ValidationError } from "../core/errors.js";
import { IdempotencyRegistry } from "../core/idempotency.js";
import { commitmentHash as computeCommitmentHash } from "../crypto/hashUtils.js";
import type { ConfidentialPayout } from "../intents/ConfidentialPayout.js";
import {
  assertIntentHash,
  assertSafeU64,
  normalizeCommitmentHash,
  requireAccountId,
} from "../near/entries.js";
import type { PayoutClient } from "../near/PayoutClient.js";
import { redactError } from "../redaction/RedactionEngine.js";
import type { PrivateReceiptSummary, PrivateStore } from "../store/PrivateStore.js";
import type { PayoutEntry, PendingPayout } from "../types.js";

const U128_MAX = (1n << 128n) - 1n;
const SALT_PATTERN = /^(?:[0-9a-fA-F]{2})+$/;
const MAX_SALT_BYTES = 64;
const MAX_MEMO_BYTES = 256;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

export type TerminalPayoutStatus = "FAILED" | "REFUNDED" | "INCOMPLETE_DEPOSIT";

export type PrivatePayoutFlowErrorCode =
  | "INVALID_REQUEST"
  | "COMMITMENT_MISMATCH"
  | "PAYOUT_NOT_STORED"
  | "PAYOUT_NOT_FOUND"
  | "PAYOUT_NOT_PENDING"
  | "PAYOUT_STORE_MISMATCH"
  | "PAYOUT_STATE_CONFLICT"
  | "PAYOUT_RESUME_REQUIRED"
  | "PAYOUT_RESUME_REFERENCE_REQUIRED"
  | "PAYOUT_EXECUTION_FAILED"
  | "PAYOUT_FAILED"
  | "PAYOUT_REFUNDED"
  | "PAYOUT_INCOMPLETE_DEPOSIT"
  | "PAYOUT_STATUS_TIMEOUT"
  | "PAYOUT_STATUS_UNEXPECTED"
  | "PAYOUT_SETTLEMENT_RECORD_FAILED";

/** Redacted flow failure carrying a stable code and terminal status. */
export class PrivatePayoutFlowError extends SubrosaError {
  readonly terminalStatus?: TerminalPayoutStatus;

  constructor(
    code: PrivatePayoutFlowErrorCode,
    message: string,
    context: Record<string, unknown> = {},
    terminalStatus?: TerminalPayoutStatus,
    cause?: unknown,
  ) {
    super(message, code, context, cause);
    this.name = "PrivatePayoutFlowError";
    if (terminalStatus !== undefined) {
      this.terminalStatus = terminalStatus;
    }
  }
}

/** Private amount/salt plus the on-chain schedule fields. */
export interface PrivatePayoutScheduleRequest {
  employer: string;
  employee: string;
  cycleId: number;
  /** Token account id used in the commitment preimage. */
  token: string;
  /** On-chain asset account id recorded in the payout row. */
  asset: string;
  /** Commitment hash the caller expects; the private preimage must match it. */
  commitmentHash: string;
  /** Salary amount in the token's smallest units (u128). */
  amount: bigint;
  /** Hex-encoded commitment salt (1..64 bytes, even-length). */
  salt: string;
  memo?: string;
  /** Execution time in nanoseconds since the epoch. */
  executeAt: number;
  /** Optional key for the on-chain schedule write. */
  idempotencyKey?: string;
}

export interface PrivatePayoutScheduleResult {
  payoutId: number;
  pending: PendingPayout;
}

export interface PrivatePayoutExecuteRequest {
  employer: string;
  payoutId: number;
  /** Defaults to `private-payout:<employer>:<payoutId>`. */
  idempotencyKey?: string;
}

export interface PrivatePayoutSettlement {
  state: "settled";
  payoutId: number;
  intentHash: string;
  commitmentHash: string;
  receiptId?: string;
}

/** Buyer-supplied reference for resuming a submitted (or in-flight) payout. */
export interface PrivatePayoutResumeRequest {
  employer: string;
  payoutId: number;
  /** Local receipt id, when known. */
  receiptId?: string;
  /** 1Click intent hash returned by submit-intent. */
  intentHash?: string;
  /**
   * Secret 1Click deposit address. Kept outside the SDK store's read surface;
   * supply it when the receipt is still non-terminal so status can be polled.
   */
  depositAddress?: string;
  depositMemo?: string;
}

export interface PrivatePayoutPendingResume {
  state: "pending";
  payoutId: number;
  status: string;
  referenceRequired: true;
  receiptId?: string;
  intentHash?: string;
}

export type PrivatePayoutResumeResult = PrivatePayoutSettlement | PrivatePayoutPendingResume;

export interface PrivatePayoutFlowDeps {
  store: Pick<
    PrivateStore,
    | "savePendingPayout"
    | "getPendingPayout"
    | "listReceipts"
    | "getReceipt"
    | "getReceiptByIntentHash"
    | "updatePrivateReceipt"
  >;
  engine: Pick<ConfidentialPayout, "executePendingPayout" | "waitForTerminalStatus">;
  payouts: Pick<PayoutClient, "schedulePayout" | "getPayout" | "markSettled" | "markFailed">;
  idempotency?: IdempotencyRegistry<PrivatePayoutSettlement>;
  now?: () => Date;
}

const PENDING_RECEIPT_STATUSES = new Set([
  "PENDING",
  "PENDING_DEPOSIT",
  "KNOWN_DEPOSIT_TX",
  "PROCESSING",
]);

function redactedMessage(prefix: string, error: unknown): string {
  const cause = error instanceof Error ? error : new Error(String(error));
  return `${prefix}: ${redactError(cause).message}`;
}

function terminalStatusOf(error: unknown): TerminalPayoutStatus | undefined {
  if (error !== null && typeof error === "object" && "terminalStatus" in error) {
    const status: unknown = error.terminalStatus;
    if (status === "FAILED" || status === "REFUNDED" || status === "INCOMPLETE_DEPOSIT") {
      return status;
    }
  }
  return undefined;
}

function normalizeStatus(value: string): string {
  return value.trim().toUpperCase();
}

function assertAmount(value: unknown): bigint {
  if (typeof value !== "bigint" || value <= 0n || value > U128_MAX) {
    throw new ValidationError(
      "amount must be a positive bigint that fits in u128.",
      "amount",
      "INVALID_AMOUNT",
    );
  }
  return value;
}

function assertSalt(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SALT_BYTES * 2 ||
    !SALT_PATTERN.test(value)
  ) {
    throw new ValidationError(
      "salt must be an even-length hex string of 1-64 bytes.",
      "salt",
      "INVALID_SALT",
    );
  }
  return value;
}

function assertMemo(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || new TextEncoder().encode(value).length > MAX_MEMO_BYTES) {
    throw new PrivatePayoutFlowError(
      "INVALID_REQUEST",
      "memo must be a string of at most 256 UTF-8 bytes.",
    );
  }
  return value;
}

function assertIdempotencyKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PrivatePayoutFlowError("INVALID_REQUEST", "idempotencyKey must be a non-empty string.");
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new PrivatePayoutFlowError("INVALID_REQUEST", "idempotencyKey is too long.");
  }
  return trimmed;
}

function assertExecuteAt(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PrivatePayoutFlowError(
      "INVALID_REQUEST",
      "executeAt must be a non-negative safe integer of nanoseconds.",
    );
  }
  return value;
}

function assertDepositMemo(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PrivatePayoutFlowError("INVALID_REQUEST", "depositMemo must be a non-empty string.");
  }
  return value;
}

/** Flow-level scheduler, executor, and resume reconciler. */
export class PrivatePayoutFlow {
  readonly #store: PrivatePayoutFlowDeps["store"];
  readonly #engine: PrivatePayoutFlowDeps["engine"];
  readonly #payouts: PrivatePayoutFlowDeps["payouts"];
  readonly #idempotency: IdempotencyRegistry<PrivatePayoutSettlement>;
  readonly #now: () => Date;

  constructor(deps: PrivatePayoutFlowDeps) {
    if (typeof deps !== "object" || deps === null) {
      throw new PrivatePayoutFlowError("INVALID_REQUEST", "PrivatePayoutFlow dependencies are required.");
    }
    this.#store = deps.store;
    this.#engine = deps.engine;
    this.#payouts = deps.payouts;
    this.#idempotency =
      deps.idempotency ?? new IdempotencyRegistry<PrivatePayoutSettlement>();
    this.#now = deps.now ?? (() => new Date());
  }

  /**
   * Schedule the payout on chain, then persist the private amount/salt bound
   * to the returned id. The commitment preimage is checked before anything is
   * submitted, so a wrong amount/salt never becomes an orphaned payout row.
   */
  async schedule(request: PrivatePayoutScheduleRequest): Promise<PrivatePayoutScheduleResult> {
    if (typeof request !== "object" || request === null) {
      throw new PrivatePayoutFlowError("INVALID_REQUEST", "Schedule request must be an object.");
    }
    const employer = requireAccountId(request.employer, "employer");
    const employee = requireAccountId(request.employee, "employee");
    const token = requireAccountId(request.token, "token");
    const asset = requireAccountId(request.asset, "asset");
    const cycleId = assertSafeU64(request.cycleId, "cycleId");
    const amount = assertAmount(request.amount);
    const salt = assertSalt(request.salt);
    const memo = assertMemo(request.memo);
    const executeAt = assertExecuteAt(request.executeAt);
    const expectedHash = normalizeCommitmentHash(request.commitmentHash, "commitmentHash");

    let computedHash: string;
    try {
      computedHash = computeCommitmentHash({
        employer,
        employee,
        token,
        cycleId,
        amount: amount.toString(),
        salt,
      });
    } catch (error) {
      throw new PrivatePayoutFlowError(
        "INVALID_REQUEST",
        redactedMessage("Commitment preimage is invalid", error),
        {},
        undefined,
        error,
      );
    }
    if (computedHash !== expectedHash) {
      throw new PrivatePayoutFlowError(
        "COMMITMENT_MISMATCH",
        "The private amount/salt do not produce the requested commitment hash.",
      );
    }

    const idempotencyKey = assertIdempotencyKey(request.idempotencyKey);
    let payoutId: number;
    try {
      payoutId = await this.#payouts.schedulePayout(
        {
          employee,
          commitmentHash: expectedHash,
          asset,
          memo,
          executeAt,
        },
        idempotencyKey === undefined ? undefined : { idempotencyKey },
      );
    } catch (error) {
      throw new PrivatePayoutFlowError(
        "PAYOUT_EXECUTION_FAILED",
        redactedMessage("Payout could not be scheduled", error),
        {},
        undefined,
        error,
      );
    }

    const pending: PendingPayout = {
      employer,
      payout_id: payoutId,
      employee,
      amount: amount.toString(),
      salt,
      asset,
      memo,
      commitment_hash: expectedHash,
    };
    await this.#store.savePendingPayout(pending);

    const onChain = await this.#payouts.getPayout(employer, payoutId);
    if (onChain === null) {
      throw new PrivatePayoutFlowError(
        "PAYOUT_NOT_FOUND",
        "Scheduled payout is not visible on chain yet.",
        { payoutId },
      );
    }
    this.#assertBinding(pending, onChain, false);
    return { payoutId, pending };
  }

  /**
   * Load the stored payout, refuse to re-submit when a receipt already exists,
   * execute once, then record the terminal result on chain.
   */
  async execute(request: PrivatePayoutExecuteRequest): Promise<PrivatePayoutSettlement> {
    if (typeof request !== "object" || request === null) {
      throw new PrivatePayoutFlowError("INVALID_REQUEST", "Execute request must be an object.");
    }
    const employer = requireAccountId(request.employer, "employer");
    const payoutId = assertSafeU64(request.payoutId, "payoutId");
    const key =
      assertIdempotencyKey(request.idempotencyKey) ??
      `private-payout:${employer}:${payoutId}`;
    return this.#idempotency.execute(key, () => this.#execute(employer, payoutId), {
      fingerprint: `${employer}:${payoutId}`,
    });
  }

  /**
   * Resume without paying again. Terminal receipts are reconciled directly.
   * A non-terminal receipt needs a deposit reference to poll; without one the
   * flow returns a `pending` result and requires the caller to keep the
   * reference rather than re-running `execute()`.
   */
  async resume(request: PrivatePayoutResumeRequest): Promise<PrivatePayoutResumeResult> {
    if (typeof request !== "object" || request === null) {
      throw new PrivatePayoutFlowError("INVALID_REQUEST", "Resume request must be an object.");
    }
    const employer = requireAccountId(request.employer, "employer");
    const payoutId = assertSafeU64(request.payoutId, "payoutId");
    const depositAddress = request.depositAddress;
    if (
      depositAddress !== undefined &&
      (typeof depositAddress !== "string" || depositAddress.trim().length === 0)
    ) {
      throw new PrivatePayoutFlowError("INVALID_REQUEST", "depositAddress must be a non-empty string.");
    }
    const depositMemo = assertDepositMemo(request.depositMemo);

    const payout = await this.#loadPayout(employer, payoutId);
    const receipt = await this.#resolveReceipt(employer, payoutId, request);
    if (receipt !== undefined) {
      const status = normalizeStatus(receipt.status);
      if (
        status === "SUCCESS" ||
        status === "FAILED" ||
        status === "REFUNDED" ||
        status === "INCOMPLETE_DEPOSIT"
      ) {
        return this.#reconcile(payoutId, payout, receipt.intentHash, receipt.receiptId, status);
      }
      if (!PENDING_RECEIPT_STATUSES.has(status)) {
        throw new PrivatePayoutFlowError(
          "PAYOUT_STATUS_UNEXPECTED",
          `Receipt has an unrecognized settlement status (${status}).`,
          { payoutId, receiptId: receipt.receiptId },
        );
      }
      if (payout.state === "Executed") {
        return this.#markSettled(payoutId, payout, receipt.intentHash ?? payout.intent_hash, receipt.receiptId);
      }
      if (payout.state !== "Pending") {
        throw new PrivatePayoutFlowError(
          "PAYOUT_STATE_CONFLICT",
          "A pending receipt conflicts with the payout's final on-chain state.",
          { payoutId, state: payout.state, receiptId: receipt.receiptId },
        );
      }
      if (depositAddress === undefined) {
        return {
          state: "pending",
          payoutId,
          status,
          referenceRequired: true,
          receiptId: receipt.receiptId,
          ...(receipt.intentHash === null ? {} : { intentHash: receipt.intentHash }),
        };
      }
      const polled = await this.#poll(depositAddress, depositMemo, payoutId);
      await this.#store.updatePrivateReceipt(receipt.receiptId, {
        status: normalizeStatus(polled.status),
        updatedAt: this.#nowIso(),
      });
      return this.#reconcile(
        payoutId,
        payout,
        receipt.intentHash,
        receipt.receiptId,
        normalizeStatus(polled.status),
      );
    }

    if (payout.state === "Executed") {
      return this.#markSettled(payoutId, payout, payout.intent_hash, undefined);
    }
    if (depositAddress === undefined) {
      throw new PrivatePayoutFlowError(
        "PAYOUT_RESUME_REFERENCE_REQUIRED",
        "No local receipt or deposit reference exists; refusing to re-pay to resume.",
        { payoutId },
      );
    }
    const pending = await this.#loadPending(employer, payoutId);
    this.#assertBinding(pending, payout, false);
    const polled = await this.#poll(depositAddress, depositMemo, payoutId);
    return this.#reconcile(payoutId, payout, undefined, undefined, normalizeStatus(polled.status));
  }

  async #execute(employer: string, payoutId: number): Promise<PrivatePayoutSettlement> {
    const payout = await this.#loadPayout(employer, payoutId);
    const existing = await this.#findReceipt(employer, payoutId);
    if (existing !== undefined) {
      return this.#reconcile(
        payoutId,
        payout,
        existing.intentHash,
        existing.receiptId,
        normalizeStatus(existing.status),
      );
    }

    const pending = await this.#loadPending(employer, payoutId);
    this.#assertBinding(pending, payout, true);

    let intentHash: string;
    try {
      const result = await this.#engine.executePendingPayout(pending);
      intentHash = result.intentHash;
    } catch (error) {
      throw await this.#failedExecution(payoutId, payout, error);
    }

    const receipt = await this.#findReceipt(employer, payoutId);
    return this.#markSettled(payoutId, payout, intentHash, receipt?.receiptId);
  }

  #assertBinding(pending: PendingPayout, payout: PayoutEntry, requirePending: boolean): void {
    if (requirePending && payout.state !== "Pending") {
      throw new PrivatePayoutFlowError(
        "PAYOUT_NOT_PENDING",
        "Payout is not pending; refusing to settle an already-final payout.",
        { payoutId: pending.payout_id, state: payout.state },
      );
    }
    if (
      payout.employee !== pending.employee ||
      payout.commitment_hash !== pending.commitment_hash ||
      payout.asset !== pending.asset
    ) {
      throw new PrivatePayoutFlowError(
        "PAYOUT_STORE_MISMATCH",
        "The private payout binding does not match the on-chain payout row.",
        { payoutId: pending.payout_id },
      );
    }
  }

  async #loadPending(employer: string, payoutId: number): Promise<PendingPayout> {
    const pending = await this.#store.getPendingPayout(employer, payoutId);
    if (pending === undefined) {
      throw new PrivatePayoutFlowError(
        "PAYOUT_NOT_STORED",
        "Pending payout is not in the private store; schedule it before settling.",
        { payoutId },
      );
    }
    return pending;
  }

  async #loadPayout(employer: string, payoutId: number): Promise<PayoutEntry> {
    const payout = await this.#payouts.getPayout(employer, payoutId);
    if (payout === null) {
      throw new PrivatePayoutFlowError(
        "PAYOUT_NOT_FOUND",
        "Payout is not scheduled on chain.",
        { payoutId },
      );
    }
    return payout;
  }

  async #findReceipt(
    employer: string,
    payoutId: number,
  ): Promise<PrivateReceiptSummary | undefined> {
    const payrollId = `payout:${employer}:${payoutId}`;
    const receipts = await this.#store.listReceipts({ employer });
    const matches = receipts.filter((receipt) => receipt.payrollId === payrollId);
    if (matches.length === 0) {
      return undefined;
    }
    const successes = matches.filter(
      (receipt) => normalizeStatus(receipt.status) === "SUCCESS" && receipt.intentHash !== null,
    );
    if (successes.length > 1) {
      const hashes = new Set(successes.map((receipt) => receipt.intentHash));
      if (hashes.size > 1) {
        throw new PrivatePayoutFlowError(
          "PAYOUT_STATE_CONFLICT",
          "Multiple successful receipts exist for this payout with different intent hashes.",
          { payoutId },
        );
      }
      return successes[0];
    }
    if (successes.length === 1) {
      return successes[0];
    }
    const terminalFailure = matches.find((receipt) => {
      const status = normalizeStatus(receipt.status);
      return status === "FAILED" || status === "REFUNDED" || status === "INCOMPLETE_DEPOSIT";
    });
    return terminalFailure ?? matches[0];
  }

  async #resolveReceipt(
    employer: string,
    payoutId: number,
    request: PrivatePayoutResumeRequest,
  ): Promise<PrivateReceiptSummary | undefined> {
    if (request.receiptId !== undefined) {
      const receipt = await this.#store.getReceipt(request.receiptId);
      if (receipt !== undefined) {
        this.#assertReceiptBinding(receipt, employer, payoutId);
        return receipt;
      }
    }
    if (request.intentHash !== undefined) {
      assertIntentHash(request.intentHash, "intentHash");
      const receipt = await this.#store.getReceiptByIntentHash(request.intentHash);
      if (receipt !== undefined) {
        this.#assertReceiptBinding(receipt, employer, payoutId);
        return receipt;
      }
    }
    return this.#findReceipt(employer, payoutId);
  }

  #assertReceiptBinding(
    receipt: PrivateReceiptSummary,
    employer: string,
    payoutId: number,
  ): void {
    if (
      receipt.employer !== employer ||
      receipt.payrollId !== `payout:${employer}:${payoutId}`
    ) {
      throw new PrivatePayoutFlowError(
        "PAYOUT_STORE_MISMATCH",
        "The receipt reference belongs to a different payout.",
        { payoutId },
      );
    }
  }

  async #poll(
    depositAddress: string,
    depositMemo: string | undefined,
    payoutId: number,
  ): Promise<{ status: string }> {
    try {
      return await this.#engine.waitForTerminalStatus(depositAddress, depositMemo);
    } catch (error) {
      const terminal = terminalStatusOf(error);
      if (terminal !== undefined) {
        return { status: terminal };
      }
      const timedOut =
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "PAYOUT_STATUS_TIMEOUT";
      throw new PrivatePayoutFlowError(
        timedOut ? "PAYOUT_STATUS_TIMEOUT" : "PAYOUT_EXECUTION_FAILED",
        redactedMessage("Payout status could not be resolved", error),
        { payoutId },
        undefined,
        error,
      );
    }
  }

  async #reconcile(
    payoutId: number,
    payout: PayoutEntry,
    intentHash: string | null | undefined,
    receiptId: string | undefined,
    status: string,
  ): Promise<PrivatePayoutSettlement> {
    if (status === "SUCCESS") {
      const resolved = intentHash ?? payout.intent_hash;
      if (resolved === null || resolved === undefined) {
        throw new PrivatePayoutFlowError(
          "PAYOUT_EXECUTION_FAILED",
          "Settlement succeeded but no intent hash was recorded.",
          { payoutId },
        );
      }
      return this.#markSettled(payoutId, payout, resolved, receiptId);
    }
    if (status === "FAILED" || status === "REFUNDED") {
      await this.#markFailed(payoutId, payout, status);
      throw new PrivatePayoutFlowError(
        status === "FAILED" ? "PAYOUT_FAILED" : "PAYOUT_REFUNDED",
        status === "FAILED"
          ? "1Click reported FAILED for this payout."
          : "1Click refunded this payout.",
        { payoutId },
        status,
      );
    }
    if (status === "INCOMPLETE_DEPOSIT") {
      throw new PrivatePayoutFlowError(
        "PAYOUT_INCOMPLETE_DEPOSIT",
        "1Click reported an incomplete deposit; the payout was not marked settled or failed.",
        { payoutId },
        "INCOMPLETE_DEPOSIT",
      );
    }
    if (PENDING_RECEIPT_STATUSES.has(status)) {
      throw new PrivatePayoutFlowError(
        "PAYOUT_RESUME_REQUIRED",
        "A payout receipt is still in flight; resume with a deposit reference instead of executing again.",
        { payoutId, status, receiptId },
      );
    }
    throw new PrivatePayoutFlowError(
      "PAYOUT_STATUS_UNEXPECTED",
      `Unexpected terminal settlement status (${status}).`,
      { payoutId },
    );
  }

  async #failedExecution(
    payoutId: number,
    payout: PayoutEntry,
    error: unknown,
  ): Promise<PrivatePayoutFlowError> {
    const terminal = terminalStatusOf(error);
    if (terminal === "FAILED" || terminal === "REFUNDED") {
      await this.#markFailed(payoutId, payout, terminal);
      return new PrivatePayoutFlowError(
        terminal === "FAILED" ? "PAYOUT_FAILED" : "PAYOUT_REFUNDED",
        redactedMessage(
          terminal === "FAILED" ? "1Click reported FAILED" : "1Click refunded the payout",
          error,
        ),
        { payoutId },
        terminal,
        error,
      );
    }
    if (terminal === "INCOMPLETE_DEPOSIT") {
      return new PrivatePayoutFlowError(
        "PAYOUT_INCOMPLETE_DEPOSIT",
        "1Click reported an incomplete deposit; the payout was not marked settled or failed.",
        { payoutId },
        "INCOMPLETE_DEPOSIT",
        error,
      );
    }
    return new PrivatePayoutFlowError(
      "PAYOUT_EXECUTION_FAILED",
      redactedMessage("Confidential payout failed", error),
      { payoutId },
      undefined,
      error,
    );
  }

  async #markSettled(
    payoutId: number,
    payout: PayoutEntry,
    intentHash: string | null | undefined,
    receiptId: string | undefined,
  ): Promise<PrivatePayoutSettlement> {
    let validated: string;
    try {
      validated = assertIntentHash(intentHash, "intentHash");
    } catch (error) {
      throw new PrivatePayoutFlowError(
        "PAYOUT_EXECUTION_FAILED",
        "Settlement intent hash is missing or invalid.",
        { payoutId },
        undefined,
        error,
      );
    }
    if (payout.state === "Executed") {
      if (payout.intent_hash !== null && payout.intent_hash !== validated) {
        throw new PrivatePayoutFlowError(
          "PAYOUT_STATE_CONFLICT",
          "Payout is already settled with a different intent hash.",
          { payoutId },
        );
      }
      return {
        state: "settled",
        payoutId,
        intentHash: validated,
        commitmentHash: payout.commitment_hash,
        ...(receiptId === undefined ? {} : { receiptId }),
      };
    }
    if (payout.state !== "Pending") {
      throw new PrivatePayoutFlowError(
        "PAYOUT_STATE_CONFLICT",
        "Payout is not pending; refusing to mark it settled.",
        { payoutId, state: payout.state },
      );
    }
    try {
      await this.#payouts.markSettled(payoutId, validated);
    } catch (error) {
      throw new PrivatePayoutFlowError(
        "PAYOUT_SETTLEMENT_RECORD_FAILED",
        redactedMessage("Payout settled off-chain but mark_settled failed", error),
        { payoutId },
        undefined,
        error,
      );
    }
    return {
      state: "settled",
      payoutId,
      intentHash: validated,
      commitmentHash: payout.commitment_hash,
      ...(receiptId === undefined ? {} : { receiptId }),
    };
  }

  async #markFailed(
    payoutId: number,
    payout: PayoutEntry,
    status: "FAILED" | "REFUNDED",
  ): Promise<void> {
    if (payout.state === "Failed") {
      return;
    }
    if (payout.state !== "Pending") {
      throw new PrivatePayoutFlowError(
        "PAYOUT_STATE_CONFLICT",
        "Payout is no longer pending; refusing to record a failure.",
        { payoutId, state: payout.state },
      );
    }
    try {
      await this.#payouts.markFailed(payoutId, status);
    } catch (error) {
      throw new PrivatePayoutFlowError(
        "PAYOUT_SETTLEMENT_RECORD_FAILED",
        redactedMessage("mark_failed failed for a failed payout", error),
        { payoutId, terminalStatus: status },
        status,
        error,
      );
    }
  }

  #nowIso(): string {
    const now = this.#now();
    const milliseconds = now.getTime();
    if (!Number.isFinite(milliseconds)) {
      throw new PrivatePayoutFlowError("INVALID_REQUEST", "Clock returned an invalid date.");
    }
    return new Date(milliseconds).toISOString();
  }
}
