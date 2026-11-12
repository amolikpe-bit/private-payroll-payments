/**
 * 1Click User-Session client for confidential account reads.
 *
 * Ownership is proved by signing an empty intent (`"intents": []`) with
 * NEP-413 and exchanging it for User-Session tokens. Balances and history are
 * owner-only; history is invite-only and may return 403. When the live read is
 * unavailable the client falls back to locally stored private receipts, which
 * are explicitly labelled as non-authoritative.
 *
 * Tokens and the signing key never leave this module: only expiries are
 * returned to callers.
 */

import { randomFillSync } from "node:crypto";

import { PrivateStore } from "../store/PrivateStore.js";
import {
  OneClickApiError,
  OneClickNetworkError,
  INTENTS_ACCOUNT_ID,
  type HistoryQuery,
  type OneClickClient,
} from "./OneClickClient.js";
import type { IntentPayloadSigner } from "./signer.js";

/**
 * 1Click's production versioned-nonce salt (`e110f317`), loaded from
 * `intents.near` by the official SDK. Overridable for a different verifier.
 */
export const DEFAULT_INTENTS_NONCE_SALT_HEX = "e110f317";

const VERSIONED_NONCE_MAGIC = Uint8Array.of(86, 40, 246, 198);
const VERSIONED_NONCE_VERSION = 0;
const VERSIONED_NONCE_BYTES = 32;
const NONCE_RANDOM_BYTES = 7;
const DEFAULT_AUTH_DEADLINE_MS = 5 * 60_000;
const DEFAULT_REFRESH_SKEW_MS = 60_000;

export interface VersionedNonceOptions {
  /** Deadline embedded in the nonce and in the signed empty intent. */
  deadline: Date;
  /** Current time written into the first eight nonce bytes. */
  startTime?: Date;
  /** Four-byte salt as 8 hex characters. */
  saltHex?: string;
  /** Seven random bytes; injected for deterministic tests. */
  randomBytes?: Uint8Array;
}

/**
 * Encode a 1Click versioned nonce:
 * magic(4) || version(1) || salt(4) || deadline u64 LE (ns) || nonce[8B time + 7B random].
 */
export function buildVersionedNonce(options: VersionedNonceOptions): string {
  if (typeof options !== "object" || options === null) {
    throw new UserSessionError("INVALID_NONCE", "Versioned nonce options must be an object.");
  }
  const deadline = options.deadline;
  if (!(deadline instanceof Date) || !Number.isFinite(deadline.getTime())) {
    throw new UserSessionError("INVALID_NONCE", "Versioned nonce deadline must be a valid date.");
  }
  const startTime = options.startTime ?? new Date();
  if (!(startTime instanceof Date) || !Number.isFinite(startTime.getTime())) {
    throw new UserSessionError("INVALID_NONCE", "Versioned nonce start time must be a valid date.");
  }
  if (deadline.getTime() <= startTime.getTime()) {
    throw new UserSessionError("INVALID_NONCE", "Versioned nonce deadline must be in the future.");
  }
  const saltHex = options.saltHex ?? DEFAULT_INTENTS_NONCE_SALT_HEX;
  if (!/^[0-9a-fA-F]{8}$/.test(saltHex)) {
    throw new UserSessionError("INVALID_NONCE", "Versioned nonce salt must be four bytes of hex.");
  }
  const salt = Uint8Array.from([
    Number.parseInt(saltHex.slice(0, 2), 16),
    Number.parseInt(saltHex.slice(2, 4), 16),
    Number.parseInt(saltHex.slice(4, 6), 16),
    Number.parseInt(saltHex.slice(6, 8), 16),
  ]);

  const nonceBytes =
    options.randomBytes === undefined
      ? Uint8Array.from(randomFillSync(new Uint8Array(NONCE_RANDOM_BYTES)))
      : options.randomBytes;
  if (nonceBytes.length !== NONCE_RANDOM_BYTES) {
    throw new UserSessionError("INVALID_NONCE", "Versioned nonce requires seven random bytes.");
  }

  const out = new Uint8Array(VERSIONED_NONCE_BYTES);
  out.set(VERSIONED_NONCE_MAGIC, 0);
  out[4] = VERSIONED_NONCE_VERSION;
  out.set(salt, 5);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setBigUint64(9, BigInt(deadline.getTime()) * 1_000_000n, true);
  view.setBigInt64(17, BigInt(startTime.getTime()) * 1_000_000n, true);
  out.set(nonceBytes, 25);
  return Buffer.from(out).toString("base64");
}

