/**
 * NEP-413 signer for 1Click intent payloads.
 *
 * The wallet signs the exact `payload` returned by `/v0/generate-intent`:
 * `{ message, nonce, recipient }` with recipient `intents.near`. Rewriting the
 * payload (or generating a different nonce) makes 1Click reject the signature,
 * so this adapter never mutates it.
 *
 * NEP-413 requires a full-access key. Function-call keys cannot sign messages;
 * their receiver/method/allowance scoping applies to contract calls only.
 */

import { baseEncode } from "near-api-js";
import type { Account, SignedMessage } from "near-api-js";
import { signMessage } from "near-api-js/nep413";

import type { SignedIntentMessage } from "../types.js";
import { INTENTS_ACCOUNT_ID, type Nep413Payload } from "./OneClickClient.js";

export type Nep413SignerErrorCode =
  | "MISSING_SIGNER"
  | "ACCESS_KEY_LOOKUP_FAILED"
  | "FULL_ACCESS_KEY_REQUIRED"
  | "INVALID_PAYLOAD"
  | "INVALID_NONCE"
  | "UNSUPPORTED_KEY"
  | "SIGNING_FAILED";

export class Nep413SignerError extends Error {
  readonly code: Nep413SignerErrorCode;

  constructor(code: Nep413SignerErrorCode, message: string) {
    super(message);
    this.name = "Nep413SignerError";
    this.code = code;
  }
}

/** Guidance surfaced whenever a non-full-access key is used for NEP-413. */
export const NEP413_FULL_ACCESS_GUIDANCE =
  "NEP-413 intent signing requires a full-access NEAR access key. Function-call keys " +
  "(receiver/method/allowance scoped) can call the contract but cannot sign intent messages; " +
  "use a wallet-held full-access key and register its public key on intents.near.";

/** Minimal signer contract consumed by the confidential payout flow. */
export interface IntentPayloadSigner {
  readonly signerId: string;
  /** Sign the payload exactly as returned by `/v0/generate-intent`. */
  signPayload(payload: Nep413Payload): Promise<SignedIntentMessage>;
}

/** Decoded NEP-413 payload with the nonce as raw bytes. */
export interface DecodedIntentPayload {
  message: string;
  recipient: string;
  nonce: Uint8Array;
  callbackUrl?: string;
}

/**
 * Validate a `/v0/generate-intent` payload and decode its base64 nonce.
 * Every signer path (local account, wallet connector) uses this so the exact
 * wire payload is enforced in one place.
 */
export function decodeIntentPayload(payload: Nep413Payload): DecodedIntentPayload {
  if (typeof payload !== "object" || payload === null) {
    throw new Nep413SignerError("INVALID_PAYLOAD", "Intent payload must be an object.");
  }
  if (typeof payload.message !== "string" || payload.message.length === 0) {
    throw new Nep413SignerError("INVALID_PAYLOAD", "Intent payload message must be non-empty.");
  }
  if (payload.recipient !== INTENTS_ACCOUNT_ID) {
    throw new Nep413SignerError(
      "INVALID_PAYLOAD",
      `Intent payload recipient must be ${INTENTS_ACCOUNT_ID}.`,
    );
  }
  if (typeof payload.nonce !== "string" || !BASE64.test(payload.nonce)) {
    throw new Nep413SignerError("INVALID_NONCE", "Intent payload nonce must be base64.");
  }
  const nonce = Buffer.from(payload.nonce, "base64");
  if (nonce.length !== NONCE_BYTES) {
    throw new Nep413SignerError("INVALID_NONCE", "Intent payload nonce must decode to 32 bytes.");
  }
  return {
    message: payload.message,
    recipient: payload.recipient,
    nonce,
    ...(payload.callbackUrl === undefined ? {} : { callbackUrl: payload.callbackUrl }),
  };
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const NONCE_BYTES = 32;

/**
 * Signs intent payloads with a near-api-js `Account` and its configured signer.
 * The account must hold the signing key with `FullAccess` permission.
 */
export class Nep413Signer implements IntentPayloadSigner {
  readonly signerId: string;
  readonly #account: Account;
  #publicKey: string | undefined;
  #fullAccessChecked = false;

  constructor(account: Account) {
    if (typeof account !== "object" || account === null || typeof account.accountId !== "string") {
      throw new Nep413SignerError("MISSING_SIGNER", "Nep413Signer requires a near-api-js account.");
    }
    this.#account = account;
    this.signerId = account.accountId;
  }

  /** Curve-prefixed public key of the account's signing key. */
  async getPublicKey(): Promise<string> {
    if (this.#publicKey !== undefined) {
      return this.#publicKey;
    }
    const signer = this.#account.getSigner();
    if (signer === undefined) {
      throw new Nep413SignerError("MISSING_SIGNER", "The account has no configured signer.");
    }
    const publicKey = await signer.getPublicKey();
    this.#publicKey = publicKey.toString();
    return this.#publicKey;
  }

  /**
   * Fail fast when the signing key is not full-access. Cached after the first
   * successful lookup; run it before funding if the caller wants a preflight.
   */
  async assertFullAccessKey(): Promise<void> {
    if (this.#fullAccessChecked) {
      return;
    }
    const publicKey = await this.getPublicKey();
    let permission: unknown;
    try {
      const accessKey = await this.#account.getAccessKey(publicKey);
      permission = accessKey.permission;
    } catch {
      throw new Nep413SignerError(
        "ACCESS_KEY_LOOKUP_FAILED",
        "Unable to read the signing key's access-key permission from RPC.",
      );
    }
    if (permission !== "FullAccess") {
      throw new Nep413SignerError("FULL_ACCESS_KEY_REQUIRED", NEP413_FULL_ACCESS_GUIDANCE);
    }
    this.#fullAccessChecked = true;
  }

  /**
   * Sign the exact payload. Returns the curve-prefixed public key and the
   * curve-prefixed base58 signature expected in `signedData`.
   */
  async signPayload(payload: Nep413Payload): Promise<SignedIntentMessage> {
    const decoded = decodeIntentPayload(payload);

    await this.assertFullAccessKey();

    let signed: SignedMessage;
    try {
      signed = await signMessage({
        signerAccount: this.#account,
        payload: {
          message: decoded.message,
          recipient: decoded.recipient,
          nonce: decoded.nonce,
          ...(decoded.callbackUrl === undefined ? {} : { callbackUrl: decoded.callbackUrl }),
        },
      });
    } catch {
      throw new Nep413SignerError("SIGNING_FAILED", "The account signer failed to sign the intent payload.");
    }
    const publicKey = signed.publicKey.toString();
    const curve = publicKey.includes(":") ? publicKey.slice(0, publicKey.indexOf(":")) : "";
    if (curve !== "ed25519" && curve !== "secp256k1") {
      throw new Nep413SignerError("UNSUPPORTED_KEY", "Only ed25519 and secp256k1 keys can sign NEP-413 intents.");
    }
    if (!(signed.signature instanceof Uint8Array) || signed.signature.length === 0) {
      throw new Nep413SignerError("SIGNING_FAILED", "The signer returned an empty signature.");
    }
    this.#publicKey = publicKey;
    return {
      publicKey,
      signature: `${curve}:${baseEncode(signed.signature)}`,
    };
  }
}
