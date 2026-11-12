/**
 * 1Click REST client for Confidential Intents.
 *
 * Wire values are kept in plain JSON/strings so nothing from the nested
 * `@defuse-protocol/intents-sdk` dependency ever crosses this boundary. The
 * partner API key is only placed in the `X-API-Key` header: it is never put
 * in a URL, an error message, or a returned object.
 */

import axios from "axios";

import { ONECLICK_BASE_URL, type NearClientConfig } from "../config.js";

/** The fourteen documented 1Click paths (OpenAPI `info.version` 0.1.10). */
export const ONECLICK_PATHS = {
  authAuthenticate: "/v0/auth/authenticate",
  authRefresh: "/v0/auth/refresh",
  accountBalances: "/v0/account/balances",
  accountHistory: "/v0/account/history",
  tokens: "/v0/tokens",
  quote: "/v0/quote",
  status: "/v0/status",
  anyInputWithdrawals: "/v0/any-input/withdrawals",
  depositSubmit: "/v0/deposit/submit",
  generateIntent: "/v0/generate-intent",
  submitIntent: "/v0/submit-intent",
  orders: "/v0/orders",
  order: "/v0/orders/{orderId}",
  orderCancel: "/v0/orders/{orderId}/cancel",
} as const;

export type OneClickPathName = keyof typeof ONECLICK_PATHS;

/** Account that verifies intents and receives signed messages. */
export const INTENTS_ACCOUNT_ID = "intents.near";

export type SwapType = "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT" | "ANY_INPUT";
export type DepositType = "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type RefundType = DepositType;
export type RecipientType = "DESTINATION_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type ConfidentialityLevel = "public" | "basic" | "advanced";
export type IntentStandard = "nep413" | "erc191" | "raw_ed25519" | "webauthn" | "ton_connect" | "sep53" | "tip191";

export type ExecutionStatus =
  | "KNOWN_DEPOSIT_TX"
  | "PENDING_DEPOSIT"
  | "INCOMPLETE_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

/** Statuses after which no further polling can change the outcome. */
export const TERMINAL_EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  "SUCCESS",
  "FAILED",
  "REFUNDED",
  "INCOMPLETE_DEPOSIT",
];

/** Statuses that require another `/v0/status` poll. */
export const PENDING_EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  "PROCESSING",
  "PENDING_DEPOSIT",
  "KNOWN_DEPOSIT_TX",
];

export function isTerminalExecutionStatus(status: string): status is ExecutionStatus {
  return (TERMINAL_EXECUTION_STATUSES as readonly string[]).includes(status);
}

export function isPendingExecutionStatus(status: string): status is ExecutionStatus {
  return (PENDING_EXECUTION_STATUSES as readonly string[]).includes(status);
}

export interface QuoteRequest {
  dry: boolean;
  swapType: SwapType;
  /** Basis points; 100 = 1%. */
  slippageTolerance: number;
  originAsset: string;
  depositType: DepositType;
  destinationAsset: string;
  /** Decimal integer string in the origin asset's smallest unit. */
  amount: string;
  refundTo: string;
  refundType: RefundType;
  recipient: string;
  recipientType: RecipientType;
  /** ISO-8601 timestamp. */
  deadline: string;
  confidentiality?: ConfidentialityLevel;
  depositMode?: "SIMPLE" | "MEMO";
}

export interface Quote {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  timeEstimate: number;
  deadline?: string;
  timeWhenInactive?: string;
  refundFee?: string;
  withdrawFee?: string;
}

export interface QuoteResponse {
  correlationId: string;
  timestamp: string;
  signature: string;
  quoteRequest: QuoteRequest;
  quote: Quote;
}

export interface TokenResponse {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  priceUpdatedAt: string;
  contractAddress?: string;
  coingeckoId?: string;
}

export interface Nep413Payload {
  message: string;
  /** Base64-encoded nonce. */
  nonce: string;
  recipient: string;
  callbackUrl?: string;
}

export interface Nep413SignedData {
  standard: "nep413";
  payload: Nep413Payload;
  public_key: string;
  signature: string;
}

export interface AuthenticateResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
}

export interface RefreshResponse {
  accessToken: string;
  expiresIn: number;
}

export interface BalanceEntry {
  tokenId: string;
  available: string;
  source: string;
}

export interface BalancesResponse {
  balances: BalanceEntry[];
}

export interface HistoryItem {
  status: ExecutionStatus | string;
  depositType: DepositType;
  recipientType: RecipientType;
  createdAt: string;
  depositAddress: string;
  depositMemo: string | null;
  originAsset?: string;
  destinationAsset?: string;
  amountInFormatted?: string;
  amountOutFormatted?: string;
  amountOutUsd?: string;
  recipient?: string;
  refundTo?: string;
  refundType: RefundType;
  refundReason?: string | null;
}

export interface HistoryResponse {
  items: HistoryItem[];
  nextCursor?: string;
  prevCursor?: string;
}

export interface GenerateIntentRequest {
  signerId: string;
  depositAddress: string;
  standard?: "nep413";
}

export interface GeneratedIntent {
  standard: "nep413";
  payload: Nep413Payload;
}

