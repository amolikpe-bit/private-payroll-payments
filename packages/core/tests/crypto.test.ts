import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COMMITMENT_DOMAIN,
  CommitmentEncodingError,
  REGISTRATION_DOMAIN,
  buildCommitmentPreimage,
  buildRegistrationPreimage,
  bytesToHex,
  commitmentHash,
  hexToBytes,
  isHex64,
  registrationHash,
  sha256Hex,
  verifyCommitment,
  verifyRegistrationCommitment,
} from "../src/crypto/hashUtils.js";

const VECTOR = {
  employer: "subrosa.testnet",
  employee: "alice.testnet",
  token: "usdc.tokens.testnet",
  cycleId: 7n,
  amount: "123456789012345678901234567890",
  salt: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
} as const;

// Hard-coded from the byte layout in CONSTANTS.md §3; the Rust contract must
// produce the same digest for the same inputs.
const EXPECTED_PREIMAGE_HEX =
  "737562726f73612f636f6d6d69742f76310f000000737562726f73612e746573746e65740d000000616c6963652e746573746e657413000000757364632e746f6b656e732e746573746e65740700000000000000d20a3f4eeee073c3f60fe98e0100000020000000000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const EXPECTED_COMMITMENT = "2352e17857723f925f4774a0eb12ffbe51f1f7d81c7ce075ed69927db9ce0485";
const EXPECTED_REGISTRATION_PREIMAGE_HEX =
  "737562726f73612f7265672f76310f000000737562726f73612e746573746e65740d000000616c6963652e746573746e657413000000757364632e746f6b656e732e746573746e65740000000000000000d20a3f4eeee073c3f60fe98e0100000020000000000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const EXPECTED_REGISTRATION = "3baa071c027b571a8c8c379bae696b1fc0ec8064d83ab746f496a80e2b24c6c6";

test("commitment preimage matches the documented Borsh layout", () => {
  assert.equal(COMMITMENT_DOMAIN, "subrosa/commit/v1");
  const preimage = buildCommitmentPreimage(VECTOR);
  assert.equal(bytesToHex(preimage), EXPECTED_PREIMAGE_HEX);
});

test("commitment hash vector is stable across languages", () => {
  assert.equal(commitmentHash(VECTOR), EXPECTED_COMMITMENT);
  assert.equal(sha256Hex(hexToBytes(EXPECTED_PREIMAGE_HEX)), EXPECTED_COMMITMENT);
});

test("registration preimage uses cycle zero and its own domain", () => {
  assert.equal(REGISTRATION_DOMAIN, "subrosa/reg/v1");
  const preimage = buildRegistrationPreimage(VECTOR);
  assert.equal(bytesToHex(preimage), EXPECTED_REGISTRATION_PREIMAGE_HEX);
  assert.equal(registrationHash(VECTOR), EXPECTED_REGISTRATION);
  assert.notEqual(EXPECTED_REGISTRATION, EXPECTED_COMMITMENT);
  assert.notDeepEqual(buildRegistrationPreimage(VECTOR), buildCommitmentPreimage(VECTOR));
});

test("verifyCommitment recomputes and compares in constant time", () => {
  assert.equal(verifyCommitment(VECTOR, EXPECTED_COMMITMENT), true);
  assert.equal(verifyCommitment(VECTOR, EXPECTED_COMMITMENT.toUpperCase()), true);
  assert.equal(verifyCommitment({ ...VECTOR, amount: "1" }, EXPECTED_COMMITMENT), false);
  assert.equal(verifyRegistrationCommitment(VECTOR, EXPECTED_REGISTRATION), true);
  assert.equal(verifyRegistrationCommitment(VECTOR, EXPECTED_COMMITMENT), false);
});

test("malformed salts are rejected before hashing", () => {
  const invalidSalts = ["", "0", "abc", "0x00ff", "zz", "gg", "00 11"];
  for (const salt of invalidSalts) {
    assert.throws(
      () => buildCommitmentPreimage({ ...VECTOR, salt }),
      (error: unknown) =>
        error instanceof CommitmentEncodingError &&
        (error.code === "INVALID_SALT" || error.code === "INVALID_SALT_HEX"),
      `salt ${JSON.stringify(salt)} should be rejected`,
    );
  }
  const tooLong = "00".repeat(65);
  assert.throws(
    () => buildCommitmentPreimage({ ...VECTOR, salt: tooLong }),
    (error: unknown) => error instanceof CommitmentEncodingError && error.code === "INVALID_SALT",
  );
});

test("malformed expected hashes are rejected", () => {
  for (const hash of ["", "abc", "zz".repeat(32), "a".repeat(63), "a".repeat(65)]) {
    assert.throws(
      () => verifyCommitment(VECTOR, hash),
      (error: unknown) => error instanceof CommitmentEncodingError && error.code === "INVALID_HASH",
    );
  }
  assert.equal(isHex64(EXPECTED_COMMITMENT), true);
  assert.equal(isHex64(EXPECTED_COMMITMENT.toUpperCase()), true);
  assert.equal(isHex64("0x" + EXPECTED_COMMITMENT), false);
});

test("amounts and cycle ids enforce unsigned integer ranges", () => {
  assert.throws(
    () => buildCommitmentPreimage({ ...VECTOR, amount: "-1" }),
    (error: unknown) => error instanceof CommitmentEncodingError && error.code === "INVALID_AMOUNT",
  );
  assert.throws(
    () => buildCommitmentPreimage({ ...VECTOR, amount: "1.5" }),
    (error: unknown) => error instanceof CommitmentEncodingError && error.code === "INVALID_AMOUNT",
  );
  assert.throws(
    () => buildCommitmentPreimage({ ...VECTOR, amount: (2n ** 128n).toString() }),
    (error: unknown) => error instanceof CommitmentEncodingError && error.code === "INVALID_AMOUNT",
  );
  assert.throws(
    () => buildCommitmentPreimage({ ...VECTOR, cycleId: 2n ** 64n }),
    (error: unknown) => error instanceof CommitmentEncodingError && error.code === "INVALID_CYCLE_ID",
  );
  assert.throws(
    () => buildCommitmentPreimage({ ...VECTOR, cycleId: Number.MAX_SAFE_INTEGER + 1 }),
    (error: unknown) => error instanceof CommitmentEncodingError && error.code === "INVALID_CYCLE_ID",
  );
  assert.throws(
    () => buildCommitmentPreimage({ ...VECTOR, employer: "" }),
    (error: unknown) => error instanceof CommitmentEncodingError && error.code === "INVALID_STRING",
  );
});

test("hex helpers round-trip bytes and reject malformed input", () => {
  const bytes = Uint8Array.of(0x00, 0x0f, 0xff, 0xa5);
  assert.equal(bytesToHex(bytes), "000fffa5");
  assert.deepEqual(hexToBytes("000fffa5"), bytes);
  assert.deepEqual(hexToBytes("000FFFA5"), bytes);
  assert.throws(
    () => hexToBytes("0"),
    (error: unknown) => error instanceof CommitmentEncodingError && error.code === "INVALID_HEX",
  );
  assert.throws(
    () => hexToBytes("0g"),
    (error: unknown) => error instanceof CommitmentEncodingError && error.code === "INVALID_HEX",
  );
});
