/**
 * Confidential Intents payout engine.
 *
 * Shield once (same-asset move into Confidential Intents), then settle each
 * employee through a signed NEP-413 intent: quote -> nested deposit address ->
 * generate-intent -> sign exact payload -> submit-intent -> poll to a terminal
 * status. The deposit address is written only to the private store and is never
 * returned, logged, or copied into a public receipt.
 */

import { randomUUID } from "node:crypto";
import { setTimeout as sleepFor } from "node:timers/promises";
import type { PendingPayout, PreflightResult } from "../types.js";
import { PrivateStore } from "../store/PrivateStore.js";
import {
  OneClickApiError,
  OneClickNetworkError,
  OneClickResponseError,
  OneClickValidationError,
  INTENTS_ACCOUNT_ID,
  assertConfidentialityLevel,
  assertIntentsAssetId,
  assertPositiveAmount,
  isPendingExecutionStatus,
  isTerminalExecutionStatus,
  readQuoteDepositAddress,
  validateQuoteResponse,
  type ConfidentialityLevel,
  type ExecutionStatusResponse,
  type OneClickClient,
  type QuoteRequest,
  type RecipientType,
} from "./OneClickClient.js";
import type { IntentPayloadSigner } from "./signer.js";

/** Default quote slippage: 100 basis points (1%). */
export const DEFAULT_SLIPPAGE_TOLERANCE_BPS = 100;
/** Default quote deadline: three minutes from now. */
export const DEFAULT_QUOTE_DEADLINE_MS = 3 * 60_000;

export interface QuoteBuilderOptions {
  dry: boolean;
  deadline?: Date | string;
  /** Clock override for deterministic deadline tests. */
  now?: Date;
}

export interface ShieldQuoteParams extends QuoteBuilderOptions {
  /** Full `nep141:` asset id read from `/v0/tokens`. */
  tokenAssetId: string;
  /** Decimal smallest-unit amount. */
  amount: string;
  accountId: string;
  confidentiality?: ConfidentialityLevel;
}

export interface PayoutQuoteParams extends QuoteBuilderOptions {
  /** Full `nep141:` asset id read from `/v0/tokens`. */
  assetId: string;
  amount: string;
  /** Employee recipient (Confidential Intents account, Intents account or chain address). */
  recipient: string;
  refundTo: string;
  /** Defaults to `CONFIDENTIAL_INTENTS`. */
  recipientType?: RecipientType;
  /** Defaults to `CONFIDENTIAL_INTENTS`; source balances are confidential. */
  refundType?: "INTENTS" | "CONFIDENTIAL_INTENTS";
  confidentiality?: ConfidentialityLevel;
}

/** Build the shield quote: same asset, public Intents deposit, confidential recipient. */
export function buildShieldQuoteRequest(params: ShieldQuoteParams): QuoteRequest {
  if (typeof params !== "object" || params === null) {
    throw new OneClickValidationError("INVALID_REQUEST", "Shield quote parameters must be an object.");
  }
  assertPositiveAmount(params.amount, "amount");
  assertIntentsAssetId(params.tokenAssetId, "tokenAssetId");
  assertAccountLike(params.accountId, "accountId");
  if (params.confidentiality !== undefined) {
    assertConfidentialityLevel(params.confidentiality);
  }
  const request: QuoteRequest = {
    dry: assertBoolean(params.dry, "dry"),
    swapType: "EXACT_INPUT",
    slippageTolerance: DEFAULT_SLIPPAGE_TOLERANCE_BPS,
    originAsset: params.tokenAssetId,
    depositType: "INTENTS",
    destinationAsset: params.tokenAssetId,
    amount: params.amount,
    refundTo: params.accountId,
    refundType: "INTENTS",
    recipient: params.accountId,
    recipientType: "CONFIDENTIAL_INTENTS",
    deadline: resolveDeadline(params.deadline, params.now),
    ...(params.confidentiality === undefined ? {} : { confidentiality: params.confidentiality }),
  };
  return request;
}

