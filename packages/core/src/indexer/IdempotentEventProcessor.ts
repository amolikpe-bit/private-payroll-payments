/**
 * Replay-safe NEP-297 log processing.
 *
 * The parser is strict by design: ordinary debug logs are ignored, but any
 * malformed `EVENT_JSON:` line is reported and aborts the batch before the
 * checkpoint moves. Handlers run in log order; each successful handler is
 * followed by a durable checkpoint write, so a crash between events replays
 * only the unfinished suffix and the processed-id window suppresses duplicates.
 *
 * The processor is a single finite pass over the supplied logs. It never polls,
 * retries a handler, or loops on a cursor, so a broken handler cannot spin.
 */

import { SubrosaError } from "../core/errors.js";
import {
  parseSubrosaEventLogs,
  type ParsedSubrosaEvent,
} from "../events/nep297.js";
import type { EventCursor, EventPosition } from "./EventCursor.js";

export type EventIndexerErrorCode =
  | "INVALID_BLOCK"
  | "INVALID_OPTIONS"
  | "EVENT_PARSE_FAILED"
  | "EVENT_HANDLER_FAILED";

export class EventIndexerError extends SubrosaError {
  constructor(
    code: EventIndexerErrorCode,
    message: string,
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, code, context, cause);
    this.name = "EventIndexerError";
  }
}

/** One decoded event at its exact chain position. */
export interface IndexerEvent {
  id: string;
  position: EventPosition;
  parsed: ParsedSubrosaEvent;
}

/** Handler result is ignored; throwing means "not processed". */
export type IndexerEventHandler = (event: IndexerEvent) => Promise<void> | void;

export interface IdempotentEventProcessorOptions {
  cursor: EventCursor;
  handler: IndexerEventHandler;
  /** Maximum handlers per `processBlock` call. Defaults to 1000. */
  maxEventsPerRun?: number;
}

export interface BlockLogs {
  blockHeight: number;
  logs: readonly string[];
}

export interface ProcessBlockResult {
  blockHeight: number;
  /** Parsed subrosa events in the batch. */
  parsed: number;
  /** Events handled and checkpointed in this call. */
  processed: number;
  /** Events already covered by the cursor/id window. */
  skipped: number;
  /** Events not attempted because `maxEventsPerRun` was reached. */
  remaining: number;
  /** Last checkpoint after this call. */
  blockHeightCheckpoint: number;
  logIndexCheckpoint: number;
}

function assertBlockHeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new EventIndexerError(
      "INVALID_BLOCK",
      "blockHeight must be a non-negative safe integer.",
    );
  }
  return value;
}

function positionOf(blockHeight: number, logIndex: number): EventPosition {
  return { blockHeight, logIndex };
}

function eventIdOf(position: EventPosition): string {
  return `${position.blockHeight}:${position.logIndex}`;
}

function comparePositions(left: EventPosition, right: EventPosition): number {
  if (left.blockHeight !== right.blockHeight) {
    return left.blockHeight - right.blockHeight;
  }
  return left.logIndex - right.logIndex;
}

/** Cursor-backed processor for one chain or one receipt-log stream. */
export class IdempotentEventProcessor {
  readonly #cursor: EventCursor;
  readonly #handler: IndexerEventHandler;
  readonly #maxEventsPerRun: number;

  constructor(options: IdempotentEventProcessorOptions) {
    if (typeof options !== "object" || options === null) {
      throw new EventIndexerError("INVALID_OPTIONS", "Processor options are required.");
    }
    if (options.cursor === undefined || options.cursor === null) {
      throw new EventIndexerError("INVALID_OPTIONS", "Processor requires an EventCursor.");
    }
    if (typeof options.handler !== "function") {
      throw new EventIndexerError("INVALID_OPTIONS", "Processor requires an event handler.");
    }
    this.#cursor = options.cursor;
    this.#handler = options.handler;
    this.#maxEventsPerRun = options.maxEventsPerRun ?? 1000;
    if (!Number.isInteger(this.#maxEventsPerRun) || this.#maxEventsPerRun < 1) {
      throw new EventIndexerError("INVALID_OPTIONS", "maxEventsPerRun must be a positive integer.");
    }
  }

  /**
   * Parse and process one block's flattened logs. Returns after a finite pass;
   * `remaining` tells the caller how many events the per-run cap deferred.
   */
  async processBlock(blockHeight: number, logs: readonly string[]): Promise<ProcessBlockResult> {
    const block = assertBlockHeight(blockHeight);
    if (!Array.isArray(logs) || logs.some((log) => typeof log !== "string")) {
      throw new EventIndexerError("INVALID_BLOCK", "logs must be an array of strings.");
    }

    const parsed = parseSubrosaEventLogs(logs);
    if (parsed.errors.length > 0) {
      const first = parsed.errors[0];
      throw new EventIndexerError(
        "EVENT_PARSE_FAILED",
        `Block ${block} contains ${parsed.errors.length} malformed subrosa event(s).`,
        {
          blockHeight: block,
          errorCount: parsed.errors.length,
          firstErrorCode: first.code,
          firstLogIndex: first.context.logIndex,
        },
        first,
      );
    }

    const events = [...parsed.events].sort((left, right) => left.logIndex - right.logIndex);
    let snapshot = await this.#cursor.load();
    let processed = 0;
    let skipped = 0;
    let remaining = 0;

    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      const position = positionOf(block, event.logIndex);
      const id = eventIdOf(position);

      if (snapshot.processed.includes(id) || comparePositions(position, snapshot) <= 0) {
        skipped += 1;
        continue;
      }
      if (processed >= this.#maxEventsPerRun) {
        remaining = events.length - index;
        break;
      }

      try {
        await this.#handler({ id, position, parsed: event });
      } catch (error) {
        throw new EventIndexerError(
          "EVENT_HANDLER_FAILED",
          `Event handler failed at block ${block}, log ${event.logIndex}; checkpoint retained.`,
          {
            blockHeight: block,
            logIndex: event.logIndex,
            event: event.event.event,
          },
          error,
        );
      }
      snapshot = await this.#cursor.markProcessed(id, position);
      processed += 1;
    }

    return {
      blockHeight: block,
      parsed: events.length,
      processed,
      skipped,
      remaining,
      blockHeightCheckpoint: snapshot.blockHeight,
      logIndexCheckpoint: snapshot.logIndex,
    };
  }

  /**
   * Process a finite block range in order. The caller supplies already-fetched
   * logs; this method never fetches or re-reads a block on its own.
   */
  async processBlocks(blocks: readonly BlockLogs[]): Promise<ProcessBlockResult[]> {
    if (!Array.isArray(blocks)) {
      throw new EventIndexerError("INVALID_BLOCK", "blocks must be an array.");
    }
    const results: ProcessBlockResult[] = [];
    for (const block of blocks) {
      results.push(await this.processBlock(block.blockHeight, block.logs));
    }
    return results;
  }
}
