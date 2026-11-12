import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ConfidentialPayout,
  buildPayoutQuoteRequest,
  buildShieldQuoteRequest,
} from "../src/intents/ConfidentialPayout.js";
import {
  OneClickApiError,
  OneClickClient,
  ONECLICK_PATHS,
  TERMINAL_EXECUTION_STATUSES,
  isPendingExecutionStatus,
  isTerminalExecutionStatus,
  validateQuoteResponse,
  type Nep413Payload,
  type OneClickHttpRequest,
  type OneClickHttpResponse,
  type OneClickTransport,
  type QuoteRequest,
  type QuoteResponse,
  type TokenResponse,
} from "../src/intents/OneClickClient.js";
import { PrivateStore } from "../src/store/PrivateStore.js";
import type { PendingPayout, SignedIntentMessage } from "../src/types.js";

class FakeTransport implements OneClickTransport {
  readonly requests: OneClickHttpRequest[] = [];

  readonly #handler: (request: OneClickHttpRequest) => OneClickHttpResponse<unknown>;

  constructor(handler: (request: OneClickHttpRequest) => OneClickHttpResponse<unknown>) {
    this.#handler = handler;
  }

  async request<T>(request: OneClickHttpRequest): Promise<OneClickHttpResponse<T>> {
    this.requests.push(request);
    const response = this.#handler(request);
    return { status: response.status, data: response.data as T };
  }
}

const TOKEN: TokenResponse = {
  assetId: "nep141:usdc.tokens.testnet",
  decimals: 6,
  blockchain: "near",
  symbol: "USDC",
  price: 1,
  priceUpdatedAt: "2026-01-01T00:00:00.000Z",
  contractAddress: "usdc.tokens.testnet",
};

const INTENT_HASH = "44XpLRAuZKoVGs9T4qbSNv33MDKMePPAibA52geVLWFw";
const PUBLIC_KEY = "ed25519:3YhZ8bH6p8xkZ1GJ7WJ8qQe7mZfM8n9cQe3rTn5xYb7L";
const SIGNATURE = "ed25519:4Zk2mQ9pXw7rT5nB8cV1sL3hJ6fG9dK2aP4uY7eR5tW8qN3mX6bC9vF2hJ5kL8pS1dG4jM7cB2nR5xZ";

function quoteResponse(
  request: QuoteRequest,
  options: {
    depositAddress?: string;
    omitDepositAddress?: boolean;
    amountIn?: string;
    recipient?: string;
    signature?: string;
  } = {},
): QuoteResponse {
  return {
    correlationId: "corr-quote",
    timestamp: "2026-01-01T00:00:00.000Z",
    signature: options.signature ?? "1click-service-signature",
    quoteRequest: {
      ...request,
      ...(options.recipient === undefined ? {} : { recipient: options.recipient }),
    },
    quote: {
      ...(options.omitDepositAddress
        ? {}
        : { depositAddress: options.depositAddress ?? "deposit-secret-address" }),
      amountIn: options.amountIn ?? request.amount,
      amountInFormatted: "1",
      amountInUsd: "1",
      minAmountIn: request.amount,
      amountOut: request.amount,
      amountOutFormatted: "1",
      amountOutUsd: "1",
      minAmountOut: "1",
      timeEstimate: 120,
    },
  };
}

const SHIELD_PARAMS = {
  tokenAssetId: TOKEN.assetId,
  amount: "1000000",
  accountId: "subrosa.testnet",
  dry: false,
  now: new Date("2026-01-01T00:00:00.000Z"),
} as const;

test("1Click path table lists the fourteen OpenAPI paths including orders", () => {
  const paths: readonly string[] = Object.values(ONECLICK_PATHS);
  assert.equal(paths.length, 14);
  assert.equal(new Set(paths).size, 14);
  for (const required of [
    "/v0/quote",
    "/v0/status",
    "/v0/tokens",
    "/v0/generate-intent",
    "/v0/submit-intent",
    "/v0/auth/authenticate",
    "/v0/auth/refresh",
    "/v0/account/balances",
    "/v0/account/history",
    "/v0/orders",
    "/v0/orders/{orderId}",
    "/v0/orders/{orderId}/cancel",
  ]) {
    assert.ok(paths.includes(required), `${required} must be in the path table`);
  }
  assert.ok(!paths.includes("/v0/deposit"));
});

