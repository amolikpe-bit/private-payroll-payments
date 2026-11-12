/**
 * Zero-funds Confidential Intents demo (PIN 3, dry-run).
 *
 * What it proves, with no wallet, no API key, and no deposit:
 *   1. three employee commitments are built from client-side amounts + salts;
 *   2. the payroll batch passes the SDK's batch validation;
 *   3. the confidential dry-quote path is exercised through `OneClickClient`
 *      (and `preflightPayout`), including an explicit, typed assertion of
 *      1Click's live User-Session gate when no session token is available;
 *   4. a public same-asset dry quote validates the quote wire format;
 *   5. a simulated transport interruption resumes from an opaque resume token;
 *   6. amount, salt, employee and deposit-address fields are redacted.
 *
 * It fails closed if a quote is not dry, if a quote carries a deposit address,
 * if 1Click returns an unexpected error (including a rejected session token),
 * or if any secret appears in printed output. It never signs, never submits a
 * transaction, and never moves funds.
 *
 * 1Click currently rejects confidential quotes without a User-Session token
 * (HTTP 401 "User authentication is required for confidential intent quotes").
 * Without `ONECLICK_USER_SESSION` this demo asserts that gate, then validates
 * the confidential payout requests locally and runs a public dry quote. With a
 * valid token, it requires the confidential dry quotes to succeed instead.
 *
 * Requires network access to the 1Click API.
 *
 * Run: npm run build && node scripts/demo.ts
 */

import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BatchPayloadBuilder,
  ConfidentialPayout,
  NearConfigPresets,
  OneClickApiError,
  OneClickClient,
  PrivateStore,
  buildPayoutQuoteRequest,
  commitmentHash,
  readQuoteDepositAddress,
  redactDeep,
  redactError,
  submitSequentialPayrollBatches,
  validateQuoteRequest,
  type BatchPaymentEntry,
  type IntentPayloadSigner,
  type OneClickHttpRequest,
  type OneClickHttpResponse,
  type OneClickTransport,
  type PendingPayout,
  type QuoteRequest,
  type QuoteResponse,
  type SignedIntentMessage,
  type TokenResponse,
} from "near-subrosa-core";

const EMPLOYER = "subrosa.testnet";
const EMPLOYEES = ["alice-demo.testnet", "bob-demo.testnet", "carol-demo.testnet"] as const;
const AMOUNTS = [1_250_000n, 2_400_000n, 3_100_000n] as const;
const CYCLE_ID = 1;
const TOTAL_STAGES = 9;
const DEMO_TIMEOUT_MS = 30_000;
const USDC_NEAR_CONTRACTS = [
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "usdc.near",
] as const;

class DemoError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DemoError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new DemoError(code, message);
}

const secrets = new Set<string>();

function assertNoSecrets(text: string): void {
  for (const secret of secrets) {
    if (secret.length > 0 && text.includes(secret)) {
      fail("SECRET_LEAK", "A private value reached demo output; refusing to print it.");
    }
  }
}

function stage(index: number, title: string, detail: string): void {
  const line = `[${index}/${TOTAL_STAGES}] ${title}: ${detail}`;
  assertNoSecrets(line);
  console.log(line);
}

/**
 * fetch-based 1Click transport. The only difference from the SDK default is
 * that an optional User-Session access token is attached as a bearer header;
 * with no token the requests are anonymous.
 */
class DemoSessionTransport implements OneClickTransport {
  readonly #baseUrl: string;
  readonly #accessToken: string | undefined;

  constructor(baseUrl: string, accessToken: string | undefined) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#accessToken = accessToken;
  }

  async request<T>(request: OneClickHttpRequest): Promise<OneClickHttpResponse<T>> {
    const url = new URL(`${this.#baseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value === undefined) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(key, String(item));
        }
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    const headers: Record<string, string> = { ...(request.headers ?? {}) };
    if (this.#accessToken !== undefined && headers.authorization === undefined) {
      headers.authorization = `Bearer ${this.#accessToken}`;
    }
    if (
      request.body !== undefined &&
      !Object.keys(headers).some((name) => name.toLowerCase() === "content-type")
    ) {
      headers["content-type"] = "application/json";
    }
    const response = await fetch(url, {
      method: request.method,
      headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: AbortSignal.timeout(request.timeoutMs ?? DEMO_TIMEOUT_MS),
    });
    const text = await response.text();
    let data: unknown = undefined;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: response.status, data: data as T };
  }
}

/**
 * A signer that cannot sign. `preflightPayout` never calls it; if a future code
 * path attempts to move funds, the demo fails instead of signing.
 */
