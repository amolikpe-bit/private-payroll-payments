/**
 * Wallet-backed NEP-413 adapter for `@hot-labs/near-connect` 0.12.0.
 *
 * The connector owns wallet selection and account state; this adapter only
 * exposes the shapes the SDK needs: an `IntentPayloadSigner` for 1Click intent
 * payloads and a small `IWalletAdapter` for session/account plumbing. The
 * payload is passed to the wallet byte-for-byte; the nonce is decoded from
 * base64 but the message, recipient, and callback URL are never rewritten.
 *
 * NEP-413 requires a full-access key. A function-call key (receiver/method
 * scoped) can send contract calls but cannot produce a valid NEP-413
 * signature; the backend must verify the signature and reject FCKs.
 */

import type {
  Account as ConnectorAccount,
  NearConnector,
  NearWalletBase,
  SignMessageParams,
  SignedMessage as WalletSignedMessage,
} from "@hot-labs/near-connect";

import type { SignedIntentMessage } from "../types.js";
import type { Nep413Payload } from "../intents/OneClickClient.js";
import {
  decodeIntentPayload,
  type IntentPayloadSigner,
} from "../intents/signer.js";

export type WalletSignerErrorCode =
  | "NOT_CONNECTED"
  | "CONNECT_FAILED"
  | "SIGNING_FAILED"
  | "ACCOUNT_MISMATCH"
  | "INVALID_SIGNATURE";

export class WalletSignerError extends Error {
  readonly code: WalletSignerErrorCode;

  constructor(code: WalletSignerErrorCode, message: string) {
    super(message);
    this.name = "WalletSignerError";
    this.code = code;
  }
}

/** Account shape returned by the connector after sign-in. */
export interface WalletAccountInfo {
  accountId: string;
  publicKey?: string;
}

/** Parameters for a NEP-413 `signMessage` request. */
export interface WalletSignMessageParams {
  message: string;
  recipient: string;
  nonce: Uint8Array;
  signerId?: string;
}

/** Wallet session returned by `NearConnector.getConnectedWallet()`. */
export interface ConnectedWallet {
  wallet: NearWalletBase;
  accounts: ConnectorAccount[];
}

/**
 * Minimal wallet adapter surface kept from the origin SDK. Concrete wallets
 * are supplied by `NearConnector`; nothing here imports a wallet library.
 */
export interface IWalletAdapter {
  readonly walletId: string;
  connect(walletId?: string): Promise<WalletAccountInfo[]>;
  disconnect(): Promise<void>;
  getAccounts(): Promise<WalletAccountInfo[]>;
  signMessage(params: WalletSignMessageParams): Promise<SignedIntentMessage>;
}

export interface NearWalletSignerOptions {
  /** Connector instance (browser or a caller-provided implementation). */
  connector: NearConnector;
  /** Network the selected account must belong to. Defaults to testnet. */
  network?: "mainnet" | "testnet";
  /** Preferred account; otherwise the wallet's first account is used. */
  signerId?: string;
  /** Pre-connected wallet, mainly for tests or restored sessions. */
  wallet?: NearWalletBase;
}

const NONCE_BYTES = 32;
const CURVE_PREFIX = /^(ed25519|secp256k1):/;
const BASE58_BODY = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Adapts a near-connect wallet to the SDK's NEP-413 signer contracts.
 *
 * `connect()` is explicit so no wallet prompt happens at construction time.
 * Once connected, `signPayload()` only prompts for the signature itself.
 */
export class NearWalletSigner implements IntentPayloadSigner, IWalletAdapter {
  readonly #connector: NearConnector;
  readonly #network: "mainnet" | "testnet";
  readonly #configuredSignerId: string | undefined;
  #wallet: NearWalletBase | undefined;
  #signerId: string | undefined;
  #publicKey: string | undefined;

  constructor(options: NearWalletSignerOptions) {
    if (typeof options !== "object" || options === null) {
      throw new WalletSignerError("NOT_CONNECTED", "NearWalletSigner options are required.");
    }
    if (options.connector === undefined || options.connector === null) {
      throw new WalletSignerError("NOT_CONNECTED", "NearWalletSigner requires a near-connect connector.");
    }
    this.#connector = options.connector;
    this.#network = options.network ?? "testnet";
    this.#configuredSignerId = options.signerId;
    this.#wallet = options.wallet;
    if (options.signerId !== undefined && options.signerId.trim().length === 0) {
      throw new WalletSignerError("NOT_CONNECTED", "signerId must be a non-empty account id.");
    }
  }

