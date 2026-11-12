/**
 * Hash-only audit trail writers.
 *
 * Settlement and hold events are published as immutable audit entries under
 * `subrosa.near`. Entries contain only hashes, enum state, and timestamps:
 * never amounts, salts, employees, recipients, deposit addresses, or memos.
 *
 * Two surfaces are supported:
 *
 * - SocialDB (`near-social-js` 2.0.4, account `social.near`; testnet
 *   `v1.social08.testnet`): a normal `set` transaction signed by the writer.
 * - near.social FastData KV: FunctionCall `__fastdata_kv` to account `social`,
 *   gas `1`, deposit `0`. The receiver has no contract, so the receipt always
 *   fails with `CodeDoesNotExist` by design. That is success; confirm through
 *   `GET https://api2.near.social/v1/tx/{tx_hash}` and never retry the write.
 */

import {
  isSettlementReceiptValid,
  isValidIntentHash,
  type PayrollReceipt,
  type ReceiptSettlementStatus,
} from "../settlement/receipt.js";
import { sha256Hex } from "../crypto/hashUtils.js";
import type { HoldReason, HoldScope, HoldState } from "../types.js";
import nearSocial from "near-social-js";
import type { SocialOptions } from "near-social-js";
import { isJsonObject } from "./jsonObject.js";

const { Social } = nearSocial;

/** SocialDB contract account. */
export const SOCIAL_CONTRACT_ID = "social.near";
/** SocialDB testnet contract account. */
export const SOCIAL_TESTNET_CONTRACT_ID = "v1.social08.testnet";
/** FastData receiver account (no contract, on purpose). */
export const FASTDATA_ACCOUNT_ID = "social";
/** FastData method name. */
export const FASTDATA_METHOD_NAME = "__fastdata_kv";
/** FastData confirmation endpoint. */
export const FASTDATA_API_BASE_URL = "https://api2.near.social";
/** Default audit owner namespace. */
export const SOCIAL_AUDIT_ACCOUNT_ID = "subrosa.near";

const HEX64 = /^[0-9a-f]{64}$/;
const HOLD_SCOPES: readonly HoldScope[] = ["Employer", "Period", "Batch", "Employee"];
const HOLD_STATES: readonly HoldState[] = ["Active", "Released"];
const HOLD_REASONS: readonly HoldReason[] = [
  "KycReviewPending",
  "SanctionsScreening",
  "TaxWithholdingDiscrepancy",
  "RegulatoryInvestigation",
  "DuplicatePaymentSuspected",
  "ManualReviewRequested",
  "Other",
];
const SETTLEMENT_STATUSES: readonly ReceiptSettlementStatus[] = [
  "settled",
  "confirmed",
  "pending",
  "rejected",
  "unknown",
];

export type AuditErrorCode =
  | "INVALID_ENTRY"
  | "SOCIAL_WRITE_FAILED"
  | "FASTDATA_WRITE_FAILED"
  | "FASTDATA_TX_HASH_MISSING"
  | "FASTDATA_NOT_CONFIRMED";

export class AuditWriteError extends Error {
  readonly code: AuditErrorCode;