export interface GenerateIntentResponse {
  intent: GeneratedIntent;
  correlationId: string;
}

export interface SubmitIntentResponse {
  intentHash: string;
  correlationId: string;
}

export interface ExecutionStatusResponse {
  correlationId: string;
  quoteResponse: QuoteResponse;
  status: ExecutionStatus | string;
  updatedAt: string;
  swapDetails?: {
    intentHashes?: string[];
    nearTxHashes?: string[];
    amountOut?: string;
    refundedAmount?: string;
    refundReason?: string;
  };
}

export interface HistoryQuery {
  prevCursor?: string;
  nextCursor?: string;
  status?: readonly ExecutionStatus[];
  limit?: number;
}

/** Query value: arrays serialize as repeated parameters (OpenAPI form). */
export type OneClickQueryValue = string | number | readonly string[] | undefined;

/** Transport request used by the injectable 1Click HTTP adapter. */
export interface OneClickHttpRequest {
  method: "GET" | "POST";
  path: string;
  query?: Readonly<Record<string, OneClickQueryValue>>;
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

export interface OneClickHttpResponse<T> {
  status: number;
  data: T;
}

/** Replaceable HTTP transport; tests inject a fake, production uses axios. */
export interface OneClickTransport {
  request<T>(request: OneClickHttpRequest): Promise<OneClickHttpResponse<T>>;
}


class AxiosTransport implements OneClickTransport {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl;
  }

  async request<T>(request: OneClickHttpRequest): Promise<OneClickHttpResponse<T>> {
    const response = await axios.request<T>({
      baseURL: this.#baseUrl,
      url: request.path,
      method: request.method,
      headers: request.headers === undefined ? undefined : { ...request.headers },
      params: request.query === undefined ? undefined : { ...request.query },
      paramsSerializer: { indexes: null },
      data: request.body,
      timeout: request.timeoutMs,
      validateStatus: () => true,
    });
    return { status: response.status, data: response.data };
  }
}

/** Request validation failed before anything was sent. */
export class OneClickValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OneClickValidationError";
    this.code = code;
  }
}

/** A 1Click response was structurally invalid or did not match its request. */
export class OneClickResponseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OneClickResponseError";
    this.code = code;
  }
}

/** Redacted subset of an error body; never contains addresses, hashes or keys. */
export interface RedactedErrorBody {
  message?: string;
  code?: string;
  error?: string;
}

/** HTTP error from 1Click with a sanitized body. */
export class OneClickApiError extends Error {
  readonly status: number;
  readonly method: OneClickHttpRequest["method"];
  readonly path: string;
  readonly body: RedactedErrorBody;

  constructor(
    status: number,
    method: OneClickHttpRequest["method"],
    path: string,
    body: RedactedErrorBody,
  ) {
    super(`1Click ${method} ${path} failed with HTTP ${status}${body.code ? ` (${body.code})` : ""}.`);
    this.name = "OneClickApiError";
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
  }
}

/** Transport failure before an HTTP response was received. */
export class OneClickNetworkError extends Error {
  readonly method: OneClickHttpRequest["method"];
  readonly path: string;
  readonly transportCode?: string;

  constructor(method: OneClickHttpRequest["method"], path: string, transportCode?: string) {
    super(`1Click ${method} ${path} failed before receiving a response.`);
    this.name = "OneClickNetworkError";
    this.method = method;
    this.path = path;
    this.transportCode = transportCode;
  }
}

export interface OneClickClientOptions {
  baseUrl?: string;
  /** Partner JWT. Defaults to `ONECLICK_API_KEY`; an empty string disables it. */
  apiKey?: string;
  transport?: OneClickTransport;
  timeoutMs?: number;
  /** In-memory `/v0/tokens` cache lifetime. */
  tokenCacheTtlMs?: number;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TOKEN_CACHE_TTL_MS = 5 * 60_000;
const MAX_ERROR_TEXT_LENGTH = 240;

/**
 * Confidential Intents REST client. Asset ids must come from {@link getTokens};
 * this client never constructs one from a ticker or contract address.
 */
export class OneClickClient {
  readonly #transport: OneClickTransport;
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #tokenCacheTtlMs: number;
  readonly #now: () => number;
  #tokenCache: { tokens: TokenResponse[]; fetchedAt: number } | null = null;