  /** Wallet manifest id, or `unconnected` before `connect()`. */
  get walletId(): string {
    return this.#wallet?.manifest?.id ?? "unconnected";
  }

  /** Connected account id; throws before `connect()` or `restore()`. */
  get signerId(): string {
    const signerId = this.#signerId;
    if (signerId === undefined) {
      throw new WalletSignerError("NOT_CONNECTED", "Call connect() before using the wallet signer.");
    }
    return signerId;
  }

  /** True once an account has been selected. */
  get connected(): boolean {
    return this.#signerId !== undefined;
  }

  /** Connect or reuse the already-connected wallet and select an account. */
  async connect(walletId?: string): Promise<WalletAccountInfo[]> {
    let wallet = this.#wallet;
    if (wallet === undefined) {
      try {
        wallet = await this.#connector.connect(
          walletId === undefined ? undefined : { walletId },
        );
      } catch {
        throw new WalletSignerError("CONNECT_FAILED", "The wallet connection was rejected or failed.");
      }
    }
    if (wallet === undefined || wallet === null) {
      throw new WalletSignerError("CONNECT_FAILED", "The connector returned no wallet.");
    }
    this.#wallet = wallet;
    const accounts = await this.getAccounts();
    if (accounts.length === 0) {
      throw new WalletSignerError("NOT_CONNECTED", "The wallet returned no accounts.");
    }
    const selected = this.#selectAccount(accounts);
    this.#signerId = selected.accountId;
    this.#publicKey = selected.publicKey;
    return accounts;
  }

  /** Restore a wallet session already persisted by the connector. */
  async restore(): Promise<WalletAccountInfo[]> {
    if (this.#wallet !== undefined) {
      return this.connect();
    }
    let connected: ConnectedWallet;
    try {
      connected = await this.#connector.getConnectedWallet();
    } catch {
      throw new WalletSignerError("NOT_CONNECTED", "No restored wallet session is available.");
    }
    if (connected.wallet === undefined || connected.wallet === null) {
      throw new WalletSignerError("NOT_CONNECTED", "No restored wallet session is available.");
    }
    this.#wallet = connected.wallet;
    return this.connect();
  }

  async disconnect(): Promise<void> {
    const wallet = this.#wallet;
    this.#wallet = undefined;
    this.#signerId = undefined;
    this.#publicKey = undefined;
    if (wallet === undefined) {
      return;
    }
    try {
      await wallet.signOut({ network: this.#network });
    } catch {
      // Signing out is best-effort; local state is already cleared.
    }
  }

  async getAccounts(): Promise<WalletAccountInfo[]> {
    const wallet = this.#wallet;
    if (wallet === undefined) {
      throw new WalletSignerError("NOT_CONNECTED", "Call connect() before reading accounts.");
    }
    let accounts: readonly ConnectorAccount[];
    try {
      accounts = await wallet.getAccounts({ network: this.#network });
    } catch {
      throw new WalletSignerError("NOT_CONNECTED", "The wallet account list is unavailable.");
    }
    return accounts.map((account) => ({
      accountId: account.accountId,
      ...(account.publicKey === undefined ? {} : { publicKey: account.publicKey }),
    }));
  }

  /** Public key of the selected account, when the wallet reports one. */
  async getPublicKey(): Promise<string> {
    if (this.#publicKey !== undefined) {
      return this.#publicKey;
    }
    const accounts = await this.getAccounts();
    const selected = this.#selectAccount(accounts);
    const publicKey = selected.publicKey;
    if (publicKey === undefined) {
      throw new WalletSignerError(
        "SIGNING_FAILED",
        "The wallet did not report a public key for the selected account.",
      );
    }
    this.#signerId = selected.accountId;
    this.#publicKey = publicKey;
    return publicKey;
  }

  /**
   * Ask the wallet to sign one NEP-413 message. The returned strings are
   * curve-prefixed; a missing prefix is filled from the public key curve.
   */
  async signMessage(params: WalletSignMessageParams): Promise<SignedIntentMessage> {
    const wallet = this.#requireWallet();
    const activeSignerId = this.#signerId;
    if (activeSignerId === undefined) {
      throw new WalletSignerError("NOT_CONNECTED", "Call connect() before signing.");
    }
    const signerId = params.signerId ?? activeSignerId;
    if (signerId !== activeSignerId) {
      throw new WalletSignerError(
        "ACCOUNT_MISMATCH",
        "signerId must match the wallet account selected by connect().",
      );
    }
    if (typeof params.message !== "string" || params.message.length === 0) {
      throw new WalletSignerError("INVALID_SIGNATURE", "Message must be a non-empty string.");
    }
    if (typeof params.recipient !== "string" || params.recipient.trim().length === 0) {
      throw new WalletSignerError("INVALID_SIGNATURE", "Recipient must be a non-empty account id.");
    }
    if (!(params.nonce instanceof Uint8Array) || params.nonce.length !== NONCE_BYTES) {
      throw new WalletSignerError("INVALID_SIGNATURE", "Nonce must be 32 bytes.");
    }

    let signed: WalletSignedMessage;
    try {
      signed = await wallet.signMessage({
        message: params.message,
        recipient: params.recipient,
        nonce: params.nonce,
        network: this.#network,
        signerId: activeSignerId,
      } satisfies SignMessageParams);
    } catch {
      throw new WalletSignerError("SIGNING_FAILED", "The wallet rejected or failed the signature request.");
    }
    if (signed.accountId !== activeSignerId) {
      throw new WalletSignerError("ACCOUNT_MISMATCH", "The wallet signed with a different account.");
    }
    const publicKey = this.#requireCurvePrefixed(signed.publicKey, "public key");
    const curve = publicKey.slice(0, publicKey.indexOf(":"));
    const signature = this.#normalizeSignature(signed.signature, curve);
    this.#publicKey = publicKey;
    return { publicKey, signature };
  }

  /** Sign the exact 1Click intent payload and return the wire signature. */
  async signPayload(payload: Nep413Payload): Promise<SignedIntentMessage> {
    const decoded = decodeIntentPayload(payload);
    return this.signMessage({
      message: decoded.message,
      recipient: decoded.recipient,
      nonce: decoded.nonce,
      signerId: this.signerId,
    });
  }

  #requireWallet(): NearWalletBase {
    const wallet = this.#wallet;
    if (wallet === undefined || this.#signerId === undefined) {
      throw new WalletSignerError("NOT_CONNECTED", "Call connect() before signing.");
    }
    return wallet;
  }

  #selectAccount(accounts: readonly WalletAccountInfo[]): WalletAccountInfo {
    const configured = this.#configuredSignerId;
    if (configured !== undefined) {
      const match = accounts.find((account) => account.accountId === configured);
      if (match === undefined) {
        throw new WalletSignerError(
          "ACCOUNT_MISMATCH",
          "The configured signer account is not available in the connected wallet.",
        );
      }
      return match;
    }
    return accounts[0];
  }

  #requireCurvePrefixed(value: unknown, field: string): string {
    if (typeof value !== "string" || !CURVE_PREFIX.test(value)) {
      throw new WalletSignerError("INVALID_SIGNATURE", `The wallet returned an invalid ${field}.`);
    }
    const body = value.slice(value.indexOf(":") + 1);
    if (!BASE58_BODY.test(body)) {
      throw new WalletSignerError("INVALID_SIGNATURE", `The wallet returned an invalid ${field}.`);
    }
    return value;
  }

  #normalizeSignature(value: unknown, curve: string): string {
    if (typeof value !== "string" || value.length === 0) {
      throw new WalletSignerError("INVALID_SIGNATURE", "The wallet returned an empty signature.");
    }
    const prefixed = CURVE_PREFIX.test(value) ? value : `${curve}:${value}`;
    const signatureCurve = prefixed.slice(0, prefixed.indexOf(":"));
    if (signatureCurve !== curve) {
      throw new WalletSignerError(
        "INVALID_SIGNATURE",
        "The signature curve does not match the public key curve.",
      );
    }
    const body = prefixed.slice(prefixed.indexOf(":") + 1);
    if (!BASE58_BODY.test(body)) {
      throw new WalletSignerError("INVALID_SIGNATURE", "The wallet returned an invalid signature.");
    }
    return prefixed;
  }
}