  constructor(code: AuditErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "AuditWriteError";
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export interface SettlementAuditEntry {
  version: 1;
  kind: "settlement";
  commitmentHash: string;
  intentHash: string;
  status?: ReceiptSettlementStatus;
  complianceHash?: string;
  at: string;
}

export interface HoldAuditEntry {
  version: 1;
  kind: "hold";
  holdIdHash: string;
  employerHash: string;
  scope: HoldScope;
  state: HoldState;
  reasonCode: HoldReason;
  at: string;
}

export type SocialAuditEntry = SettlementAuditEntry | HoldAuditEntry;

export interface SocialAuditWriteResult {
  entryId: string;
  key: string;
  txHash?: string;
}

/** SocialDB `set` builder surface; tests inject a fake with the same shape. */
export interface SocialTransactionHandle {
  send(): Promise<unknown>;
}

export interface SocialSetClient {
  set(options: {
    signerId: string;
    data: Record<string, Record<string, unknown>>;
    refundUnusedDeposit?: boolean;
  }): Promise<SocialTransactionHandle>;
}

export interface SocialAuditWriterOptions {
  /** Account that owns the audit namespace. Defaults to `subrosa.near`. */
  accountId?: string;
  /** Transaction signer; defaults to `accountId`. */
  signerId?: string;
  /** SocialDB contract id. Defaults to `social.near`. */
  contractId?: string;
  apiServer?: string;
  network?: "mainnet" | "testnet";
  /** Injected near-kit instance used by near-social-js. */
  near?: SocialOptions["near"];
  /** Injected SocialDB client, mainly for tests. */
  social?: SocialSetClient;
}

export interface FastDataAccount {
  callFunctionRaw(params: {
    contractId: string;
    methodName: string;
    args: Record<string, unknown>;
    gas?: bigint;
    deposit?: bigint;
    waitUntil?: "NONE" | "INCLUDED" | "EXECUTED_OPTIMISTIC" | "INCLUDED_FINAL" | "EXECUTED" | "FINAL";
  }): Promise<unknown>;
}

export interface FastDataTransactionStatus {
  indexed: boolean;
  accepted: boolean;
  details?: string;
}

export interface FastDataAuditWriterOptions {
  account: FastDataAccount;
  /** Confirmation hook; defaults to polling the near.social API. */
  confirm?: (txHash: string) => Promise<FastDataTransactionStatus>;
  /** Account that owns the audit key namespace. Defaults to `subrosa.near`. */
  accountId?: string;
}

/** Build a settlement audit entry from a validated public receipt. */
export function buildSettlementAuditEntry(receipt: PayrollReceipt): SettlementAuditEntry {
  if (!isSettlementReceiptValid(receipt)) {
    throw new AuditWriteError("INVALID_ENTRY", "Receipt is not a valid settlement receipt.");
  }
  const intentHash = receipt.transactionReference.txHash;
  if (!isValidIntentHash(intentHash)) {
    throw new AuditWriteError("INVALID_ENTRY", "Receipt intent hash is invalid.");
  }
  if (!HEX64.test(receipt.metadataDigest)) {
    throw new AuditWriteError("INVALID_ENTRY", "Receipt metadata digest is invalid.");
  }
  if (receipt.complianceHash !== undefined && !HEX64.test(receipt.complianceHash)) {
    throw new AuditWriteError("INVALID_ENTRY", "Receipt compliance hash is invalid.");
  }
  return {
    version: 1,
    kind: "settlement",
    commitmentHash: receipt.metadataDigest,
    intentHash,
    status: receipt.settlementStatus,
    ...(receipt.complianceHash === undefined
      ? {}
      : { complianceHash: receipt.complianceHash }),
    at: toIsoTimestamp(receipt.settledAt ?? receipt.issuedAt),
  };
}

export interface HoldAuditInput {
  holdId: string;
  employer: string;
  scope: HoldScope;
  state: HoldState;
  reasonCode: HoldReason;
  at?: string | number | Date;
}

/** Build a hold audit entry; identifiers are hashed, never published raw. */
export function buildHoldAuditEntry(input: HoldAuditInput): HoldAuditEntry {
  if (typeof input !== "object" || input === null) {
    throw new AuditWriteError("INVALID_ENTRY", "Hold audit input must be an object.");
  }
  if (typeof input.holdId !== "string" || input.holdId.trim().length === 0) {
    throw new AuditWriteError("INVALID_ENTRY", "holdId must be a non-empty string.");
  }
  if (typeof input.employer !== "string" || input.employer.trim().length === 0) {
    throw new AuditWriteError("INVALID_ENTRY", "employer must be a non-empty account id.");
  }
  if (!HOLD_SCOPES.includes(input.scope)) {
    throw new AuditWriteError("INVALID_ENTRY", "Hold scope is invalid.");
  }
  if (!HOLD_STATES.includes(input.state)) {
    throw new AuditWriteError("INVALID_ENTRY", "Hold state is invalid.");
  }
  if (!HOLD_REASONS.includes(input.reasonCode)) {
    throw new AuditWriteError("INVALID_ENTRY", "Hold reason is invalid.");
  }
  return {
    version: 1,
    kind: "hold",
    holdIdHash: sha256Hex(input.holdId.trim()),
    employerHash: sha256Hex(input.employer.trim()),
    scope: input.scope,
    state: input.state,
    reasonCode: input.reasonCode,
    at: input.at === undefined ? new Date().toISOString() : toIsoTimestamp(input.at),
  };
}

/** Deterministic entry id over canonical JSON. */
export function auditEntryId(entry: SocialAuditEntry): string {
  return sha256Hex(canonicalJson(validateAuditEntry(entry)));
}

/** Validate and copy an entry; rejects unknown fields and non-hash values. */
export function validateAuditEntry(entry: SocialAuditEntry): SocialAuditEntry {
  if (typeof entry !== "object" || entry === null) {
    throw new AuditWriteError("INVALID_ENTRY", "Audit entry must be an object.");
  }
  if (entry.kind === "settlement") {
    assertSettlementEntry(entry);
    return {
      version: 1,
      kind: "settlement",
      commitmentHash: entry.commitmentHash,
      intentHash: entry.intentHash,
      ...(entry.status === undefined ? {} : { status: entry.status }),
      ...(entry.complianceHash === undefined
        ? {}
        : { complianceHash: entry.complianceHash }),
      at: entry.at,
    };
  }
  if (entry.kind === "hold") {
    assertHoldEntry(entry);
    return {
      version: 1,
      kind: "hold",
      holdIdHash: entry.holdIdHash,
      employerHash: entry.employerHash,
      scope: entry.scope,
      state: entry.state,
      reasonCode: entry.reasonCode,
      at: entry.at,
    };
  }
  throw new AuditWriteError("INVALID_ENTRY", "Audit entry kind is invalid.");
}

/** SocialDB writer for hash-only entries under `subrosa.near`. */
export class SocialAuditWriter {
  readonly #accountId: string;
  readonly #signerId: string;
  readonly #social: SocialSetClient;

  constructor(options: SocialAuditWriterOptions = {}) {
    this.#accountId = options.accountId ?? SOCIAL_AUDIT_ACCOUNT_ID;
    this.#signerId = options.signerId ?? this.#accountId;
    this.#social =
      options.social ??
      new Social({
        contractId:
          options.contractId ??
          (options.network === "testnet" ? SOCIAL_TESTNET_CONTRACT_ID : SOCIAL_CONTRACT_ID),
        network: options.network ?? "mainnet",
        ...(options.apiServer === undefined ? {} : { apiServer: options.apiServer }),
        ...(options.near === undefined ? {} : { near: options.near }),
      });
  }

  async write(entry: SocialAuditEntry): Promise<SocialAuditWriteResult> {
    const normalized = validateAuditEntry(entry);
    const entryId = sha256Hex(canonicalJson(normalized));
    const key = `${this.#accountId}/subrosa/audit/${entryId}`;
    const data: Record<string, Record<string, unknown>> = {
      [this.#accountId]: {
        subrosa: {
          audit: {
            [entryId]: normalized,
          },
        },
      },
    };
    let handle: SocialTransactionHandle;
    try {
      handle = await this.#social.set({
        signerId: this.#signerId,
        data,
        refundUnusedDeposit: true,
      });
    } catch (error) {
      throw new AuditWriteError(
        "SOCIAL_WRITE_FAILED",
        "SocialDB audit entry could not be prepared.",
        error,
      );
    }
    try {
      const outcome = await handle.send();
      const txHash = findTxHash(outcome);
      return {
        entryId,
        key,
        ...(txHash === undefined ? {} : { txHash }),
      };
    } catch (error) {
      throw new AuditWriteError(
        "SOCIAL_WRITE_FAILED",
        "SocialDB audit entry could not be written.",
        error,
      );
    }
  }
}

