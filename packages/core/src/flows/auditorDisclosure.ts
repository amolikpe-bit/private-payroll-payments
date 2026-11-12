/**
 * Auditor disclosure export.
 *
 * 1Click has no viewer-key or auditor endpoint: confidential account reads are
 * owner-signed User-Session calls (`/v0/account/history`), and history is
 * invite-only (403 for accounts without access). Disclosure is therefore a
 * CSV export from the employer's User-Session history plus the local private
 * receipts, which fill in commitment hashes the remote API does not return.
 *
 * The CSV is deliberately boring and deterministic: fixed columns, ISO times,
 * ascending chronological order, RFC 4180 quoting, and hash-only identity. It
 * never reads or writes `depositAddress`/`depositMemo`; the private store's
 * read API cannot return them, and this module only consumes its summary type.
 */

import { sha256Hex } from "../crypto/hashUtils.js";
import {
  OneClickApiError,
  OneClickNetworkError,
} from "../intents/OneClickClient.js";
import type {
  UserSession,
  UserSessionHistory,
  UserSessionHistoryItem,
} from "../intents/UserSession.js";
import type { PrivateReceiptSummary, PrivateStore } from "../store/PrivateStore.js";

/** Fixed column order; changing it is a breaking export format change. */
export const DISCLOSURE_CSV_COLUMNS = [
  "created_at",
  "status",
  "intent_hash",
  "commitment_hash",
  "asset",
  "amount",
  "amount_formatted",
  "employee_hash",
  "source",
] as const;

export type DisclosureCsvColumn = (typeof DISCLOSURE_CSV_COLUMNS)[number];

export interface DisclosureExportRequest {
  /** Inclusive lower bound. */
  from: Date | string;
  /** Inclusive upper bound. */
  to: Date | string;
  /** Employer whose local receipts are exported. Defaults to the session owner. */
  employer?: string;
}

export interface DisclosureExportResult {
  csv: string;
  rowCount: number;
  source: "remote+local" | "local-receipts";
  degraded: boolean;
  notice?: string;
}

export type DisclosureExportErrorCode =
  | "INVALID_RANGE"
  | "INVALID_REQUEST"
  | "INVALID_HISTORY_ITEM"
  | "HISTORY_PAGE_LIMIT";

export class DisclosureExportError extends Error {
  readonly code: DisclosureExportErrorCode;

  constructor(code: DisclosureExportErrorCode, message: string) {
    super(message);
    this.name = "DisclosureExportError";
    this.code = code;
  }
}

export interface AuditorDisclosureExporterOptions {
  session: Pick<UserSession, "getHistory" | "signerId">;
  store: Pick<PrivateStore, "listReceipts">;
  /** History page size (1..100). Defaults to 100. */
  pageLimit?: number;
  /** Safety cap on history pages. Defaults to 50. */
  maxPages?: number;
  /** Fallback notice override, mainly for tests. */
  localFallbackNotice?: string;
}

interface DisclosureRow {
  createdAt: string;
  status: string;
  intentHash: string;
  commitmentHash: string;
  asset: string;
  amount: string;
  amountFormatted: string;
  employeeHash: string;
  source: "remote" | "local-receipts";
}

const CSV_VALUE: Record<DisclosureCsvColumn, (row: DisclosureRow) => string> = {
  created_at: (row) => row.createdAt,
  status: (row) => row.status,
  intent_hash: (row) => row.intentHash,
  commitment_hash: (row) => row.commitmentHash,
  asset: (row) => row.asset,
  amount: (row) => row.amount,
  amount_formatted: (row) => row.amountFormatted,
  employee_hash: (row) => row.employeeHash,
  source: (row) => row.source,
};

const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_MAX_PAGES = 50;
const LOCAL_FALLBACK_NOTICE =
  "Live confidential history was unavailable (403 or network failure). " +
  "This export contains locally stored receipts only.";

function parseBound(value: Date | string, field: string): number {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new DisclosureExportError("INVALID_RANGE", `${field} must be a valid ISO-8601 timestamp.`);
  }
  return parsed;
}

function rowKey(row: DisclosureRow): string {
  if (row.intentHash.length > 0) {
    return `intent:${row.intentHash}`;
  }
  return `local:${row.createdAt}|${row.status}|${row.asset}|${row.amount}|${row.employeeHash}`;
}