  constructor(options: OneClickClientOptions = {}) {
    const baseUrl = (options.baseUrl ?? ONECLICK_BASE_URL).trim().replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) {
      throw new OneClickValidationError("INVALID_BASE_URL", "1Click base URL must be an HTTP(S) URL.");
    }
    const configuredKey = options.apiKey === undefined ? process.env.ONECLICK_API_KEY : options.apiKey;
    const apiKey = configuredKey?.trim();
    this.#baseUrl = baseUrl;
    this.#apiKey = apiKey === undefined || apiKey === "" ? undefined : apiKey;
    this.#transport = options.transport ?? new AxiosTransport(baseUrl);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#tokenCacheTtlMs = options.tokenCacheTtlMs ?? DEFAULT_TOKEN_CACHE_TTL_MS;
    this.#now = options.now ?? Date.now;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new OneClickValidationError("INVALID_TIMEOUT", "Request timeout must be positive.");
    }
    if (!Number.isFinite(this.#tokenCacheTtlMs) || this.#tokenCacheTtlMs < 0) {
      throw new OneClickValidationError("INVALID_CACHE_TTL", "Token cache TTL must be non-negative.");
    }
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  static fromConfig(
    config: Pick<NearClientConfig, "oneClickBaseUrl">,
    options: Omit<OneClickClientOptions, "baseUrl"> = {},
  ): OneClickClient {
    return new OneClickClient({ ...options, baseUrl: config.oneClickBaseUrl });
  }

  /** Supported tokens, cached in memory; ids for quotes come only from here. */
  async getTokens(options: { refresh?: boolean } = {}): Promise<TokenResponse[]> {
    const cached = this.#tokenCache;
    if (
      options.refresh !== true &&
      cached !== null &&
      this.#now() - cached.fetchedAt < this.#tokenCacheTtlMs
    ) {
      return cached.tokens;
    }
    const data = await this.#send<unknown>("GET", ONECLICK_PATHS.tokens);
    if (!Array.isArray(data)) {
      throw new OneClickResponseError("TOKENS_INVALID", "GET /v0/tokens returned a non-array payload.");
    }
    const tokens = data.map((entry, index) => parseToken(entry, index));
    this.#tokenCache = { tokens, fetchedAt: this.#now() };
    return tokens;
  }

  /** Look up one asset id exactly as published by `/v0/tokens`. */
  async getToken(assetId: string): Promise<TokenResponse> {
    assertNonEmptyString(assetId, "assetId", "INVALID_ASSET_ID");
    const tokens = await this.getTokens();
    const token = tokens.find((candidate) => candidate.assetId === assetId);
    if (token === undefined) {
      throw new OneClickValidationError(
        "UNKNOWN_ASSET",
        "Asset id is not listed by GET /v0/tokens; use the published id verbatim.",
      );
    }
    return token;
  }

  /** Verify every asset id against `/v0/tokens` before a quote is requested. */
  async requireAssets(assetIds: readonly string[]): Promise<void> {
    if (!Array.isArray(assetIds) || assetIds.length === 0) {
      throw new OneClickValidationError("INVALID_ASSET_ID", "At least one asset id is required.");
    }
    const tokens = await this.getTokens();
    const known = new Set(tokens.map((token) => token.assetId));
    for (const assetId of assetIds) {
      assertIntentsAssetId(assetId, "assetId");
      if (!known.has(assetId)) {
        throw new OneClickValidationError(
          "UNKNOWN_ASSET",
          "Asset id is not listed by GET /v0/tokens; use the published id verbatim.",
        );
      }
    }
  }

  /**
   * Resolve a NEAR token contract (or an already-published asset id) to the
   * exact `/v0/tokens` asset id. Ambiguous or unknown contracts are rejected.
   */
  async resolveNearAssetId(contractOrAssetId: string): Promise<string> {
    assertNonEmptyString(contractOrAssetId, "asset", "INVALID_ASSET_ID");
    const tokens = await this.getTokens();
    const direct = tokens.find((candidate) => candidate.assetId === contractOrAssetId);
    if (direct !== undefined) {
      return direct.assetId;
    }
    const contract = contractOrAssetId.startsWith("nep141:")
      ? contractOrAssetId.slice("nep141:".length)
      : contractOrAssetId;
    const matches = tokens.filter(
      (candidate) => candidate.blockchain === "near" && candidate.contractAddress === contract,
    );
    if (matches.length !== 1) {
      throw new OneClickValidationError(
        "UNKNOWN_ASSET",
        "NEAR token contract does not resolve to exactly one asset id in GET /v0/tokens.",
      );
    }
    return matches[0].assetId;
  }

  /**
   * Request a quote. The response signature is required but treated as
   * untrusted: its presence is checked and every safety field is revalidated
   * against the request before the caller can fund anything.
   */
  async getQuote(request: QuoteRequest): Promise<QuoteResponse> {
    validateQuoteRequest(request);
    const data = await this.#send<unknown>("POST", ONECLICK_PATHS.quote, { body: request });
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new OneClickResponseError("QUOTE_SHAPE_INVALID", "Quote response must be an object.");
    }
    const response = data as unknown as QuoteResponse;
    validateQuoteResponse(request, response, { requireDepositAddress: !request.dry });
    return response;
  }

