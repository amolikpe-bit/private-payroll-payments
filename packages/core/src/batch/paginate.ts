/**
 * Batch pagination helpers.
 *
 * Pure, stateless utilities that decide which records belong to the current
 * batch. Invalid page sizes fail fast (a payroll run must never silently
 * process an unintended batch size), ordering is preserved, and records are
 * never duplicated or skipped across batches.
 */

import { ValidationError } from "../core/errors.js";

/** A single deterministic batch (page) of a larger collection. */
export interface BatchPage<T> {
  /** Records belonging to this batch, in original collection order. */
  readonly items: T[];
  /** Zero-based index of this batch (`0 .. totalPages - 1`). */
  readonly index: number;
  /** Starting offset of this batch within the original collection. */
  readonly offset: number;
  /** Number of records in this batch. */
  readonly count: number;
  /** Total number of records in the underlying collection. */
  readonly totalItems: number;
  /** Total number of batches the collection is divided into. */
  readonly totalPages: number;
  /** Whether another batch follows this one. */
  readonly hasNext: boolean;
}

/**
 * Validates a batch size.
 *
 * Rejects `0`, negative values, non-finite values, and non-integers. An
 * `undefined` page size means "no pagination" and treats the whole collection
 * as one batch.
 */
export function assertValidPageSize(pageSize: unknown): void {
  if (pageSize === undefined) return;

  if (
    typeof pageSize !== "number" ||
    !Number.isFinite(pageSize) ||
    !Number.isInteger(pageSize) ||
    pageSize <= 0
  ) {
    throw new ValidationError("Invalid page size: expected a positive integer.", "pageSize");
  }
}

/** Validates a zero-based batch index. */
export function assertValidBatchIndex(batchIndex: number): void {
  if (
    typeof batchIndex !== "number" ||
    !Number.isFinite(batchIndex) ||
    !Number.isInteger(batchIndex) ||
    batchIndex < 0
  ) {
    throw new ValidationError(
      "Invalid batch index: expected a non-negative integer.",
      "batchIndex"
    );
  }
}

/**
 * Returns the requested batch of an ordered collection.
 *
 * A batch index beyond the last page returns an empty batch rather than
 * throwing, mirroring view pagination.
 */
export function getBatchPage<T>(items: readonly T[], pageSize?: number, batchIndex = 0): BatchPage<T> {
  assertValidPageSize(pageSize);
  assertValidBatchIndex(batchIndex);

  const totalItems = items.length;
  const effectivePageSize = pageSize ?? totalItems;
  const totalPages = totalItems === 0 ? 1 : Math.ceil(totalItems / effectivePageSize);

  const offset = batchIndex * effectivePageSize;
  const clampedOffset = Math.min(offset, totalItems);
  const pageItems = items.slice(clampedOffset, clampedOffset + effectivePageSize);

  return {
    items: pageItems,
    index: batchIndex,
    offset: clampedOffset,
    count: pageItems.length,
    totalItems,
    totalPages,
    hasNext: batchIndex + 1 < totalPages,
  };
}

/**
 * Lazily iterates over all batches of an ordered collection.
 *
 * Concatenating `items` across all yielded batches reconstructs the original
 * collection exactly once and in order.
 */
export function* iterateBatches<T>(items: readonly T[], pageSize?: number): Generator<BatchPage<T>> {
  assertValidPageSize(pageSize);

  const totalItems = items.length;
  const effectivePageSize = pageSize ?? (totalItems > 0 ? totalItems : 1);
  const totalPages = totalItems === 0 ? 1 : Math.ceil(totalItems / effectivePageSize);

  for (let index = 0; index < totalPages; index++) {
    const offset = index * effectivePageSize;
    const pageItems = items.slice(offset, offset + effectivePageSize);

    yield {
      items: pageItems,
      index,
      offset,
      count: pageItems.length,
      totalItems,
      totalPages,
      hasNext: index + 1 < totalPages,
    };
  }
}
