/**
 * Resumable batch state machine.
 *
 * Tracks progress through an ordered batch collection so an interrupted run
 * can resume where it stopped. Checkpoints contain only stable item ids, batch
 * ids, counters, failure codes, and timestamps — never salaries, amounts,
 * salts, or account ids.
 */

export type BatchStatus = "PENDING" | "IN_PROGRESS" | "PAUSED" | "COMPLETED" | "FAILED";

/** One item tracked by a resumable batch. */
export interface BatchItem {
  /** Stable, non-empty identifier; the only item field copied into a checkpoint. */
  id: string;
  /** Optional private metadata kept in memory only. */
  metadata?: Record<string, unknown>;
}

/** A privacy-safe snapshot of batch progress. */
export interface BatchCheckpoint {
  batchId: string;
  status: BatchStatus;
  currentIndex: number;
  totalItems: number;
  processedIds: string[];
  failedItems: Array<{ id: string; error: string }>;
  updatedAt: string;
}

/** Options for the in-memory checkpoint store. */
export interface ResumableBatchOptions {
  /** Injectable clock for deterministic tests (defaults to `new Date()`). */
  now?: () => Date;
}

function copyCheckpoint(checkpoint: BatchCheckpoint): BatchCheckpoint {
  return {
    ...checkpoint,
    processedIds: [...checkpoint.processedIds],
    failedItems: checkpoint.failedItems.map((failure) => ({ ...failure })),
  };
}

/** Validates that a batch id is a usable non-empty string. */
function assertBatchId(batchId: unknown): asserts batchId is string {
  if (typeof batchId !== "string" || batchId.trim().length === 0) {
    throw new Error("Invalid batchId: batchId must be a non-empty string");
  }
}

/** In-memory manager for resumable batch checkpoints. */
export class ResumableBatchManager {
  private readonly checkpoints = new Map<string, BatchCheckpoint>();
  private readonly now: () => Date;

  constructor(options: ResumableBatchOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Registers a new batch and returns its initial `PENDING` checkpoint.
   *
   * @throws {Error} for an empty batch id, an empty item list, duplicate ids,
   *   or a batch id that already exists.
   */
  public initializeBatch(batchId: string, items: readonly BatchItem[]): BatchCheckpoint {
    assertBatchId(batchId);
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error("Invalid batch items: items must be a non-empty array");
    }
    if (this.checkpoints.has(batchId)) {
      throw new Error(`Batch "${batchId}" already exists`);
    }

    const ids = new Set<string>();
    for (const item of items) {
      if (typeof item?.id !== "string" || item.id.trim().length === 0) {
        throw new Error("Invalid batch item: every item needs a non-empty id");
      }
      if (ids.has(item.id)) {
        throw new Error(`Duplicate batch item id "${item.id}"`);
      }
      ids.add(item.id);
    }

    const checkpoint: BatchCheckpoint = {
      batchId,
      status: "PENDING",
      currentIndex: 0,
      totalItems: items.length,
      processedIds: [],
      failedItems: [],
      updatedAt: this.now().toISOString(),
    };

    this.checkpoints.set(batchId, checkpoint);
    return copyCheckpoint(checkpoint);
  }

  /** Returns a defensive copy of a checkpoint. */
  public getCheckpoint(batchId: string): BatchCheckpoint {
    const checkpoint = this.checkpoints.get(batchId);
    if (!checkpoint) {
      throw new Error(`Batch "${batchId}" not found`);
    }
    return copyCheckpoint(checkpoint);
  }

  /** True when a batch has reached `COMPLETED` or `FAILED`. */
  public isTerminal(batchId: string): boolean {
    const checkpoint = this.checkpoints.get(batchId);
    if (!checkpoint) {
      throw new Error(`Batch "${batchId}" not found`);
    }
    return checkpoint.status === "COMPLETED" || checkpoint.status === "FAILED";
  }

