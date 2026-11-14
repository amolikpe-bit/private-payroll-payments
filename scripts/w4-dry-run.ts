/**
 * W4 dry run: zero-funds end-to-end Confidential Intents payroll.
 *
 * What it proves, with no wallet, no API key, no User-Session and no deposit:
 *   1-2. a three-employee payroll plan validates destinations and batch shape;
 *   3-4. commitments are derived from private amounts + salts, then the exact
 *        preimages are recomputed and a tampered amount is rejected;
 *   5. an anonymous confidential dry quote hits the documented 1Click
 *      User-Session gate (HTTP 401) while a public same-asset dry quote is
 *      still exercised; a returned dry quote is validated field by field;
 *   6. pending payouts are stored privately and the payout preflight fails
 *      closed with a signer that refuses to sign;
 *   7. an interrupted sequential batch resumes from an opaque resume token;
 *   8. settlement receipts carry a deterministic fixture intent hash and the
 *      commitment digest but no amount, salt, employee, deposit address or view key;
 *   9. private payout records and error text lose amount, salt, employee,
 *      deposit address and deposit memo under the redaction engine.
 *
 * The run fails closed if a non-dry quote is requested or returned, if a dry
 * quote carries a deposit address, if a credential header reaches the
 * transport, or if a private value appears in printed output. It never signs,
 * never submits an intent, and never moves funds.
 *
 * 1Click currently rejects confidential quotes without a User-Session token
 * (HTTP 401 "User authentication is required for confidential intent quotes").
 * This dry run is deliberately anonymous, so it asserts that gate; if 1Click
 * later accepts the anonymous dry request, the quote must still be dry and
 * deposit-address free. The public dry quote may succeed or hit the same
 * documented 401 gate; no other network result is allowed to change shape.
 *
 * Requires network access to the 1Click API.
 *
 * Run: npm run build && node scripts/w4-dry-run.ts
 */

const VIEW_KEY_FIELD = ["view", "Key", "Id"].join("");

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BatchPayloadBuilder,
  ConfidentialPayout,
  NearConfigPresets,
  ONECLICK_PATHS,
  OneClickApiError,
  OneClickClient,
  PrivateStore,
  buildCommitmentPreimage,
  buildPayoutQuoteRequest,
  commitmentHash,
  createSettlementReceipt,
  readQuoteDepositAddress,
  redactDeep,
  redactError,
  sha256Hex,
  submitSequentialPayrollBatches,
  validateNearDestination,
  validateQuoteRequest,
  validateQuoteResponse,
  validateSettlementReceipt,
  verifyCommitment,
  type BatchPaymentEntry,
  type IntentPayloadSigner,
  type OneClickHttpRequest,
  type OneClickHttpResponse,
  type OneClickTransport,
  type PendingPayout,
  type QuoteRequest,
  type QuoteResponse,
  type SignedIntentMessage,
} from "near-subrosa-core";

import {
  AMOUNTS,
  CYCLE_ID,
  DEMO_TIMEOUT_MS,
  EMPLOYEES,
  EMPLOYER,
  createSecretScanner,
} from "./lib/dry-run-harness.ts";

const TOTAL_STAGES = 10;
const FIXED_CLOCK_MS = Date.parse("2026-01-01T00:00:00.000Z");
const FIXED_ISO = new Date(FIXED_CLOCK_MS).toISOString();
const SALT_DOMAIN = "subrosa/w4-dry-run/salt/v1";
const INTENT_DOMAIN = "subrosa/w4-dry-run/intent";
const SETTLEMENT_CONTRACT =
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const SETTLEMENT_ASSET = `nep141:${SETTLEMENT_CONTRACT}`;

class DryRunError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DryRunError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new DryRunError(code, message);
}

const { secrets, assertNoSecrets } = createSecretScanner(() =>
  fail("SECRET_LEAK", "A private value reached dry-run output; refusing to print it."),
);

function stage(index: number, title: string, detail: string): void {
  const line = `[${index}/${TOTAL_STAGES}] ${title}: ${detail}`;
  assertNoSecrets(line);
  console.log(line);
}

let signerCalls = 0;

/**
 * A signer that cannot sign. `preflightPayout` never calls it; if any code
 * path attempts to move funds, the dry run fails instead of signing.
 */
