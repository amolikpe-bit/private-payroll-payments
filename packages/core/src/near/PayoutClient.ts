/**
 * Typed client for the payout lifecycle.
 *
 * Scheduling is bookkeeping: the amount and salt live only in the SDK's
 * private `PendingPayout` store, and settlement happens off-chain through
 * Confidential Intents. The contract records the commitment hash, asset, memo,
 * execution timestamp (nanoseconds), and later the settlement intent hash.
 */

import type { PayoutEntry } from "../types.js";
import type { NearContractWrapper, NearContractCallOptions } from "./NearContractWrapper.js";
import {
  assertNonEmptyString,
  assertPageLimit,
  assertSafeU64,
  assertTimestampNs,
  assertU32,
  assertIntentHash,
  normalizeCommitmentHash,
  parseBoolean,
  parseCount,
  parsePayoutArray,
  parsePayoutEntry,
  requireAccountId,
  storageDepositNear,
} from "./entries.js";

import { ValidationError } from "../core/errors.js";

export const CANCELLATION_REASON_CODES = [
  "insufficient_funds",
  "duplicate_run",
  "employee_dispute",
  "compliance_hold",
  "schedule_error",
  "other",
] as const;

export type CancellationReasonCode = (typeof CANCELLATION_REASON_CODES)[number];

function assertCancellationReason(value: unknown): CancellationReasonCode {
  if (
    typeof value !== "string" ||
    !(CANCELLATION_REASON_CODES as readonly string[]).includes(value)
  ) {
    throw new ValidationError(
      "reasonCode must be one of the six documented cancellation codes.",
      "reasonCode",
    );
  }
  return value as CancellationReasonCode;
}
export interface SchedulePayoutArgs {
  employee: string;
  commitmentHash: string;
  asset: string;
  memo?: string;
  /** Execution time in nanoseconds since epoch. */
  executeAt: number;
}

export interface CancelPayoutArgs {
  payoutId: number;
  reasonCode: string;
}

export class PayoutClient {
  constructor(private readonly near: NearContractWrapper) {}

  /** Schedule a payout and return the per-employer payout id (1-based). */
  async schedulePayout(args: SchedulePayoutArgs, opts?: NearContractCallOptions): Promise<number> {
    const memo = args.memo ?? "";
    const memoBytes = new TextEncoder().encode(memo).length;
    if (memoBytes > 256) {
      throw new ValidationError("memo must be at most 256 UTF-8 bytes.", "memo");
    }
    const result = await this.near.call<number>(
      "schedule_payout",
      {
        employee: requireAccountId(args.employee, "employee"),
        commitment_hash: normalizeCommitmentHash(args.commitmentHash, "commitmentHash"),
        asset: requireAccountId(args.asset, "asset"),
        memo,
        execute_at: assertTimestampNs(args.executeAt, "executeAt"),
      },
      { ...opts, deposit: opts?.deposit ?? storageDepositNear(258 + memoBytes) },
    );
    return parseCount(result, "schedule_payout");
  }

  async cancelPayout(args: CancelPayoutArgs, opts?: NearContractCallOptions): Promise<void> {
    await this.near.call<null>(
      "cancel_payout",
      {
        payout_id: assertSafeU64(args.payoutId, "payoutId"),
        reason_code: assertCancellationReason(args.reasonCode),
      },
      opts,
    );
  }

  /** Record the intent hash returned by the confidential payout executor. */
  async markSettled(
    payoutId: number,
    intentHash: string,
    opts?: NearContractCallOptions,
  ): Promise<void> {
    await this.near.call<null>(
      "mark_settled",
      {
        payout_id: assertSafeU64(payoutId, "payoutId"),
        intent_hash: assertIntentHash(intentHash, "intentHash"),
      },
      opts,
    );
  }

  /** Record a terminal failure reported by 1Click (FAILED / REFUNDED). */
  async markFailed(
    payoutId: number,
    status: string,
    opts?: NearContractCallOptions,
  ): Promise<void> {
    await this.near.call<null>(
      "mark_failed",
      {
        payout_id: assertSafeU64(payoutId, "payoutId"),
        status: assertNonEmptyString(status, "status"),
      },
      opts,
    );
  }

  async expirePayout(payoutId: number, opts?: NearContractCallOptions): Promise<void> {
    await this.near.call<null>(
      "expire_payout",
      { payout_id: assertSafeU64(payoutId, "payoutId") },
      opts,
    );
  }

  async getPayout(employer: string, payoutId: number): Promise<PayoutEntry | null> {
    const result = await this.near.view<PayoutEntry | null>("get_payout", {
      employer: requireAccountId(employer, "employer"),
      payout_id: assertSafeU64(payoutId, "payoutId"),
    });
    return parsePayoutEntry(result);
  }

  async getPendingPayouts(
    employer: string,
    fromIndex: number,
    limit: number,
  ): Promise<PayoutEntry[]> {
    const result = await this.near.view<PayoutEntry[]>("get_pending_payouts", {
      employer: requireAccountId(employer, "employer"),
      from_index: assertU32(fromIndex, "fromIndex"),
      limit: assertPageLimit(limit),
    });
    return parsePayoutArray(result);
  }

  async getPayoutCount(employer: string): Promise<number> {
    const result = await this.near.view<number>("get_payout_count", {
      employer: requireAccountId(employer, "employer"),
    });
    return parseCount(result, "get_payout_count");
  }

  async isPayoutDue(employer: string, payoutId: number): Promise<boolean> {
    const result = await this.near.view<boolean>("is_payout_due", {
      employer: requireAccountId(employer, "employer"),
      payout_id: assertSafeU64(payoutId, "payoutId"),
    });
    return parseBoolean(result, "is_payout_due");
  }
}
