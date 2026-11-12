/**
 * Optional Groth16 attestation client.
 *
 * Verification keys and proofs travel as raw bytes. JSON has no byte type, so
 * `Vec<u8>` arguments are sent as number arrays and results are normalized
 * back to lowercase hex for callers. `verify_proof` mutates the on-chain
 * nullifier set, so it is a state-changing call, not a view.
 */

import { bytesToHex, hexToBytes } from "../crypto/hashUtils.js";
import { InvalidResponseError, ValidationError } from "../core/errors.js";
import type { VerificationKeyInfo } from "../types.js";
import type { NearContractWrapper, NearContractCallOptions } from "./NearContractWrapper.js";
import { assertU32, assertNonEmptyString, parseCount, parseBoolean, storageDepositNear } from "./entries.js";

function toByteArray(value: Uint8Array | string, field: string): number[] {
  let bytes: Uint8Array;
  if (typeof value === "string") {
    bytes = hexToBytes(value);
  } else if (value instanceof Uint8Array) {
    bytes = value;
  } else {
    throw new ValidationError(`${field} must be a Uint8Array or a hex string.`, field);
  }
  if (bytes.length === 0) {
    throw new ValidationError(`${field} must not be empty.`, field);
  }
  return Array.from(bytes);
}

function fromByteResult(value: unknown): Uint8Array {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidResponseError("Expected a non-empty byte array.", { method: "verification_key" });
  }
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index++) {
    const byte = value[index];
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new InvalidResponseError("Invalid byte value.", { method: "verification_key" });
    }
    bytes[index] = byte;
  }
  return bytes;
}

const DECIMAL = /^(?:0|[1-9]\d*)$/;

export class VerificationKeyClient {
  constructor(private readonly near: NearContractWrapper) {}

  /** Owner-only: add a verification key and return its u32 id. */
  async addVerificationKey(
    vkBytes: Uint8Array | string,
    description: string,
    opts?: NearContractCallOptions,
  ): Promise<number> {
    const result = await this.near.call<number>(
      "add_verification_key",
      {
        vk_bytes: toByteArray(vkBytes, "vkBytes"),
        description: assertNonEmptyString(description, "description"),
      },
      opts,
    );
    return parseCount(result, "add_verification_key");
  }

  async getVerificationKey(id: number): Promise<string | null> {
    const result = await this.near.view<number[] | null>("get_verification_key", {
      id: assertU32(id, "id"),
    });
    return result === null ? null : bytesToHex(fromByteResult(result));
  }

  async getVerificationKeyInfo(id: number): Promise<VerificationKeyInfo | null> {
    const result = await this.near.view<Record<string, unknown> | null>(
      "get_verification_key_info",
      { id: assertU32(id, "id") },
    );
    if (result === null) return null;

    const key = result.key;
    const description = result.description;
    if (typeof description !== "string") {
      throw new InvalidResponseError("VerificationKeyInfo.description must be a string.", {
        method: "get_verification_key_info",
      });
    }
    if (typeof key === "string") {
      return { key: key.toLowerCase(), description };
    }
    return { key: bytesToHex(fromByteResult(key)), description };
  }

  /** Owner-only: select the active verification key. */
  async setActiveVerificationKey(id: number, opts?: NearContractCallOptions): Promise<void> {
    await this.near.call<null>(
      "set_active_verification_key",
      { id: assertU32(id, "id") },
      opts,
    );
  }

  async getActiveVerificationKeyId(): Promise<number> {
    const result = await this.near.view<number>("get_active_verification_key_id", {});
    return parseCount(result, "get_active_verification_key_id");
  }

  async getVerificationKeyCount(): Promise<number> {
    const result = await this.near.view<number>("get_verification_key_count", {});
    return parseCount(result, "get_verification_key_count");
  }

  /**
   * Submit a proof for verification. Returns true only when the contract
   * recorded the nullifier; a replay does not return true.
   */
  async verifyProof(
    proofBytes: Uint8Array | string,
    publicInputs: readonly string[],
    verificationKeyId: number,
    opts?: NearContractCallOptions,
  ): Promise<boolean> {
    if (!Array.isArray(publicInputs) || publicInputs.length === 0) {
      throw new ValidationError("publicInputs must contain at least one decimal string.", "publicInputs");
    }
    for (const input of publicInputs) {
      if (typeof input !== "string" || !DECIMAL.test(input)) {
        throw new ValidationError(
          "publicInputs must be decimal strings.",
          "publicInputs",
        );
      }
    }

    const result = await this.near.call<boolean>(
      "verify_proof",
      {
        proof_bytes: toByteArray(proofBytes, "proofBytes"),
        public_inputs: [...publicInputs],
        verification_key_id: assertU32(verificationKeyId, "verificationKeyId"),
      },
      { ...opts, deposit: opts?.deposit ?? storageDepositNear(73) },
    );
    return parseBoolean(result, "verify_proof");
  }
}
