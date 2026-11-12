/**
 * Backend-side NEP-413 authentication.
 *
 * A wallet signs an application challenge with `signMessage`; the backend
 * verifies the signature with `verifyMessage` from `near-api-js/nep413`,
 * which checks both the signature and the signing key's on-chain permission.
 * Function-call keys are rejected explicitly: NEP-413 is a message signature,
 * and a receiver/method-scoped key can never authorize it. The access key is
 * read up front so that failure is a stable `FULL_ACCESS_KEY_REQUIRED` code
 * instead of an opaque RPC error.
 *
 * The verifier also enforces the expected recipient, an optional expected
 * challenge message, and one-time nonce consumption. Error messages never echo
 * the signature, nonce, access key, or RPC payload.
 */

import { JsonRpcProvider, baseDecode, type Provider } from "near-api-js";
import { verifyMessage } from "near-api-js/nep413";

import { NEP413_FULL_ACCESS_GUIDANCE } from "./signer.js";

export type BackendAuthErrorCode =
  | "INVALID_REQUEST"
  | "EXPECTED_MESSAGE_MISMATCH"
  | "RECIPIENT_MISMATCH"
  | "INVALID_NONCE"
  | "INVALID_SIGNATURE_FORMAT"
  | "ACCESS_KEY_LOOKUP_FAILED"
  | "FULL_ACCESS_KEY_REQUIRED"
  | "SIGNATURE_INVALID"
  | "NONCE_REPLAYED";

export class BackendAuthError extends Error {
  readonly code: BackendAuthErrorCode;

  constructor(code: BackendAuthErrorCode, message: string) {
    super(message);
    this.name = "BackendAuthError";
    this.code = code;
  }
}

/** One wallet `signMessage` result plus the challenge it answers. */
export interface BackendAuthRequest {
  signerAccountId: string;
  /** Curve-prefixed public key, e.g. `ed25519:…`. */
  publicKey: string;
  /** Exact message the wallet signed. */
  message: string;
  /** Exact recipient the wallet signed for. */
  recipient: string;
  /** Base64 NEP-413 nonce (32 bytes). */
  nonce: string;
  /** Curve-prefixed base58 signature, e.g. `ed25519:…`. */
  signature: string;
  callbackUrl?: string;
}

export interface BackendAuthResult {
  signerAccountId: string;
  publicKey: string;
}

/** One-time nonce store. Return false when the nonce was already used. */
export interface BackendAuthNonceStore {
  consume(key: string): boolean | Promise<boolean>;
}

export interface InMemoryNonceStoreOptions {
  /** How long a consumed nonce is remembered. Defaults to 10 minutes. */
  ttlMs?: number;
  /** Cap on retained nonces; oldest entries are evicted first. */
  maxEntries?: number;
  now?: () => number;
}

/**
 * Process-local replay guard. Multi-instance deployments must supply a shared
 * `BackendAuthNonceStore`; this class only covers a single process.
 */
export class InMemoryNonceStore implements BackendAuthNonceStore {
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #seen = new Map<string, number>();

  constructor(options: InMemoryNonceStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 10 * 60_000;
    this.#maxEntries = options.maxEntries ?? 100_000;
    this.#now = options.now ?? Date.now;
    if (!Number.isFinite(this.#ttlMs) || this.#ttlMs <= 0) {
      throw new BackendAuthError("INVALID_REQUEST", "Nonce TTL must be positive.");
    }
    if (!Number.isInteger(this.#maxEntries) || this.#maxEntries <= 0) {
      throw new BackendAuthError("INVALID_REQUEST", "Nonce store size must be a positive integer.");
    }
  }

  consume(key: string): boolean {
    const now = this.#now();
    this.#prune(now);
    if (this.#seen.has(key)) {
      return false;
    }
    this.#seen.set(key, now + this.#ttlMs);
    if (this.#seen.size > this.#maxEntries) {
      const oldest = this.#seen.keys().next();
      if (!oldest.done) {
        this.#seen.delete(oldest.value);
      }
    }
    return true;
  }

  #prune(now: number): void {
    for (const [key, expiresAt] of this.#seen) {
      if (expiresAt <= now) {
        this.#seen.delete(key);
      }
    }
  }
}

export interface BackendAuthVerifierOptions {
  /** Recipient the challenge was issued for, e.g. `subrosa.testnet`. */
  recipient: string;
  /** RPC URL used when no provider is injected. */
  rpcUrl?: string;
  /** Injected provider, mainly for tests or a shared RPC pool. */
  provider?: Provider;
  /** Exact challenge text; when set, any other message is rejected. */
  expectedMessage?: string;
  /** Replay protection; defaults to a process-local in-memory store. */
  nonceStore?: BackendAuthNonceStore;
}

const CURVE_PREFIX = /^(ed25519|secp256k1):/;
const BASE58_BODY = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const NONCE_BYTES = 32;
const MAX_MESSAGE_LENGTH = 16_384;

function assertRequest(value: unknown): asserts value is BackendAuthRequest {
  if (typeof value !== "object" || value === null) {
    throw new BackendAuthError("INVALID_REQUEST", "Authentication request must be an object.");
  }
  const record = value as Record<string, unknown>;
  for (const field of ["signerAccountId", "publicKey", "message", "recipient", "nonce", "signature"] as const) {
    if (typeof record[field] !== "string" || record[field].length === 0) {
      throw new BackendAuthError("INVALID_REQUEST", `Authentication request is missing ${field}.`);
    }
  }
  const message = record.message;
  if (typeof message !== "string") {
    throw new BackendAuthError("INVALID_REQUEST", "Authentication request is missing message.");
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new BackendAuthError("INVALID_REQUEST", "Authentication message is too long.");
  }
}

function decodeNonce(value: string): Uint8Array {
  if (!BASE64.test(value)) {
    throw new BackendAuthError("INVALID_NONCE", "Nonce must be base64.");
  }
  const nonce = Buffer.from(value, "base64");
  if (nonce.length !== NONCE_BYTES) {
    throw new BackendAuthError("INVALID_NONCE", "Nonce must decode to 32 bytes.");
  }
  return nonce;
}

function decodeSignature(value: string): { curve: string; signature: Uint8Array } {
  if (!CURVE_PREFIX.test(value)) {
    throw new BackendAuthError(
      "INVALID_SIGNATURE_FORMAT",
      "Signature must be curve-prefixed (ed25519: or secp256k1:).",
    );
  }
  const separator = value.indexOf(":");
  const curve = value.slice(0, separator);
  const body = value.slice(separator + 1);
  if (!BASE58_BODY.test(body)) {
    throw new BackendAuthError("INVALID_SIGNATURE_FORMAT", "Signature must be base58.");
  }
  let signature: Uint8Array;
  try {
    signature = baseDecode(body);
  } catch {
    throw new BackendAuthError("INVALID_SIGNATURE_FORMAT", "Signature must be base58.");
  }
  if (signature.length !== 64) {
    throw new BackendAuthError("INVALID_SIGNATURE_FORMAT", "Signature has an invalid length.");
  }
  return { curve, signature };
}

function assertPublicKey(value: string): void {
  if (!CURVE_PREFIX.test(value)) {
    throw new BackendAuthError(
      "INVALID_SIGNATURE_FORMAT",
      "Public key must be curve-prefixed (ed25519: or secp256k1:).",
    );
  }
  const body = value.slice(value.indexOf(":") + 1);
  if (!BASE58_BODY.test(body)) {
    throw new BackendAuthError("INVALID_SIGNATURE_FORMAT", "Public key must be base58.");
  }
}

/** Verify wallet NEP-413 challenges and return the authenticated account. */
export class BackendAuthVerifier {
  readonly #recipient: string;
  readonly #provider: Provider;
  readonly #expectedMessage: string | undefined;
  readonly #nonceStore: BackendAuthNonceStore;