/**
 * FastData KV writer. A `CodeDoesNotExist` receipt is the expected outcome;
 * the transaction hash is confirmed through the near.social indexer instead of
 * retrying a transaction that already landed.
 */
export class FastDataAuditWriter {
  readonly #account: FastDataAccount;
  readonly #confirm: (txHash: string) => Promise<FastDataTransactionStatus>;
  readonly #accountId: string;

  constructor(options: FastDataAuditWriterOptions) {
    if (typeof options !== "object" || options === null || options.account === undefined) {
      throw new AuditWriteError("INVALID_ENTRY", "FastDataAuditWriter requires a NEAR account.");
    }
    this.#account = options.account;
    this.#accountId = options.accountId ?? SOCIAL_AUDIT_ACCOUNT_ID;
    this.#confirm = options.confirm ?? confirmFastDataTransaction;
  }

  async write(entry: SocialAuditEntry): Promise<SocialAuditWriteResult> {
    const normalized = validateAuditEntry(entry);
    const entryId = sha256Hex(canonicalJson(normalized));
    const key = `${this.#accountId}/audit/${entryId}`;
    const args = { [key]: normalized };

    let txHash: string | undefined;
    try {
      const outcome = await this.#account.callFunctionRaw({
        contractId: FASTDATA_ACCOUNT_ID,
        methodName: FASTDATA_METHOD_NAME,
        args,
        gas: 1n,
        deposit: 0n,
        waitUntil: "EXECUTED_OPTIMISTIC",
      });
      txHash = findTxHash(outcome);
    } catch (error) {
      if (!isCodeDoesNotExistError(error)) {
        throw new AuditWriteError(
          "FASTDATA_WRITE_FAILED",
          "FastData audit transaction failed for a reason other than CodeDoesNotExist.",
          error,
        );
      }
      txHash = findTxHash(error);
    }

    if (txHash === undefined) {
      throw new AuditWriteError(
        "FASTDATA_TX_HASH_MISSING",
        "FastData transaction hash is unavailable; confirmation cannot be checked.",
      );
    }
    const status = await this.#confirm(txHash);
    if (!status.indexed || !status.accepted) {
      throw new AuditWriteError(
        "FASTDATA_NOT_CONFIRMED",
        "FastData write was not confirmed as indexed and accepted.",
      );
    }
    return { entryId, key, txHash };
  }
}

