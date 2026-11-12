/**
 * Typed client for salary commitments.
 *
 * A commitment is `sha256(DOMAIN ‖ borsh{employer, employee, token, cycle_id,
 * amount: u128, salt})`; the amount and salt never leave the client. The
 * on-chain verify view deliberately does not exist, so `verifyCommitment`
 * recomputes the hash locally and compares it to the public on-chain value.
 */

import {
  verifyCommitment as verifyCommitmentHash,
} from "../crypto/hashUtils.js";
import type { CommitmentEntry, CommitItem } from "../types.js";
import type { NearContractWrapper, NearContractCallOptions } from "./NearContractWrapper.js";
import {
  assertSafeU64,
  normalizeCommitmentHash,
  parseCommitmentEntry,
  parseCount,
  requireAccountId,
} from "./entries.js";
import { ValidationError } from "../core/errors.js";

/** Contract cap for one `batch_commit_salaries` call. */
export const MAX_COMMIT_BATCH_SIZE = 50;
/** Storage bytes charged per commitment record (doc §3.6). */
export const COMMITMENT_STORAGE_BYTES = 182n;

const YOCTO_PER_NEAR = 10n ** 24n;
const YOCTO_PER_BYTE = 10n ** 19n;

export interface CommitSalaryArgs {
  employee: string;
  commitmentHash: string;
  cycleId: number;
}

export interface CommitmentBatchResult {
  chunks: number;
  itemsCommitted: number;
}

/** Format a yoctoNEAR amount as an exact decimal NEAR string. */
function formatNearFromYocto(yocto: bigint): string {
  const whole = yocto / YOCTO_PER_NEAR;
  const fraction = (yocto % YOCTO_PER_NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}

/** Exact storage deposit for `count` commitment records. */
export function commitmentDepositNear(count: number): string {
  if (!Number.isInteger(count) || count <= 0) {
    throw new ValidationError("Commitment count must be a positive integer.", "count");
  }
  return formatNearFromYocto(BigInt(count) * COMMITMENT_STORAGE_BYTES * YOCTO_PER_BYTE);
}

function toCommitItem(item: CommitItem): CommitItem {
  return {
    employee: requireAccountId(item.employee, "employee"),
    commitment_hash: normalizeCommitmentHash(item.commitment_hash, "commitment_hash"),
    cycle_id: assertSafeU64(item.cycle_id, "cycle_id"),
  };
}

export class CommitmentClient {
  constructor(private readonly near: NearContractWrapper) {}

  async commitSalary(args: CommitSalaryArgs, opts?: NearContractCallOptions): Promise<void> {
    await this.near.call<null>(
      "commit_salary",
      {
        employee: requireAccountId(args.employee, "employee"),
        commitment_hash: normalizeCommitmentHash(args.commitmentHash, "commitmentHash"),
        cycle_id: assertSafeU64(args.cycleId, "cycleId"),
      },
      opts,
    );
  }

  /**
   * Commit up to 50 items per call, attaching the exact storage deposit for
   * each chunk. No refund path exists: the deposit must cover the chunk and is
   * retained by the contract.
   */
  async batchCommit(
    items: CommitItem[],
    opts?: NearContractCallOptions,
  ): Promise<CommitmentBatchResult> {
    if (!Array.isArray(items) || items.length === 0) {
      throw new ValidationError("items must contain at least one commitment.", "items", "EMPTY_BATCH");
    }

    const normalized = items.map(toCommitItem);
    let chunks = 0;

    for (let offset = 0; offset < normalized.length; offset += MAX_COMMIT_BATCH_SIZE) {
      const chunk = normalized.slice(offset, offset + MAX_COMMIT_BATCH_SIZE);
      const deposit = opts?.deposit ?? commitmentDepositNear(chunk.length);
      await this.near.call<null>(
        "batch_commit_salaries",
        { items: chunk },
        { ...opts, deposit },
      );
      chunks += 1;
    }

    return { chunks, itemsCommitted: normalized.length };
  }

  async getCommitment(
    employer: string,
    employee: string,
    cycleId: number,
  ): Promise<CommitmentEntry | null> {
    const result = await this.near.view<CommitmentEntry | null>("get_commitment", {
      employer: requireAccountId(employer, "employer"),
      employee: requireAccountId(employee, "employee"),
      cycle_id: assertSafeU64(cycleId, "cycleId"),
    });
    return parseCommitmentEntry(result);
  }

  async getCommitmentCount(employer: string, employee: string): Promise<number> {
    const result = await this.near.view<number>("get_commitment_count", {
      employer: requireAccountId(employer, "employer"),
      employee: requireAccountId(employee, "employee"),
    });
    return parseCount(result, "get_commitment_count");
  }

  /**
   * Recompute the commitment preimage locally and compare it with the public
   * on-chain hash. Delegates byte construction and hashing to
   * `crypto/hashUtils.ts` so the TS and Rust encoders stay identical.
   */
  verifyCommitment(
    args: Parameters<typeof verifyCommitmentHash>[0],
    expectedHex: string,
  ): boolean {
    return verifyCommitmentHash(args, expectedHex);
  }
}
