/**
 * near-api-js v7 contract transport.
 *
 * Writes use `Account.callFunction` with a single object argument and
 * `waitUntil: "FINAL"`; the RPC performs the finality poll, and the wrapper
 * bounds the wait with `callTimeoutMs`. Reads use `Provider.callFunction` with
 * `blockQuery: { finality: "final" }` (a provider view takes `contractId` and
 * `method`, not `accountId`/`methodName`).
 *
 * Reads and status polls run under `core/retry-budget.ts` budgets. Writes are
 * deliberately not retried by default: a failed submission may already be in
 * flight, so the wrapper caps writes at one attempt unless the caller supplies
 * an idempotency key and opts into a larger write budget. Concurrent calls
 * that share a key are deduplicated by the registry instead of being
 * submitted twice.
 */

import {
  nearToYocto,
  teraToGas,
  type BlockReference,
  type SerializedReturnValue,
  type TxExecutionStatus,
} from "near-api-js";
import type { NearClientConfig } from "../config.js";
import {
  ContractErrorCode,
  ContractExecutionError,
  RpcTimeoutError,
  SubrosaError,
  ValidationError,
} from "../core/errors.js";
import { IdempotencyRegistry } from "../core/idempotency.js";
import {
  RetryBudgetExhaustedError,
  RetryOperationType,
  withRetryBudget,
  type RetryBudgetByOperation,
} from "../core/retry-budget.js";
import { assertNearAccountId } from "../settlement/destination.js";

/** Default gas attached to a state-changing call (TGas, decimal string). */
export const DEFAULT_GAS_TGAS = "30";
/** Default attached deposit (NEAR, decimal string). */
export const DEFAULT_DEPOSIT_NEAR = "0";
/** Default bound on waiting for a transaction to reach FINAL. */
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;

/** Minimal structural account surface the wrapper needs. */
export interface NearCallFunctionParams {
  contractId: string;
  methodName: string;
  args?: Record<string, unknown> | Uint8Array;
  deposit?: bigint | string | number;
  gas?: bigint | string | number;
  waitUntil?: TxExecutionStatus;
}

/** Structural account surface the wrapper needs. */
export interface NearCallAccount {
  readonly accountId?: string;
  callFunction<T extends SerializedReturnValue>(params: NearCallFunctionParams): Promise<T>;
}

export interface NearViewFunctionParams {
  contractId: string;
  method: string;
  args: Record<string, unknown> | Uint8Array;
  blockQuery?: BlockReference;
}

/** Structural provider surface the wrapper needs for views. */
export interface NearViewProvider {
  callFunction<T extends SerializedReturnValue>(
    params: NearViewFunctionParams,
  ): Promise<T | undefined>;
}

export interface NearContractWrapperDeps {
  account: NearCallAccount;
  provider: NearViewProvider;
}

export interface NearContractWrapperOptions {
  retryBudgets?: RetryBudgetByOperation;
  /** Dedupes concurrent writes that share an idempotency key. */
  idempotency?: IdempotencyRegistry<unknown>;
  /** Bound on a write's wait for FINAL (default 60 s). */
  callTimeoutMs?: number;
  /** Per-attempt timeout for view calls; timeouts consume read budget. */
  viewTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface NearContractCallOptions {
  /** Gas in TGas as a decimal string (default "30"). */
  gas?: string;
  /** Attached deposit in NEAR as a decimal string (default "0"). */
  deposit?: string;
  /** Concurrent submissions sharing this key are deduplicated. */
  idempotencyKey?: string;
}

const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

/**
 * Validate a non-negative decimal string and brand it for the near-api-js
 * unit helpers, which accept template-literal numeric strings only.
 */
function parseDecimal(value: string, field: string): `${number}` {
  const trimmed = value.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new ValidationError(`${field} must be a non-negative decimal string.`, field);
  }
  return trimmed as `${number}`;
}