test("shield quote emits every required QuoteRequest field", () => {
  const request = buildShieldQuoteRequest(SHIELD_PARAMS);
  assert.deepEqual(Object.keys(request).sort(), [
    "amount",
    "deadline",
    "depositType",
    "destinationAsset",
    "dry",
    "originAsset",
    "recipient",
    "recipientType",
    "refundTo",
    "refundType",
    "slippageTolerance",
    "swapType",
  ]);
  assert.equal(request.dry, false);
  assert.equal(request.swapType, "EXACT_INPUT");
  assert.equal(request.slippageTolerance, 100);
  assert.equal(request.originAsset, TOKEN.assetId);
  assert.equal(request.destinationAsset, TOKEN.assetId);
  assert.equal(request.depositType, "INTENTS");
  assert.equal(request.recipientType, "CONFIDENTIAL_INTENTS");
  assert.equal(request.refundType, "INTENTS");
  assert.equal(request.recipient, "subrosa.testnet");
  assert.equal(request.refundTo, "subrosa.testnet");
  assert.equal(request.deadline, "2026-01-01T00:03:00.000Z");
});

test("payout quote uses confidential deposit/recipient/refund types and fallbacks", () => {
  const request = buildPayoutQuoteRequest({
    assetId: TOKEN.assetId,
    amount: "2500000",
    recipient: "alice.testnet",
    refundTo: "subrosa.testnet",
    dry: false,
    now: new Date("2026-01-01T00:00:00.000Z"),
  });
  assert.equal(request.depositType, "CONFIDENTIAL_INTENTS");
  assert.equal(request.recipientType, "CONFIDENTIAL_INTENTS");
  assert.equal(request.refundType, "CONFIDENTIAL_INTENTS");
  assert.equal(request.slippageTolerance, 100);

  const publicFallback = buildPayoutQuoteRequest({
    assetId: TOKEN.assetId,
    amount: "1",
    recipient: "alice.testnet",
    refundTo: "subrosa.testnet",
    recipientType: "INTENTS",
    refundType: "INTENTS",
    dry: true,
  });
  assert.equal(publicFallback.recipientType, "INTENTS");
  assert.equal(publicFallback.refundType, "INTENTS");

  const chainFallback = buildPayoutQuoteRequest({
    assetId: TOKEN.assetId,
    amount: "1",
    recipient: "0xAbC0000000000000000000000000000000000001",
    refundTo: "subrosa.testnet",
    recipientType: "DESTINATION_CHAIN",
    dry: false,
  });
  assert.equal(chainFallback.recipientType, "DESTINATION_CHAIN");
});