/** Build a per-employee confidential payout quote. */
export function buildPayoutQuoteRequest(params: PayoutQuoteParams): QuoteRequest {
  if (typeof params !== "object" || params === null) {
    throw new OneClickValidationError("INVALID_REQUEST", "Payout quote parameters must be an object.");
  }
  assertPositiveAmount(params.amount, "amount");
  assertIntentsAssetId(params.assetId, "assetId");
  assertAccountLike(params.recipient, "recipient");
  assertAccountLike(params.refundTo, "refundTo");
  const recipientType = params.recipientType ?? "CONFIDENTIAL_INTENTS";
  assertRecipientType(recipientType);
  const refundType = params.refundType ?? "CONFIDENTIAL_INTENTS";
  if (refundType !== "INTENTS" && refundType !== "CONFIDENTIAL_INTENTS") {
    throw new OneClickValidationError(
      "INVALID_REQUEST",
      "refundType must be INTENTS or CONFIDENTIAL_INTENTS for a confidential payout.",
    );
  }
  if (params.confidentiality !== undefined) {
    assertConfidentialityLevel(params.confidentiality);
  }
  const request: QuoteRequest = {
    dry: assertBoolean(params.dry, "dry"),
    swapType: "EXACT_INPUT",
    slippageTolerance: DEFAULT_SLIPPAGE_TOLERANCE_BPS,
    originAsset: params.assetId,
    depositType: "CONFIDENTIAL_INTENTS",
    destinationAsset: params.assetId,
    amount: params.amount,
    refundTo: params.refundTo,
    refundType,
    recipient: params.recipient,
    recipientType,
    deadline: resolveDeadline(params.deadline, params.now),
    ...(params.confidentiality === undefined ? {} : { confidentiality: params.confidentiality }),
  };
  return request;
}

export interface PayoutPollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  /** Injected for tests; defaults to `setTimeout`. */
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export interface ConfidentialPayoutOptions {
  store?: PrivateStore;
  poll?: PayoutPollOptions;
  now?: () => Date;
  /** Receipt id generator; defaults to `rcpt_<uuid>`. */
  receiptIdFactory?: () => string;
}

export interface ShieldParams {
  tokenAssetId: string;
  amount: string;
  accountId: string;
  confidentiality?: ConfidentialityLevel;
}

export interface PayoutExecutionOptions {
  recipientType?: RecipientType;
  refundType?: "INTENTS" | "CONFIDENTIAL_INTENTS";
  confidentiality?: ConfidentialityLevel;
}

export type ConfidentialPayoutErrorCode =
  | "PAYOUT_NOT_STORED"
  | "PAYOUT_STORE_MISMATCH"
  | "PAYOUT_STATUS_UNEXPECTED"
  | "PAYOUT_STATUS_TIMEOUT"
  | "QUOTE_NOT_FUNDABLE";

export class ConfidentialPayoutError extends Error {
  readonly code: ConfidentialPayoutErrorCode;

  constructor(code: ConfidentialPayoutErrorCode, message: string) {
    super(message);
    this.name = "ConfidentialPayoutError";
    this.code = code;
  }
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_TIMEOUT_MS = 10 * 60_000;

/**
 * Executes shield and per-employee confidential payouts. One instance can be
 * reused; the store serializes its own writes.
 */
export class ConfidentialPayout {
  readonly #client: OneClickClient;
  readonly #signer: IntentPayloadSigner;
  readonly #store: PrivateStore;
  readonly #now: () => Date;
  readonly #receiptIdFactory: () => string;
  readonly #pollIntervalMs: number;
  readonly #pollTimeoutMs: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #pollNow: () => number;

