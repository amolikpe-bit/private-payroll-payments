/**
 * Cross-language salary commitments.
 *
 * The contract stores only a hex digest. The amount and its salt stay in the
 * employer's private store. Both the Rust contract and this module must build
 * the exact same byte string, so the encoding is deliberately small and
 * explicit:
 *
 * `sha256(DOMAIN || borsh{employer, employee, token, cycle_id, amount, salt})`
 *
 * Borsh rules used here:
 * - `AccountId`/`String`: u32 little-endian byte length, then UTF-8 bytes.
 * - `u64`: 8 bytes little-endian.
 * - `u128`: 16 bytes little-endian.
 * - salt: hex decoded first, then u32 little-endian length and raw bytes.
 */

import { hash as cryptoHash, timingSafeEqual } from "node:crypto";
import { ValidationError } from "../core/errors.js";
/** Domain separator for per-cycle salary commitments. */
export const COMMITMENT_DOMAIN = "subrosa/commit/v1";
/** Domain separator for registry (salary) commitments; `cycle_id` is zero. */
export const REGISTRATION_DOMAIN = "subrosa/reg/v1";

const ENC = new TextEncoder();
const COMMIT_BYTES = ENC.encode(COMMITMENT_DOMAIN);
const REG_BYTES = ENC.encode(REGISTRATION_DOMAIN);
const MAX_STR = 1024;
export const MAX_SALT = 64;
const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;
const HEX64 = /^[0-9a-fA-F]{64}$/;
const LOWER_HEX64 = /^[0-9a-f]{64}$/;
export const HEX_BYTES = /^(?:[0-9a-fA-F]{2})+$/;
/** Stable failure codes for malformed commitment inputs. */
export type CommitmentEncodingErrorCode =
  | "INVALID_STRING"
  | "INVALID_CYCLE_ID"
  | "INVALID_AMOUNT"
  | "INVALID_SALT"
  | "INVALID_SALT_HEX"
  | "INVALID_HASH"
  | "INVALID_HEX";

/** Raised before any hashing when an input cannot produce a canonical preimage. */
export class CommitmentEncodingError extends Error {
  readonly code: CommitmentEncodingErrorCode;

  constructor(code: CommitmentEncodingErrorCode, message: string) {
    super(message);
    this.name = "CommitmentEncodingError";
    this.code = code;
  }
}

/** Inputs for a per-cycle commitment preimage. */
export interface CommitmentPreimageInput {
  employer: string;
  employee: string;
  token: string;
  /** Cycle identifier (`u64`); accepted as number only when safe. */
  cycleId: number | bigint | string;
  /** Decimal `u128` in the token's smallest unit. */
  amount: number | bigint | string;
  /** Salt as hexadecimal bytes. */
  salt: string;
}

/** Inputs for a registry commitment preimage; `cycle_id` is fixed to zero. */
export interface RegistrationPreimageInput {
  employer: string;
  employee: string;
  token: string;
  amount: number | bigint | string;
  salt: string;
}

/** True when `value` is exactly 64 hexadecimal characters. */
export function isHex64(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

/** True when `value` is exactly 64 lowercase hexadecimal characters. */
export function isLowerHex64(value: unknown): value is string {
  return typeof value === "string" && LOWER_HEX64.test(value);
}
/**
 * Decode a hexadecimal byte string.
 *
 * Rejects odd lengths, whitespace, a `0x` prefix and non-hex characters: a
 * silently mangled salt would make a commitment unverifiable forever.
 */
export function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== "string" || !HEX_BYTES.test(hex)) {
    throw new CommitmentEncodingError(
      "INVALID_HEX",
      "Expected a non-empty, even-length hexadecimal string without a prefix.",
    );
  }
  const buf = Buffer.from(hex, "hex");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Encode raw bytes as lowercase hexadecimal. */
export function bytesToHex(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) {
    throw new CommitmentEncodingError("INVALID_HEX", "Expected a Uint8Array.");
  }
  return bytes.toHex();
}

/** SHA-256 of raw bytes or a UTF-8 string, as 64-character lowercase hex. */
export function sha256Hex(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? ENC.encode(data) : data;
  if (!(bytes instanceof Uint8Array)) {
    throw new CommitmentEncodingError("INVALID_HEX", "Expected a Uint8Array or a string.");
  }
  return cryptoHash("sha256", bytes);
}

/** Build the exact Borsh preimage hashed for a per-cycle commitment. */
export function buildCommitmentPreimage(input: CommitmentPreimageInput): Uint8Array {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new CommitmentEncodingError("INVALID_STRING", "Commitment input must be an object.");
  }
  return buildPreimage(
    COMMIT_BYTES,
    input.employer,
    input.employee,
    input.token,
    input.cycleId,
    input.amount,
    input.salt,
  );
}

/**
 * Build the registry preimage: the same layout as a cycle commitment with
 * `cycle_id = 0` under {@link REGISTRATION_DOMAIN}.
 */
export function buildRegistrationPreimage(input: RegistrationPreimageInput): Uint8Array {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new CommitmentEncodingError("INVALID_STRING", "Registration input must be an object.");
  }
  return buildPreimage(
    REG_BYTES,
    input.employer,
    input.employee,
    input.token,
    0n,
    input.amount,
    input.salt,
  );
}

/** Hex digest stored on chain for a per-cycle commitment. */
export function commitmentHash(input: CommitmentPreimageInput): string {
  return sha256Hex(buildCommitmentPreimage(input));
}

/** Hex digest stored on chain for a registry (salary) commitment. */
export function registrationHash(input: RegistrationPreimageInput): string {
  return sha256Hex(buildRegistrationPreimage(input));
}

