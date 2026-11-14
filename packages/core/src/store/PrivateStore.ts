/**
 * Private JSON store for scheduled-payout amounts and confidential receipts.
 *
 * NEAR state is public, so amounts, salts and the 1Click deposit address never
 * go on chain. They live in one JSON file written with mode `0600`. Writes are
 * atomic (temp file + rename) and serialized so concurrent payouts cannot lose
 * updates.
 *
 * Read APIs return {@link PrivateReceiptSummary}: `depositAddress` and
 * `depositMemo` never leave the store. Only the write path accepts the secret,
 * because a quote's deposit address is needed to correlate the private receipt.
 */

import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import { atomicWriteFile } from "../core/atomicWrite.js";
import { dirname, resolve } from "node:path";

import type { PendingPayout } from "../types.js";
import { isValidIntentHash } from "../settlement/receipt.js";
import { isHex64 } from "../crypto/hashUtils.js";

/** Current on-disk schema version. */
export const PRIVATE_STORE_VERSION = 1;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const DEFAULT_STORE_PATH = ".subrosa/private-store.json";

export type PrivateStoreErrorCode =
  | "CORRUPT_STORE"
  | "INVALID_RECORD"
  | "DUPLICATE_RECEIPT"
  | "DUPLICATE_INTENT_HASH"
  | "READ_FAILED"
  | "WRITE_FAILED"
  | "PERMISSIONS_UNENFORCEABLE"
  | "SYMLINK_NOT_ALLOWED";

export class PrivateStoreError extends Error {
  readonly code: PrivateStoreErrorCode;

  constructor(code: PrivateStoreErrorCode, message: string) {
    super(message);
    this.name = "PrivateStoreError";
    this.code = code;
  }
}

/**
 * Full private receipt. `depositAddress`/`depositMemo` are secrets: they are
 * persisted but never returned by a read method.
 */
export interface PrivateReceipt {
  receiptId: string;
  payrollId: string;
  employer: string;
  employee: string;
  /** Null until `/v0/submit-intent` returns the intent hash. */
  intentHash: string | null;
  /** Null for shield/refund operations that are not tied to a commitment. */
  commitmentHash: string | null;
  amount: string;
  asset: string;
  /** Secret 1Click deposit address; never expose publicly. */
  depositAddress: string;
  /** Secret deposit memo; meaningless without the address but kept private. */
  depositMemo?: string;
  quoteSignature?: string;
  correlationId?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/** Public projection of a private receipt: no address, memo or salt material. */
export type PrivateReceiptSummary = Omit<PrivateReceipt, "depositAddress" | "depositMemo">;

export interface PrivateReceiptFilter {
  employer?: string;
  employee?: string;
  status?: string;
  limit?: number;
}

export interface PrivateReceiptPatch {
  intentHash?: string;
  status?: string;
  updatedAt?: string;
  correlationId?: string;
  quoteSignature?: string;
}

export interface PrivateStoreOptions {
  /** Defaults to `SUBROSA_STORE_PATH` or `.subrosa/private-store.json`. */
  filePath?: string;
}

interface PrivateStoreFile {
  version: typeof PRIVATE_STORE_VERSION;
  pendingPayouts: PendingPayout[];
  receipts: PrivateReceipt[];
}

/**
 * File-backed private store. Construct once per process; all methods share one
 * serialized write queue.
 */
export class PrivateStore {
  readonly #filePath: string;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(options: PrivateStoreOptions = {}) {
    const configured = options.filePath ?? process.env.SUBROSA_STORE_PATH ?? DEFAULT_STORE_PATH;
    if (typeof configured !== "string" || configured.trim().length === 0) {
      throw new PrivateStoreError("INVALID_RECORD", "Private store path must be a non-empty string.");
    }
    this.#filePath = resolve(configured);
  }

  /** Absolute path of the JSON file (directory listing is not sensitive). */
  get filePath(): string {
    return this.#filePath;
  }

