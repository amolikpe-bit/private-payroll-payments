/**
 * Payroll execution preflight — dry-run only.
 *
 * Shows the PayrollService-shaped path without a chain or funds: validate a
 * batch, then run every payout through `ConfidentialPayout.preflightPayout`
 * (a confidential `dry:true` quote). No signer, no transaction, no deposit.
 *
 * 1Click currently requires a User-Session token for confidential quotes.
 * Without one this example asserts that gate and validates the exact
 * confidential requests locally instead of fabricating quotes.
 *
 * Run: npm run build && node examples/payroll-execution.ts
 * Requires network access to https://1click.chaindefuser.com.
 */

import {
  BatchPayloadBuilder,
  ConfidentialPayout,
  NearConfigPresets,
  OneClickApiError,
  OneClickClient,
  PrivateStore,
  buildPayoutQuoteRequest,
  commitmentHash,
  submitSequentialPayrollBatches,
  validateQuoteRequest,
  type BatchPaymentEntry,
  type IntentPayloadSigner,
  type PendingPayout,
  type SignedIntentMessage,
  type TokenResponse,
} from "near-subrosa-core";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EMPLOYER = "subrosa.testnet";
const EMPLOYEES = ["alice-demo.testnet", "bob-demo.testnet"] as const;
const AMOUNTS = [1_250_000n, 2_400_000n] as const;
const CYCLE_ID = 11;
const TIMEOUT_MS = 30_000;
const KNOWN_NEAR_USDC = [
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "usdc.near",
] as const;

class ExampleError extends Error {}

function fail(message: string): never {
  throw new ExampleError(message);
}

const REFUSING_SIGNER: IntentPayloadSigner = {
  signerId: EMPLOYER,
  async signPayload(): Promise<SignedIntentMessage> {
    fail("dry-run example refuses to sign intent payloads");
  },
};

function selectNearUsdc(tokens: readonly TokenResponse[]): TokenResponse {
  const nearTokens = tokens.filter((token) => token.blockchain === "near");
  for (const contract of KNOWN_NEAR_USDC) {
    const match = nearTokens.find((token) => token.contractAddress === contract);
    if (match !== undefined) {
      return match;
    }
  }
  const usdc = nearTokens.filter((token) => token.symbol.toUpperCase() === "USDC");
  if (usdc.length === 1) {
    return usdc[0];
  }
  fail("no unique NEAR USDC asset in /v0/tokens; refusing to guess");
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

async function main(): Promise<void> {
  const config = NearConfigPresets.testnet();
  const client = new OneClickClient({
    baseUrl: config.oneClickBaseUrl,
    apiKey: "",
    timeoutMs: TIMEOUT_MS,
  });

  const token = selectNearUsdc(await client.getTokens());
  const tokenContract = token.contractAddress;
  if (tokenContract === undefined) {
    fail("resolved token has no NEAR contract address");
  }
  const assetId = `nep141:${tokenContract}`;

  const entries: BatchPaymentEntry[] = EMPLOYEES.map((employee, index) => ({
    employee,
    commitment_hash: commitmentHash({
      employer: EMPLOYER,
      employee,
      token: tokenContract,
      cycleId: CYCLE_ID,
      amount: AMOUNTS[index],
      salt: String(index + 1).repeat(64).slice(0, 64),
    }),
    cycle_id: CYCLE_ID,
    amount: AMOUNTS[index],
    salt: String(index + 1).repeat(64).slice(0, 64),
    asset: assetId,
    memo: "payroll-execution-example",
  }));
  const payload = new BatchPayloadBuilder().addMany(entries).build();
  console.log(`batch validated: entries=${payload.entries.length} totalAmount=hidden`);

  const payouts: PendingPayout[] = payload.entries.map((entry, index) => ({
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
    store: new PrivateStore({ filePath: join(tmpdir(), "subrosa-example-private-store.json") }),
  });

  let mode: "preflight" | "gated" = "preflight";
  try {
    const probe = await client.getQuote(
      buildPayoutQuoteRequest({
        dry: true,
        assetId,
        amount: payouts[0].amount,
        recipient: payouts[0].employee,
        refundTo: EMPLOYER,
      }),
    );
    if (probe.quoteRequest.dry !== true) {
      fail("1Click returned a non-dry quote to a dry request");
    }
  } catch (error) {
    if (!isConfidentialAuthGate(error)) {
      throw error;
    }
    mode = "gated";
    for (const item of payouts) {
      validateQuoteRequest(
        buildPayoutQuoteRequest({
          dry: true,
          assetId: item.asset,
          amount: item.amount,
          recipient: item.employee,
          refundTo: EMPLOYER,
        }),
      );
    }
    console.log("confidential preflight: gated=401 User-Session-required; requests validated locally");
  }

  if (mode === "preflight") {
    interface DryBatchResult {
      preflighted: number;
    }

    const result = await submitSequentialPayrollBatches(
      payouts,
      async (batchItems) => {
        for (const item of batchItems) {
          const preflight = await payout.preflightPayout(item);
          if (!preflight.canProceed) {
            fail(`dry preflight rejected a payout (${preflight.findings.length} finding(s))`);
          }
        }
        return [{ preflighted: batchItems.length } satisfies DryBatchResult];
      },
      { batchSize: payouts.length, maxRetries: 0 },
    );

    if (!result.success || result.itemsProcessed !== payouts.length) {
      fail("dry preflight did not complete every payout");
    }
    console.log(
      `dry preflight complete: payouts=${result.itemsProcessed}/${payouts.length} ` +
        `batches=${result.batchesProcessed} fundsMoved=0`,
    );
    return;
  }

  console.log(
    `dry preflight gated: payouts=${payouts.length}/${payouts.length} validated=local fundsMoved=0`,
  );
}

main().catch((error: unknown) => {
  console.error(
    `payroll-execution failed: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
});