  /** Poll a deposit's execution status. The query is never logged. */
  async getStatus(depositAddress: string, depositMemo?: string): Promise<ExecutionStatusResponse> {
    assertNonEmptyString(depositAddress, "depositAddress", "INVALID_DEPOSIT_ADDRESS");
    if (depositMemo !== undefined) {
      assertNonEmptyString(depositMemo, "depositMemo", "INVALID_DEPOSIT_MEMO");
    }
    const data = await this.#send<unknown>("GET", ONECLICK_PATHS.status, {
      query: { depositAddress, depositMemo },
    });
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new OneClickResponseError("STATUS_INVALID", "Status response must be an object.");
    }
    const record = data as Record<string, unknown>;
    if (typeof record.status !== "string" || record.status.length === 0) {
      throw new OneClickResponseError("STATUS_INVALID", "Status response is missing its status.");
    }
    if (typeof record.quoteResponse !== "object" || record.quoteResponse === null) {
      throw new OneClickResponseError("STATUS_INVALID", "Status response is missing its quote.");
    }
    return data as ExecutionStatusResponse;
  }

  /** Generate the unsigned NEP-413 intent for a quote deposit address. */
  async generateIntent(request: GenerateIntentRequest): Promise<GenerateIntentResponse> {
    assertNonEmptyString(request.signerId, "signerId", "INVALID_REQUEST");
    assertNonEmptyString(request.depositAddress, "depositAddress", "INVALID_REQUEST");
    if (request.standard !== undefined && request.standard !== "nep413") {
      throw new OneClickValidationError("INVALID_REQUEST", "Only the nep413 standard is supported.");
    }
    const body = {
      type: "swap_transfer" as const,
      standard: "nep413" as const,
      signerId: request.signerId,
      depositAddress: request.depositAddress,
    };
    const data = await this.#send<unknown>("POST", ONECLICK_PATHS.generateIntent, { body });
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new OneClickResponseError("INTENT_INVALID", "Generate-intent response must be an object.");
    }
    const record = data as Record<string, unknown>;
    const intent = parseGeneratedIntent(record.intent);
    if (typeof record.correlationId !== "string" || record.correlationId.length === 0) {
      throw new OneClickResponseError("INTENT_INVALID", "Generate-intent response is missing its correlation id.");
    }
    return { intent, correlationId: record.correlationId };
  }

  /** Submit the signed NEP-413 payload; returns the base58 intent hash. */
  async submitIntent(signedData: Nep413SignedData): Promise<SubmitIntentResponse> {
    validateSignedData(signedData);
    const data = await this.#send<unknown>("POST", ONECLICK_PATHS.submitIntent, {
      body: { type: "swap_transfer", signedData },
    });
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new OneClickResponseError("INTENT_INVALID", "Submit-intent response must be an object.");
    }
    const record = data as Record<string, unknown>;
    if (typeof record.intentHash !== "string" || record.intentHash.length === 0) {
      throw new OneClickResponseError("INTENT_INVALID", "Submit-intent response is missing its intent hash.");
    }
    if (typeof record.correlationId !== "string" || record.correlationId.length === 0) {
      throw new OneClickResponseError("INTENT_INVALID", "Submit-intent response is missing its correlation id.");
    }
    return { intentHash: record.intentHash, correlationId: record.correlationId };
  }

  /** Exchange an empty-intent NEP-413 signature for User-Session tokens. */
  async authenticate(signedData: Nep413SignedData): Promise<AuthenticateResponse> {
    validateSignedData(signedData);
    const data = await this.#send<unknown>("POST", ONECLICK_PATHS.authAuthenticate, {
      body: { signedData },
    });
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new OneClickResponseError("AUTH_INVALID", "Authenticate response must be an object.");
    }
    const record = data as Record<string, unknown>;
    const accessToken = record.accessToken;
    const refreshTokenValue = record.refreshToken;
    const expiresIn = record.expiresIn;
    const refreshExpiresIn = record.refreshExpiresIn;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new OneClickResponseError("AUTH_INVALID", "Authenticate response is missing accessToken.");
    }
    if (typeof refreshTokenValue !== "string" || refreshTokenValue.length === 0) {
      throw new OneClickResponseError("AUTH_INVALID", "Authenticate response is missing refreshToken.");
    }
    if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new OneClickResponseError("AUTH_INVALID", "Authenticate response has an invalid expiresIn.");
    }
    if (
      typeof refreshExpiresIn !== "number" ||
      !Number.isFinite(refreshExpiresIn) ||
      refreshExpiresIn <= 0
    ) {
      throw new OneClickResponseError(
        "AUTH_INVALID",
        "Authenticate response has an invalid refreshExpiresIn.",
      );
    }
    return { accessToken, refreshToken: refreshTokenValue, expiresIn, refreshExpiresIn };
  }

  /** Exchange a refresh token for a new access token. */
  async refresh(refreshToken: string): Promise<RefreshResponse> {
    assertNonEmptyString(refreshToken, "refreshToken", "INVALID_REQUEST");
    const data = await this.#send<unknown>("POST", ONECLICK_PATHS.authRefresh, {
      body: { refreshToken },
    });
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new OneClickResponseError("AUTH_INVALID", "Refresh response must be an object.");
    }
    const record = data as Record<string, unknown>;
    if (typeof record.accessToken !== "string" || record.accessToken.length === 0) {
      throw new OneClickResponseError("AUTH_INVALID", "Refresh response is missing its access token.");
    }
    if (typeof record.expiresIn !== "number" || !Number.isFinite(record.expiresIn) || record.expiresIn <= 0) {
      throw new OneClickResponseError("AUTH_INVALID", "Refresh response has an invalid expiry.");
    }
    return { accessToken: record.accessToken, expiresIn: record.expiresIn };
  }

  /** Private balances for the user proved by the User-Session token. */
  async getBalances(accessToken: string, tokenIds?: readonly string[]): Promise<BalancesResponse> {
    assertNonEmptyString(accessToken, "accessToken", "INVALID_REQUEST");
    if (tokenIds !== undefined && (!Array.isArray(tokenIds) || tokenIds.some((id) => typeof id !== "string"))) {
      throw new OneClickValidationError("INVALID_REQUEST", "tokenIds must be an array of strings.");
    }
    const query =
      tokenIds === undefined || tokenIds.length === 0 ? undefined : { tokenIds: tokenIds.join(",") };
    const data = await this.#send<unknown>("GET", ONECLICK_PATHS.accountBalances, {
      query,
      accessToken,
    });
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new OneClickResponseError("BALANCES_INVALID", "Balances response must be an object.");
    }
    const record = data as Record<string, unknown>;
    if (!Array.isArray(record.balances)) {
      throw new OneClickResponseError("BALANCES_INVALID", "Balances response is missing its list.");
    }
    const balances = record.balances.map((entry, index) => parseBalance(entry, index));
    return { balances };
  }

  /** Confidential history for the user proved by the User-Session token. */
  async getHistory(accessToken: string, query: HistoryQuery = {}): Promise<HistoryResponse> {
    assertNonEmptyString(accessToken, "accessToken", "INVALID_REQUEST");
    const params: Record<string, OneClickQueryValue> = {};
    if (query.prevCursor !== undefined) {
      assertNonEmptyString(query.prevCursor, "prevCursor", "INVALID_REQUEST");
      params.prevCursor = query.prevCursor;
    }
    if (query.nextCursor !== undefined) {
      assertNonEmptyString(query.nextCursor, "nextCursor", "INVALID_REQUEST");
      params.nextCursor = query.nextCursor;
    }
    if (query.status !== undefined) {
      if (!Array.isArray(query.status) || query.status.some((status) => typeof status !== "string")) {
        throw new OneClickValidationError("INVALID_REQUEST", "status must be an array of statuses.");
      }
      params.status = query.status;
    }
    if (query.limit !== undefined) {
      if (!Number.isInteger(query.limit) || query.limit <= 0 || query.limit > 100) {
        throw new OneClickValidationError("INVALID_REQUEST", "limit must be an integer between 1 and 100.");
      }
      params.limit = query.limit;
    }
    const data = await this.#send<unknown>("GET", ONECLICK_PATHS.accountHistory, {
      query: Object.keys(params).length === 0 ? undefined : params,
      accessToken,
    });
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new OneClickResponseError("HISTORY_INVALID", "History response must be an object.");
    }
    const record = data as Record<string, unknown>;
    if (!Array.isArray(record.items)) {
      throw new OneClickResponseError("HISTORY_INVALID", "History response is missing its items.");
    }
    const items = record.items.map((entry, index) => parseHistoryItem(entry, index));
    return {
      items,
      nextCursor: typeof record.nextCursor === "string" ? record.nextCursor : undefined,
      prevCursor: typeof record.prevCursor === "string" ? record.prevCursor : undefined,
    };
  }

  async #send<T>(
    method: OneClickHttpRequest["method"],
    path: string,
    options: {
      query?: Readonly<Record<string, OneClickQueryValue>>;
      body?: unknown;
      accessToken?: string;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (this.#apiKey !== undefined) {
      headers["X-API-Key"] = this.#apiKey;
    }
    if (options.accessToken !== undefined) {
      headers.Authorization = `Bearer ${options.accessToken}`;
    }

    let response: OneClickHttpResponse<T>;
    try {
      response = await this.#transport.request<T>({
        method,
        path,
        query: options.query,
        body: options.body,
        headers,
        timeoutMs: this.#timeoutMs,
      });
    } catch (error) {
      throw new OneClickNetworkError(method, path, transportCode(error));
    }

    if (response.status < 200 || response.status >= 300) {
      const secrets = [this.#apiKey, options.accessToken, ...Object.values(options.query ?? {})].filter(
        (value): value is string => typeof value === "string" && value.length >= 4,
      );
      throw new OneClickApiError(
        response.status,
        method,
        path,
        redactErrorBody(response.data, secrets),
      );
    }
    if (response.data === undefined || response.data === null) {
      throw new OneClickResponseError("MALFORMED_RESPONSE", `1Click ${method} ${path} returned an empty body.`);
    }
    return response.data;
  }
}