/** Canonical empty-intent message signed for User-Session authentication. */
export function emptyIntentMessage(signerId: string, deadline: Date): string {
  if (typeof signerId !== "string" || signerId.trim().length === 0) {
    throw new UserSessionError("INVALID_NONCE", "Signer id is required for an empty intent.");
  }
  if (!(deadline instanceof Date) || !Number.isFinite(deadline.getTime())) {
    throw new UserSessionError("INVALID_NONCE", "Empty-intent deadline must be a valid date.");
  }
  return JSON.stringify({
    deadline: deadline.toISOString(),
    intents: [],
    signer_id: signerId,
  });
}

export type UserSessionErrorCode =
  | "NOT_AUTHENTICATED"
  | "SESSION_EXPIRED"
  | "INVALID_NONCE"
  | "INVALID_AUTH_RESPONSE";

export class UserSessionError extends Error {
  readonly code: UserSessionErrorCode;

  constructor(code: UserSessionErrorCode, message: string) {
    super(message);
    this.name = "UserSessionError";
    this.code = code;
  }
}

export interface UserSessionOptions {
  store?: PrivateStore;
  clock?: () => Date;
  saltHex?: string;
  authDeadlineMs?: number;
  refreshSkewMs?: number;
}

export interface UserSessionBalances {
  balances: Array<{ tokenId: string; available: string; source: string }>;
  source: "remote" | "local-receipts";
  degraded: boolean;
  notice?: string;
}

export interface UserSessionHistoryItem {
  status: string;
  createdAt: string;
  originAsset?: string;
  destinationAsset?: string;
  recipient?: string;
  amount?: string;
  intentHash?: string;
  source: "remote" | "local-receipts";
}

export interface UserSessionHistory {
  items: UserSessionHistoryItem[];
  nextCursor?: string;
  prevCursor?: string;
  source: "remote" | "local-receipts";
  degraded: boolean;
  notice?: string;
}

export interface UserSessionStatus {
  authenticated: boolean;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
}

interface SessionState {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

const LOCAL_FALLBACK_NOTICE =
  "Live confidential account reads are unavailable (403 or network failure). " +
  "Showing locally stored receipts only; these values are not an authoritative balance.";

/**
 * Owner-scoped confidential account reads. One instance per signed-in user;
 * `authenticate()` triggers the wallet signature once, then `refresh()` keeps
 * the User-Session alive without re-signing.
 */
export class UserSession {
  readonly #client: OneClickClient;
  readonly #signer: IntentPayloadSigner;
  readonly #store: PrivateStore;
  readonly #clock: () => Date;
  readonly #saltHex: string;
  readonly #authDeadlineMs: number;
  readonly #refreshSkewMs: number;
  #session: SessionState | null = null;

  constructor(
    client: OneClickClient,
    signer: IntentPayloadSigner,
    options: UserSessionOptions = {},
  ) {
    this.#client = client;
    this.#signer = signer;
    this.#store = options.store ?? new PrivateStore();
    this.#clock = options.clock ?? (() => new Date());
    this.#saltHex = options.saltHex ?? DEFAULT_INTENTS_NONCE_SALT_HEX;
    this.#authDeadlineMs = options.authDeadlineMs ?? DEFAULT_AUTH_DEADLINE_MS;
    this.#refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    if (!Number.isFinite(this.#authDeadlineMs) || this.#authDeadlineMs <= 0) {
      throw new UserSessionError("INVALID_NONCE", "Authentication deadline must be positive.");
    }
    if (!Number.isFinite(this.#refreshSkewMs) || this.#refreshSkewMs < 0) {
      throw new UserSessionError("INVALID_NONCE", "Refresh skew must be non-negative.");
    }
  }

