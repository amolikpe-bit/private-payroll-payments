/**
 * Durable NEP-297 event checkpoint.
 *
 * The cursor is client-side only (never on chain) and records the last fully
 * processed `(blockHeight, logIndex)` plus a bounded window of processed event
 * ids. The id window makes a crashed/retried batch idempotent even though the
 * cursor itself only advances after a handler succeeds.
 *
 * Writes are atomic (temp file + rename) and serialized, matching the private
 * store. The file contains only public chain positions and log ids.
 */

import { chmod, lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { atomicWriteFile } from "../core/atomicWrite.js";
import { dirname, resolve } from "node:path";

import { SubrosaError } from "../core/errors.js";

/** Current on-disk cursor schema version. */
export const EVENT_CURSOR_VERSION = 1;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const DEFAULT_CURSOR_PATH = ".subrosa/indexer-cursor.json";
const DEFAULT_PROCESSED_WINDOW = 4096;

export type EventCursorErrorCode =
  | "CORRUPT_CURSOR"
  | "INVALID_POSITION"
  | "READ_FAILED"
  | "WRITE_FAILED";

export class EventCursorError extends SubrosaError {
  constructor(code: EventCursorErrorCode, message: string, cause?: unknown) {
    super(message, code, {}, cause);
    this.name = "EventCursorError";
  }
}

/** Position of one event inside a block's flattened log list. */
export interface EventPosition {
  blockHeight: number;
  logIndex: number;
}

export interface EventCursorSnapshot extends EventPosition {
  /** Ids processed inside the retained window, oldest first. */
  processed: readonly string[];
  updatedAt: string;
}

export interface EventCursorOptions {
  /** Defaults to `.subrosa/indexer-cursor.json`. */
  filePath?: string;
  /** Start position used when the file does not exist yet. */
  initial?: EventPosition;
  /** Retained processed-id window; defaults to 4096. */
  processedWindow?: number;
  now?: () => Date;
}

interface EventCursorFile {
  version: typeof EVENT_CURSOR_VERSION;
  blockHeight: number;
  logIndex: number;
  processed: string[];
  updatedAt: string;
}

function comparePositions(left: EventPosition, right: EventPosition): number {
  if (left.blockHeight !== right.blockHeight) {
    return left.blockHeight - right.blockHeight;
  }
  return left.logIndex - right.logIndex;
}

function assertPosition(value: unknown, field: string): EventPosition {
  if (typeof value !== "object" || value === null) {
    throw new EventCursorError("INVALID_POSITION", `${field} must be a position object.`);
  }
  const record = value as Record<string, unknown>;
  const blockHeight = record.blockHeight;
  const logIndex = record.logIndex;
  if (
    typeof blockHeight !== "number" ||
    !Number.isSafeInteger(blockHeight) ||
    blockHeight < 0 ||
    typeof logIndex !== "number" ||
    !Number.isSafeInteger(logIndex) ||
    logIndex < 0
  ) {
    throw new EventCursorError(
      "INVALID_POSITION",
      `${field} must contain non-negative safe integers.`,
    );
  }
  return { blockHeight, logIndex };
}

function eventId(position: EventPosition): string {
  return `${position.blockHeight}:${position.logIndex}`;
}

/**
 * File-backed checkpoint. Construct once per process; `markProcessed` is
 * serialized and monotonic, so an out-of-order retry cannot rewind progress.
 */
export class EventCursor {
  readonly #filePath: string;
  readonly #processedWindow: number;
  readonly #now: () => Date;
  readonly #initial: EventPosition | null;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(options: EventCursorOptions = {}) {
    const configured = options.filePath ?? process.env.SUBROSA_INDEXER_CURSOR ?? DEFAULT_CURSOR_PATH;
    if (typeof configured !== "string" || configured.trim().length === 0) {
      throw new EventCursorError("INVALID_POSITION", "Cursor path must be a non-empty string.");
    }
    this.#filePath = resolve(configured);
    this.#processedWindow = options.processedWindow ?? DEFAULT_PROCESSED_WINDOW;
    this.#now = options.now ?? (() => new Date());
    this.#initial =
      options.initial === undefined ? null : assertPosition(options.initial, "initial");
    if (!Number.isInteger(this.#processedWindow) || this.#processedWindow < 1) {
      throw new EventCursorError("INVALID_POSITION", "processedWindow must be a positive integer.");
    }
  }

  get filePath(): string {
    return this.#filePath;
  }

  /** Load the checkpoint, or the configured initial position for a new file. */
  async load(): Promise<EventCursorSnapshot> {
    let raw: string;
    try {
      await this.#assertNotSymlink();
      raw = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        const initial = this.#initial ?? { blockHeight: 0, logIndex: -1 };
        return {
          blockHeight: initial.blockHeight,
          logIndex: initial.logIndex,
          processed: [],
          updatedAt: this.#nowIso(),
        };
      }
      if (error instanceof EventCursorError) {
        throw error;
      }
      throw new EventCursorError("READ_FAILED", "Indexer cursor could not be read.", error);
    }
    return parseCursorFile(raw);
  }

  /** True when `id` was already processed inside the retained window. */
  async isProcessed(id: string): Promise<boolean> {
    const snapshot = await this.load();
    return snapshot.processed.includes(id);
  }

  /** True when `position` is at or before the checkpoint. */
  async isAtOrBefore(position: EventPosition): Promise<boolean> {
    const checked = assertPosition(position, "position");
    const snapshot = await this.load();
    return comparePositions(checked, snapshot) <= 0;
  }

  /** Advance the checkpoint without recording an id (monotonic only). */
  async advance(position: EventPosition): Promise<EventCursorSnapshot> {
    const checked = assertPosition(position, "position");
    return this.#mutate((state) => {
      if (comparePositions(checked, state) > 0) {
        state.blockHeight = checked.blockHeight;
        state.logIndex = checked.logIndex;
      }
      return state;
    });
  }

  /**
   * Record a handled event and advance the checkpoint in one atomic write.
   * Re-marking an id is a no-op; the processed window is FIFO-bounded.
   */
  async markProcessed(id: string, position: EventPosition): Promise<EventCursorSnapshot> {
    if (typeof id !== "string" || !/^\d+:\d+$/.test(id)) {
      throw new EventCursorError("INVALID_POSITION", "Event id must be `<block>:<logIndex>`.");
    }
    const checked = assertPosition(position, "position");
    if (id !== eventId(checked)) {
      throw new EventCursorError("INVALID_POSITION", "Event id does not match its position.");
    }
    return this.#mutate((state) => {
      if (!state.processed.includes(id)) {
        state.processed.push(id);
        if (state.processed.length > this.#processedWindow) {
          state.processed.splice(0, state.processed.length - this.#processedWindow);
        }
      }
      if (comparePositions(checked, state) > 0) {
        state.blockHeight = checked.blockHeight;
        state.logIndex = checked.logIndex;
      }
      return state;
    });
  }

  /** Remove the checkpoint file; the next `load()` returns the initial state. */
  async reset(): Promise<void> {
    await this.#run(async () => {
      try {
        await unlink(this.#filePath);
      } catch (error) {
        if (!isErrno(error, "ENOENT")) {
          throw new EventCursorError("WRITE_FAILED", "Indexer cursor could not be removed.", error);
        }
      }
    });
  }

  async #mutate(change: (state: EventCursorFile) => EventCursorFile): Promise<EventCursorSnapshot> {
    let result: EventCursorSnapshot | undefined;
    await this.#run(async () => {
      const state = await this.#readFileState();
      const next = change(state);
      next.updatedAt = this.#nowIso();
      await this.#writeFileState(next);
      result = toSnapshot(next);
    });
    if (result === undefined) {
      throw new EventCursorError("WRITE_FAILED", "Indexer cursor update produced no state.");
    }
    return result;
  }

  async #readFileState(): Promise<EventCursorFile> {
    try {
      await this.#assertNotSymlink();
      return parseCursorFile(await readFile(this.#filePath, "utf8"));
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        const initial = this.#initial ?? { blockHeight: 0, logIndex: -1 };
        return {
          version: EVENT_CURSOR_VERSION,
          blockHeight: initial.blockHeight,
          logIndex: initial.logIndex,
          processed: [],
          updatedAt: this.#nowIso(),
        };
      }
      if (error instanceof EventCursorError) {
        throw error;
      }
      throw new EventCursorError("READ_FAILED", "Indexer cursor could not be read.", error);
    }
  }

  async #writeFileState(state: EventCursorFile): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true, mode: DIRECTORY_MODE });
    if (process.platform !== "win32") {
      await chmod(dirname(this.#filePath), DIRECTORY_MODE).catch(() => undefined);
    }
    try {
      await atomicWriteFile(this.#filePath, `${JSON.stringify(state)}\n`, { mode: FILE_MODE });
      if (process.platform !== "win32") {
        await chmod(this.#filePath, FILE_MODE).catch(() => undefined);
      }
    } catch (error) {
      throw new EventCursorError("WRITE_FAILED", "Indexer cursor could not be written.", error);
    }
  }

  async #assertNotSymlink(): Promise<void> {
    try {
      const stats = await lstat(this.#filePath);
      if (stats.isSymbolicLink()) {
        throw new EventCursorError("READ_FAILED", "Indexer cursor path must not be a symlink.");
      }
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return;
      }
      throw error;
    }
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#writeQueue.then(operation, operation);
    this.#writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  #nowIso(): string {
    const now = this.#now();
    const milliseconds = now.getTime();
    if (!Number.isFinite(milliseconds)) {
      throw new EventCursorError("WRITE_FAILED", "Cursor clock returned an invalid date.");
    }
    return new Date(milliseconds).toISOString();
  }
}

function parseCursorFile(raw: string): EventCursorFile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new EventCursorError("CORRUPT_CURSOR", "Indexer cursor is not valid JSON.");
  }
  if (typeof value !== "object" || value === null) {
    throw new EventCursorError("CORRUPT_CURSOR", "Indexer cursor must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== EVENT_CURSOR_VERSION) {
    throw new EventCursorError("CORRUPT_CURSOR", "Indexer cursor version is unsupported.");
  }
  const position = assertPosition(record, "cursor");
  if (!Array.isArray(record.processed)) {
    throw new EventCursorError("CORRUPT_CURSOR", "Indexer cursor processed list is malformed.");
  }
  const processed: string[] = [];
  for (const id of record.processed) {
    if (typeof id !== "string") {
      throw new EventCursorError("CORRUPT_CURSOR", "Indexer cursor processed list is malformed.");
    }
    processed.push(id);
  }
  if (typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new EventCursorError("CORRUPT_CURSOR", "Indexer cursor updatedAt is invalid.");
  }
  return {
    version: EVENT_CURSOR_VERSION,
    blockHeight: position.blockHeight,
    logIndex: position.logIndex,
    processed,
    updatedAt: record.updatedAt,
  };
}

function toSnapshot(state: EventCursorFile): EventCursorSnapshot {
  return {
    blockHeight: state.blockHeight,
    logIndex: state.logIndex,
    processed: [...state.processed],
    updatedAt: state.updatedAt,
  };
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