  async savePendingPayout(payout: PendingPayout): Promise<void> {
    const record = parsePendingPayout(payout);
    await this.#run(async () => {
      const state = await this.#readState();
      const index = state.pendingPayouts.findIndex(
        (candidate) =>
          candidate.employer === record.employer && candidate.payout_id === record.payout_id,
      );
      if (index >= 0) {
        state.pendingPayouts[index] = record;
      } else {
        state.pendingPayouts.push(record);
      }
      await this.#writeState(state);
    });
  }

  async getPendingPayout(employer: string, payoutId: number): Promise<PendingPayout | undefined> {
    assertNonEmpty(employer, "employer");
    assertPayoutId(payoutId);
    const state = await this.#readState();
    return state.pendingPayouts.find(
      (candidate) => candidate.employer === employer && candidate.payout_id === payoutId,
    );
  }

  async listPendingPayouts(employer?: string): Promise<PendingPayout[]> {
    if (employer !== undefined) {
      assertNonEmpty(employer, "employer");
    }
    const state = await this.#readState();
    return state.pendingPayouts
      .filter((candidate) => employer === undefined || candidate.employer === employer)
      .slice()
      .sort((left, right) =>
        left.employer === right.employer
          ? left.payout_id - right.payout_id
          : left.employer.localeCompare(right.employer),
      )
      .map((candidate) => ({ ...candidate }));
  }

  async deletePendingPayout(employer: string, payoutId: number): Promise<boolean> {
    assertNonEmpty(employer, "employer");
    assertPayoutId(payoutId);
    return this.#run(async () => {
      const state = await this.#readState();
      const index = state.pendingPayouts.findIndex(
        (candidate) => candidate.employer === employer && candidate.payout_id === payoutId,
      );
      if (index < 0) {
        return false;
      }
      state.pendingPayouts.splice(index, 1);
      await this.#writeState(state);
      return true;
    });
  }

  /**
   * Persist a private receipt. The write is the only place a deposit address is
   * accepted; every read method returns a redacted projection.
   */
  async savePrivateReceipt(receipt: PrivateReceipt): Promise<void> {
    const record = parsePrivateReceipt(receipt);
    await this.#run(async () => {
      const state = await this.#readState();
      ensureUniqueReceipt(state, record);
      const index = state.receipts.findIndex((candidate) => candidate.receiptId === record.receiptId);
      if (index >= 0) {
        state.receipts[index] = record;
      } else {
        state.receipts.push(record);
      }
      await this.#writeState(state);
    });
  }

  async updatePrivateReceipt(
    receiptId: string,
    patch: PrivateReceiptPatch,
  ): Promise<PrivateReceiptSummary> {
    assertReceiptId(receiptId);
    if (typeof patch !== "object" || patch === null) {
      throw new PrivateStoreError("INVALID_RECORD", "Receipt patch must be an object.");
    }
    return this.#run(async () => {
      const state = await this.#readState();
      const index = state.receipts.findIndex((candidate) => candidate.receiptId === receiptId);
      if (index < 0) {
        throw new PrivateStoreError("INVALID_RECORD", "Receipt is not present in the private store.");
      }
      const current = state.receipts[index];
      const nextIntentHash = patch.intentHash;
      if (nextIntentHash !== undefined) {
        if (!isValidIntentHash(nextIntentHash)) {
          throw new PrivateStoreError("INVALID_RECORD", "Intent hash is invalid.");
        }
        const conflict = state.receipts.find(
          (candidate) =>
            candidate.receiptId !== current.receiptId && candidate.intentHash === nextIntentHash,
        );
        if (conflict !== undefined) {
          throw new PrivateStoreError("DUPLICATE_INTENT_HASH", "Intent hash is already recorded.");
        }
        current.intentHash = nextIntentHash;
      }
      const nextStatus = patch.status;
      if (nextStatus !== undefined) {
        assertNonEmpty(nextStatus, "status");
        current.status = nextStatus;
      }
      const nextCorrelationId = patch.correlationId;
      if (nextCorrelationId !== undefined) {
        assertNonEmpty(nextCorrelationId, "correlationId");
        current.correlationId = nextCorrelationId;
      }
      const nextQuoteSignature = patch.quoteSignature;
      if (nextQuoteSignature !== undefined) {
        assertNonEmpty(nextQuoteSignature, "quoteSignature");
        current.quoteSignature = nextQuoteSignature;
      }
      current.updatedAt =
        patch.updatedAt === undefined ? new Date().toISOString() : patch.updatedAt;
      assertTimestamp(current.updatedAt, "updatedAt");
      await this.#writeState(state);
      return toSummary(current);
    });
  }

  async getReceipt(receiptId: string): Promise<PrivateReceiptSummary | undefined> {
    assertReceiptId(receiptId);
    const state = await this.#readState();
    const receipt = state.receipts.find((candidate) => candidate.receiptId === receiptId);
    return receipt === undefined ? undefined : toSummary(receipt);
  }

  async getReceiptByIntentHash(intentHash: string): Promise<PrivateReceiptSummary | undefined> {
    if (!isValidIntentHash(intentHash)) {
      throw new PrivateStoreError("INVALID_RECORD", "Intent hash is invalid.");
    }
    const state = await this.#readState();
    const receipt = state.receipts.find((candidate) => candidate.intentHash === intentHash);
    return receipt === undefined ? undefined : toSummary(receipt);
  }

  async listReceipts(filter: PrivateReceiptFilter = {}): Promise<PrivateReceiptSummary[]> {
    if (typeof filter !== "object" || filter === null) {
      throw new PrivateStoreError("INVALID_RECORD", "Receipt filter must be an object.");
    }
    if (filter.employer !== undefined) {
      assertNonEmpty(filter.employer, "employer");
    }
    if (filter.employee !== undefined) {
      assertNonEmpty(filter.employee, "employee");
    }
    if (filter.status !== undefined) {
      assertNonEmpty(filter.status, "status");
    }
    if (filter.limit !== undefined && (!Number.isInteger(filter.limit) || filter.limit <= 0)) {
      throw new PrivateStoreError("INVALID_RECORD", "Receipt limit must be a positive integer.");
    }
    const state = await this.#readState();
    const receipts = state.receipts
      .filter(
        (candidate) =>
          (filter.employer === undefined || candidate.employer === filter.employer) &&
          (filter.employee === undefined || candidate.employee === filter.employee) &&
          (filter.status === undefined || candidate.status === filter.status),
      )
      .slice()
      .sort((left, right) => {
        const leftTime = Date.parse(left.createdAt);
        const rightTime = Date.parse(right.createdAt);
        return leftTime === rightTime
          ? left.receiptId.localeCompare(right.receiptId)
          : rightTime - leftTime;
      })
      .map(toSummary);
    return filter.limit === undefined ? receipts : receipts.slice(0, filter.limit);
  }

  async deleteReceipt(receiptId: string): Promise<boolean> {
    assertReceiptId(receiptId);
    return this.#run(async () => {
      const state = await this.#readState();
      const index = state.receipts.findIndex((candidate) => candidate.receiptId === receiptId);
      if (index < 0) {
        return false;
      }
      state.receipts.splice(index, 1);
      await this.#writeState(state);
      return true;
    });
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#writeQueue.then(operation, operation);
    this.#writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #readState(): Promise<PrivateStoreFile> {
    await this.#assertNotSymlink();
    let raw: string;
    try {
      raw = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return { version: PRIVATE_STORE_VERSION, pendingPayouts: [], receipts: [] };
      }
      throw new PrivateStoreError("READ_FAILED", "Private store could not be read.");
    }
    const state = parsePrivateStoreFile(raw);
    await this.#enforceFileMode();
    return state;
  }

  async #writeState(state: PrivateStoreFile): Promise<void> {
    await this.#assertNotSymlink();
    const directory = dirname(this.#filePath);
    try {
      await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    } catch {
      throw new PrivateStoreError("WRITE_FAILED", "Private store directory could not be created.");
    }
    await this.#enforceDirectoryMode(directory);

    const payload = `${JSON.stringify(state, null, 2)}\n`;
    try {
      await atomicWriteFile(this.#filePath, payload, { mode: FILE_MODE });
      await this.#enforceFileMode();
    } catch (error) {
      if (error instanceof PrivateStoreError) {
        throw error;
      }
      throw new PrivateStoreError("WRITE_FAILED", "Private store could not be written atomically.");
    }
  }

  async #assertNotSymlink(): Promise<void> {
    try {
      const info = await lstat(this.#filePath);
      if (info.isSymbolicLink()) {
        throw new PrivateStoreError(
          "SYMLINK_NOT_ALLOWED",
          "Private store path must not be a symbolic link.",
        );
      }
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return;
      }
      if (error instanceof PrivateStoreError) {
        throw error;
      }
      throw new PrivateStoreError("READ_FAILED", "Private store path could not be inspected.");
    }
  }

  async #enforceFileMode(): Promise<void> {
    if (process.platform === "win32") {
      return;
    }
    try {
      await chmod(this.#filePath, FILE_MODE);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return;
      }
      throw new PrivateStoreError(
        "PERMISSIONS_UNENFORCEABLE",
        "Private store permissions could not be restricted to 0600.",
      );
    }
  }

  async #enforceDirectoryMode(directory: string): Promise<void> {
    if (process.platform === "win32") {
      return;
    }
    try {
      await chmod(directory, DIRECTORY_MODE);
    } catch {
      throw new PrivateStoreError(
        "PERMISSIONS_UNENFORCEABLE",
        "Private store directory permissions could not be restricted to 0700.",
      );
    }
  }
}