/** Validate a quote request before it is sent; no values are echoed on failure. */
export function validateQuoteRequest(request: QuoteRequest): void {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw new OneClickValidationError("INVALID_REQUEST", "Quote request must be an object.");
  }
  const record = request as unknown as Record<string, unknown>;
  if (typeof record.dry !== "boolean") {
    throw new OneClickValidationError("INVALID_REQUEST", "Quote request requires a boolean `dry`.");
  }
  assertEnum(record.swapType, ["EXACT_INPUT", "EXACT_OUTPUT", "FLEX_INPUT", "ANY_INPUT"], "swapType");
  if (
    typeof record.slippageTolerance !== "number" ||
    !Number.isInteger(record.slippageTolerance) ||
    record.slippageTolerance < 0 ||
    record.slippageTolerance > 10_000
  ) {
    throw new OneClickValidationError(
      "INVALID_REQUEST",
      "slippageTolerance must be an integer number of basis points between 0 and 10000.",
    );
  }
  assertIntentsAssetId(record.originAsset, "originAsset");
  assertEnum(record.depositType, ["ORIGIN_CHAIN", "INTENTS", "CONFIDENTIAL_INTENTS"], "depositType");
  assertIntentsAssetId(record.destinationAsset, "destinationAsset");
  assertPositiveAmount(record.amount, "amount");
  assertNonEmptyString(record.refundTo, "refundTo", "INVALID_REQUEST");
  assertEnum(record.refundType, ["ORIGIN_CHAIN", "INTENTS", "CONFIDENTIAL_INTENTS"], "refundType");
  assertNonEmptyString(record.recipient, "recipient", "INVALID_REQUEST");
  assertEnum(
    record.recipientType,
    ["DESTINATION_CHAIN", "INTENTS", "CONFIDENTIAL_INTENTS"],
    "recipientType",
  );
  if (typeof record.deadline !== "string" || !Number.isFinite(Date.parse(record.deadline))) {
    throw new OneClickValidationError("INVALID_DEADLINE", "deadline must be an ISO-8601 timestamp.");
  }
  if (record.confidentiality !== undefined) {
    assertConfidentialityLevel(record.confidentiality);
  }
  if (record.depositMode !== undefined) {
    assertEnum(record.depositMode, ["SIMPLE", "MEMO"], "depositMode");
  }
}