  get signerId(): string {
    return this.#signer.signerId;
  }

  get status(): UserSessionStatus {
    const session = this.#session;
    return {
      authenticated: session !== null && this.#nowMs() < session.refreshExpiresAt,
      accessTokenExpiresAt:
        session === null ? null : new Date(session.accessExpiresAt).toISOString(),
      refreshTokenExpiresAt:
        session === null ? null : new Date(session.refreshExpiresAt).toISOString(),
    };
  }

  /** Sign the empty intent and exchange it for User-Session tokens. */
  async authenticate(): Promise<UserSessionStatus> {
    await this.#authenticate();
    return this.status;
  }

  /** Rotate the access token without another wallet signature. */
  async refresh(): Promise<UserSessionStatus> {
    await this.#refreshSession();
    return this.status;
  }

  /** Private balances, falling back to local receipts on 403/network failure. */
  async getBalances(tokenIds?: readonly string[]): Promise<UserSessionBalances> {
    try {
      const response = await this.#withAccess((token) => this.#client.getBalances(token, tokenIds));
      return {
        balances: response.balances.map((entry) => ({
          tokenId: entry.tokenId,
          available: entry.available,
          source: entry.source,
        })),
        source: "remote",
        degraded: false,
      };
    } catch (error) {
      if (!(error instanceof OneClickNetworkError) && !(error instanceof OneClickApiError && error.status === 403)) {
        throw error;
      }
      return this.#localBalances();
    }
  }

  /** Confidential history, falling back to local receipts on 403/network failure. */
  async getHistory(query: HistoryQuery = {}): Promise<UserSessionHistory> {
    try {
      const response = await this.#withAccess((token) => this.#client.getHistory(token, query));
      return {
        items: response.items.map((item) => ({
          status: item.status,
          createdAt: item.createdAt,
          originAsset: item.originAsset,
          destinationAsset: item.destinationAsset,
          recipient: item.recipient,
          amount: item.amountOutFormatted,
          source: "remote" as const,
        })),
        nextCursor: response.nextCursor,
        prevCursor: response.prevCursor,
        source: "remote",
        degraded: false,
      };
    } catch (error) {
      if (!(error instanceof OneClickNetworkError) && !(error instanceof OneClickApiError && error.status === 403)) {
        throw error;
      }
      return this.#localHistory(query);
    }
  }