export class NearContractWrapper {
  readonly contractId: string;
  private readonly account: NearCallAccount;
  private readonly provider: NearViewProvider;
  private readonly retryBudgets?: RetryBudgetByOperation;
  private readonly idempotency: IdempotencyRegistry<unknown>;
  private readonly callTimeoutMs: number;
  private readonly viewTimeoutMs?: number;
  private readonly now?: () => number;
  private readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    config: NearClientConfig,
    deps: NearContractWrapperDeps,
    options: NearContractWrapperOptions = {},
  ) {
    this.contractId = assertNearAccountId(config.contractId, "contractId");
    this.account = deps.account;
    this.provider = deps.provider;
    this.retryBudgets = options.retryBudgets;
    this.idempotency = options.idempotency ?? new IdempotencyRegistry<unknown>();
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.viewTimeoutMs = options.viewTimeoutMs;
    this.now = options.now;
    this.sleep = options.sleep;
  }

  /**
   * Read a contract view method. Returns the JSON-decoded result (or `null`
   * for an empty `Option` result), retrying transient failures under the read
   * budget and querying at `finality: "final"`.
   */
  async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const request = {
      contractId: this.contractId,
      method,
      args,
      blockQuery: { finality: "final" as const },
    };

    let raw: unknown;
    try {
      raw = await withRetryBudget(() => this.provider.callFunction(request), {
        operationType: RetryOperationType.READ,
        budgets: this.retryBudgets,
        attemptTimeoutMs: this.viewTimeoutMs,
        now: this.now,
        sleep: this.sleep,
      });
    } catch (error) {
      throw this.mapError(error, method, "read");
    }

    // near-api-js has already JSON-decoded the result; `T` is the contract
    // method's declared result type.
    return (raw ?? null) as T;
  }

  /**
   * Submit a state-changing contract method and return its JSON-decoded
   * result once the transaction reaches FINAL. Writes are capped at one
   * attempt unless a write budget with more attempts is configured together
   * with an idempotency key.
   */
  async call<T>(
    method: string,
    args: Record<string, unknown> = {},
    opts: NearContractCallOptions = {},
  ): Promise<T> {
    const gas = parseDecimal(opts.gas ?? DEFAULT_GAS_TGAS, "gas");
    const deposit = parseDecimal(opts.deposit ?? DEFAULT_DEPOSIT_NEAR, "deposit");
    const idempotencyKey = opts.idempotencyKey?.trim();

    const submitOnce = async (): Promise<T> => {
      try {
        const decoded: unknown = await this.withCallTimeout(
          this.account.callFunction<SerializedReturnValue>({
            contractId: this.contractId,
            methodName: method,
            args,
            gas: teraToGas(gas),
            deposit: nearToYocto(deposit),
            waitUntil: "FINAL",
          }),
          method,
        );
        return decoded as T;
      } catch (error) {
        throw this.mapError(error, method, "write");
      }
    };

    const submit: () => Promise<T> = idempotencyKey
      ? async () => {
          const result: unknown = await this.idempotency.execute(idempotencyKey, submitOnce, {
            ttlMs: 0,
          });
          return result as T;
        }
      : submitOnce;

    try {
      return await withRetryBudget(submit, {
        operationType: RetryOperationType.WRITE,
        budgets: this.retryBudgets,
        idempotencyKey,
        now: this.now,
        sleep: this.sleep,
      });
    } catch (error) {
      // A one-attempt write reports exhaustion instead of the submission
      // error; surface the mapped cause so callers see the RPC/contract error.
      if (
        error instanceof RetryBudgetExhaustedError &&
        error.retryRefused &&
        error.cause instanceof Error
      ) {
        throw error.cause;
      }
      throw error;
    }
  }

  private withCallTimeout<T>(submission: Promise<T>, method: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new RpcTimeoutError(
            `Transaction for "${method}" did not reach FINAL within ${this.callTimeoutMs}ms`,
            { contractId: this.contractId, method },
            undefined,
            ContractErrorCode.TRANSACTION_TIMEOUT,
          ),
        );
      }, this.callTimeoutMs);

      submission.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private mapError(error: unknown, method: string, direction: "read" | "write"): unknown {
    if (error instanceof SubrosaError) {
      return error;
    }

    const detail = error instanceof Error ? error.message : String(error);
    const reverted = /FunctionCallError|ActionError|Smart contract panicked|execution failed/i.test(
      detail,
    );
    const code =
      direction === "read"
        ? ContractErrorCode.UNKNOWN_RPC_ERROR
        : reverted
          ? ContractErrorCode.CONTRACT_REVERT
          : ContractErrorCode.TRANSACTION_SUBMISSION_FAILED;

    return new ContractExecutionError(
      `Contract ${direction} "${method}" failed: ${detail}`,
      code,
      { contractId: this.contractId, method },
      error,
    );
  }
}
