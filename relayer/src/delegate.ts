/**
 * Wire format for accepted signed delegates.
 *
 * The relayer accepts the canonical Borsh encoding of `SignedDelegate`
 * (near-api-js `encodeSignedDelegate` / `SignedDelegate.encode`), base64
 * encoded. JSON reconstruction of near-api-js class instances loses `Uint8Array`
 * argument bytes and byte-exact bigint handling, so Borsh is the only accepted
 * transport.
 */

import { SignedDelegate } from "near-api-js";

import { MAX_SIGNED_DELEGATE_BYTES } from "./constants.js";
import { RelayerError } from "./errors.js";

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decode one base64 Borsh `SignedDelegate`.
 *
 * Rejects empty input, non-base64 text, oversized payloads, and encodings that
 * near-api-js does not consider canonical (nested delegate actions, extra
 * trailing bytes, reserved action variants).
 */
export function decodeSignedDelegateBase64(value: unknown): SignedDelegate {
  if (typeof value !== "string") {
    throw new RelayerError("INVALID_SIGNED_DELEGATE", "signedDelegate must be a base64 string.");
  }
  const encoded = value.trim();
  if (encoded.length === 0) {
    throw new RelayerError("INVALID_SIGNED_DELEGATE", "signedDelegate must not be empty.");
  }
  if (!BASE64_PATTERN.test(encoded)) {
    throw new RelayerError("INVALID_SIGNED_DELEGATE", "signedDelegate is not valid base64.");
  }
  // Four base64 characters encode three bytes; check before allocating.
  if (Math.floor((encoded.length * 3) / 4) > MAX_SIGNED_DELEGATE_BYTES) {
    throw new RelayerError("BODY_TOO_LARGE", "signedDelegate exceeds the size limit.");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length > MAX_SIGNED_DELEGATE_BYTES) {
    throw new RelayerError("INVALID_SIGNED_DELEGATE", "signedDelegate decoded to an invalid size.");
  }
  try {
    return SignedDelegate.decode(new Uint8Array(bytes));
  } catch (error) {
    throw new RelayerError(
      "INVALID_SIGNED_DELEGATE",
      "signedDelegate is not a canonical Borsh SignedDelegate.",
      { cause: error },
    );
  }
}

/** Encode a signed delegate for transport; used by clients and tests. */
export function encodeSignedDelegateBase64(signedDelegate: SignedDelegate): string {
  return Buffer.from(signedDelegate.encode()).toString("base64");
}
