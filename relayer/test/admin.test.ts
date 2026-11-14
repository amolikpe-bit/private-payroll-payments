// Consolidated relayer config and gas-key withdrawal admin suite.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { KeyPair } from "near-api-js";

import {
  assertTestnetRpcUrl,
  resolveRelayerConfigFromEnv,
} from "../src/config.js";
import {
  NearRelayerChain,
  withdrawThenDeleteGasKey,
  type GasKeyAccess,
  type GasKeyAdmin,
} from "../src/near.js";
import { RelayerError, type RelayerErrorCode } from "../src/errors.js";

describe("relayer config", () => {
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
});

describe("relayer gas-key withdrawal", () => {
  class FakeGasKeyAdmin implements GasKeyAdmin {
    readonly calls: string[] = [];
    access: GasKeyAccess | null;
    failWithdraw = false;
    failDelete = false;

    constructor(access: GasKeyAccess | null) {
      this.access = access;
    }

    async getAccessKey(): Promise<GasKeyAccess | null> {
      this.calls.push("lookup");
      return this.access;
    }

    async withdrawFromGasKey(_publicKey: string, amount: bigint): Promise<void> {
      this.calls.push(`withdraw:${amount.toString()}`);
      if (this.failWithdraw) {
        throw new Error("rpc rejected withdrawal");
      }
    }

    async deleteKey(): Promise<void> {
      this.calls.push("delete");
      if (this.failDelete) {
        throw new Error("rpc rejected deletion");
      }
    }
  }

  function gasKey(balance: bigint): GasKeyAccess {
    return { permission: { GasKeyFullAccess: { balance: balance.toString(), num_nonces: 1 } } };
  }

  test("withdraws the gas-key balance before deleting the key", async () => {
    const admin = new FakeGasKeyAdmin(gasKey(100_000n));
    const result = await withdrawThenDeleteGasKey(admin, "ed25519:test", { reserveYocto: 10_000n });
    assert.equal(result.withdrawnYocto, 90_000n);
    assert.equal(result.deleted, true);
    assert.deepEqual(admin.calls, ["lookup", "withdraw:90000", "delete"]);
  });

  test("never deletes the key when withdrawal fails", async () => {
    const admin = new FakeGasKeyAdmin(gasKey(100_000n));
    admin.failWithdraw = true;
    await assert.rejects(
      withdrawThenDeleteGasKey(admin, "ed25519:test", { reserveYocto: 10_000n }),
      (error: unknown) => error instanceof RelayerError && error.code === "GAS_KEY_WITHDRAW_FAILED",
    );
    assert.deepEqual(admin.calls, ["lookup", "withdraw:90000"]);
  });

  test("reports a partial failure when deletion fails after withdrawal", async () => {
    const admin = new FakeGasKeyAdmin(gasKey(100_000n));
    admin.failDelete = true;
    await assert.rejects(
      withdrawThenDeleteGasKey(admin, "ed25519:test", { reserveYocto: 10_000n }),
      (error: unknown) => error instanceof RelayerError && error.code === "GAS_KEY_DELETE_FAILED",
    );
    assert.deepEqual(admin.calls, ["lookup", "withdraw:90000", "delete"]);
  });

  test("skips the withdrawal when the balance is at or below the reserve", async () => {
    const admin = new FakeGasKeyAdmin(gasKey(5_000n));
    const result = await withdrawThenDeleteGasKey(admin, "ed25519:test", { reserveYocto: 10_000n });
    assert.equal(result.withdrawnYocto, 0n);
    assert.deepEqual(admin.calls, ["lookup", "delete"]);
  });

  test("refuses to delete a missing key", async () => {
    const admin = new FakeGasKeyAdmin(null);
    await assert.rejects(
      withdrawThenDeleteGasKey(admin, "ed25519:test"),
      (error: unknown) => error instanceof RelayerError && error.code === "GAS_KEY_NOT_FOUND",
    );
    assert.deepEqual(admin.calls, ["lookup"]);
  });

  test("refuses to delete a regular FullAccess key", async () => {
    const admin = new FakeGasKeyAdmin({ permission: "FullAccess" });
    await assert.rejects(
      withdrawThenDeleteGasKey(admin, "ed25519:test"),
      (error: unknown) => error instanceof RelayerError && error.code === "GAS_KEY_REQUIRED",
    );
    assert.deepEqual(admin.calls, ["lookup"]);
  });

  test("rejects a reserve above the 1 NEAR deletion limit", async () => {
    const admin = new FakeGasKeyAdmin(gasKey(100_000n));
    await assert.rejects(
      withdrawThenDeleteGasKey(admin, "ed25519:test", { reserveYocto: 10n ** 24n + 1n }),
      (error: unknown) => error instanceof RelayerError && error.code === "INVALID_REQUEST",
    );
    assert.deepEqual(admin.calls, []);
  });

  test("supports a function-call gas key balance", async () => {
    const admin = new FakeGasKeyAdmin({
      permission: {
        GasKeyFunctionCall: {
          balance: "50000",
          num_nonces: 1,
          receiver_id: "subrosa.testnet",
          method_names: [],
          allowance: null,
        },
      },
    });
    const result = await withdrawThenDeleteGasKey(admin, "ed25519:test", { reserveYocto: 10_000n });
    assert.equal(result.withdrawnYocto, 40_000n);
    assert.deepEqual(admin.calls, ["lookup", "withdraw:40000", "delete"]);
  });
});