  async #authenticate(): Promise<string> {
    const now = this.#clock();
    const deadline = new Date(now.getTime() + this.#authDeadlineMs);
    const nonce = buildVersionedNonce({
      deadline,
      startTime: now,
      saltHex: this.#saltHex,
    });
    const message = emptyIntentMessage(this.#signer.signerId, deadline);
    const signed = await this.#signer.signPayload({
      message,
      nonce,
      recipient: INTENTS_ACCOUNT_ID,
    });
    const response = await this.#client.authenticate({
      standard: "nep413",
      payload: { message, nonce, recipient: INTENTS_ACCOUNT_ID },
      public_key: signed.publicKey,
      signature: signed.signature,
    });
    if (
      typeof response.accessToken !== "string" ||
      typeof response.refreshToken !== "string" ||
      !Number.isFinite(response.expiresIn) ||
      !Number.isFinite(response.refreshExpiresIn)
    ) {
      throw new UserSessionError("INVALID_AUTH_RESPONSE", "User-Session response is incomplete.");
    }
    const base = this.#nowMs();
    this.#session = {
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      accessExpiresAt: base + response.expiresIn * 1000,
      refreshExpiresAt: base + response.refreshExpiresIn * 1000,
    };
    return response.accessToken;
  }

  async #refreshSession(): Promise<string> {
    const session = this.#session;
    if (session === null) {
      throw new UserSessionError("NOT_AUTHENTICATED", "Call authenticate() before refreshing.");
    }
    if (this.#nowMs() >= session.refreshExpiresAt) {
      throw new UserSessionError("SESSION_EXPIRED", "The User-Session refresh token has expired.");
    }
    const response = await this.#client.refresh(session.refreshToken);
    session.accessToken = response.accessToken;
    session.accessExpiresAt = this.#nowMs() + response.expiresIn * 1000;
    return session.accessToken;
  }

  async #ensureAccessToken(): Promise<string> {
    const session = this.#session;
    if (session === null) {
      return this.#authenticate();
    }
    if (this.#nowMs() >= session.accessExpiresAt - this.#refreshSkewMs) {
      if (this.#nowMs() < session.refreshExpiresAt) {
        return this.#refreshSession();
      }
      return this.#authenticate();
    }
    return session.accessToken;
  }

  async #withAccess<T>(operation: (accessToken: string) => Promise<T>): Promise<T> {
    const token = await this.#ensureAccessToken();
    try {
      return await operation(token);
    } catch (error) {
      if (!(error instanceof OneClickApiError) || error.status !== 401) {
        throw error;
      }
      const session = this.#session;
      const refreshed =
        session !== null && this.#nowMs() < session.refreshExpiresAt
          ? await this.#refreshSession()
          : await this.#authenticate();
      return operation(refreshed);
    }
  }

  async #localBalances(): Promise<UserSessionBalances> {
    const account = this.#signer.signerId;
    const receipts = (await this.#store.listReceipts()).filter(
      (receipt) => receipt.employer === account || receipt.employee === account,
    );
    const totals = new Map<string, bigint>();
    for (const receipt of receipts) {
      if (receipt.status.toUpperCase() !== "SUCCESS") {
        continue;
      }
      totals.set(receipt.asset, (totals.get(receipt.asset) ?? 0n) + BigInt(receipt.amount));
    }
    const balances = [...totals.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([tokenId, available]) => ({
        tokenId,
        available: available.toString(),
        source: "local-receipts",
      }));
    return {
      balances,
      source: "local-receipts",
      degraded: true,
      notice: LOCAL_FALLBACK_NOTICE,
    };
  }

  async #localHistory(query: HistoryQuery): Promise<UserSessionHistory> {
    const account = this.#signer.signerId;
    const receipts = (await this.#store.listReceipts()).filter(
      (receipt) => receipt.employer === account || receipt.employee === account,
    );
    const wanted = query.status === undefined ? null : new Set(query.status.map((status) => status.toUpperCase()));
    const filtered = receipts
      .filter((receipt) => wanted === null || wanted.has(receipt.status.toUpperCase()))
      .slice(0, query.limit ?? receipts.length)
      .map((receipt): UserSessionHistoryItem => ({
        status: receipt.status,
        createdAt: receipt.createdAt,
        originAsset: receipt.asset,
        destinationAsset: receipt.asset,
        recipient: receipt.employee,
        amount: receipt.amount,
        ...(receipt.intentHash === null ? {} : { intentHash: receipt.intentHash }),
        source: "local-receipts",
      }));
    return {
      items: filtered,
      source: "local-receipts",
      degraded: true,
      notice: LOCAL_FALLBACK_NOTICE,
    };
  }

  #nowMs(): number {
    const now = this.#clock();
    const milliseconds = now.getTime();
    if (!Number.isFinite(milliseconds)) {
      throw new UserSessionError("INVALID_NONCE", "Clock returned an invalid date.");
    }
    return milliseconds;
  }
}