  constructor(
    client: OneClickClient,
    signer: IntentPayloadSigner,
    options: ConfidentialPayoutOptions = {},
  ) {
    this.#client = client;
    this.#signer = signer;
    this.#store = options.store ?? new PrivateStore();
    this.#now = options.now ?? (() => new Date());
    this.#receiptIdFactory = options.receiptIdFactory ?? (() => `rcpt_${randomUUID()}`);
    const poll = options.poll ?? {};
    this.#pollIntervalMs = poll.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#pollTimeoutMs = poll.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    this.#sleep = poll.sleep ?? ((milliseconds) => sleepFor(milliseconds));
    this.#pollNow = poll.now ?? Date.now;
    if (!Number.isFinite(this.#pollIntervalMs) || this.#pollIntervalMs <= 0) {
      throw new ConfidentialPayoutError("PAYOUT_STATUS_UNEXPECTED", "Poll interval must be positive.");
    }
    if (!Number.isFinite(this.#pollTimeoutMs) || this.#pollTimeoutMs <= 0) {
      throw new ConfidentialPayoutError("PAYOUT_STATUS_UNEXPECTED", "Poll timeout must be positive.");
    }
  }

  /** Move the employer's tokens into Confidential Intents and settle the intent. */
  async shield(params: ShieldParams): Promise<{ intentHash: string }> {
    if (typeof params !== "object" || params === null) {
      throw new OneClickValidationError("INVALID_REQUEST", "Shield parameters must be an object.");
    }
    assertPositiveAmount(params.amount, "amount");
    const request = buildShieldQuoteRequest({ ...params, dry: false });
    await this.#client.requireAssets([request.originAsset]);
    const response = await this.#client.getQuote(request);
    const depositAddress = readQuoteDepositAddress(response, { require: true });
    if (depositAddress === null) {
      throw new ConfidentialPayoutError(
        "QUOTE_NOT_FUNDABLE",
        "Non-dry shield quote did not include a deposit address.",
      );
    }

    const receiptId = this.#newReceiptId();
    const now = this.#nowIso();
    const depositMemo = response.quote.depositMemo;
    await this.#store.savePrivateReceipt({
      receiptId,
      payrollId: `shield:${receiptId}`,
      employer: params.accountId,
      employee: params.accountId,
      intentHash: null,
      commitmentHash: null,
      amount: params.amount,
      asset: request.originAsset,
      depositAddress,
      ...(depositMemo === undefined ? {} : { depositMemo }),
      quoteSignature: response.signature,
      correlationId: response.correlationId,
      status: "PENDING_DEPOSIT",
      createdAt: now,
      updatedAt: now,
    });

    const submitted = await this.#signAndSubmit(depositAddress);
    await this.#store.updatePrivateReceipt(receiptId, {
      intentHash: submitted.intentHash,
      correlationId: submitted.correlationId,
      updatedAt: this.#nowIso(),
    });
    const finalStatus = await this.waitForTerminalStatus(depositAddress, depositMemo);
    await this.#store.updatePrivateReceipt(receiptId, {
      status: finalStatus.status,
      updatedAt: this.#nowIso(),
    });
    return { intentHash: submitted.intentHash };
  }

  /**
   * Settle one scheduled payout. The amount and salt must already be in the
   * private store: the on-chain schedule carries bookkeeping only.
   */
  async executePendingPayout(
    entry: PendingPayout,
    options: PayoutExecutionOptions = {},
  ): Promise<{ intentHash: string }> {
    const stored = await this.#requireStoredPayout(entry);
    const assetId = await this.#client.resolveNearAssetId(entry.asset);
    const request = buildPayoutQuoteRequest({
      dry: false,
      assetId,
      amount: stored.amount,
      recipient: stored.employee,
      refundTo: stored.employer,
      ...(options.recipientType === undefined ? {} : { recipientType: options.recipientType }),
      ...(options.refundType === undefined ? {} : { refundType: options.refundType }),
      ...(options.confidentiality === undefined
        ? {}
        : { confidentiality: options.confidentiality }),
      now: this.#now(),
    });
    await this.#client.requireAssets([request.originAsset, request.destinationAsset]);
    const response = await this.#client.getQuote(request);
    const depositAddress = readQuoteDepositAddress(response, { require: true });
    if (depositAddress === null) {
      throw new ConfidentialPayoutError(
        "QUOTE_NOT_FUNDABLE",
        "Non-dry payout quote did not include a deposit address.",
      );
    }

    const receiptId = this.#newReceiptId();
    const now = this.#nowIso();
    const depositMemo = response.quote.depositMemo;
    await this.#store.savePrivateReceipt({
      receiptId,
      payrollId: `payout:${stored.employer}:${stored.payout_id}`,
      employer: stored.employer,
      employee: stored.employee,
      intentHash: null,
      commitmentHash: stored.commitment_hash,
      amount: stored.amount,
      asset: request.originAsset,
      depositAddress,
      ...(depositMemo === undefined ? {} : { depositMemo }),
      quoteSignature: response.signature,
      correlationId: response.correlationId,
      status: "PENDING_DEPOSIT",
      createdAt: now,
      updatedAt: now,
    });

    const submitted = await this.#signAndSubmit(depositAddress);
    await this.#store.updatePrivateReceipt(receiptId, {
      intentHash: submitted.intentHash,
      correlationId: submitted.correlationId,
      updatedAt: this.#nowIso(),
    });
    const finalStatus = await this.waitForTerminalStatus(depositAddress, depositMemo);
    await this.#store.updatePrivateReceipt(receiptId, {
      status: finalStatus.status,
      updatedAt: this.#nowIso(),
    });
    return { intentHash: submitted.intentHash };
  }

  /** Dry quote validation for a scheduled payout; no funds move. */
  async preflightPayout(
    entry: PendingPayout,
    options: PayoutExecutionOptions = {},
  ): Promise<PreflightResult> {
    const findings: string[] = [];
    let assetId: string;
    try {
      assetId = await this.#client.resolveNearAssetId(entry.asset);
    } catch (error) {
      return { canProceed: false, findings: [describeFinding(error)] };
    }
    try {
      const request = buildPayoutQuoteRequest({
        dry: true,
        assetId,
        amount: entry.amount,
        recipient: entry.employee,
        refundTo: entry.employer,
        ...(options.recipientType === undefined ? {} : { recipientType: options.recipientType }),
        ...(options.refundType === undefined ? {} : { refundType: options.refundType }),
        ...(options.confidentiality === undefined
          ? {}
          : { confidentiality: options.confidentiality }),
        now: this.#now(),
      });
      await this.#client.requireAssets([request.originAsset, request.destinationAsset]);
      const response = await this.#client.getQuote(request);
      validateQuoteResponse(request, response, { requireDepositAddress: false });
      if (readQuoteDepositAddress(response, { require: false }) !== null) {
        findings.push("Dry quote unexpectedly returned a deposit address.");
      }
    } catch (error) {
      findings.push(describeFinding(error));
    }
    return { canProceed: findings.length === 0, findings };
  }

  /** Poll `/v0/status` until a terminal state or timeout. */
  async waitForTerminalStatus(
    depositAddress: string,
    depositMemo?: string,
  ): Promise<ExecutionStatusResponse> {
    const started = this.#pollNow();
    let lastStatus = "UNKNOWN";
    for (;;) {
      const response = await this.#client.getStatus(depositAddress, depositMemo);
      lastStatus = response.status;
      if (isTerminalExecutionStatus(response.status)) {
        return response;
      }
      if (!isPendingExecutionStatus(response.status)) {
        throw new ConfidentialPayoutError(
          "PAYOUT_STATUS_UNEXPECTED",
          `1Click returned an unrecognized execution status: ${lastStatus}.`,
        );
      }
      if (this.#pollNow() - started >= this.#pollTimeoutMs) {
        throw new ConfidentialPayoutError(
          "PAYOUT_STATUS_TIMEOUT",
          `1Click settlement is still ${lastStatus} after the polling timeout.`,
        );
      }
      await this.#sleep(this.#pollIntervalMs);
    }
  }

  async #signAndSubmit(
    depositAddress: string,
  ): Promise<{ intentHash: string; correlationId: string }> {
    const generated = await this.#client.generateIntent({
      signerId: this.#signer.signerId,
      depositAddress,
    });
    if (generated.intent.payload.recipient !== INTENTS_ACCOUNT_ID) {
      throw new ConfidentialPayoutError(
        "QUOTE_NOT_FUNDABLE",
        `Generated intent recipient must be ${INTENTS_ACCOUNT_ID}.`,
      );
    }
    const signed = await this.#signer.signPayload(generated.intent.payload);
    const submitted = await this.#client.submitIntent({
      standard: "nep413",
      payload: generated.intent.payload,
      public_key: signed.publicKey,
      signature: signed.signature,
    });
    return { intentHash: submitted.intentHash, correlationId: submitted.correlationId };
  }

  async #requireStoredPayout(entry: PendingPayout): Promise<PendingPayout> {
    if (typeof entry !== "object" || entry === null) {
      throw new ConfidentialPayoutError("PAYOUT_NOT_STORED", "Pending payout entry must be an object.");
    }
    const stored = await this.#store.getPendingPayout(entry.employer, entry.payout_id);
    if (stored === undefined) {
      throw new ConfidentialPayoutError(
        "PAYOUT_NOT_STORED",
        "Pending payout is not in the private store; schedule and store the amount before settling.",
      );
    }
    const fields: readonly (keyof PendingPayout)[] = [
      "employer",
      "payout_id",
      "employee",
      "amount",
      "salt",
      "asset",
      "memo",
      "commitment_hash",
    ];
    for (const field of fields) {
      if (stored[field] !== entry[field]) {
        throw new ConfidentialPayoutError(
          "PAYOUT_STORE_MISMATCH",
          `Pending payout does not match the private store (${field}).`,
        );
      }
    }
    return stored;
  }

  #newReceiptId(): string {
    const receiptId = this.#receiptIdFactory();
    if (typeof receiptId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(receiptId)) {
      throw new ConfidentialPayoutError("PAYOUT_NOT_STORED", "Receipt id factory returned an invalid id.");
    }
    return receiptId;
  }

  #nowIso(): string {
    const now = this.#now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new ConfidentialPayoutError("PAYOUT_NOT_STORED", "Clock returned an invalid date.");
    }
    return now.toISOString();
  }
}