/**
 * Poll `GET /v1/tx/{hash}` a bounded number of times. `indexed:false` is the
 * only retryable state; an indexed-but-rejected write is final.
 */
export async function confirmFastDataTransaction(
  txHash: string,
  options: {
    attempts?: number;
    intervalMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<FastDataTransactionStatus> {
  const attempts = options.attempts ?? 5;
  const intervalMs = options.intervalMs ?? 1_500;
  const sleep =
    options.sleep ??
    ((milliseconds) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, milliseconds);
      return promise;
    });
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new AuditWriteError("FASTDATA_NOT_CONFIRMED", "Confirmation attempts must be positive.");
  }
  let last: FastDataTransactionStatus = { indexed: false, accepted: false };
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await fetchImpl(
      `${FASTDATA_API_BASE_URL}/v1/tx/${encodeURIComponent(txHash)}`,
      { headers: { Accept: "application/json" } },
    );
    if (response.ok) {
      const body: unknown = await response.json();
      last = parseFastDataStatus(body);
      if (last.indexed) {
        return last;
      }
    }
    if (attempt < attempts - 1) {
      await sleep(intervalMs);
    }
  }
  return last;
}

function parseFastDataStatus(value: unknown): FastDataTransactionStatus {
  if (!isJsonObject(value)) {
    return { indexed: false, accepted: false };
  }
  const indexed = value.indexed === true;
  if (!indexed) {
    return { indexed: false, accepted: false };
  }
  if (!Array.isArray(value.actions)) {
    return { indexed: true, accepted: false };
  }
  let accepted = true;
  const rejected: string[] = [];
  for (const action of value.actions) {
    if (!isJsonObject(action)) {
      accepted = false;
      continue;
    }
    if (!Array.isArray(action.keys)) {
      accepted = false;
      continue;
    }
    for (const keyStatus of action.keys) {
      if (!isJsonObject(keyStatus) || keyStatus.status !== "ok") {
        accepted = false;
        if (isJsonObject(keyStatus) && typeof keyStatus.status === "string") {
          rejected.push(keyStatus.status);
        }
      }
    }
  }
  return {
    indexed: true,
    accepted,
    ...(rejected.length === 0 ? {} : { details: rejected.join(",") }),
  };
}

