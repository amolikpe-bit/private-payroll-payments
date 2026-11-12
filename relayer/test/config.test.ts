import assert from "node:assert/strict";
import test from "node:test";

import { KeyPair } from "near-api-js";

import {
  assertTestnetRpcUrl,
  resolveRelayerConfigFromEnv,
} from "../src/config.js";
import { NearRelayerChain } from "../src/near.js";
import { RelayerError, type RelayerErrorCode } from "../src/errors.js";

function expectCode(fn: () => unknown, code: RelayerErrorCode): void {
  assert.throws(
    fn,
    (error: unknown) => error instanceof RelayerError && error.code === code,
    `expected RelayerError ${code}`,
  );
}

test("rejects mainnet RPC endpoints", () => {
  expectCode(
    () => assertTestnetRpcUrl("https://rpc.mainnet.near.org"),
    "NETWORK_NOT_ALLOWED",
  );
});

test("allows testnet and loopback sandbox RPC endpoints", () => {
  assert.doesNotThrow(() => assertTestnetRpcUrl("https://rpc.testnet.near.org"));
  assert.doesNotThrow(() => assertTestnetRpcUrl("http://127.0.0.1:3030"));
  expectCode(
    () => assertTestnetRpcUrl("http://rpc.testnet.near.org"),
    "INVALID_REQUEST",
  );
});

test("requires the relayer account and gas key without echoing them", () => {
  const missingAccount = () => resolveRelayerConfigFromEnv({});
  assert.throws(
    missingAccount,
    (error: unknown) =>
      error instanceof RelayerError &&
      error.code === "INVALID_REQUEST" &&
      error.message.includes("RELAYER_ACCOUNT_ID"),
  );

  expectCode(
    () =>
      resolveRelayerConfigFromEnv({
        RELAYER_ACCOUNT_ID: "relayer.testnet",
      }),
    "INVALID_REQUEST",
  );
});

test("parses defaults and validates the port", () => {
  const config = resolveRelayerConfigFromEnv({
    RELAYER_ACCOUNT_ID: "relayer.testnet",
    RELAYER_GAS_KEY: "ed25519:11111111111111111111111111111111",
  });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8787);
  assert.equal(config.maxTtlBlocks, 600);
  assert.equal(config.rpcUrl, "https://rpc.testnet.near.org");
  assert.equal(config.apiToken, undefined);

  expectCode(
    () =>
      resolveRelayerConfigFromEnv({
        RELAYER_ACCOUNT_ID: "relayer.testnet",
        RELAYER_GAS_KEY: "ed25519:11111111111111111111111111111111",
        RELAYER_PORT: "70000",
      }),
    "INVALID_REQUEST",
  );
});

test("the chain adapter refuses a mainnet RPC before any RPC call", async () => {
  const secret = KeyPair.fromRandom("ed25519").toString();
  await assert.rejects(
    NearRelayerChain.create({
      relayerAccountId: "relayer.testnet",
      gasKeySecret: secret,
      rpcUrl: "https://rpc.mainnet.near.org",
    }),
    (error: unknown) => error instanceof RelayerError && error.code === "NETWORK_NOT_ALLOWED",
  );
});

test("rejects a mainnet RPC in environment configuration", () => {
  expectCode(
    () =>
      resolveRelayerConfigFromEnv({
        RELAYER_ACCOUNT_ID: "relayer.testnet",
        RELAYER_GAS_KEY: "ed25519:11111111111111111111111111111111",
        RELAYER_RPC_URL: "https://rpc.mainnet.near.org",
      }),
    "NETWORK_NOT_ALLOWED",
  );
});
