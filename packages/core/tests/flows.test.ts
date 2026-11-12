import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { baseEncode, type Provider } from "near-api-js";

import {
  AuditWriteError,
  FastDataAuditWriter,
  SocialAuditWriter,
  buildSettlementAuditEntry,
} from "../src/audit/socialAudit.js";
import { commitmentHash } from "../src/crypto/hashUtils.js";
import { NearConfigPresets } from "../src/config.js";
import { AuditorDisclosureExporter, DISCLOSURE_CSV_COLUMNS } from "../src/flows/auditorDisclosure.js";
import { PrivatePayoutFlow, PrivatePayoutFlowError } from "../src/flows/privatePayout.js";
import { EventCursor } from "../src/indexer/EventCursor.js";
import {
  EventIndexerError,
  IdempotentEventProcessor,
} from "../src/indexer/IdempotentEventProcessor.js";
import {
  BackendAuthError,
  BackendAuthVerifier,
} from "../src/intents/backendAuth.js";
import { ConfidentialPayout } from "../src/intents/ConfidentialPayout.js";
import {
  OneClickApiError,
  OneClickClient,
  ONECLICK_PATHS,
  type Nep413Payload,
} from "../src/intents/OneClickClient.js";
import { createNearClients } from "../src/near/client.js";
import { NearContractWrapper } from "../src/near/NearContractWrapper.js";
import { PayoutClient } from "../src/near/PayoutClient.js";
import { PrivateStore } from "../src/store/PrivateStore.js";
import { EVENT_JSON_PREFIX } from "../src/events/nep297.js";
import {
  FakeNearContract,
  MOCK_PUBLIC_KEY,
  MOCK_SIGNATURE,
  MockOneClickTransport,
} from "../src/testing/mocks.js";
import type { SignedIntentMessage } from "../src/types.js";
import type {
  NearWalletBase,
  NearConnector,
  SignMessageParams,
} from "@hot-labs/near-connect";
import { NearWalletSigner } from "../src/wallet/NearWalletSigner.js";
import { createSettlementReceipt } from "../src/settlement/receipt.js";

const EMPLOYER = "employer.near";
const EMPLOYEE = "alice.near";
const TOKEN = "usdc.testnet";
const ASSET = "usdc.testnet";
const SALT = "deadbeef";
const AMOUNT = 1_000_000n;
const CYCLE_ID = 3;
const COMMITMENT = commitmentHash({
  employer: EMPLOYER,
  employee: EMPLOYEE,
  token: TOKEN,
  cycleId: CYCLE_ID,
  amount: AMOUNT,
  salt: SALT,
});
const HEX_HASH = "c".repeat(64);
const TX_HASH = "44XpLRAuZKoVGs9T4qbSNv33MDKMePPAibA52geVLWFw";

function fakeSigner(signedPayloads: Nep413Payload[] = []): {
  signerId: string;
  signPayload(payload: Nep413Payload): Promise<SignedIntentMessage>;
} {
  return {
    signerId: EMPLOYER,
    async signPayload(payload: Nep413Payload): Promise<SignedIntentMessage> {
      signedPayloads.push(payload);
      return { publicKey: MOCK_PUBLIC_KEY, signature: MOCK_SIGNATURE };
    },
  };
}

interface Harness {
  directory: string;
  store: PrivateStore;
  transport: MockOneClickTransport;
  fake: FakeNearContract;
  flow: PrivatePayoutFlow;
  payoutClient: PayoutClient;
  client: OneClickClient;
}