test("confidentiality accepts only lowercase values", () => {
  const basic = buildPayoutQuoteRequest({
    assetId: TOKEN.assetId,
    amount: "1",
    recipient: "alice.testnet",
    refundTo: "subrosa.testnet",
    dry: true,
    confidentiality: "basic",
  });
  assert.equal(basic.confidentiality, "basic");

  for (const invalid of ["BASIC", "Advanced", "PUBLIC", "secret"] as const) {
    assert.throws(
      () =>
        buildPayoutQuoteRequest({
          assetId: TOKEN.assetId,
          amount: "1",
          recipient: "alice.testnet",
          refundTo: "subrosa.testnet",
          dry: true,
          confidentiality: invalid as never,
        }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "INVALID_CONFIDENTIALITY",
    );
  }
});

test("status helpers classify terminal and pending states", () => {
  for (const status of TERMINAL_EXECUTION_STATUSES) {
    assert.equal(isTerminalExecutionStatus(status), true);
  }
  for (const status of ["PROCESSING", "PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX"]) {
    assert.equal(isPendingExecutionStatus(status), true);
    assert.equal(isTerminalExecutionStatus(status), false);
  }
  assert.equal(isTerminalExecutionStatus("WHAT"), false);
});

test("quote validation rechecks assets, amount, recipient and signature", () => {
  const request = buildShieldQuoteRequest(SHIELD_PARAMS);
  const valid = validateQuoteResponse(request, quoteResponse(request), {
    requireDepositAddress: true,
  });
  assert.equal(valid.depositAddress, "deposit-secret-address");
  assert.equal(valid.signaturePresent, true);

  const dryRequest = buildShieldQuoteRequest({ ...SHIELD_PARAMS, dry: true });
  const dry = validateQuoteResponse(dryRequest, quoteResponse(dryRequest, { omitDepositAddress: true }));
  assert.equal(dry.depositAddress, null);

  assert.throws(
    () =>
      validateQuoteResponse(request, quoteResponse(request, { omitDepositAddress: true }), {
        requireDepositAddress: true,
      }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "QUOTE_DEPOSIT_ADDRESS_MISSING",
  );
  assert.throws(
    () =>
      validateQuoteResponse(request, quoteResponse(request, { recipient: "mallory.testnet" }), {
        requireDepositAddress: true,
      }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "QUOTE_FIELD_MISMATCH",
  );
  assert.throws(
    () =>
      validateQuoteResponse(request, quoteResponse(request, { amountIn: "1" }), {
        requireDepositAddress: true,
      }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "QUOTE_AMOUNT_MISMATCH",
  );
  assert.throws(
    () =>
      validateQuoteResponse(request, quoteResponse(request, { signature: "" }), {
        requireDepositAddress: true,
      }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "QUOTE_SIGNATURE_MISSING",
  );
});

test("client sends partner key and quote body without leaking secrets in errors", async () => {
  const request = buildShieldQuoteRequest(SHIELD_PARAMS);
  let transport: FakeTransport;
  transport = new FakeTransport(() => ({ status: 200, data: quoteResponse(request) }));
  const client = new OneClickClient({
    baseUrl: "https://example.test",
    apiKey: "partner-secret",
    transport,
  });
  const response = await client.getQuote(request);
  assert.equal(response.quote.depositAddress, "deposit-secret-address");
  assert.equal(transport.requests[0]?.headers?.["X-API-Key"], "partner-secret");
  assert.deepEqual(transport.requests[0]?.body, request);

  const secretAddress = `0x${"a".repeat(40)}`;
  const failing = new FakeTransport(() => ({
    status: 401,
    data: { message: `bad deposit ${secretAddress}`, code: "unauthorized", depositAddress: secretAddress },
  }));
  const failingClient = new OneClickClient({
    baseUrl: "https://example.test",
    apiKey: "partner-secret",
    transport: failing,
  });
  await assert.rejects(failingClient.getStatus("deposit-secret-address"), (error: unknown) => {
    assert.ok(error instanceof OneClickApiError);
    assert.equal(error.status, 401);
    const serialized = JSON.stringify(error);
    assert.ok(!serialized.includes("partner-secret"));
    assert.ok(!serialized.includes("deposit-secret-address"));
    assert.ok(!serialized.includes(secretAddress));
    assert.ok(serialized.includes("unauthorized"));
    return true;
  });
});

test("token ids come from /v0/tokens and are cached", async () => {
  const transport = new FakeTransport(() => ({ status: 200, data: [TOKEN] }));
  const client = new OneClickClient({ baseUrl: "https://example.test", apiKey: "", transport });
  const first = await client.getTokens();
  const second = await client.getTokens();
  assert.deepEqual(first, [TOKEN]);
  assert.deepEqual(second, [TOKEN]);
  assert.equal(transport.requests.length, 1);

  assert.equal(await client.resolveNearAssetId("usdc.tokens.testnet"), TOKEN.assetId);
  assert.equal(await client.resolveNearAssetId(TOKEN.assetId), TOKEN.assetId);
  await assert.rejects(
    client.requireAssets(["nep141:not-listed.near"]),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "UNKNOWN_ASSET",
  );

  await client.getTokens({ refresh: true });
  assert.equal(transport.requests.length, 2);
});

test("generate-intent and submit-intent shapes match the OpenAPI schema", async () => {
  const transport = new FakeTransport((request) => {
    if (request.path === ONECLICK_PATHS.generateIntent) {
      return {
        status: 200,
        data: {
          intent: {
            standard: "nep413",
            payload: {
              message: '{"deadline":"2026-01-01T00:05:00.000Z","intents":[],"signer_id":"subrosa.testnet"}',
              nonce: Buffer.alloc(32, 1).toString("base64"),
              recipient: "intents.near",
            },
          },
          correlationId: "corr-generate",
        },
      };
    }
    if (request.path === ONECLICK_PATHS.submitIntent) {
      return { status: 200, data: { intentHash: INTENT_HASH, correlationId: "corr-submit" } };
    }
    return { status: 404, data: { message: "unexpected" } };
  });
  const client = new OneClickClient({ baseUrl: "https://example.test", apiKey: "key", transport });
  const generated = await client.generateIntent({
    signerId: "subrosa.testnet",
    depositAddress: "deposit-secret-address",
  });
  assert.equal(generated.intent.standard, "nep413");
  assert.equal(generated.intent.payload.recipient, "intents.near");
  assert.deepEqual(transport.requests[0]?.body, {
    type: "swap_transfer",
    standard: "nep413",
    signerId: "subrosa.testnet",
    depositAddress: "deposit-secret-address",
  });

  const submitted = await client.submitIntent({
    standard: "nep413",
    payload: generated.intent.payload,
    public_key: PUBLIC_KEY,
    signature: SIGNATURE,
  });
  assert.equal(submitted.intentHash, INTENT_HASH);
  assert.deepEqual(transport.requests[1]?.body, {
    type: "swap_transfer",
    signedData: {
      standard: "nep413",
      payload: generated.intent.payload,
      public_key: PUBLIC_KEY,
      signature: SIGNATURE,
    },
  });
});

test("authenticate, refresh, balances and history use the documented shapes", async () => {
  const signedData = {
    standard: "nep413" as const,
    payload: {
      message: '{"deadline":"2026-01-01T00:05:00.000Z","intents":[],"signer_id":"subrosa.testnet"}',
      nonce: Buffer.alloc(32, 2).toString("base64"),
      recipient: "intents.near",
    },
    public_key: PUBLIC_KEY,
    signature: SIGNATURE,
  };
  const transport = new FakeTransport((request) => {
    if (request.path === ONECLICK_PATHS.authAuthenticate) {
      return {
        status: 200,
        data: { accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 900, refreshExpiresIn: 3600 },
      };
    }
    if (request.path === ONECLICK_PATHS.authRefresh) {
      return { status: 200, data: { accessToken: "access-2", expiresIn: 900 } };
    }
    if (request.path === ONECLICK_PATHS.accountBalances) {
      return {
        status: 200,
        data: { balances: [{ tokenId: TOKEN.assetId, available: "100", source: "private" }] },
      };
    }
    if (request.path === ONECLICK_PATHS.accountHistory) {
      return {
        status: 200,
        data: {
          items: [
            {
              status: "SUCCESS",
              depositType: "CONFIDENTIAL_INTENTS",
              recipientType: "CONFIDENTIAL_INTENTS",
              createdAt: "2026-01-01T00:00:00.000Z",
              depositAddress: "deposit-secret-address",
              depositMemo: null,
              refundType: "CONFIDENTIAL_INTENTS",
            },
          ],
          nextCursor: "next-1",
        },
      };
    }
    return { status: 404, data: { message: "unexpected" } };
  });
  const client = new OneClickClient({ baseUrl: "https://example.test", apiKey: "partner", transport });

  const auth = await client.authenticate(signedData);
  assert.equal(auth.accessToken, "access-1");
  assert.deepEqual(transport.requests[0]?.body, { signedData });

  const refreshed = await client.refresh("refresh-1");
  assert.equal(refreshed.accessToken, "access-2");

  const balances = await client.getBalances("access-2", [TOKEN.assetId]);
  assert.equal(balances.balances[0]?.available, "100");
  assert.equal(transport.requests[2]?.headers?.Authorization, "Bearer access-2");
  assert.equal(transport.requests[2]?.query?.tokenIds, TOKEN.assetId);

  const history = await client.getHistory("access-2", { nextCursor: "next-0", status: ["SUCCESS"] });
  assert.equal(history.items[0]?.status, "SUCCESS");
  assert.equal(history.nextCursor, "next-1");
  assert.deepEqual(transport.requests[3]?.query?.status, ["SUCCESS"]);
});

test("executePendingPayout signs the exact generated payload and keeps the deposit address private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subrosa-intents-"));
  const store = new PrivateStore({ filePath: join(directory, "private-store.json") });
  const payout: PendingPayout = {
    employer: "subrosa.testnet",
    payout_id: 3,
    employee: "alice.testnet",
    amount: "1000000",
    salt: "00".repeat(32),
    asset: "usdc.tokens.testnet",
    memo: "salary",
    commitment_hash: "a".repeat(64),
  };
  await store.savePendingPayout(payout);

  const generatedPayload: Nep413Payload = {
    message: '{"deadline":"2026-01-01T00:05:00.000Z","intents":[],"signer_id":"subrosa.testnet"}',
    nonce: Buffer.alloc(32, 3).toString("base64"),
    recipient: "intents.near",
  };
  let statusCalls = 0;
  const transport = new FakeTransport((request) => {
    if (request.path === ONECLICK_PATHS.tokens) {
      return { status: 200, data: [TOKEN] };
    }
    if (request.path === ONECLICK_PATHS.quote) {
      const quoteRequest = request.body as QuoteRequest;
      return { status: 200, data: quoteResponse(quoteRequest) };
    }
    if (request.path === ONECLICK_PATHS.generateIntent) {
      return {
        status: 200,
        data: {
          intent: { standard: "nep413", payload: generatedPayload },
          correlationId: "corr-generate",
        },
      };
    }
    if (request.path === ONECLICK_PATHS.submitIntent) {
      return { status: 200, data: { intentHash: INTENT_HASH, correlationId: "corr-submit" } };
    }
    if (request.path === ONECLICK_PATHS.status) {
      statusCalls += 1;
      return {
        status: 200,
        data: {
          correlationId: "corr-status",
          quoteResponse: {},
          status: statusCalls === 1 ? "PENDING_DEPOSIT" : "SUCCESS",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
      };
    }
    return { status: 404, data: { message: "unexpected" } };
  });

  const signedPayloads: Nep413Payload[] = [];
  const signer: { signerId: string; signPayload: (payload: Nep413Payload) => Promise<SignedIntentMessage> } = {
    signerId: "subrosa.testnet",
    async signPayload(payload: Nep413Payload): Promise<SignedIntentMessage> {
      signedPayloads.push(payload);
      return { publicKey: PUBLIC_KEY, signature: SIGNATURE };
    },
  };
  const client = new OneClickClient({ baseUrl: "https://example.test", apiKey: "partner", transport });
  const payoutEngine = new ConfidentialPayout(client, signer, {
    store,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    receiptIdFactory: () => "rcpt_test_1",
    poll: { intervalMs: 1, timeoutMs: 1000, sleep: async () => undefined },
  });

  try {
    const result = await payoutEngine.executePendingPayout(payout);
    assert.deepEqual(result, { intentHash: INTENT_HASH });
    assert.equal(signedPayloads.length, 1);
    assert.deepEqual(signedPayloads[0], generatedPayload);

    const generated = transport.requests.find((request) => request.path === ONECLICK_PATHS.generateIntent);
    assert.deepEqual(generated?.body, {
      type: "swap_transfer",
      standard: "nep413",
      signerId: "subrosa.testnet",
      depositAddress: "deposit-secret-address",
    });
    const submitted = transport.requests.find((request) => request.path === ONECLICK_PATHS.submitIntent);
    const submitBody = submitted?.body as { signedData: { payload: Nep413Payload } };
    assert.deepEqual(submitBody.signedData.payload, generatedPayload);

    const receipt = await store.getReceiptByIntentHash(INTENT_HASH);
    assert.ok(receipt);
    assert.equal(receipt.status, "SUCCESS");
    assert.ok(!("depositAddress" in receipt));
    assert.ok(!("depositMemo" in receipt));
    assert.ok(!JSON.stringify(receipt).includes("deposit-secret-address"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("executePendingPayout rejects an entry missing from the private store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subrosa-intents-"));
  const store = new PrivateStore({ filePath: join(directory, "private-store.json") });
  const transport = new FakeTransport(() => ({ status: 500, data: { message: "unused" } }));
  const client = new OneClickClient({ baseUrl: "https://example.test", apiKey: "", transport });
  const payoutEngine = new ConfidentialPayout(
    client,
    { signerId: "subrosa.testnet", signPayload: async () => ({ publicKey: PUBLIC_KEY, signature: SIGNATURE }) },
    { store },
  );
  const entry: PendingPayout = {
    employer: "subrosa.testnet",
    payout_id: 1,
    employee: "alice.testnet",
    amount: "1",
    salt: "00",
    asset: "usdc.tokens.testnet",
    memo: "",
    commitment_hash: "b".repeat(64),
  };
  try {
    await assert.rejects(
      payoutEngine.executePendingPayout(entry),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "PAYOUT_NOT_STORED",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