/** Validate `confidentiality` exactly as the schema spells it: lowercase. */
export function assertConfidentialityLevel(value: unknown): asserts value is ConfidentialityLevel {
  if (value !== "public" && value !== "basic" && value !== "advanced") {
    throw new OneClickValidationError(
      "INVALID_CONFIDENTIALITY",
      'confidentiality must be lowercase "public", "basic" or "advanced".',
    );
  }
}

/** Validate an Omni/NEP-141 asset id shape without constructing one. */
export function assertIntentsAssetId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^nep141:[^\s]+$/.test(value) || value.length > 256) {
    throw new OneClickValidationError("INVALID_ASSET_ID", `${field} must be a nep141 asset id.`);
  }
}

/** Validate an unsigned decimal integer string greater than zero. */
export function assertPositiveAmount(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value) || BigInt(value) <= 0n) {
    throw new OneClickValidationError("INVALID_AMOUNT", `${field} must be a positive integer string.`);
  }
}

/** Validate a Nep-413 signed payload before submit/authenticate. */
export function validateSignedData(value: unknown): asserts value is Nep413SignedData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OneClickValidationError("INVALID_INTENT", "Signed intent data must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.standard !== "nep413") {
    throw new OneClickValidationError("INVALID_INTENT", 'Signed intent standard must be "nep413".');
  }
  if (typeof record.payload !== "object" || record.payload === null || Array.isArray(record.payload)) {
    throw new OneClickValidationError("INVALID_INTENT", "Signed intent payload must be an object.");
  }
  const payload = record.payload as Record<string, unknown>;
  assertNonEmptyString(payload.message, "message", "INVALID_INTENT");
  assertNonEmptyString(payload.nonce, "nonce", "INVALID_INTENT");
  assertNonEmptyString(payload.recipient, "recipient", "INVALID_INTENT");
  assertKeyString(record.public_key, "public_key");
  assertKeyString(record.signature, "signature");
}

/**
 * Revalidate a quote response against its request.
 *
 * The response signature is required by the schema but its verification recipe
 * is not public, so it is treated as untrusted. Asset ids, amount, recipient,
 * refund routing and (for wet quotes) the nested deposit address are checked
 * again before any funding step.
 */
export interface QuoteValidationOptions {
  requireDepositAddress?: boolean;
}

export interface ValidatedQuoteResponse {
  quote: Quote;
  /** Secret; never persist outside the private store or log it. */
  depositAddress: string | null;
  signaturePresent: true;
}