function assertSettlementEntry(entry: SettlementAuditEntry): void {
  assertExactFields(entry, [
    "version",
    "kind",
    "commitmentHash",
    "intentHash",
    "status",
    "complianceHash",
    "at",
  ]);
  if (entry.version !== 1 || entry.kind !== "settlement") {
    throw new AuditWriteError("INVALID_ENTRY", "Settlement audit entry version/kind is invalid.");
  }
  if (typeof entry.commitmentHash !== "string" || !HEX64.test(entry.commitmentHash)) {
    throw new AuditWriteError("INVALID_ENTRY", "Settlement commitment hash is invalid.");
  }
  if (!isValidIntentHash(entry.intentHash)) {
    throw new AuditWriteError("INVALID_ENTRY", "Settlement intent hash is invalid.");
  }
  if (entry.status !== undefined && !SETTLEMENT_STATUSES.includes(entry.status)) {
    throw new AuditWriteError("INVALID_ENTRY", "Settlement status is invalid.");
  }
  if (entry.complianceHash !== undefined && !HEX64.test(entry.complianceHash)) {
    throw new AuditWriteError("INVALID_ENTRY", "Settlement compliance hash is invalid.");
  }
  assertIsoTimestamp(entry.at);
}

function assertHoldEntry(entry: HoldAuditEntry): void {
  assertExactFields(entry, [
    "version",
    "kind",
    "holdIdHash",
    "employerHash",
    "scope",
    "state",
    "reasonCode",
    "at",
  ]);
  if (entry.version !== 1 || entry.kind !== "hold") {
    throw new AuditWriteError("INVALID_ENTRY", "Hold audit entry version/kind is invalid.");
  }
  if (typeof entry.holdIdHash !== "string" || !HEX64.test(entry.holdIdHash)) {
    throw new AuditWriteError("INVALID_ENTRY", "Hold id hash is invalid.");
  }
  if (typeof entry.employerHash !== "string" || !HEX64.test(entry.employerHash)) {
    throw new AuditWriteError("INVALID_ENTRY", "Employer hash is invalid.");
  }
  if (!HOLD_SCOPES.includes(entry.scope)) {
    throw new AuditWriteError("INVALID_ENTRY", "Hold scope is invalid.");
  }
  if (!HOLD_STATES.includes(entry.state)) {
    throw new AuditWriteError("INVALID_ENTRY", "Hold state is invalid.");
  }
  if (!HOLD_REASONS.includes(entry.reasonCode)) {
    throw new AuditWriteError("INVALID_ENTRY", "Hold reason is invalid.");
  }
  assertIsoTimestamp(entry.at);
}

function assertExactFields(entry: object, fields: readonly string[]): void {
  for (const key of Object.keys(entry)) {
    if (!fields.includes(key)) {
      throw new AuditWriteError("INVALID_ENTRY", "Audit entry contains unknown fields.");
    }
  }
}

function assertIsoTimestamp(value: unknown): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new AuditWriteError("INVALID_ENTRY", "Audit timestamp must be an ISO-8601 string.");
  }
}

function toIsoTimestamp(value: number | string | Date): string {
  let milliseconds: number;
  if (value instanceof Date) {
    milliseconds = value.getTime();
  } else if (typeof value === "number") {
    milliseconds = value < 1e12 ? value * 1000 : value;
  } else {
    milliseconds = Date.parse(value);
  }
  if (!Number.isFinite(milliseconds)) {
    throw new AuditWriteError("INVALID_ENTRY", "Audit timestamp is invalid.");
  }
  return new Date(milliseconds).toISOString();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isJsonObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new AuditWriteError("INVALID_ENTRY", "Audit entry contains a non-serializable value.");
  }
  return serialized;
}

function isCodeDoesNotExistError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "ContractCodeDoesNotExistError") {
    return true;
  }
  return /CodeDoesNotExist/.test(error.message);
}

function findTxHash(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || !isJsonObject(value)) {
    return undefined;
  }
  const direct = value.txHash ?? value.transactionHash ?? value.transaction_hash;
  if (isTxHash(direct)) {
    return direct;
  }
  const transaction = value.transaction;
  if (isJsonObject(transaction) && isTxHash(transaction.hash)) {
    return transaction.hash;
  }
  const transactionOutcome = value.transaction_outcome;
  if (isJsonObject(transactionOutcome) && isTxHash(transactionOutcome.id)) {
    return transactionOutcome.id;
  }
  for (const nested of [value.transactionResult, value.result, value.transactionOutcome]) {
    const found = findTxHash(nested, depth + 1);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function isTxHash(value: unknown): value is string {
  return typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}
