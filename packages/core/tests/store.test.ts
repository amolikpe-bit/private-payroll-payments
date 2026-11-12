import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  PRIVATE_STORE_VERSION,
  PrivateStore,
  PrivateStoreError,
  type PrivateReceipt,
} from "../src/store/PrivateStore.js";
import type { PendingPayout } from "../src/types.js";

const INTENT_HASH = "44XpLRAuZKoVGs9T4qbSNv33MDKMePPAibA52geVLWFw";
const COMMITMENT = "a".repeat(64);

function payout(payoutId: number, employer = "subrosa.testnet"): PendingPayout {
  return {
    employer,
    payout_id: payoutId,
    employee: `alice${payoutId}.testnet`,
    amount: String(1_000_000 + payoutId),
    salt: "00".repeat(32),
    asset: "usdc.tokens.testnet",
    memo: `cycle-${payoutId}`,
    commitment_hash: COMMITMENT,
  };
}

function receipt(overrides: Partial<PrivateReceipt> = {}): PrivateReceipt {
  return {
    receiptId: "rcpt_1",
    payrollId: "payout:subrosa.testnet:1",
    employer: "subrosa.testnet",
    employee: "alice.testnet",
    intentHash: null,
    commitmentHash: COMMITMENT,
    amount: "1000000",
    asset: "nep141:usdc.tokens.testnet",
    depositAddress: "deposit-secret-address",
    depositMemo: "deposit-secret-memo",
    quoteSignature: "1click-signature",
    correlationId: "corr-1",
    status: "PENDING_DEPOSIT",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function withStore(
  run: (store: PrivateStore, directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "subrosa-store-"));
  try {
    await run(new PrivateStore({ filePath: join(directory, "private-store.json") }), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("pending payouts round-trip, upsert and delete", async () => {
  await withStore(async (store) => {
    await store.savePendingPayout(payout(1));
    await store.savePendingPayout(payout(2));
    assert.deepEqual(await store.getPendingPayout("subrosa.testnet", 1), payout(1));
    assert.equal(await store.getPendingPayout("subrosa.testnet", 99), undefined);
    assert.deepEqual(
      (await store.listPendingPayouts("subrosa.testnet")).map((entry) => entry.payout_id),
      [1, 2],
    );
    assert.equal((await store.listPendingPayouts()).length, 2);

    const replacement = { ...payout(1), amount: "42" };
    await store.savePendingPayout(replacement);
    assert.equal((await store.getPendingPayout("subrosa.testnet", 1))?.amount, "42");

    assert.equal(await store.deletePendingPayout("subrosa.testnet", 1), true);
    assert.equal(await store.deletePendingPayout("subrosa.testnet", 1), false);
    assert.deepEqual(
      (await store.listPendingPayouts()).map((entry) => entry.payout_id),
      [2],
    );
  });
});

test("private receipts never expose deposit secrets from read methods", async () => {
  await withStore(async (store, directory) => {
    await store.savePrivateReceipt(receipt());

    const summary = await store.getReceipt("rcpt_1");
    assert.ok(summary);
    assert.equal(summary.status, "PENDING_DEPOSIT");
    assert.equal(summary.amount, "1000000");
    assert.ok(!("depositAddress" in summary));
    assert.ok(!("depositMemo" in summary));
    assert.ok(!JSON.stringify(summary).includes("deposit-secret-address"));

    const listed = await store.listReceipts();
    assert.equal(listed.length, 1);
    assert.ok(!JSON.stringify(listed).includes("deposit-secret-address"));

    const updated = await store.updatePrivateReceipt("rcpt_1", {
      intentHash: INTENT_HASH,
      status: "SUCCESS",
    });
    assert.equal(updated.intentHash, INTENT_HASH);
    assert.equal(updated.status, "SUCCESS");
    assert.ok(!("depositAddress" in updated));

    const byIntent = await store.getReceiptByIntentHash(INTENT_HASH);
    assert.equal(byIntent?.receiptId, "rcpt_1");
    assert.ok(!JSON.stringify(byIntent).includes("deposit-secret-address"));

    const onDisk = await readFile(join(directory, "private-store.json"), "utf8");
    assert.ok(onDisk.includes("deposit-secret-address"));
    assert.ok(onDisk.includes(PRIVATE_STORE_VERSION.toString()));
  });
});

test("private store file is 0600 and no temporary file remains", async () => {
  await withStore(async (store, directory) => {
    await store.savePrivateReceipt(receipt({ intentHash: INTENT_HASH }));
    const filePath = join(directory, "private-store.json");
    const entries = await readdir(directory);
    assert.deepEqual(entries, ["private-store.json"]);
    if (process.platform !== "win32") {
      const fileStat = await stat(filePath);
      assert.equal(fileStat.mode & 0o777, 0o600);
      const directoryStat = await stat(directory);
      assert.equal(directoryStat.mode & 0o777, 0o700);
    }
  });
});

test("concurrent saves are serialized without losing updates", async () => {
  await withStore(async (store) => {
    await Promise.all(Array.from({ length: 25 }, (_, index) => store.savePendingPayout(payout(index))));
    const listed = await store.listPendingPayouts();
    assert.equal(listed.length, 25);
    assert.deepEqual(
      listed.map((entry) => entry.payout_id),
      Array.from({ length: 25 }, (_, index) => index),
    );
  });
});

test("duplicate intent hashes and receipt ids are rejected", async () => {
  await withStore(async (store) => {
    await store.savePrivateReceipt(receipt({ intentHash: INTENT_HASH }));
    await assert.rejects(
      store.savePrivateReceipt(receipt({ receiptId: "rcpt_2", intentHash: INTENT_HASH })),
      (error: unknown) => error instanceof PrivateStoreError && error.code === "DUPLICATE_INTENT_HASH",
    );
    await assert.rejects(
      store.savePrivateReceipt(receipt({ intentHash: null, status: "SUCCESS" })),
      (error: unknown) => error instanceof PrivateStoreError && error.code === "DUPLICATE_RECEIPT",
    );
  });
});

test("a corrupt store fails closed instead of returning empty state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subrosa-store-"));
  const filePath = join(directory, "private-store.json");
  try {
    await writeFile(filePath, "{ not json", { encoding: "utf8", mode: 0o600 });
    const store = new PrivateStore({ filePath });
    await assert.rejects(
      store.getPendingPayout("subrosa.testnet", 1),
      (error: unknown) => error instanceof PrivateStoreError && error.code === "CORRUPT_STORE",
    );
    await assert.rejects(
      store.savePendingPayout(payout(1)),
      (error: unknown) => error instanceof PrivateStoreError && error.code === "CORRUPT_STORE",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("store path is configurable through SUBROSA_STORE_PATH", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subrosa-store-"));
  const previous = process.env.SUBROSA_STORE_PATH;
  try {
    process.env.SUBROSA_STORE_PATH = join(directory, "nested", "store.json");
    const store = new PrivateStore();
    assert.equal(store.filePath, resolve(directory, "nested", "store.json"));
    await store.savePendingPayout(payout(1));
    assert.equal((await store.listPendingPayouts()).length, 1);
  } finally {
    if (previous === undefined) {
      delete process.env.SUBROSA_STORE_PATH;
    } else {
      process.env.SUBROSA_STORE_PATH = previous;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