const REFUSING_SIGNER: IntentPayloadSigner = {
  signerId: EMPLOYER,
  async signPayload(): Promise<SignedIntentMessage> {
    fail("DEMO_WOULD_SIGN", "Demo is dry-only; refusing to sign an intent payload.");
  },
};

function demoSalts(): string[] {
  return EMPLOYEES.map((employee) =>
    createHash("sha256").update(`subrosa-demo-salt:${employee}:${CYCLE_ID}`, "utf8").digest("hex"),
  );
}

function selectNearUsdc(tokens: readonly TokenResponse[]): TokenResponse {
  const nearTokens = tokens.filter((token) => token.blockchain === "near");
  if (nearTokens.length === 0) {
    fail("TOKEN_NOT_FOUND", "1Click /v0/tokens returned no NEAR assets.");
  }
  for (const contract of USDC_NEAR_CONTRACTS) {
    const match = nearTokens.find((token) => token.contractAddress === contract);
    if (match !== undefined) {
      return match;
    }
  }
  const usdc = nearTokens.filter((token) => token.symbol.toUpperCase() === "USDC");
  if (usdc.length === 1) {
    return usdc[0];
  }
  fail(
    "TOKEN_AMBIGUOUS",
    `No unique NEAR USDC asset in /v0/tokens (${usdc.length} candidates); refusing to guess.`,
  );
}

function isConfidentialAuthGate(error: unknown): boolean {
  return (
    error instanceof OneClickApiError &&
    error.status === 401 &&
    /User authentication is required for confidential intent quotes/i.test(
      error.body.message ?? "",
    )
  );
}

function assertDryQuote(
  request: QuoteRequest,
  response: QuoteResponse,
  options: { readonly confidential: boolean },
): void {
  if (request.dry !== true) {
    fail("QUOTE_NOT_DRY", "Internal error: demo requested a non-dry quote.");
  }
  if (response.quoteRequest.dry !== true) {
    fail("QUOTE_NOT_DRY", "1Click returned a non-dry quote to a dry request.");
  }
  const depositAddress = readQuoteDepositAddress(response, { require: false });
  if (depositAddress !== null) {
    secrets.add(depositAddress);
    fail("DRY_QUOTE_DEPOSIT_ADDRESS", "1Click returned a deposit address for a dry quote.");
  }
  if (typeof response.signature !== "string" || response.signature.trim().length === 0) {
    fail("QUOTE_UNSIGNED", "1Click quote is missing its signature.");
  }
  if (response.quoteRequest.originAsset !== request.originAsset) {
    fail("QUOTE_ASSET_MISMATCH", "Quote origin asset does not match the request.");
  }
  if (response.quoteRequest.amount !== request.amount) {
    fail("QUOTE_AMOUNT_MISMATCH", "Quote amount does not match the request.");
  }
  const expectedType = options.confidential ? "CONFIDENTIAL_INTENTS" : "INTENTS";
  if (response.quoteRequest.recipientType !== expectedType) {
    fail("QUOTE_RECIPIENT_MISMATCH", `Quote recipient type is not ${expectedType}.`);
  }
  if (options.confidential && response.quoteRequest.depositType !== "CONFIDENTIAL_INTENTS") {
    fail("QUOTE_DEPOSIT_MISMATCH", "Quote deposit type is not CONFIDENTIAL_INTENTS.");
  }
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => timeout.reject(new DemoError("DEMO_TIMEOUT", `${label} timed out.`)),
    DEMO_TIMEOUT_MS,
  );
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

function redactionChecks(sample: {
  employee: string;
  amount: bigint;
  salt: string;
  asset: string;
}): void {
  const record = {
    employee: sample.employee,
    recipient: sample.employee,
    amount: sample.amount.toString(),
    salt: sample.salt,
    asset: sample.asset,
    memo: "demo",
    depositAddress: "demo-secret-deposit-address",
  };
  secrets.add(sample.amount.toString());
  secrets.add(sample.salt);
  secrets.add(record.depositAddress);

  const { redacted, fieldsRedacted } = redactDeep(record);
  const serialized = JSON.stringify(redacted);
  assertNoSecrets(serialized);

  const rawError = new Error(
    `payout failed amount=${sample.amount.toString()} salt=${sample.salt} ` +
      `depositAddress=${record.depositAddress} asset=${sample.asset}`,
  );
  const cleanError = redactError(rawError);
  assertNoSecrets(cleanError.message);
  assertNoSecrets(cleanError.stack ?? "");
  if (fieldsRedacted.length === 0) {
    fail("REDACTION_FAILED", "Redaction reported no fields.");
  }
}