export function validateQuoteResponse(
  request: QuoteRequest,
  response: QuoteResponse,
  options: QuoteValidationOptions = {},
): ValidatedQuoteResponse {
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    throw new OneClickResponseError("QUOTE_SHAPE_INVALID", "Quote response must be an object.");
  }
  const record = response as unknown as Record<string, unknown>;
  assertNonEmptyString(record.correlationId, "correlationId", "QUOTE_SHAPE_INVALID");
  assertNonEmptyString(record.timestamp, "timestamp", "QUOTE_SHAPE_INVALID");
  if (typeof record.signature !== "string" || record.signature.length === 0) {
    throw new OneClickResponseError(
      "QUOTE_SIGNATURE_MISSING",
      "Quote response is missing the required service signature.",
    );
  }
  if (typeof record.quoteRequest !== "object" || record.quoteRequest === null) {
    throw new OneClickResponseError("QUOTE_SHAPE_INVALID", "Quote response is missing its request echo.");
  }
  const echoed = record.quoteRequest as Record<string, unknown>;
  const expected = request as unknown as Record<string, unknown>;
  for (const field of [
    "dry",
    "swapType",
    "slippageTolerance",
    "originAsset",
    "depositType",
    "destinationAsset",
    "amount",
    "refundTo",
    "refundType",
    "recipient",
    "recipientType",
  ] as const) {
    if (echoed[field] !== expected[field]) {
      throw new OneClickResponseError(
        "QUOTE_FIELD_MISMATCH",
        `Quote response does not match the request (${field}).`,
      );
    }
  }
  if (Date.parse(String(echoed.deadline)) !== Date.parse(String(expected.deadline))) {
    throw new OneClickResponseError(
      "QUOTE_FIELD_MISMATCH",
      "Quote response does not match the request (deadline).",
    );
  }
  if (
    request.confidentiality !== undefined &&
    echoed.confidentiality !== undefined &&
    echoed.confidentiality !== request.confidentiality
  ) {
    throw new OneClickResponseError(
      "QUOTE_FIELD_MISMATCH",
      "Quote response does not match the request (confidentiality).",
    );
  }

  if (typeof record.quote !== "object" || record.quote === null || Array.isArray(record.quote)) {
    throw new OneClickResponseError("QUOTE_SHAPE_INVALID", "Quote response is missing its quote.");
  }
  const quote = record.quote as Record<string, unknown>;
  assertPositiveAmount(quote.amountOut, "amountOut");
  assertPositiveAmount(quote.minAmountOut, "minAmountOut");
  if (typeof quote.amountIn !== "string" || !/^[0-9]+$/.test(quote.amountIn)) {
    throw new OneClickResponseError("QUOTE_SHAPE_INVALID", "Quote response has an invalid input amount.");
  }
  if (request.swapType === "EXACT_INPUT" && quote.amountIn !== request.amount) {
    throw new OneClickResponseError(
      "QUOTE_AMOUNT_MISMATCH",
      "Quote response input amount differs from the requested amount.",
    );
  }

  const requireAddress = options.requireDepositAddress ?? !request.dry;
  let depositAddress: string | null = null;
  if (requireAddress) {
    if (typeof quote.depositAddress !== "string" || quote.depositAddress.length === 0) {
      throw new OneClickResponseError(
        "QUOTE_DEPOSIT_ADDRESS_MISSING",
        "Quote response is missing quote.depositAddress for a non-dry quote.",
      );
    }
    depositAddress = quote.depositAddress;
  }

  return {
    quote: record.quote as unknown as Quote,
    depositAddress,
    signaturePresent: true,
  };
}

/**
 * Read `quote.depositAddress` (never a top-level field). Dry quotes omit it,
 * so they yield `null` unless `require` is set.
 */
export function readQuoteDepositAddress(
  response: QuoteResponse,
  options: { require: boolean },
): string | null {
  const raw: unknown = response;
  if (typeof raw !== "object" || raw === null || !("quote" in raw)) {
    throw new OneClickResponseError("QUOTE_SHAPE_INVALID", "Quote response must be an object with a quote.");
  }
  const quote = raw.quote;
  if (typeof quote !== "object" || quote === null) {
    throw new OneClickResponseError("QUOTE_SHAPE_INVALID", "Quote response is missing its quote.");
  }
  const address = "depositAddress" in quote ? quote.depositAddress : undefined;
  if (address === undefined || address === null || address === "") {
    if (options.require) {
      throw new OneClickResponseError(
        "QUOTE_DEPOSIT_ADDRESS_MISSING",
        "Quote response is missing quote.depositAddress for a non-dry quote.",
      );
    }
    return null;
  }
  if (typeof address !== "string") {
    throw new OneClickResponseError("QUOTE_SHAPE_INVALID", "quote.depositAddress must be a string.");
  }
  return address;
}

function parseToken(value: unknown, index: number): TokenResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OneClickResponseError("TOKENS_INVALID", `Token entry ${index} is not an object.`);
  }
  const record = value as Record<string, unknown>;
  assertNonEmptyString(record.assetId, "assetId", "TOKENS_INVALID");
  const decimals = record.decimals;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0) {
    throw new OneClickResponseError("TOKENS_INVALID", `Token entry ${index} has invalid decimals.`);
  }
  assertNonEmptyString(record.symbol, "symbol", "TOKENS_INVALID");
  assertNonEmptyString(record.blockchain, "blockchain", "TOKENS_INVALID");
  return {
    assetId: record.assetId,
    decimals,
    blockchain: record.blockchain,
    symbol: record.symbol,
    price: typeof record.price === "number" && Number.isFinite(record.price) ? record.price : 0,
    priceUpdatedAt: typeof record.priceUpdatedAt === "string" ? record.priceUpdatedAt : "",
    contractAddress: typeof record.contractAddress === "string" ? record.contractAddress : undefined,
    coingeckoId: typeof record.coingeckoId === "string" ? record.coingeckoId : undefined,
  };
}