function resolveDeadline(deadline: Date | string | undefined, now?: Date): string {
  const clock = now ?? new Date();
  if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) {
    throw new OneClickValidationError("INVALID_DEADLINE", "Deadline clock is invalid.");
  }
  const resolved =
    deadline === undefined
      ? new Date(clock.getTime() + DEFAULT_QUOTE_DEADLINE_MS)
      : deadline instanceof Date
        ? deadline
        : new Date(deadline);
  if (!Number.isFinite(resolved.getTime())) {
    throw new OneClickValidationError("INVALID_DEADLINE", "deadline must be an ISO-8601 timestamp.");
  }
  if (resolved.getTime() <= clock.getTime()) {
    throw new OneClickValidationError("INVALID_DEADLINE", "deadline must be in the future.");
  }
  return resolved.toISOString();
}

function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new OneClickValidationError("INVALID_REQUEST", `${field} must be a boolean.`);
  }
  return value;
}

function assertAccountLike(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 128 || /\s/.test(value)) {
    throw new OneClickValidationError("INVALID_REQUEST", `${field} must be a non-empty address string.`);
  }
}

function assertRecipientType(value: unknown): asserts value is RecipientType {
  if (value !== "DESTINATION_CHAIN" && value !== "INTENTS" && value !== "CONFIDENTIAL_INTENTS") {
    throw new OneClickValidationError("INVALID_REQUEST", "recipientType is unsupported.");
  }
}

function describeFinding(error: unknown): string {
  if (error instanceof OneClickValidationError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof OneClickResponseError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof OneClickApiError) {
    return `1Click HTTP ${error.status} for ${error.path}${error.body.code ? ` (${error.body.code})` : ""}.`;
  }
  if (error instanceof OneClickNetworkError) {
    return `1Click network failure for ${error.path}.`;
  }
  if (error instanceof ConfidentialPayoutError) {
    return `${error.code}: ${error.message}`;
  }
  return "Unexpected preflight failure.";
}