/**
 * Recompute the commitment and compare it against the public on-chain hash.
 *
 * Malformed inputs (including a malformed expected hash) throw; a well-formed
 * mismatch returns `false`. Comparison is constant-time.
 */
export function verifyCommitment(input: CommitmentPreimageInput, expectedHex: string): boolean {
  const expected = normalizeHex64(expectedHex, "INVALID_HASH");
  const actual = commitmentHash(input);
  return timingSafeEqual(hexToBytes(actual), hexToBytes(expected));
}

/** Recompute a registry commitment and compare it to the registry entry. */
export function verifyRegistrationCommitment(
  input: RegistrationPreimageInput,
  expectedHex: string,
): boolean {
  const expected = normalizeHex64(expectedHex, "INVALID_HASH");
  const actual = registrationHash(input);
  return timingSafeEqual(hexToBytes(actual), hexToBytes(expected));
}

function buildPreimage(
  domain: Uint8Array,
  employer: string,
  employee: string,
  token: string,
  cycleId: number | bigint | string,
  amount: number | bigint | string,
  salt: string,
): Uint8Array {
  const employerBytes = borshStringBytes(employer);
  const employeeBytes = borshStringBytes(employee);
  const tokenBytes = borshStringBytes(token);
  const saltBytes = encodeSalt(salt);
  const cycle = parseUnsigned(cycleId, U64_MAX, "INVALID_CYCLE_ID", "cycleId");
  const value = parseUnsigned(amount, U128_MAX, "INVALID_AMOUNT", "amount");
  const total =
    domain.length +
    4 + employerBytes.length +
    4 + employeeBytes.length +
    4 + tokenBytes.length +
    8 + 16 +
    4 + saltBytes.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  out.set(domain, offset);
  offset += domain.length;
  offset = writeBytes(view, out, offset, employerBytes);
  offset = writeBytes(view, out, offset, employeeBytes);
  offset = writeBytes(view, out, offset, tokenBytes);
  view.setBigUint64(offset, cycle, true);
  offset += 8;
  view.setBigUint64(offset, value & U64_MAX, true);
  view.setBigUint64(offset + 8, value >> 64n, true);
  offset += 16;
  offset = writeBytes(view, out, offset, saltBytes);
  return out;
}

function borshStringBytes(value: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0) {
    throw new CommitmentEncodingError("INVALID_STRING", "Borsh strings must be non-empty.");
  }
  const bytes = ENC.encode(value);
  if (bytes.length === 0 || bytes.length > MAX_STR) {
    throw new CommitmentEncodingError(
      "INVALID_STRING",
      `Borsh strings must be between 1 and ${MAX_STR} UTF-8 bytes.`,
    );
  }
  return bytes;
}

function writeBytes(
  view: DataView,
  out: Uint8Array,
  offset: number,
  bytes: Uint8Array,
): number {
  if (!Number.isInteger(bytes.length) || bytes.length < 0 || bytes.length > 0xffffffff) {
    throw new CommitmentEncodingError("INVALID_STRING", "Borsh length is out of range.");
  }
  view.setUint32(offset, bytes.length, true);
  out.set(bytes, offset + 4);
  return offset + 4 + bytes.length;
}

function encodeSalt(salt: string): Uint8Array {
  if (typeof salt !== "string" || salt.length === 0) {
    throw new CommitmentEncodingError("INVALID_SALT", "Commitment salt must be a hex string.");
  }
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(salt);
  } catch (error) {
    if (error instanceof CommitmentEncodingError) {
      throw new CommitmentEncodingError(
        "INVALID_SALT_HEX",
        "Commitment salt must be an even-length hexadecimal string.",
      );
    }
    throw error;
  }
  if (bytes.length === 0 || bytes.length > MAX_SALT) {
    throw new CommitmentEncodingError(
      "INVALID_SALT",
      `Commitment salt must be between 1 and ${MAX_SALT} bytes.`,
    );
  }
  return bytes;
}

function parseUnsigned(
  value: number | bigint | string,
  maximum: bigint,
  code: CommitmentEncodingErrorCode,
  field: "cycleId" | "amount",
): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new CommitmentEncodingError(code, `${field} must be a safe integer.`);
    }
    parsed = BigInt(value);
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^[0-9]+$/.test(trimmed)) {
      throw new CommitmentEncodingError(code, `${field} must be a decimal integer string.`);
    }
    parsed = BigInt(trimmed);
  } else {
    throw new CommitmentEncodingError(code, `${field} has an unsupported type.`);
  }
  if (parsed < 0n || parsed > maximum) {
    throw new CommitmentEncodingError(code, `${field} is outside its unsigned integer range.`);
  }
  return parsed;
}


function normalizeHex64(value: string, code: CommitmentEncodingErrorCode): string {
  if (!isHex64(value)) {
    throw new CommitmentEncodingError(code, "Expected a 64-character hexadecimal digest.");
  }
  return value.toLowerCase();
}

/** Validate a positive `u128` amount bigint. */
export function assertPositiveU128(value: unknown): bigint {
  if (typeof value !== "bigint" || value <= 0n || value > U128_MAX) {
    throw new ValidationError(
      "amount must be a positive bigint that fits in u128.",
      "amount",
      "INVALID_AMOUNT",
    );
  }
  return value;
}

/** Validate an even-length hex salt of `1..=MAX_SALT` bytes. */
export function assertHexSalt(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SALT * 2 ||
    !HEX_BYTES.test(value)
  ) {
    throw new ValidationError(
      "salt must be an even-length hex string of 1-64 bytes.",
      "salt",
      "INVALID_SALT",
    );
  }
  return value;
}