function parsePrivateStoreFile(raw: string): PrivateStoreFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PrivateStoreError("CORRUPT_STORE", "Private store is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PrivateStoreError("CORRUPT_STORE", "Private store root must be an object.");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== PRIVATE_STORE_VERSION) {
    throw new PrivateStoreError("CORRUPT_STORE", "Private store version is unsupported.");
  }
  const pendingRecords = record.pendingPayouts;
  const receiptRecords = record.receipts;
  if (!Array.isArray(pendingRecords) || !Array.isArray(receiptRecords)) {
    throw new PrivateStoreError("CORRUPT_STORE", "Private store collections are missing.");
  }
  const pendingPayouts = pendingRecords.map(parsePendingPayout);
  const receipts = receiptRecords.map(parsePrivateReceipt);

  const pendingKeys = new Set<string>();
  for (const payout of pendingPayouts) {
    const key = `${payout.employer}\u0000${payout.payout_id}`;
    if (pendingKeys.has(key)) {
      throw new PrivateStoreError("CORRUPT_STORE", "Private store contains duplicate pending payouts.");
    }
    pendingKeys.add(key);
  }
  const receiptIds = new Set<string>();
  const intentHashes = new Set<string>();
  for (const receipt of receipts) {
    if (receiptIds.has(receipt.receiptId)) {
      throw new PrivateStoreError("CORRUPT_STORE", "Private store contains duplicate receipt ids.");
    }
    receiptIds.add(receipt.receiptId);
    if (receipt.intentHash !== null) {
      if (intentHashes.has(receipt.intentHash)) {
        throw new PrivateStoreError("CORRUPT_STORE", "Private store contains duplicate intent hashes.");
      }
      intentHashes.add(receipt.intentHash);
    }
  }
  return { version: PRIVATE_STORE_VERSION, pendingPayouts, receipts };
}