async function harness(options: {
  statuses?: readonly string[];
  receiptId?: string;
} = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "subrosa-flow-"));
  const store = new PrivateStore({ filePath: join(directory, "private-store.json") });
  const transport = new MockOneClickTransport({
    statuses: options.statuses ?? ["SUCCESS"],
  });
  const client = new OneClickClient({
    baseUrl: "https://mock.oneclick.test",
    apiKey: "test-key",
    transport,
    now: () => 0,
  });
  const fake = new FakeNearContract({ callerId: EMPLOYER });
  const wrapper = new NearContractWrapper(
    NearConfigPresets.testnet({ contractId: "subrosa.testnet" }),
    { account: fake.account, provider: fake.provider },
  );
  const payoutClient = new PayoutClient(wrapper);
  let receiptCounter = 0;
  const engine = new ConfidentialPayout(client, fakeSigner(), {
    store,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    receiptIdFactory: () => options.receiptId ?? `rcpt_flow_${++receiptCounter}`,
    poll: { intervalMs: 1, timeoutMs: 1000, sleep: async () => undefined },
  });
  const flow = new PrivatePayoutFlow({
    store,
    engine,
    payouts: payoutClient,
  });
  return { directory, store, transport, fake, flow, payoutClient, client };
}

async function schedule(harnessValue: Harness): Promise<number> {
  const result = await harnessValue.flow.schedule({
    employer: EMPLOYER,
    employee: EMPLOYEE,
    cycleId: CYCLE_ID,
    token: TOKEN,
    asset: ASSET,
    commitmentHash: COMMITMENT,
    amount: AMOUNT,
    salt: SALT,
    memo: "November salary",
    executeAt: 1,
  });
  return result.payoutId;
}

