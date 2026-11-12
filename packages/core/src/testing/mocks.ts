/**
 * Test-only doubles for the flow tests.
 *
 * `MockOneClickTransport` speaks the real `OneClickTransport` interface and
 * emits schema-valid quotes/intents/statuses, so the production OneClickClient
 * and ConfidentialPayout run unchanged. `FakeNearContract` implements the
 * contract methods used by the typed clients in memory.
 *
 * Neither double is referenced by production flows; they are shipped only so
 * the test suite can exercise the real orchestration without network funds.
 */

import { sha256Hex } from "../crypto/hashUtils.js";
import {
  INTENTS_ACCOUNT_ID,
  ONECLICK_PATHS,
  type ExecutionStatusResponse,
  type Nep413Payload,
  type OneClickHttpRequest,
  type OneClickHttpResponse,
  type OneClickTransport,
  type QuoteRequest,
  type QuoteResponse,
  type TokenResponse,
} from "../intents/OneClickClient.js";
import type {
  NearCallFunctionParams,
  NearCallAccount,
  NearViewFunctionParams,
  NearViewProvider,
} from "../near/NearContractWrapper.js";
import type { HoldEntry, PayoutEntry } from "../types.js";
import { isJsonObject } from "../audit/jsonObject.js";

/** Default token used by mock quotes. */
export const MOCK_TOKEN: TokenResponse = {
  assetId: "nep141:usdc.testnet",
  decimals: 6,
  blockchain: "near",
  symbol: "USDC",
  price: 1,
  priceUpdatedAt: "2026-01-01T00:00:00.000Z",
  contractAddress: "usdc.testnet",
};

export const MOCK_PUBLIC_KEY = "ed25519:3YhZ8bH6p8xkZ1GJ7WJ8qQe7mZfM8n9cQe3rTn5xYb7L";
export const MOCK_SIGNATURE =
  "ed25519:4Zk2mQ9pXw7rT5nB8cV1sL3hJ6fG9dK2aP4uY7eR5tW8qN3mX6bC9vF2hJ5kL8pS1dG4jM7cB2nR5xZ";

const MOCK_QUOTE_REQUEST: QuoteRequest = {
  dry: false,
  swapType: "EXACT_INPUT",
  slippageTolerance: 100,
  originAsset: MOCK_TOKEN.assetId,
  depositType: "CONFIDENTIAL_INTENTS",
  destinationAsset: MOCK_TOKEN.assetId,
  amount: "1",
  refundTo: "subrosa.testnet",
  refundType: "CONFIDENTIAL_INTENTS",
  recipient: "alice.testnet",
  recipientType: "CONFIDENTIAL_INTENTS",
  deadline: "2026-01-01T00:03:00.000Z",
};

export interface MockOneClickTransportOptions {
  tokens?: TokenResponse[];
  /** Status sequence shared by every deposit address. */
  statuses?: readonly string[];
  /** Per-deposit status sequence, overriding `statuses`. */
  statusByDeposit?: Readonly<Record<string, readonly string[]>>;
  depositAddressPrefix?: string;
  quoteSignature?: string;
  correlationIdPrefix?: string;
}

/** Build a schema-valid quote response that echoes the request. */
export function mockQuoteResponse(
  request: QuoteRequest,
  options: {
    depositAddress?: string;
    signature?: string;
    correlationId?: string;
    amountIn?: string;
  } = {},
): QuoteResponse {
  const amountIn = options.amountIn ?? request.amount;
  return {
    correlationId: options.correlationId ?? "mock-correlation",
    timestamp: "2026-01-01T00:00:00.000Z",
    signature: options.signature ?? "mock-quote-signature",
    quoteRequest: { ...request },
    quote: {
      ...(options.depositAddress === undefined
        ? {}
        : { depositAddress: options.depositAddress }),
      amountIn,
      amountInFormatted: "1",
      amountInUsd: "1",
      minAmountIn: amountIn,
      amountOut: amountIn,
      amountOutFormatted: "1",
      amountOutUsd: "1",
      minAmountOut: amountIn,
      timeEstimate: 120,
    },
  };
}

/** Programmable 1Click transport with deterministic ids and statuses. */
export class MockOneClickTransport implements OneClickTransport {
  readonly requests: OneClickHttpRequest[] = [];
  readonly submittedIntentHashes: string[] = [];
  readonly #options: MockOneClickTransportOptions;
  readonly #statusByDeposit = new Map<string, string[]>();
  readonly #quoteByDeposit = new Map<string, QuoteResponse>();
  #depositCounter = 0;
  #intentCounter = 0;