function parsePendingPayout(value: unknown): PendingPayout {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PrivateStoreError("INVALID_RECORD", "Pending payout must be an object.");
  }
  const record = value as Record<string, unknown>;
  assertNonEmpty(record.employer, "employer");
  assertNonEmpty(record.employee, "employee");
  assertNonEmpty(record.asset, "asset");
  assertPayoutId(record.payout_id);
  const amount = assertAmount(record.amount);
  if (typeof record.salt !== "string" || !/^(?:[0-9a-fA-F]{2})+$/.test(record.salt)) {
    throw new PrivateStoreError("INVALID_RECORD", "Pending payout salt must be hexadecimal.");
  }
  if (!isHex64(record.commitment_hash)) {
    throw new PrivateStoreError("INVALID_RECORD", "Pending payout commitment hash is invalid.");
  }
  if (typeof record.memo !== "string") {
    throw new PrivateStoreError("INVALID_RECORD", "Pending payout memo must be a string.");
  }
  return {
    employer: record.employer,
    payout_id: record.payout_id,
    employee: record.employee,
    amount,
    salt: record.salt,
    asset: record.asset,
    memo: record.memo,
    commitment_hash: record.commitment_hash.toLowerCase(),
  };
}

function parsePrivateReceipt(value: unknown): PrivateReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PrivateStoreError("INVALID_RECORD", "Private receipt must be an object.");
  }
  const record = value as Record<string, unknown>;
  assertReceiptId(record.receiptId);
  assertNonEmpty(record.payrollId, "payrollId");
  assertNonEmpty(record.employer, "employer");
  assertNonEmpty(record.employee, "employee");
  assertNonEmpty(record.asset, "asset");
  assertNonEmpty(record.depositAddress, "depositAddress");
  assertNonEmpty(record.status, "status");
  assertTimestamp(record.createdAt, "createdAt");
  assertTimestamp(record.updatedAt, "updatedAt");
  const amount = assertAmount(record.amount);

  let intentHash: string | null = null;
  if (record.intentHash !== null && record.intentHash !== undefined) {
    if (!isValidIntentHash(record.intentHash)) {
      throw new PrivateStoreError("INVALID_RECORD", "Private receipt intent hash is invalid.");
    }
    intentHash = record.intentHash;
  }
  let commitmentHash: string | null = null;
  if (record.commitmentHash !== null && record.commitmentHash !== undefined) {
    if (!isHex64(record.commitmentHash)) {
      throw new PrivateStoreError("INVALID_RECORD", "Private receipt commitment hash is invalid.");
    }
    commitmentHash = record.commitmentHash.toLowerCase();
  }

  return {
    receiptId: record.receiptId,
    payrollId: record.payrollId,
    employer: record.employer,
    employee: record.employee,
    intentHash,
    commitmentHash,
    amount,
    asset: record.asset,
    depositAddress: record.depositAddress,
    depositMemo: optionalString(record.depositMemo, "depositMemo"),
    quoteSignature: optionalString(record.quoteSignature, "quoteSignature"),
    correlationId: optionalString(record.correlationId, "correlationId"),
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function ensureUniqueReceipt(state: PrivateStoreFile, record: PrivateReceipt): void {
  const sameId = state.receipts.find((candidate) => candidate.receiptId === record.receiptId);
  if (sameId !== undefined && sameId.intentHash !== record.intentHash) {
    throw new PrivateStoreError(
      "DUPLICATE_RECEIPT",
      "A different private receipt already uses this receipt id.",
    );
  }
  if (record.intentHash !== null) {
    const conflict = state.receipts.find(
      (candidate) =>
        candidate.receiptId !== record.receiptId && candidate.intentHash === record.intentHash,
    );
    if (conflict !== undefined) {
      throw new PrivateStoreError("DUPLICATE_INTENT_HASH", "Intent hash is already recorded.");
    }
  }
}

function toSummary(receipt: PrivateReceipt): PrivateReceiptSummary {
  const { depositAddress, depositMemo, ...summary } = receipt;
  void depositAddress;
  void depositMemo;
  return summary;
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw new PrivateStoreError("INVALID_RECORD", `${field} must be a non-empty string.`);
  }
}

function assertReceiptId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new PrivateStoreError("INVALID_RECORD", "Receipt id is invalid.");
  }
}

function assertPayoutId(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PrivateStoreError("INVALID_RECORD", "Payout id must be a non-negative safe integer.");
  }
}

function assertAmount(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value) || BigInt(value) <= 0n) {
    throw new PrivateStoreError("INVALID_RECORD", "Amount must be a positive integer string.");
  }
  return value;
}

function assertTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new PrivateStoreError("INVALID_RECORD", `${field} must be an ISO-8601 timestamp.`);
  }
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new PrivateStoreError("INVALID_RECORD", `${field} must be a non-empty string.`);
  }
  return value;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