test("flow schedules, settles SUCCESS, and does not re-pay on replay", async () => {
  const setup = await harness();
  try {
    const payoutId = await schedule(setup);
    const settled = await setup.flow.execute({ employer: EMPLOYER, payoutId });
    assert.equal(settled.state, "settled");
    assert.equal(settled.commitmentHash, COMMITMENT);
    assert.equal(setup.fake.payout(EMPLOYER, payoutId)?.state, "Executed");
    assert.equal(setup.fake.payout(EMPLOYER, payoutId)?.intent_hash, settled.intentHash);
    assert.equal(setup.transport.countRequests("POST", ONECLICK_PATHS.submitIntent), 1);

    const submits = setup.transport.countRequests("POST", ONECLICK_PATHS.submitIntent);
    const replay = new PrivatePayoutFlow({
      store: setup.store,
      engine: new ConfidentialPayout(setup.client, fakeSigner(), {
        store: setup.store,
        poll: { intervalMs: 1, timeoutMs: 1000, sleep: async () => undefined },
      }),
      payouts: setup.payoutClient,
    });
    const replayed = await replay.execute({ employer: EMPLOYER, payoutId });
    assert.equal(replayed.intentHash, settled.intentHash);
    assert.equal(setup.transport.countRequests("POST", ONECLICK_PATHS.submitIntent), submits);
  } finally {
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test("flow marks FAILED and REFUNDED payouts failed once", async () => {
  for (const status of ["FAILED", "REFUNDED"] as const) {
    const setup = await harness({ statuses: [status] });
    try {
      const payoutId = await schedule(setup);
      await assert.rejects(
        () => setup.flow.execute({ employer: EMPLOYER, payoutId }),
        (error: unknown) =>
          error instanceof PrivatePayoutFlowError &&
          error.code === (status === "FAILED" ? "PAYOUT_FAILED" : "PAYOUT_REFUNDED") &&
          error.terminalStatus === status,
      );
      assert.equal(setup.fake.payout(EMPLOYER, payoutId)?.state, "Failed");
      const submits = setup.transport.countRequests("POST", ONECLICK_PATHS.submitIntent);

      const replay = new PrivatePayoutFlow({
        store: setup.store,
        engine: new ConfidentialPayout(setup.client, fakeSigner(), {
          store: setup.store,
          poll: { intervalMs: 1, timeoutMs: 1000, sleep: async () => undefined },
        }),
        payouts: setup.payoutClient,
      });
      await assert.rejects(
        () => replay.execute({ employer: EMPLOYER, payoutId }),
        (error: unknown) =>
          error instanceof PrivatePayoutFlowError &&
          (error.code === "PAYOUT_FAILED" || error.code === "PAYOUT_REFUNDED"),
      );
      assert.equal(setup.transport.countRequests("POST", ONECLICK_PATHS.submitIntent), submits);
    } finally {
      await rm(setup.directory, { recursive: true, force: true });
    }
  }
});

test("flow surfaces INCOMPLETE_DEPOSIT without mark_failed and without a retry", async () => {
  const setup = await harness({ statuses: ["INCOMPLETE_DEPOSIT"] });
  try {
    const payoutId = await schedule(setup);
    await assert.rejects(
      () => setup.flow.execute({ employer: EMPLOYER, payoutId }),
      (error: unknown) =>
        error instanceof PrivatePayoutFlowError &&
        error.code === "PAYOUT_INCOMPLETE_DEPOSIT" &&
        error.terminalStatus === "INCOMPLETE_DEPOSIT",
    );
    assert.equal(setup.fake.payout(EMPLOYER, payoutId)?.state, "Pending");
    assert.equal(setup.transport.countRequests("POST", ONECLICK_PATHS.submitIntent), 1);
  } finally {
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test("resume returns pending without a deposit reference and never submits again", async () => {
  const setup = await harness();
  try {
    const payoutId = await seedSubmittedPayout(setup);
    const requestsBefore = setup.transport.requests.length;
    const pending = await setup.flow.resume({
      employer: EMPLOYER,
      payoutId,
      intentHash: HEX_HASH,
    });
    assert.equal(pending.state, "pending");
    if (pending.state === "pending") {
      assert.equal(pending.status, "PENDING_DEPOSIT");
      assert.equal(pending.referenceRequired, true);
    }
    assert.equal(setup.transport.requests.length, requestsBefore);
    assert.equal(setup.fake.payout(EMPLOYER, payoutId)?.state, "Pending");

    const settled = await setup.flow.resume({
      employer: EMPLOYER,
      payoutId,
      intentHash: HEX_HASH,
      depositAddress: "deposit-mock-resume",
    });
    assert.equal(settled.state, "settled");
    assert.equal(setup.fake.payout(EMPLOYER, payoutId)?.state, "Executed");
    assert.equal(setup.transport.countRequests("POST", ONECLICK_PATHS.submitIntent), 0);
  } finally {
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test("resume rejects a receipt that belongs to another payout", async () => {
  const setup = await harness();
  try {
    const firstPayout = await schedule(setup);
    const secondPayout = await schedule(setup);
    await setup.store.savePrivateReceipt({
      receiptId: "rcpt_other_payout",
      payrollId: `payout:${EMPLOYER}:${firstPayout}`,
      employer: EMPLOYER,
      employee: EMPLOYEE,
      intentHash: "e".repeat(64),
      commitmentHash: COMMITMENT,
      amount: AMOUNT.toString(),
      asset: TOKEN,
      depositAddress: "deposit-other-payout",
      status: "PENDING_DEPOSIT",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await assert.rejects(
      () =>
        setup.flow.resume({
          employer: EMPLOYER,
          payoutId: secondPayout,
          receiptId: "rcpt_other_payout",
        }),
      (error: unknown) =>
        error instanceof PrivatePayoutFlowError && error.code === "PAYOUT_STORE_MISMATCH",
    );
    await assert.rejects(
      () =>
        setup.flow.resume({
          employer: EMPLOYER,
          payoutId: secondPayout,
          intentHash: "e".repeat(64),
        }),
      (error: unknown) =>
        error instanceof PrivatePayoutFlowError && error.code === "PAYOUT_STORE_MISMATCH",
    );
  } finally {
    await rm(setup.directory, { recursive: true, force: true });
  }
});

async function seedSubmittedPayout(setup: Harness): Promise<number> {
  const payoutId = await schedule(setup);
  await setup.store.savePrivateReceipt({
    receiptId: "rcpt_pending_resume",
    payrollId: `payout:${EMPLOYER}:${payoutId}`,
    employer: EMPLOYER,
    employee: EMPLOYEE,
    intentHash: HEX_HASH,
    commitmentHash: COMMITMENT,
    amount: AMOUNT.toString(),
    asset: TOKEN,
    depositAddress: "deposit-mock-resume",
    quoteSignature: "quote-signature",
    correlationId: "corr-resume",
    status: "PENDING_DEPOSIT",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  return payoutId;
}

test("execute refuses an in-flight receipt instead of submitting a second intent", async () => {
  const setup = await harness();
  try {
    const payoutId = await seedSubmittedPayout(setup);
    const requestsBefore = setup.transport.requests.length;
    await assert.rejects(
      () => setup.flow.execute({ employer: EMPLOYER, payoutId }),
      (error: unknown) =>
        error instanceof PrivatePayoutFlowError && error.code === "PAYOUT_RESUME_REQUIRED",
    );
    assert.equal(setup.transport.requests.length, requestsBefore);
    assert.equal(setup.transport.countRequests("POST", ONECLICK_PATHS.submitIntent), 0);
  } finally {
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test("auditor CSV is deterministic, hash-only, and omits deposit references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subrosa-csv-"));
  const store = new PrivateStore({ filePath: join(directory, "private-store.json") });
  try {
    await store.savePrivateReceipt({
      receiptId: "rcpt_csv",
      payrollId: `payout:${EMPLOYER}:1`,
      employer: EMPLOYER,
      employee: EMPLOYEE,
      intentHash: HEX_HASH,
      commitmentHash: COMMITMENT,
      amount: AMOUNT.toString(),
      asset: TOKEN,
      depositAddress: "deposit-secret-address",
      depositMemo: "deposit-secret-memo",
      status: "SUCCESS",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    const session = {
      signerId: EMPLOYER,
      async getHistory() {
        return {
          items: [
            {
              status: "=SUM(A1)",
              createdAt: "2026-01-02T00:00:00.000Z",
              destinationAsset: TOKEN,
              recipient: EMPLOYEE,
              amount: "1.25",
              intentHash: HEX_HASH,
              source: "remote" as const,
            },
          ],
          source: "remote" as const,
          degraded: false,
        };
      },
    };
    const exporter = new AuditorDisclosureExporter({ session, store });
    const first = await exporter.export({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-31T23:59:59.999Z",
    });
    const second = await exporter.export({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-31T23:59:59.999Z",
    });
    assert.equal(first.csv, second.csv);
    assert.equal(first.rowCount, 1);
    assert.equal(first.source, "remote+local");
    assert.equal(first.csv.split("\n")[0], DISCLOSURE_CSV_COLUMNS.join(","));
    assert.ok(first.csv.includes(AMOUNT.toString()));
    assert.ok(first.csv.includes("1.25"));
    assert.ok(first.csv.includes("'=SUM(A1)"));
    assert.ok(first.csv.includes(COMMITMENT));
    assert.ok(!first.csv.includes("deposit-secret"));
    assert.ok(!first.csv.includes(EMPLOYEE));
    assert.ok(!first.csv.includes(EMPLOYER));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("auditor CSV falls back to local receipts on 403", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subrosa-csv-403-"));
  const store = new PrivateStore({ filePath: join(directory, "private-store.json") });
  try {
    await store.savePrivateReceipt({
      receiptId: "rcpt_csv_403",
      payrollId: `payout:${EMPLOYER}:2`,
      employer: EMPLOYER,
      employee: EMPLOYEE,
      intentHash: "d".repeat(64),
      commitmentHash: COMMITMENT,
      amount: AMOUNT.toString(),
      asset: TOKEN,
      depositAddress: "deposit-secret-address",
      status: "SUCCESS",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    const session = {
      signerId: EMPLOYER,
      async getHistory(): Promise<never> {
        throw new OneClickApiError(403, "GET", ONECLICK_PATHS.accountHistory, {
          message: "invite only",
        });
      },
    };
    const exporter = new AuditorDisclosureExporter({ session, store });
    const result = await exporter.export({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-31T23:59:59.999Z",
    });
    assert.equal(result.source, "local-receipts");
    assert.equal(result.degraded, true);
    assert.equal(result.rowCount, 1);
    assert.ok(result.csv.includes(COMMITMENT));
    assert.ok(!result.csv.includes("deposit-secret"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("backend auth rejects a function-call key before any signature check", async () => {
  const nonce = Buffer.alloc(32, 1).toString("base64");
  const request = {
    signerAccountId: EMPLOYER,
    publicKey: `ed25519:${baseEncode(Buffer.alloc(32, 2))}`,
    message: "subrosa backend login 2026-01-01",
    recipient: "subrosa.testnet",
    nonce,
    signature: `ed25519:${baseEncode(Buffer.alloc(64, 3))}`,
  };
  const provider = {
    async viewAccessKey() {
      return {
        nonce: 1n,
        permission: {
          FunctionCall: {
            receiver_id: "subrosa.testnet",
            method_names: ["commit_salary"],
            allowance: "1000000000000000000000000",
          },
        },
        block_hash: "11111111111111111111111111111111",
        block_height: 1,
      };
    },
  };
  const verifier = new BackendAuthVerifier({
    recipient: "subrosa.testnet",
    provider: provider as unknown as Provider,
  });
  await assert.rejects(
    () => verifier.verify(request),
    (error: unknown) =>
      error instanceof BackendAuthError &&
      error.code === "FULL_ACCESS_KEY_REQUIRED" &&
      !error.message.includes(request.publicKey),
  );

  const unavailable = new BackendAuthVerifier({
    recipient: "subrosa.testnet",
    provider: {
      async viewAccessKey(): Promise<never> {
        throw new Error("rpc unavailable");
      },
    } as unknown as Provider,
  });
  await assert.rejects(
    () => unavailable.verify(request),
    (error: unknown) =>
      error instanceof BackendAuthError && error.code === "ACCESS_KEY_LOOKUP_FAILED",
  );

  const wrongRecipient = new BackendAuthVerifier({
    recipient: "other.testnet",
    provider: provider as unknown as Provider,
  });
  await assert.rejects(
    () => wrongRecipient.verify(request),
    (error: unknown) =>
      error instanceof BackendAuthError && error.code === "RECIPIENT_MISMATCH",
  );
});

test("indexer checkpoint makes replayed blocks idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subrosa-indexer-"));
  const cursor = new EventCursor({ filePath: join(directory, "cursor.json") });
  try {
    const handled: string[] = [];
    const processor = new IdempotentEventProcessor({
      cursor,
      handler: (event) => {
        handled.push(event.id);
      },
    });
    const log = eventLog("EmployeeRegistered", [
      {
        employer: EMPLOYER,
        employee: EMPLOYEE,
        token: TOKEN,
        commitment_hash: HEX_HASH,
        at_ns: "1712345678901234567",
      },
    ]);

    const first = await processor.processBlock(10, ["ordinary debug log", log]);
    assert.equal(first.parsed, 1);
    assert.equal(first.processed, 1);
    assert.equal(first.skipped, 0);

    const replay = await processor.processBlock(10, ["ordinary debug log", log]);
    assert.equal(replay.processed, 0);
    assert.equal(replay.skipped, 1);
    assert.deepEqual(handled, ["10:1"]);

    const reloadedCursor = new EventCursor({ filePath: join(directory, "cursor.json") });
    const afterRestart = new IdempotentEventProcessor({
      cursor: reloadedCursor,
      handler: (event) => {
        handled.push(event.id);
      },
    });
    await afterRestart.processBlock(10, ["ordinary debug log", log]);
    assert.deepEqual(handled, ["10:1"]);

    const secondLog = eventLog("EmployeeUpdated", [
      {
        employer: EMPLOYER,
        employee: EMPLOYEE,
        commitment_hash: HEX_HASH,
        active: true,
        at_ns: "1712345678901234568",
      },
    ]);
    const next = await afterRestart.processBlock(11, [secondLog]);
    assert.equal(next.processed, 1);
    assert.deepEqual(handled, ["10:1", "11:0"]);

    const badLog = `${EVENT_JSON_PREFIX}{"standard":"subrosa","version":"1.0.0","event":"Nope","data":[]}`;
    await assert.rejects(
      () => afterRestart.processBlock(12, [badLog]),
      (error: unknown) => error instanceof EventIndexerError && error.code === "EVENT_PARSE_FAILED",
    );
    const checkpoint = await reloadedCursor.load();
    assert.equal(checkpoint.blockHeight, 11);
    assert.equal(checkpoint.logIndex, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("indexer retains the checkpoint when a handler fails and retries only that event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subrosa-indexer-fail-"));
  const cursor = new EventCursor({ filePath: join(directory, "cursor.json") });
  try {
    let fail = true;
    const handled: string[] = [];
    const processor = new IdempotentEventProcessor({
      cursor,
      handler: (event) => {
        if (fail) throw new Error("handler down");
        handled.push(event.id);
      },
    });
    const log = eventLog("EmployeeRegistered", [
      {
        employer: EMPLOYER,
        employee: EMPLOYEE,
        token: TOKEN,
        commitment_hash: HEX_HASH,
        at_ns: "1712345678901234567",
      },
    ]);
    await assert.rejects(
      () => processor.processBlock(5, [log]),
      (error: unknown) => error instanceof EventIndexerError && error.code === "EVENT_HANDLER_FAILED",
    );
    assert.equal((await cursor.load()).blockHeight, 0);
    fail = false;
    const retried = await processor.processBlock(5, [log]);
    assert.equal(retried.processed, 1);
    assert.deepEqual(handled, ["5:0"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("near client factory wires all typed clients", async () => {
  const fake = new FakeNearContract();
  const clients = createNearClients(NearConfigPresets.testnet(), {
    account: fake.account,
    provider: fake.provider,
  });
  assert.equal(clients.wrapper.contractId, "subrosa.testnet");
  assert.ok(clients.registry instanceof Object);
  assert.ok(clients.commitments instanceof Object);
  assert.ok(clients.payouts instanceof Object);
  assert.ok(clients.holds instanceof Object);
  assert.ok(clients.verificationKeys instanceof Object);
});

test("NearWalletSigner signs the exact NEP-413 payload", async () => {
  const seen: SignMessageParams[] = [];
  const wallet: NearWalletBase = {
    manifest: {
      id: "test-wallet",
      platform: ["web"],
      name: "Test",
      icon: "",
      description: "",
      website: "",
      version: "1",
      executor: "",
      type: "injected",
      permissions: {},
      features: {
        signMessage: true,
        signTransaction: true,
        signAndSendTransaction: true,
        signAndSendTransactions: true,
        signInWithoutAddKey: true,
        signInAndSignMessage: true,
        signInWithFunctionCallKey: false,
        signDelegateActions: false,
        mainnet: true,
        testnet: true,
      },
    },
    async signIn() {
      return [{ accountId: EMPLOYER }];
    },
    async signInAndSignMessage() {
      return [];
    },
    async signOut() {},
    async getAccounts() {
      return [{ accountId: EMPLOYER, publicKey: MOCK_PUBLIC_KEY }];
    },
    async signAndSendTransaction() {
      throw new Error("not used");
    },
    async signAndSendTransactions() {
      return [];
    },
    async signMessage(params) {
      seen.push(params);
      return {
        accountId: EMPLOYER,
        publicKey: MOCK_PUBLIC_KEY,
        signature: MOCK_SIGNATURE.slice(MOCK_SIGNATURE.indexOf(":") + 1),
      };
    },
    async signDelegateActions() {
      return { signedDelegateActions: [] };
    },
  };
  const connector = {
    async connect() {
      return wallet;
    },
    async getConnectedWallet() {
      return { wallet, accounts: [{ accountId: EMPLOYER }] };
    },
  } as unknown as NearConnector;

  const signer = new NearWalletSigner({ connector, network: "testnet" });
  const accounts = await signer.connect();
  assert.deepEqual(accounts, [{ accountId: EMPLOYER, publicKey: MOCK_PUBLIC_KEY }]);
  const payload: Nep413Payload = {
    message: '{"deadline":"2026-01-01T00:05:00.000Z","intents":[],"signer_id":"employer.near"}',
    nonce: Buffer.alloc(32, 7).toString("base64"),
    recipient: "intents.near",
  };
  const signed = await signer.signPayload(payload);
  assert.equal(signed.publicKey, MOCK_PUBLIC_KEY);
  assert.equal(signed.signature, MOCK_SIGNATURE);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].message, payload.message);
  assert.deepEqual(seen[0].nonce, Buffer.alloc(32, 7));
});

test("social audit writer stores only hashes and rejects secret fields", async () => {
  const receipt = createSettlementReceipt({
    receiptId: "rcpt_audit",
    payrollId: "payroll-1",
    intentHash: HEX_HASH,
    commitmentHash: COMMITMENT,
    status: "SUCCESS",
    issuedAt: "2026-01-01T00:00:00.000Z",
    settledAt: "2026-01-01T00:00:01.000Z",
  });
  const entry = buildSettlementAuditEntry(receipt);
  const writes: unknown[] = [];
  const social = {
    async set(options: unknown) {
      writes.push(options);
      return { async send() {} };
    },
  };
  const writer = new SocialAuditWriter({ social });
  const result = await writer.write(entry);
  assert.ok(result.key.endsWith(result.entryId));
  assert.equal(writes.length, 1);
  assert.ok(!JSON.stringify(writes[0]).includes("deposit"));
  assert.ok(!JSON.stringify(writes[0]).includes("amount"));
  await assert.rejects(
    () => writer.write({ ...entry, depositAddress: "secret" } as never),
    (error: unknown) => error instanceof AuditWriteError && error.code === "INVALID_ENTRY",
  );
});

test("FastData writer treats CodeDoesNotExist as success after api2 confirmation", async () => {
  const receipt = createSettlementReceipt({
    receiptId: "rcpt_fastdata",
    payrollId: "payroll-2",
    intentHash: HEX_HASH,
    commitmentHash: COMMITMENT,
    status: "SUCCESS",
    issuedAt: "2026-01-01T00:00:00.000Z",
  });
  const entry = buildSettlementAuditEntry(receipt);
  let calls = 0;
  let gas: bigint | undefined;
  let deposit: bigint | undefined;
  const account = {
    async callFunctionRaw(params: {
      gas?: bigint;
      deposit?: bigint;
      methodName: string;
    }): Promise<never> {
      calls += 1;
      gas = params.gas;
      deposit = params.deposit;
      assert.equal(params.methodName, "__fastdata_kv");
      const error = new Error("CodeDoesNotExist");
      error.name = "ContractCodeDoesNotExistError";
      Object.assign(error, {
        transactionResult: { transaction_outcome: { id: TX_HASH } },
      });
      throw error;
    },
  };
  const writer = new FastDataAuditWriter({
    account,
    confirm: async (txHash) => {
      assert.equal(txHash, TX_HASH);
      return { indexed: true, accepted: true };
    },
  });
  const result = await writer.write(entry);
  assert.equal(result.txHash, TX_HASH);
  assert.equal(calls, 1, "CodeDoesNotExist must never be retried");
  assert.equal(gas, 1n);
  assert.equal(deposit, 0n);
});

function eventLog(event: string, data: unknown[]): string {
  return `${EVENT_JSON_PREFIX}${JSON.stringify({
    standard: "subrosa",
    version: "1.0.0",
    event,
    data,
  })}`;
}