  constructor(options: MockOneClickTransportOptions = {}) {
    this.#options = options;
  }

  async request<T>(request: OneClickHttpRequest): Promise<OneClickHttpResponse<T>> {
    this.requests.push(request);
    const data = this.#handle(request);
    return { status: data.status, data: data.data as T };
  }

  /** Count requests by method/path without re-running the mock. */
  countRequests(method: OneClickHttpRequest["method"], path: string): number {
    return this.requests.filter((request) => request.method === method && request.path === path).length;
  }

  #handle(request: OneClickHttpRequest): OneClickHttpResponse<unknown> {
    switch (request.path) {
      case ONECLICK_PATHS.tokens:
        return { status: 200, data: this.#options.tokens ?? [MOCK_TOKEN] };
      case ONECLICK_PATHS.quote: {
        const body = request.body;
        if (!isJsonObject(body)) {
          return { status: 400, data: { message: "quote body must be an object" } };
        }
        const quoteRequest = body as unknown as QuoteRequest;
        const depositAddress =
          quoteRequest.dry === true
            ? undefined
            : `${this.#options.depositAddressPrefix ?? "mock-deposit"}-${++this.#depositCounter}`;
        if (depositAddress !== undefined) {
          const sequence =
            this.#options.statusByDeposit?.[depositAddress] ??
            this.#options.statuses ?? ["SUCCESS"];
          this.#statusByDeposit.set(depositAddress, [...sequence]);
        }
        const response = mockQuoteResponse(quoteRequest, {
          ...(depositAddress === undefined ? {} : { depositAddress }),
          ...(this.#options.quoteSignature === undefined
            ? {}
            : { signature: this.#options.quoteSignature }),
          ...(this.#options.correlationIdPrefix === undefined
            ? {}
            : { correlationId: `${this.#options.correlationIdPrefix}-quote` }),
        });
        if (depositAddress !== undefined) {
          this.#quoteByDeposit.set(depositAddress, response);
        }
        return { status: 200, data: response };
      }
      case ONECLICK_PATHS.generateIntent: {
        this.#intentCounter += 1;
        const payload: Nep413Payload = {
          message: JSON.stringify({
            deadline: "2026-01-01T00:05:00.000Z",
            intents: [],
            signer_id: "subrosa.testnet",
          }),
          nonce: Buffer.alloc(32, this.#intentCounter).toString("base64"),
          recipient: INTENTS_ACCOUNT_ID,
        };
        return {
          status: 200,
          data: {
            intent: { standard: "nep413", payload },
            correlationId: `${this.#options.correlationIdPrefix ?? "mock"}-generate-${this.#intentCounter}`,
          },
        };
      }
      case ONECLICK_PATHS.submitIntent: {
        const intentHash = sha256Hex(`mock-intent-${this.#intentCounter}`);
        this.submittedIntentHashes.push(intentHash);
        return {
          status: 200,
          data: {
            intentHash,
            correlationId: `${this.#options.correlationIdPrefix ?? "mock"}-submit-${this.#intentCounter}`,
          },
        };
      }
      case ONECLICK_PATHS.status: {
        const depositAddress = request.query?.depositAddress;
        if (typeof depositAddress !== "string") {
          return { status: 400, data: { message: "missing depositAddress" } };
        }
        const sequence = this.#statusByDeposit.get(depositAddress) ?? ["SUCCESS"];
        const status = sequence.length > 1 ? sequence.shift() ?? "SUCCESS" : sequence[0] ?? "SUCCESS";
        const response: ExecutionStatusResponse = {
          correlationId: `mock-status-${depositAddress}`,
          quoteResponse:
            this.#quoteByDeposit.get(depositAddress) ??
            mockQuoteResponse(MOCK_QUOTE_REQUEST, { depositAddress }),
          status,
          updatedAt: "2026-01-01T00:00:01.000Z",
        };
        return { status: 200, data: response };
      }
      case ONECLICK_PATHS.authAuthenticate:
        return {
          status: 200,
          data: {
            accessToken: "mock-access",
            refreshToken: "mock-refresh",
            expiresIn: 900,
            refreshExpiresIn: 3600,
          },
        };
      case ONECLICK_PATHS.authRefresh:
        return { status: 200, data: { accessToken: "mock-access-2", expiresIn: 900 } };
      case ONECLICK_PATHS.accountBalances:
        return { status: 200, data: { balances: [] } };
      case ONECLICK_PATHS.accountHistory:
        return { status: 200, data: { items: [] } };
      default:
        return { status: 404, data: { message: "unexpected mock 1Click path" } };
    }
  }
}

export interface FakeNearContractOptions {
  contractId?: string;
  /** Caller used for writes that omit an employer (schedule/mark). */
  callerId?: string;
  employers?: Record<string, string>;
  commitments?: Array<{
    employer: string;
    employee: string;
    cycleId: number;
    commitmentHash: string;
    token: string;
  }>;
}

/** In-memory contract double covering the payout/hold surface used by tests. */
export class FakeNearContract {
  readonly contractId: string;
  readonly #employees = new Map<string, { active: boolean; token: string; commitmentHash: string }>();
  readonly #commitments = new Map<string, { commitmentHash: string; token: string }>();
  readonly #payouts = new Map<string, PayoutEntry>();
  readonly #payoutSeq = new Map<string, number>();
  readonly #holds = new Map<string, HoldEntry>();
  #paused = false;
  readonly #callerId: string;

  readonly account: NearCallAccount;
  readonly provider: NearViewProvider;

  constructor(options: FakeNearContractOptions = {}) {
    this.contractId = options.contractId ?? "subrosa.testnet";
    this.#callerId = options.callerId ?? this.contractId;
    for (const [employer, employee] of Object.entries(options.employers ?? {})) {
      this.#employees.set(`${employer}:${employee}`, {
        active: true,
        token: "usdc.testnet",
        commitmentHash: "a".repeat(64),
      });
    }
    for (const item of options.commitments ?? []) {
      this.#commitments.set(`${item.employer}:${item.employee}:${item.cycleId}`, {
        commitmentHash: item.commitmentHash,
        token: item.token,
      });
    }
    this.account = {
      accountId: this.contractId,
      callFunction: async <T extends string | number | boolean | object>(
        params: NearCallFunctionParams,
      ): Promise<T> => {
        const result = this.#write(params.methodName, callArgs(params.args));
        return result as T;
      },
    };
    this.provider = {
      callFunction: async <T extends string | number | boolean | object>(
        params: NearViewFunctionParams,
      ): Promise<T | undefined> => {
        const result = this.#view(params.method, callArgs(params.args));
        return result as T | undefined;
      },
    };
  }

  /** Seed a scheduled payout at an explicit id. */
  seedPayout(employer: string, payoutId: number, entry: PayoutEntry): void {
    this.#payouts.set(`${employer}:${payoutId}`, { ...entry });
    this.#payoutSeq.set(employer, Math.max(this.#payoutSeq.get(employer) ?? 0, payoutId));
  }

  seedHold(holdId: string, entry: HoldEntry): void {
    this.#holds.set(holdId, { ...entry });
  }

  payout(employer: string, payoutId: number): PayoutEntry | undefined {
    const entry = this.#payouts.get(`${employer}:${payoutId}`);
    return entry === undefined ? undefined : { ...entry };
  }

  setPaused(paused: boolean): void {
    this.#paused = paused;
  }

  #write(methodName: string, args: Record<string, unknown>): unknown {
    switch (methodName) {
      case "schedule_payout": {
        if (this.#paused) throw new Error("Smart contract panicked: paused");
        const employer = this.#employerFrom(args);
        const next = (this.#payoutSeq.get(employer) ?? 0) + 1;
        this.#payoutSeq.set(employer, next);
        this.#payouts.set(`${employer}:${next}`, {
          employer,
          employee: stringField(args.employee, "employee"),
          commitment_hash: stringField(args.commitment_hash, "commitment_hash"),
          asset: stringField(args.asset, "asset"),
          memo: typeof args.memo === "string" ? args.memo : "",
          execute_at: numberField(args.execute_at, "execute_at"),
          created_at: 1,
          state: "Pending",
          intent_hash: null,
        });
        return next;
      }
      case "mark_settled": {
        const entry = this.#requirePayout(args);
        if (entry.state !== "Pending") throw new Error("Smart contract panicked: payout is not pending");
        entry.state = "Executed";
        entry.intent_hash = stringField(args.intent_hash, "intent_hash");
        return null;
      }
      case "mark_failed": {
        const entry = this.#requirePayout(args);
        if (entry.state !== "Pending") throw new Error("Smart contract panicked: payout is not pending");
        const status = stringField(args.status, "status");
        if (status !== "FAILED" && status !== "REFUNDED") {
          throw new Error("Smart contract panicked: invalid failure status");
        }
        entry.state = "Failed";
        return null;
      }
      case "expire_payout": {
        const entry = this.#requirePayout(args);
        if (entry.state !== "Pending") throw new Error("Smart contract panicked: payout is not pending");
        entry.state = "Expired";
        return null;
      }
      case "create_audit_hold": {
        const holdId = stringField(args.hold_id, "hold_id");
        this.#holds.set(holdId, {
          employer: stringField(args.employer, "employer"),
          scope: args.scope as HoldEntry["scope"],
          scope_id: stringField(args.scope_id, "scope_id"),
          reason_code: args.reason_code as HoldEntry["reason_code"],
          state: "Active",
          placed_by: "subrosa.testnet",
          placed_at: 1,
          released_by: null,
          released_at: null,
          release_reason: null,
        });
        return null;
      }
      case "release_audit_hold": {
        const holdId = stringField(args.hold_id, "hold_id");
        const hold = this.#holds.get(holdId);
        if (hold === undefined) throw new Error("Smart contract panicked: unknown hold");
        hold.state = "Released";
        hold.released_by = "subrosa.testnet";
        hold.released_at = 2;
        hold.release_reason = args.release_reason as HoldEntry["reason_code"];
        return null;
      }
      default:
        throw new Error(`FakeNearContract has no write method "${methodName}"`);
    }
  }

  #view(method: string, args: Record<string, unknown>): unknown {
    switch (method) {
      case "get_payout": {
        const employer = stringField(args.employer, "employer");
        const payoutId = numberField(args.payout_id, "payout_id");
        const entry = this.#payouts.get(`${employer}:${payoutId}`);
        return entry === undefined ? null : { ...entry };
      }
      case "get_pending_payouts": {
        const employer = stringField(args.employer, "employer");
        const from = numberField(args.from_index, "from_index");
        const limit = numberField(args.limit, "limit");
        return [...this.#payouts.entries()]
          .filter(([key, entry]) => key.startsWith(`${employer}:`) && entry.state === "Pending")
          .map(([, entry]) => ({ ...entry }))
          .slice(from, from + limit);
      }
      case "get_payout_count": {
        const employer = stringField(args.employer, "employer");
        let count = 0;
        for (const key of this.#payouts.keys()) {
          if (key.startsWith(`${employer}:`)) count += 1;
        }
        return count;
      }
      case "get_hold_ids":
        return [...this.#holds.keys()];
      case "get_audit_hold": {
        const holdId = stringField(args.hold_id, "hold_id");
        const hold = this.#holds.get(holdId);
        return hold === undefined ? null : { ...hold };
      }
      case "is_payout_due": {
        const entry = this.#requirePayout(args);
        return entry.execute_at <= 1;
      }
      case "get_employee": {
        const employer = stringField(args.employer, "employer");
        const employee = stringField(args.employee, "employee");
        const entry = this.#employees.get(`${employer}:${employee}`);
        return entry === undefined
          ? null
          : {
              salary_commitment: entry.commitmentHash,
              token: entry.token,
              metadata: "",
              active: entry.active,
              created_at: 1,
              updated_at: 1,
            };
      }
      case "get_commitment": {
        const employer = stringField(args.employer, "employer");
        const employee = stringField(args.employee, "employee");
        const cycleId = numberField(args.cycle_id, "cycle_id");
        const entry = this.#commitments.get(`${employer}:${employee}:${cycleId}`);
        return entry === undefined
          ? null
          : { commitment_hash: entry.commitmentHash, token: entry.token, created_at: 1 };
      }
      default:
        throw new Error(`FakeNearContract has no view method "${method}"`);
    }
  }

  #requirePayout(args: Record<string, unknown>): PayoutEntry {
    const employer = this.#employerFrom(args);
    const payoutId = numberField(args.payout_id, "payout_id");
    const entry = this.#payouts.get(`${employer}:${payoutId}`);
    if (entry === undefined) throw new Error("Smart contract panicked: unknown payout");
    return entry;
  }

  #employerFrom(args: Record<string, unknown>): string {
    return typeof args.employer === "string" && args.employer.length > 0
      ? args.employer
      : this.#callerId;
  }
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`FakeNearContract: ${field} must be a string`);
  }
  return value;
}

function numberField(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`FakeNearContract: ${field} must be a safe integer`);
  }
  return value;
}

function callArgs(value: unknown): Record<string, unknown> {
  if (value instanceof Uint8Array) {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(value));
    return isJsonObject(parsed) ? parsed : {};
  }
  return isJsonObject(value) ? value : {};
}