function csvField(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

function toIso(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new DisclosureExportError("INVALID_HISTORY_ITEM", `${field} must be an ISO timestamp.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new DisclosureExportError("INVALID_HISTORY_ITEM", `${field} must be an ISO timestamp.`);
  }
  return new Date(milliseconds).toISOString();
}

function optionalText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function remoteRow(item: UserSessionHistoryItem): DisclosureRow {
  const createdAt = toIso(item.createdAt, "history.createdAt");
  if (typeof item.status !== "string" || item.status.length === 0) {
    throw new DisclosureExportError("INVALID_HISTORY_ITEM", "history.status must be non-empty.");
  }
  return {
    createdAt,
    status: item.status,
    intentHash: optionalText(item.intentHash),
    commitmentHash: "",
    asset: optionalText(item.destinationAsset ?? item.originAsset),
    amount: "",
    amountFormatted: optionalText(item.amount),
    employeeHash: item.recipient === undefined ? "" : sha256Hex(item.recipient),
    source: item.source,
  };
}

function localRow(receipt: PrivateReceiptSummary): DisclosureRow {
  return {
    createdAt: toIso(receipt.createdAt, "receipt.createdAt"),
    status: receipt.status,
    intentHash: receipt.intentHash ?? "",
    commitmentHash: receipt.commitmentHash ?? "",
    asset: receipt.asset,
    amount: receipt.amount,
    amountFormatted: "",
    employeeHash: sha256Hex(receipt.employee),
    source: "local-receipts",
  };
}

/**
 * Stable date-range CSV from User-Session history and private receipts.
 * Remote rows win on provenance; a local row fills in a missing commitment
 * hash for the same intent hash.
 */
export class AuditorDisclosureExporter {
  readonly #session: AuditorDisclosureExporterOptions["session"];
  readonly #store: AuditorDisclosureExporterOptions["store"];
  readonly #pageLimit: number;
  readonly #maxPages: number;
  readonly #notice: string;

  constructor(options: AuditorDisclosureExporterOptions) {
    if (typeof options !== "object" || options === null) {
      throw new DisclosureExportError("INVALID_REQUEST", "Exporter options are required.");
    }
    this.#session = options.session;
    this.#store = options.store;
    this.#pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
    this.#maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    this.#notice = options.localFallbackNotice ?? LOCAL_FALLBACK_NOTICE;
    if (!Number.isInteger(this.#pageLimit) || this.#pageLimit < 1 || this.#pageLimit > 100) {
      throw new DisclosureExportError("INVALID_REQUEST", "pageLimit must be between 1 and 100.");
    }
    if (!Number.isInteger(this.#maxPages) || this.#maxPages < 1) {
      throw new DisclosureExportError("INVALID_REQUEST", "maxPages must be a positive integer.");
    }
  }

  async export(request: DisclosureExportRequest): Promise<DisclosureExportResult> {
    if (typeof request !== "object" || request === null) {
      throw new DisclosureExportError("INVALID_REQUEST", "Export request must be an object.");
    }
    const from = parseBound(request.from, "from");
    const to = parseBound(request.to, "to");
    if (from > to) {
      throw new DisclosureExportError("INVALID_RANGE", "from must not be after to.");
    }
    const employer = request.employer ?? this.#session.signerId;

    const rows: DisclosureRow[] = [];
    let degraded = false;
    let remoteFailed = false;
    try {
      const items = await this.#readHistory();
      if (items.source === "local-receipts") {
        degraded = true;
      }
      for (const item of items.items) {
        rows.push(remoteRow(item));
      }
    } catch (error) {
      if (!isForbiddenOrNetwork(error)) {
        throw error;
      }
      degraded = true;
      remoteFailed = true;
    }

    const receipts = await this.#store.listReceipts({ employer });
    for (const receipt of receipts) {
      rows.push(localRow(receipt));
    }

    const inRange = rows
      .filter((row) => {
        const at = Date.parse(row.createdAt);
        return at >= from && at <= to;
      })
      .map(assertPublicRow);

    const merged = new Map<string, DisclosureRow>();
    for (const row of inRange) {
      const key = rowKey(row);
      const existing = merged.get(key);
      if (existing === undefined) {
        merged.set(key, row);
        continue;
      }
      if (existing.source === "local-receipts" && row.source === "remote") {
        merged.set(key, {
          ...row,
          amount: row.amount || existing.amount,
          amountFormatted: row.amountFormatted || existing.amountFormatted,
          commitmentHash: existing.commitmentHash || row.commitmentHash,
        });
        continue;
      }
      if (existing.source === "remote" && row.source === "local-receipts") {
        existing.amount = existing.amount || row.amount;
        existing.amountFormatted = existing.amountFormatted || row.amountFormatted;
        existing.commitmentHash = existing.commitmentHash || row.commitmentHash;
        continue;
      }
      if (existing.commitmentHash.length === 0 && row.commitmentHash.length > 0) {
        existing.commitmentHash = row.commitmentHash;
      }
      if (existing.intentHash.length === 0 && row.intentHash.length > 0) {
        existing.intentHash = row.intentHash;
      }
    }

    const sorted = [...merged.values()].sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt < right.createdAt ? -1 : 1;
      }
      if (left.intentHash !== right.intentHash) {
        return left.intentHash < right.intentHash ? -1 : 1;
      }
      if (left.employeeHash !== right.employeeHash) {
        return left.employeeHash < right.employeeHash ? -1 : 1;
      }
      return left.status < right.status ? -1 : left.status > right.status ? 1 : 0;
    });

    const lines = [
      DISCLOSURE_CSV_COLUMNS.join(","),
      ...sorted.map((row) =>
        DISCLOSURE_CSV_COLUMNS.map((column) => csvField(CSV_VALUE[column](row))).join(","),
      ),
    ];
    const source = remoteFailed || degraded ? "local-receipts" : "remote+local";
    return {
      csv: `${lines.join("\n")}\n`,
      rowCount: sorted.length,
      source,
      degraded,
      ...(degraded ? { notice: this.#notice } : {}),
    };
  }

  async #readHistory(): Promise<UserSessionHistory> {
    const items: UserSessionHistoryItem[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    let pages = 0;
    let source: "remote" | "local-receipts" = "remote";
    let degraded = false;
    let notice: string | undefined;

    for (;;) {
      const page = await this.#session.getHistory({
        limit: this.#pageLimit,
        ...(cursor === undefined ? {} : { nextCursor: cursor }),
      });
      pages += 1;
      source = page.source;
      degraded = degraded || page.degraded;
      notice = notice ?? page.notice;
      items.push(...page.items);
      const next = page.nextCursor;
      if (next === undefined || next.length === 0) {
        break;
      }
      if (seenCursors.has(next)) {
        throw new DisclosureExportError(
          "HISTORY_PAGE_LIMIT",
          "History pagination cursor repeated before the end of the export.",
        );
      }
      seenCursors.add(next);
      if (pages >= this.#maxPages) {
        throw new DisclosureExportError(
          "HISTORY_PAGE_LIMIT",
          "History export exceeded its page cap; narrow the date range.",
        );
      }
      cursor = next;
    }
    return { items, source, degraded, ...(notice === undefined ? {} : { notice }) };
  }
}

function isForbiddenOrNetwork(error: unknown): boolean {
  if (error instanceof OneClickNetworkError) {
    return true;
  }
  if (error instanceof OneClickApiError) {
    return error.status === 403;
  }
  return false;
}

function assertPublicRow(row: DisclosureRow): DisclosureRow {
  const allowed = new Set<string>([
    "createdAt",
    "status",
    "intentHash",
    "commitmentHash",
    "asset",
    "amount",
    "amountFormatted",
    "employeeHash",
    "source",
  ]);
  for (const key of Object.keys(row)) {
    if (!allowed.has(key)) {
      throw new DisclosureExportError(
        "INVALID_HISTORY_ITEM",
        "Disclosure row contains a non-exportable field.",
      );
    }
  }
  const serialized = JSON.stringify(row);
  if (/depositAddress|deposit_address|depositMemo|deposit_memo/i.test(serialized)) {
    throw new DisclosureExportError(
      "INVALID_HISTORY_ITEM",
      "Disclosure row contains a deposit reference.",
    );
  }
  return row;
}