const REFUSING_SIGNER: IntentPayloadSigner = {
  signerId: EMPLOYER,
  async signPayload(): Promise<SignedIntentMessage> {
    signerCalls += 1;
    fail("DRY_RUN_WOULD_SIGN", "Dry run is anonymous; refusing to sign an intent payload.");
  },
};

/**
 * fetch-based 1Click transport with two hard invariants: every quote body asks
 * for `dry: true`, and no credential header is ever attached. Violations are
 * recorded and short-circuited locally so the run can fail with a stable code.
 */
class DryOnlyTransport implements OneClickTransport {
  readonly #baseUrl: string;
  quoteRequests = 0;
  wetQuoteRequests = 0;
  credentialRequests = 0;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async request<T>(request: OneClickHttpRequest): Promise<OneClickHttpResponse<T>> {
    for (const name of Object.keys(request.headers ?? {})) {
      const header = name.toLowerCase();
      if (header === "authorization" || header === "x-api-key") {
        this.credentialRequests += 1;
        return { status: 400, data: { message: "dry run refuses credentials" } as T };
      }
    }
    if (request.path === ONECLICK_PATHS.quote) {
      this.quoteRequests += 1;
      const body = request.body;
      const isDry =
        typeof body === "object" && body !== null && "dry" in body && body.dry === true;
      if (!isDry) {
        this.wetQuoteRequests += 1;
        return { status: 400, data: { message: "dry run refuses non-dry quotes" } as T };
      }
    }

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
    const headers: Record<string, string> = { ...request.headers };
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

function assertTransportInvariants(transport: DryOnlyTransport): void {
  if (transport.credentialRequests > 0) {
    fail(
      "CREDENTIAL_PRESENT",
      "A request carried an authorization or API-key header; the dry run must stay anonymous.",
    );
  }
  if (transport.wetQuoteRequests > 0) {
    fail("NON_DRY_QUOTE_REQUEST", "A non-dry quote was attempted; refusing to continue.");
  }
}

function isAuthGate(error: unknown): error is OneClickApiError {
  return error instanceof OneClickApiError && error.status === 401;
}

function assertDryQuote(
  request: QuoteRequest,
  response: QuoteResponse,
  options: { readonly confidential: boolean },
): void {
  if (request.dry !== true) {
    fail("QUOTE_NOT_DRY", "Internal error: the dry run requested a non-dry quote.");
  }
  if (response.quoteRequest.dry !== true) {
    fail("QUOTE_NOT_DRY", "1Click returned a non-dry quote to a dry request.");
  }
  validateQuoteResponse(request, response, { requireDepositAddress: false });
  const depositAddress = readQuoteDepositAddress(response, { require: false });
  if (depositAddress !== null) {
    secrets.add(depositAddress);
    fail("DRY_QUOTE_DEPOSIT_ADDRESS", "1Click returned a deposit address for a dry quote.");
  }
  const expectedRecipient = options.confidential ? "CONFIDENTIAL_INTENTS" : "INTENTS";
  if (response.quoteRequest.recipientType !== expectedRecipient) {
    fail("QUOTE_RECIPIENT_MISMATCH", `Quote recipient type is not ${expectedRecipient}.`);
  }
  if (options.confidential && response.quoteRequest.depositType !== "CONFIDENTIAL_INTENTS") {
    fail("QUOTE_DEPOSIT_MISMATCH", "Confidential quote deposit type is not CONFIDENTIAL_INTENTS.");
  }
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => timeout.reject(new DryRunError("DRY_RUN_TIMEOUT", `${label} timed out.`)),
    DEMO_TIMEOUT_MS,
  );
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

interface CommitmentInput {
  employer: string;
  employee: string;
  token: string;
  cycleId: number;
  amount: bigint;
  salt: string;
}

interface DryPayoutResult {
  dry: true;
  commitmentHash: string;
}

function validateDryPayoutRequest(entry: PendingPayout): DryPayoutResult {
  const request = buildPayoutQuoteRequest({
    dry: true,
    assetId: entry.asset,
    amount: entry.amount,
    recipient: entry.employee,
    refundTo: entry.employer,
  });
  validateQuoteRequest(request);
  return { dry: true, commitmentHash: entry.commitment_hash };
}

async function main(): Promise<void> {
  const config = NearConfigPresets.testnet();
  const oneClickHost = new URL(config.oneClickBaseUrl).host;
  stage(
    1,
    "config",
    `network=${config.network} contract=${config.contractId} oneclick=${oneClickHost} ` +
      "wallet=none keys=none session=anonymous funds=0",
  );

  const salts = EMPLOYEES.map((employee) =>
    createHash("sha256").update(`${SALT_DOMAIN}:${employee}:${CYCLE_ID}`, "utf8").digest("hex"),
  );
  const inputs: CommitmentInput[] = EMPLOYEES.map((employee, index) => ({
    employer: EMPLOYER,
    employee,
    token: SETTLEMENT_CONTRACT,
    cycleId: CYCLE_ID,
    amount: AMOUNTS[index],
    salt: salts[index],
  }));
  const entries: BatchPaymentEntry[] = inputs.map((input) => ({
    employee: input.employee,
    commitment_hash: commitmentHash(input),
    cycle_id: input.cycleId,
    amount: input.amount,
    salt: input.salt,
    asset: SETTLEMENT_ASSET,
    memo: "w4-dry-run",
  }));
  for (const entry of entries) {
    secrets.add(entry.employee);
    secrets.add(entry.amount.toString());
    secrets.add(entry.salt);
  }

  const destinations = await Promise.all(
    entries.map((entry) => validateNearDestination(entry.employee)),
  );
  for (const destination of destinations) {
    if (!destination.ok) {
      fail("DESTINATION_INVALID", `A payroll destination was rejected (${destination.state}).`);
    }
  }
  const payload = new BatchPayloadBuilder().addMany(entries).build();
  const expectedTotal = AMOUNTS.reduce((sum, amount) => sum + amount, 0n);
  if (payload.entries.length !== entries.length || payload.totalAmount !== expectedTotal) {
    fail("BATCH_INVALID", "Batch validation dropped entries or changed the total.");
  }
  stage(
    2,
    "payroll",
    `employer=${EMPLOYER} employees=${entries.length} cycle=${CYCLE_ID} ` +
      "destinations=valid batch=valid totalAmount=hidden",
  );

  stage(
    3,
    "commitments",
    `${entries.length} commitments cycle=${CYCLE_ID} hashes=` +
      entries.map((entry) => entry.commitment_hash.slice(0, 12)).join(","),
  );

  let verified = 0;
  for (const [index, input] of inputs.entries()) {
    const preimage = buildCommitmentPreimage(input);
    if (sha256Hex(preimage) !== entries[index].commitment_hash) {
      fail("COMMITMENT_PREIMAGE_MISMATCH", "A commitment preimage does not match its digest.");
    }
    if (!verifyCommitment(input, entries[index].commitment_hash)) {
      fail("COMMITMENT_VERIFY_FAILED", "A recomputed commitment did not verify.");
    }
    verified += 1;
  }
  const tampered = verifyCommitment(
    { ...inputs[0], amount: inputs[0].amount + 1n },
    entries[0].commitment_hash,
  );
  if (tampered) {
    fail("PROOF_TAMPER_ACCEPTED", "A one-unit amount change still verified.");
  }
  stage(
    4,
    "proof",
    `preimages=${inputs.length} verified=${verified} tamperedAmount=rejected ` +
      `preimageBytes=${buildCommitmentPreimage(inputs[0]).length}`,
  );

  const transport = new DryOnlyTransport(config.oneClickBaseUrl);
  const client = new OneClickClient({
    baseUrl: config.oneClickBaseUrl,
    apiKey: "", // explicit: the dry run must not consume a partner or user key
    timeoutMs: DEMO_TIMEOUT_MS,
    transport,
  });

  const confidentialRequest = buildPayoutQuoteRequest({
    dry: true,
    assetId: SETTLEMENT_ASSET,
    amount: AMOUNTS[0].toString(),
    recipient: EMPLOYEES[0],
    refundTo: EMPLOYER,
  });
  validateQuoteRequest(confidentialRequest);
  let confidential: "accepted" | "gated" = "gated";
  try {
    const quote = await withTimeout(
      client.getQuote(confidentialRequest),
      "POST /v0/quote (confidential dry)",
    );
    assertDryQuote(confidentialRequest, quote, { confidential: true });
    confidential = "accepted";
  } catch (error) {
    assertTransportInvariants(transport);
    if (!isAuthGate(error)) {
      throw error;
    }
  }

  const publicRequest: QuoteRequest = {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: SETTLEMENT_ASSET,
    depositType: "INTENTS",
    destinationAsset: SETTLEMENT_ASSET,
    amount: AMOUNTS[0].toString(),
    refundTo: EMPLOYER,
    refundType: "INTENTS",
    recipient: EMPLOYER,
    recipientType: "INTENTS",
    deadline: new Date(Date.now() + 3 * 60_000).toISOString(),
  };
  validateQuoteRequest(publicRequest);
  let publicQuote: "ok" | "gated" = "gated";
  try {
    const quote = await withTimeout(client.getQuote(publicRequest), "POST /v0/quote (public dry)");
    assertDryQuote(publicRequest, quote, { confidential: false });
    publicQuote = "ok";
  } catch (error) {
    assertTransportInvariants(transport);
    if (!isAuthGate(error)) {
      throw error;
    }
  }
  if (transport.quoteRequests !== 2) {
    fail("QUOTE_COUNT_UNEXPECTED", "Expected one confidential and one public dry quote request.");
  }
  stage(
    5,
    "quote-gate",
    `anonymousConfidential=${
      confidential === "gated" ? "gated-401(User-Session-required)" : "dry-ok"
    } publicDry=${publicQuote === "ok" ? "dry-ok" : "gated-401(documented)"} ` +
      `quoteRequests=${transport.quoteRequests}`,
  );

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

  const storeDir = await mkdtemp(join(tmpdir(), "subrosa-w4-dry-run-"));
  try {
    const store = new PrivateStore({ filePath: join(storeDir, "private-store.json") });
    for (const payout of payouts) {
      await store.savePendingPayout(payout);
    }
    const stored = await store.listPendingPayouts(EMPLOYER);
    if (stored.length !== payouts.length) {
      fail("PAYOUT_STORE_MISMATCH", "The private store did not return every pending payout.");
    }

    // The preflight deadline must be in the future, so it uses the real clock;
    // only the resume-token clock is pinned for determinism.
    const payoutEngine = new ConfidentialPayout(client, REFUSING_SIGNER, { store });
    // The engine applies the client's per-request timeout to both calls.
    const preflight = await payoutEngine.preflightPayout(payouts[0]);
    assertTransportInvariants(transport);
    if (confidential === "gated") {
      if (preflight.canProceed) {
        fail("AUTH_GATE_INCONSISTENT", "The quote was gated but the payout preflight passed.");
      }
      if (preflight.findings.length === 0) {
        fail("PREFLIGHT_SILENT_FAILURE", "The payout preflight failed without a finding.");
      }
    } else if (!preflight.canProceed) {
      fail("PREFLIGHT_REJECTED", "The dry payout preflight rejected a valid payout.");
    }
    for (const finding of preflight.findings) {
      assertNoSecrets(finding);
    }
    if (signerCalls !== 0) {
      fail("SIGNER_CALLED", "The payout path called the signer during a dry run.");
    }
    stage(
      6,
      "payout",
      `stored=${stored.length} preflight=${
        confidential === "gated" ? "blocked-fail-closed" : "dry-ok"
      } signerCalls=0 funds=0`,
    );

    let checkpoint: string | undefined;
    const interrupted = await submitSequentialPayrollBatches<
      PendingPayout,
      DryPayoutResult
    >(
      payouts,
      async (batchItems, batchIndex) => {
        if (batchIndex === 1) {
          throw new Error("w4-dry-run: simulated transport interruption before batch 2");
        }
        return batchItems.map(validateDryPayoutRequest);
      },
      {
        batchSize: 1,
        maxRetries: 0,
        now: () => FIXED_CLOCK_MS,
        onCheckpoint: (token) => {
          checkpoint = token;
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
    if (interruptedToken !== checkpoint) {
      fail("RESUME_TOKEN_MISMATCH", "The failure token and the checkpoint token disagree.");
    }
    const resumed = await submitSequentialPayrollBatches<PendingPayout, DryPayoutResult>(
      payouts,
      async (batchItems) => batchItems.map(validateDryPayoutRequest),
      {
        batchSize: 1,
        maxRetries: 0,
        now: () => FIXED_CLOCK_MS,
        resumeToken: checkpoint,
      },
    );
    if (
      !resumed.success ||
      resumed.itemsProcessed !== payouts.length ||
      resumed.results.some((result) => result.dry !== true)
    ) {
      fail("RESUME_FAILED", "The resumed dry submission did not process every payout.");
    }
    stage(
      7,
      "resume",
      `interruptedAtBatch=1 resumedBatches=${
        resumed.batchesProcessed - interrupted.batchesProcessed
      } ` +
        `processed=${resumed.itemsProcessed}/${payouts.length} token=verified mode=dry-request-validation`,
    );

    const receipts = payouts.map((payout, index) =>
      createSettlementReceipt({
        receiptId: `rcpt_w4_dry_run_${index + 1}`,
        payrollId: `w4-dry-run:${EMPLOYER}:${CYCLE_ID}`,
        intentHash: sha256Hex(`${INTENT_DOMAIN}:${payout.commitment_hash}`),
        commitmentHash: payout.commitment_hash,
        status: "SUCCESS",
        issuedAt: FIXED_ISO,
        settledAt: FIXED_ISO,
        network: config.network,
      }),
    );
    for (const [index, receipt] of receipts.entries()) {
      const validation = validateSettlementReceipt(receipt);
      if (!validation.ok) {
        fail("RECEIPT_INVALID", `A settlement receipt failed validation (${validation.code}).`);
      }
      if (receipt.metadataDigest !== payouts[index].commitment_hash) {
        fail("RECEIPT_DIGEST_MISMATCH", "A receipt digest does not match its commitment.");
      }
      if (receipt.settlementStatus !== "settled") {
        fail("RECEIPT_STATUS_MISMATCH", "A receipt did not map SUCCESS to settled.");
      }
      if (VIEW_KEY_FIELD in receipt) {
        fail("RECEIPT_VIEW_KEY", "A receipt exposed an unsupported view-key identifier.");
      }
    }
    assertNoSecrets(JSON.stringify(receipts));
    stage(
      8,
      "receipt",
      `receipts=${receipts.length} statuses=settled references=deterministic-fixture ` +
        "metadata=commitment viewKey=none signatures=absent",
    );

    const sample = {
      employer: EMPLOYER,
      employee: entries[0].employee,
      amount: entries[0].amount.toString(),
      salt: entries[0].salt,
      asset: entries[0].asset,
      memo: entries[0].memo,
      commitment_hash: entries[0].commitment_hash,
      depositAddress: "w4-dry-run-deposit-address-fixture",
      depositMemo: "w4-dry-run-deposit-memo-fixture",
    };
    secrets.add(sample.depositAddress);
    secrets.add(sample.depositMemo);

    const { redacted, fieldsRedacted } = redactDeep(sample, {
      additionalFields: ["depositMemo"],
    });
    assertNoSecrets(JSON.stringify(redacted));
    for (const field of ["employee", "amount", "salt", "depositAddress", "depositMemo"]) {
      if (!fieldsRedacted.includes(field)) {
        fail("REDACTION_FAILED", `Redaction did not remove ${field}.`);
      }
    }

    const rawError = new Error(
      `payout failed employee=${sample.employee} amount=${sample.amount} salt=${sample.salt} ` +
        `depositAddress=${sample.depositAddress} depositMemo=${sample.depositMemo}`,
    );
    const cleanError = redactError(rawError, { additionalFields: ["depositMemo"] });
    assertNoSecrets(cleanError.message);
    assertNoSecrets(cleanError.stack ?? "");
    stage(
      9,
      "redaction",
      `fields=${fieldsRedacted.length} receiptLeak=0 errorLeak=0 secretHits=0`,
    );

    assertTransportInvariants(transport);
    stage(
      10,
      "summary",
      `stages=${TOTAL_STAGES} commitments=${entries.length} proofs=${verified} ` +
        `quoteGate=${confidential} publicQuote=${publicQuote} payoutsStored=${payouts.length} ` +
        `resumed=${resumed.itemsProcessed} receipts=${receipts.length} secretHits=0 ` +
        "wetQuotes=0 fundsMoved=0",
    );
  } finally {
    // The file holds amount/salt witness data; never leave it behind.
    await rm(storeDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  let code = "DRY_RUN_FAILED";
  let message: string;
  if (error instanceof DryRunError) {
    code = error.code;
    message = error.message;
  } else if (error instanceof Error) {
    message = redactError(error).message;
  } else {
    message = "unexpected failure";
  }
  for (const secret of secrets) {
    if (message.includes(secret)) {
      message = "dry run failed; the error text contained a private value and was suppressed";
      break;
    }
  }
  console.error(`w4-dry-run failed [${code}]: ${message}`);
  process.exitCode = 1;
});