function parseGeneratedIntent(value: unknown): GeneratedIntent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OneClickResponseError("INTENT_INVALID", "Generated intent must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.standard !== "nep413") {
    throw new OneClickResponseError("INTENT_INVALID", "Generated intent is not a NEP-413 payload.");
  }
  if (typeof record.payload !== "object" || record.payload === null || Array.isArray(record.payload)) {
    throw new OneClickResponseError("INTENT_INVALID", "Generated intent payload must be an object.");
  }
  const payload = record.payload as Record<string, unknown>;
  assertNonEmptyString(payload.message, "message", "INTENT_INVALID");
  assertNonEmptyString(payload.nonce, "nonce", "INTENT_INVALID");
  assertNonEmptyString(payload.recipient, "recipient", "INTENT_INVALID");
  return {
    standard: "nep413",
    payload: {
      message: payload.message,
      nonce: payload.nonce,
      recipient: payload.recipient,
      callbackUrl: typeof payload.callbackUrl === "string" ? payload.callbackUrl : undefined,
    },
  };
}

function parseBalance(value: unknown, index: number): BalanceEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OneClickResponseError("BALANCES_INVALID", `Balance entry ${index} is not an object.`);
  }
  const record = value as Record<string, unknown>;
  assertNonEmptyString(record.tokenId, "tokenId", "BALANCES_INVALID");
  if (typeof record.available !== "string" || !/^[0-9]+$/.test(record.available)) {
    throw new OneClickResponseError("BALANCES_INVALID", `Balance entry ${index} has an invalid amount.`);
  }
  assertNonEmptyString(record.source, "source", "BALANCES_INVALID");
  return { tokenId: record.tokenId, available: record.available, source: record.source };
}

function parseHistoryItem(value: unknown, index: number): HistoryItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OneClickResponseError("HISTORY_INVALID", `History item ${index} is not an object.`);
  }
  const record = value as Record<string, unknown>;
  assertNonEmptyString(record.status, "status", "HISTORY_INVALID");
  assertNonEmptyString(record.createdAt, "createdAt", "HISTORY_INVALID");
  assertEnum(record.depositType, ["ORIGIN_CHAIN", "INTENTS", "CONFIDENTIAL_INTENTS"], "depositType");
  assertEnum(
    record.recipientType,
    ["DESTINATION_CHAIN", "INTENTS", "CONFIDENTIAL_INTENTS"],
    "recipientType",
  );
  assertEnum(record.refundType, ["ORIGIN_CHAIN", "INTENTS", "CONFIDENTIAL_INTENTS"], "refundType");
  assertNonEmptyString(record.depositAddress, "depositAddress", "HISTORY_INVALID");
  return {
    status: record.status,
    depositType: record.depositType,
    recipientType: record.recipientType,
    createdAt: record.createdAt,
    depositAddress: record.depositAddress,
    depositMemo: typeof record.depositMemo === "string" ? record.depositMemo : null,
    originAsset: typeof record.originAsset === "string" ? record.originAsset : undefined,
    destinationAsset: typeof record.destinationAsset === "string" ? record.destinationAsset : undefined,
    amountInFormatted:
      typeof record.amountInFormatted === "string" ? record.amountInFormatted : undefined,
    amountOutFormatted:
      typeof record.amountOutFormatted === "string" ? record.amountOutFormatted : undefined,
    amountOutUsd: typeof record.amountOutUsd === "string" ? record.amountOutUsd : undefined,
    recipient: typeof record.recipient === "string" ? record.recipient : undefined,
    refundTo: typeof record.refundTo === "string" ? record.refundTo : undefined,
    refundType: record.refundType,
    refundReason: typeof record.refundReason === "string" ? record.refundReason : null,
  };
}

function assertNonEmptyString(
  value: unknown,
  field: string,
  code: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OneClickValidationError(code, `${field} must be a non-empty string.`);
  }
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new OneClickValidationError("INVALID_REQUEST", `${field} has an unsupported value.`);
  }
}

function assertKeyString(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    !/^(?:ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{16,}$/.test(value)
  ) {
    throw new OneClickValidationError("INVALID_INTENT", `${field} must be a curve-prefixed base58 string.`);
  }
}

function redactErrorBody(value: unknown, secrets: readonly string[]): RedactedErrorBody {
  if (typeof value === "string") {
    return { message: sanitizeErrorText(value, secrets) };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const message = record.message;
  const code = record.code;
  const error = record.error;
  return {
    ...(typeof message === "string" && message.length > 0
      ? { message: sanitizeErrorText(message, secrets) }
      : {}),
    ...(typeof code === "string" && code.length > 0
      ? { code: sanitizeErrorText(code, secrets) }
      : {}),
    ...(typeof error === "string" && error.length > 0
      ? { error: sanitizeErrorText(error, secrets) }
      : {}),
  };
}

function sanitizeErrorText(value: string, secrets: readonly string[]): string {
  let text = value;
  for (const secret of secrets) {
    text = text.split(secret).join("[redacted]");
  }
  return text
    .replace(/\b0x[0-9a-fA-F]{40,}\b/g, "[redacted-address]")
    .replace(/\b[0-9a-fA-F]{64}\b/g, "[redacted-hash]")
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{43,64}\b/g, "[redacted-key]")
    .slice(0, MAX_ERROR_TEXT_LENGTH);
}

function transportCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : undefined;
}
