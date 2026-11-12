import assert from "node:assert/strict";
import test from "node:test";

import { RelayerError } from "../src/errors.js";
import {
  withdrawThenDeleteGasKey,
  type GasKeyAccess,
  type GasKeyAdmin,
} from "../src/near.js";

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