  constructor(options: BackendAuthVerifierOptions) {
    if (typeof options !== "object" || options === null) {
      throw new BackendAuthError("INVALID_REQUEST", "BackendAuthVerifier options are required.");
    }
    if (typeof options.recipient !== "string" || options.recipient.trim().length === 0) {
      throw new BackendAuthError("INVALID_REQUEST", "A challenge recipient is required.");
    }
    this.#recipient = options.recipient;
    this.#expectedMessage = options.expectedMessage;
    this.#nonceStore = options.nonceStore ?? new InMemoryNonceStore();
    this.#provider =
      options.provider ??
      new JsonRpcProvider({ url: options.rpcUrl ?? "https://rpc.testnet.near.org" });
  }

  /**
   * Verify a wallet challenge. Rejects FCK-signed requests, wrong recipients,
   * mismatched challenge text, and replayed nonces before accepting.
   */
  async verify(request: BackendAuthRequest): Promise<BackendAuthResult> {
    assertRequest(request);
    if (request.recipient !== this.#recipient) {
      throw new BackendAuthError(
        "RECIPIENT_MISMATCH",
        "Authentication message was signed for a different recipient.",
      );
    }
    if (this.#expectedMessage !== undefined && request.message !== this.#expectedMessage) {
      throw new BackendAuthError(
        "EXPECTED_MESSAGE_MISMATCH",
        "Authentication message does not match the issued challenge.",
      );
    }
    assertPublicKey(request.publicKey);
    const { signature } = decodeSignature(request.signature);
    const nonce = decodeNonce(request.nonce);

    let permission: unknown;
    try {
      const accessKey = await this.#provider.viewAccessKey({
        accountId: request.signerAccountId,
        publicKey: request.publicKey,
      });
      permission = accessKey.permission;
    } catch {
      throw new BackendAuthError(
        "ACCESS_KEY_LOOKUP_FAILED",
        "The signing key's access-key permission could not be read.",
      );
    }
    if (permission !== "FullAccess") {
      throw new BackendAuthError("FULL_ACCESS_KEY_REQUIRED", NEP413_FULL_ACCESS_GUIDANCE);
    }

    try {
      await verifyMessage({
        signerAccountId: request.signerAccountId,
        signerPublicKey: request.publicKey,
        payload: {
          message: request.message,
          recipient: request.recipient,
          nonce,
          ...(request.callbackUrl === undefined ? {} : { callbackUrl: request.callbackUrl }),
        },
        signature,
        provider: this.#provider,
      });
    } catch {
      throw new BackendAuthError("SIGNATURE_INVALID", "The NEP-413 signature is invalid.");
    }

    // Consume only after the signature verifies so junk requests cannot burn
    // legitimate nonces.
    const nonceKey = `${request.signerAccountId}:${request.nonce}`;
    let fresh: boolean;
    try {
      fresh = await this.#nonceStore.consume(nonceKey);
    } catch {
      throw new BackendAuthError("INVALID_REQUEST", "Nonce replay protection is unavailable.");
    }
    if (!fresh) {
      throw new BackendAuthError("NONCE_REPLAYED", "This authentication nonce was already used.");
    }

    return {
      signerAccountId: request.signerAccountId,
      publicKey: request.publicKey,
    };
  }
}
