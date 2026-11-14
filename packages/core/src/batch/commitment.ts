/**
 * Deterministic batch-entry commitment used by resume tokens.
 *
 * The commitment is a SHA-256 over a domain separator plus the entries'
 * identifying fields in submission order. It is non-reversible and the token
 * that carries it contains no account ids, amounts, or salts.
 *
 * Order matters: a resume token authorizes skipping batches, so reordering the
 * entries must invalidate it (a reordered collection would skip different
 * payouts).
 */

import { hash as cryptoHash } from "node:crypto";

/** Domain separator for batch resume commitments. */
export const BATCH_ENTRY_COMMITMENT_DOMAIN = "subrosa/batch-resume/v1";

/** Fields extracted from a payout-like entry for the commitment. */
interface ExtractableEntry {
  employee?: unknown;
  recipient?: unknown;
  amount?: unknown;
  salt?: unknown;
  commitment_hash?: unknown;
  commitmentHash?: unknown;
  asset?: unknown;
  memo?: unknown;
}

function fieldValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "1" : "0";
  return "";
}

/**
 * Computes the order-sensitive commitment of an entries collection.
 *
 * @param entries - Payout-like records (`employee`, `amount`, `salt`,
 *   `commitment_hash`, `asset`, `memo` are read when present).
 */
export function computeBatchEntriesCommitment(entries: readonly unknown[]): string {
  let acc = `${BATCH_ENTRY_COMMITMENT_DOMAIN}\u0000${entries.length}`;
  for (const entry of entries) {
    const record: ExtractableEntry =
      entry !== null && typeof entry === "object" ? (entry as ExtractableEntry) : {};
    acc +=
      `\u0000${fieldValue(record.employee ?? record.recipient)}` +
      `\u0001${fieldValue(record.commitment_hash ?? record.commitmentHash)}` +
      `\u0001${fieldValue(record.amount)}` +
      `\u0001${fieldValue(record.salt)}` +
      `\u0001${fieldValue(record.asset)}` +
      `\u0001${fieldValue(record.memo)}`;
  }
  return cryptoHash("sha256", acc);
}