async function main(): Promise<void> {
  const config = NearConfigPresets.testnet();
  const oneClickHost = new URL(config.oneClickBaseUrl).host;
  const sessionToken = process.env.ONECLICK_USER_SESSION?.trim() || undefined;
  stage(
    1,
    "config",
    `network=${config.network} contract=${config.contractId} oneclick=${oneClickHost} ` +
      `apiKey=none funds=0 session=${sessionToken === undefined ? "none" : "provided"}`,
  );

  const client = new OneClickClient({
    baseUrl: config.oneClickBaseUrl,
    apiKey: "", // explicit: demo must not consume a partner API key
    timeoutMs: DEMO_TIMEOUT_MS,
    transport: new DemoSessionTransport(config.oneClickBaseUrl, sessionToken),
  });

  const token = await withTimeout(client.getTokens(), "GET /v0/tokens").then((tokens) =>
    selectNearUsdc(tokens),
  );
  const tokenContract = token.contractAddress;
  if (tokenContract === undefined) {
    fail("TOKEN_NOT_FOUND", "Resolved USDC entry has no NEAR contract address.");
  }
  const settlementAsset = `nep141:${tokenContract}`;
  stage(
    2,
    "asset",
    `symbol=${token.symbol} blockchain=${token.blockchain} asset=${settlementAsset} source=/v0/tokens`,
  );

  const salts = demoSalts();
  const entries: BatchPaymentEntry[] = EMPLOYEES.map((employee, index) => ({
    employee,
    commitment_hash: commitmentHash({
      employer: EMPLOYER,
      employee,
      token: tokenContract,
      cycleId: CYCLE_ID,
      amount: AMOUNTS[index],
      salt: salts[index],
    }),
    cycle_id: CYCLE_ID,
    amount: AMOUNTS[index],
    salt: salts[index],
    asset: settlementAsset,
    memo: "demo",
  }));
  for (const entry of entries) {
    secrets.add(entry.salt);
    secrets.add(entry.amount.toString());
  }
  stage(
    3,
    "commitments",
    `${entries.length} commitments cycle=${CYCLE_ID} hashes=` +
      entries.map((entry) => entry.commitment_hash.slice(0, 12)).join(","),
  );

  const payload = new BatchPayloadBuilder().addMany(entries).build();
  if (payload.entries.length !== EMPLOYEES.length) {
    fail("BATCH_INVALID", "Batch validation dropped entries.");
  }
  stage(4, "batch-validation", `entries=${payload.entries.length} totalAmount=hidden status=ok`);

  const payouts: PendingPayout[] = entries.map((entry, index) => ({
    employer: EMPLOYER,
    payout_id: index + 1,
    employee: entry.employee,
    amount: entry.amount.toString(),
    salt: entry.salt,
    asset: entry.asset,
    memo: entry.memo,
    commitment_hash: entry.commitment_hash,
  }));

  const payout = new ConfidentialPayout(client, REFUSING_SIGNER, {
    store: new PrivateStore({ filePath: join(tmpdir(), "subrosa-demo-private-store.json") }),
  });

  const firstEntry = entries[0];
  const confidentialRequest = buildPayoutQuoteRequest({
    dry: true,
    assetId: settlementAsset,
    amount: firstEntry.amount.toString(),
    recipient: firstEntry.employee,
    refundTo: EMPLOYER,
  });

  let confidentialDryQuotes = 0;
  let confidentialAccess: "session" | "anonymous" | "gated" = "gated";
  try {
    const quote = await withTimeout(
      client.getQuote(confidentialRequest),
      "POST /v0/quote (confidential dry)",
    );
    assertDryQuote(confidentialRequest, quote, { confidential: true });
    confidentialAccess = sessionToken === undefined ? "anonymous" : "session";
    confidentialDryQuotes += 1;
    stage(
      5,
      "confidential-quote",
      "dry=true recipientType=CONFIDENTIAL_INTENTS depositAddress=none signature=present",
    );
  } catch (error) {
    if (sessionToken !== undefined) {
      fail(
        "USER_SESSION_REJECTED",
        "The provided ONECLICK_USER_SESSION was rejected; refusing to fall back.",
      );
    }
    if (!isConfidentialAuthGate(error)) {
      throw error;
    }
    confidentialAccess = "gated";
    const preflight = await payout.preflightPayout(payouts[0]);
    if (preflight.canProceed) {
      fail("AUTH_GATE_INCONSISTENT", "Quote was gated but preflight unexpectedly passed.");
    }
    stage(
      5,
      "confidential-quote",
      "gated=401 User-Session-required; preflight=fail-closed (no key or funds in demo)",
    );
  }

  const publicRequest: QuoteRequest = {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: settlementAsset,
    depositType: "INTENTS",
    destinationAsset: settlementAsset,
    amount: firstEntry.amount.toString(),
    refundTo: EMPLOYER,
    refundType: "INTENTS",
    recipient: EMPLOYER,
    recipientType: "INTENTS",
    deadline: new Date(Date.now() + 3 * 60_000).toISOString(),
  };
  validateQuoteRequest(publicRequest);
  const publicQuote = await withTimeout(client.getQuote(publicRequest), "POST /v0/quote (public dry)");
  assertDryQuote(publicRequest, publicQuote, { confidential: false });
  stage(
    6,
    "public-dry-quote",
    "dry=true recipientType=INTENTS depositAddress=none signature=present",
  );

  interface DryBatchResult {
    processed: number;
  }

  const processEntry = async (item: PendingPayout): Promise<void> => {
    if (confidentialAccess === "gated") {
      // 1Click will not issue a confidential quote without a User-Session.
      // Validate the exact confidential request locally instead of faking one.
      validateQuoteRequest(
        buildPayoutQuoteRequest({
          dry: true,
          assetId: item.asset,
          amount: item.amount,
          recipient: item.employee,
          refundTo: EMPLOYER,
        }),
      );
      return;
    }
    const preflight = await payout.preflightPayout(item);
    if (!preflight.canProceed) {
      fail(
        "PREFLIGHT_REJECTED",
        `Dry preflight rejected a payout (${preflight.findings.length} finding(s)).`,
      );
    }
    confidentialDryQuotes += 1;
  };

  const runBatch = async (items: readonly PendingPayout[]): Promise<DryBatchResult[]> => {
    for (const item of items) {
      await processEntry(item);
    }
    return [{ processed: items.length }];
  };

  let checkpoint: string | undefined;
  const interrupted = await submitSequentialPayrollBatches(
    payouts,
    async (batchItems, batchIndex) => {
      if (batchIndex === 1) {
        throw new Error("demo: simulated transport interruption before batch 2");
      }
      return runBatch(batchItems);
    },
    {
      batchSize: 1,
      maxRetries: 0,
      onCheckpoint: (tokenValue) => {
        checkpoint = tokenValue;
      },
    },
  );
  const interruptedToken = interrupted.error?.resumeToken;
  if (
    interrupted.success ||
    interrupted.failedBatchIndex !== 1 ||
    interruptedToken === undefined ||
    checkpoint === undefined
  ) {
    fail("RESUME_TOKEN_FAILED", "The interrupted run did not produce the expected resume token.");
  }

  const resumed = await submitSequentialPayrollBatches(
    payouts,
    async (batchItems) => runBatch(batchItems),
    { batchSize: 1, maxRetries: 0, resumeToken: checkpoint },
  );
  if (!resumed.success || resumed.itemsProcessed !== payouts.length) {
    fail("RESUME_FAILED", "Resumed submission did not complete every payout.");
  }
  stage(
    7,
    "resume-token",
    `interruptedAtBatch=1 resumedBatches=${resumed.batchesProcessed} ` +
      `processed=${resumed.itemsProcessed}/${payouts.length} token=verified ` +
      `mode=${confidentialAccess === "gated" ? "local-request-validation" : "confidential-preflight"}`,
  );

  redactionChecks({
    employee: firstEntry.employee,
    amount: firstEntry.amount,
    salt: firstEntry.salt,
    asset: settlementAsset,
  });
  stage(8, "redaction", "amount,salt,employee,recipient,depositAddress=redacted secretHits=0");

  assertNoSecrets(JSON.stringify({ employer: EMPLOYER, employees: EMPLOYEES }));
  stage(
    9,
    "summary",
    `commitments=3 confidentialDryQuotes=${confidentialDryQuotes} publicDryQuotes=1 ` +
      `confidential=${confidentialAccess} resumed=1 secretsLeaked=0 fundsMoved=0`,
  );
}

main().catch((error: unknown) => {
  let message: string;
  let code: string;
  if (error instanceof DemoError) {
    code = error.code;
    message = error.message;
  } else if (error instanceof Error) {
    code = "DEMO_FAILED";
    message = redactError(error).message;
  } else {
    code = "DEMO_FAILED";
    message = "unexpected failure";
  }
  for (const secret of secrets) {
    if (message.includes(secret)) {
      message = "demo failed; error text contained a private value and was suppressed";
      break;
    }
  }
  console.error(`demo failed [${code}]: ${message}`);
  process.exitCode = 1;
});