  /**
   * Records progress: advances the cursor, marks an item as processed, and/or
   * records a failure.
   *
   * @param currentIndex - New cursor; clamped to `0..totalItems`.
   * @param processedId - Optional item id that finished successfully.
   * @param error - Optional failure to append.
   */
  public updateProgress(
    batchId: string,
    currentIndex: number,
    processedId?: string,
    error?: { id: string; message: string }
  ): BatchCheckpoint {
    const checkpoint = this.getCheckpoint(batchId);
    if (checkpoint.status === "COMPLETED" || checkpoint.status === "FAILED") {
      throw new Error(`Cannot update batch "${batchId}" in terminal status "${checkpoint.status}"`);
    }
    if (!Number.isInteger(currentIndex)) {
      throw new Error("Invalid currentIndex: expected an integer");
    }

    checkpoint.status = "IN_PROGRESS";
    checkpoint.currentIndex = Math.max(0, Math.min(currentIndex, checkpoint.totalItems));

    if (processedId && !checkpoint.processedIds.includes(processedId)) {
      checkpoint.processedIds.push(processedId);
    }

    if (error) {
      checkpoint.failedItems.push({ id: error.id, error: error.message });
    }

    checkpoint.updatedAt = this.now().toISOString();
    this.checkpoints.set(batchId, checkpoint);
    return copyCheckpoint(checkpoint);
  }

  /** Pauses a non-terminal batch. Pausing an already paused batch is a no-op. */
  public pauseBatch(batchId: string): BatchCheckpoint {
    const checkpoint = this.getCheckpoint(batchId);
    if (checkpoint.status === "COMPLETED") {
      throw new Error(`Cannot pause completed batch "${batchId}"`);
    }
    if (checkpoint.status === "FAILED") {
      throw new Error(`Cannot pause failed batch "${batchId}"`);
    }

    checkpoint.status = "PAUSED";
    checkpoint.updatedAt = this.now().toISOString();
    this.checkpoints.set(batchId, checkpoint);
    return copyCheckpoint(checkpoint);
  }

  /** Resumes a `PENDING`, `IN_PROGRESS`, or `PAUSED` batch. */
  public resumeBatch(batchId: string): BatchCheckpoint {
    const checkpoint = this.getCheckpoint(batchId);
    if (
      checkpoint.status !== "PAUSED" &&
      checkpoint.status !== "IN_PROGRESS" &&
      checkpoint.status !== "PENDING"
    ) {
      throw new Error(`Cannot resume batch "${batchId}" from status "${checkpoint.status}"`);
    }

    checkpoint.status = "IN_PROGRESS";
    checkpoint.updatedAt = this.now().toISOString();
    this.checkpoints.set(batchId, checkpoint);
    return copyCheckpoint(checkpoint);
  }

  /** Marks a non-terminal, non-failed batch as completed. */
  public completeBatch(batchId: string): BatchCheckpoint {
    const checkpoint = this.getCheckpoint(batchId);
    if (checkpoint.status === "COMPLETED") {
      return copyCheckpoint(checkpoint);
    }
    if (checkpoint.status === "FAILED") {
      throw new Error(`Cannot complete failed batch "${batchId}"; reinitialize it instead`);
    }

    checkpoint.status = "COMPLETED";
    checkpoint.updatedAt = this.now().toISOString();
    this.checkpoints.set(batchId, checkpoint);
    return copyCheckpoint(checkpoint);
  }

  /** Marks a batch as failed. Completing or failing a failed batch is rejected. */
  public failBatch(batchId: string): BatchCheckpoint {
    const checkpoint = this.getCheckpoint(batchId);
    if (checkpoint.status === "FAILED") {
      return copyCheckpoint(checkpoint);
    }
    if (checkpoint.status === "COMPLETED") {
      throw new Error(`Cannot fail completed batch "${batchId}"`);
    }

    checkpoint.status = "FAILED";
    checkpoint.updatedAt = this.now().toISOString();
    this.checkpoints.set(batchId, checkpoint);
    return copyCheckpoint(checkpoint);
  }
}
