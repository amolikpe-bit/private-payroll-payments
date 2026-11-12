/**
 * Private payroll simulation — dry-run only.
 *
 * Builds salary commitments, verifies one locally, and exercises the
 * confidential dry-quote path. No wallet, API key, deposit, or transaction is
 * used. Fails closed on a non-dry quote, a deposit address, or an unexpected
 * 1Click error.
 *
 * 1Click currently requires a User-Session token for confidential quotes, so
 * without one this example asserts that gate, validates the exact confidential
 * requests locally, and runs a public same-asset dry quote instead. It never
 * fabricates a confidential quote.
 *
 * Run: npm run build && node examples/private-payroll-simulation.ts
 * Requires network access to https://1click.chaindefuser.com.
 */

import {
  NearConfigPresets,
  OneClickApiError,
  OneClickClient,
  buildPayoutQuoteRequest,
  commitmentHash,
  readQuoteDepositAddress,
  validateQuoteRequest,
  verifyCommitment,
  type QuoteRequest,
  type QuoteResponse,
  type TokenResponse,
} from "near-subrosa-core";

const EMPLOYER = "subrosa.testnet";
const EMPLOYEES = ["alice-demo.testnet", "bob-demo.testnet"] as const;
const AMOUNTS = [1_250_000n, 2_400_000n] as const;
const CYCLE_ID = 7;
const TIMEOUT_MS = 30_000;
const KNOWN_NEAR_USDC = [
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "usdc.near",
] as const;

function fail(message: string): never {
  throw new Error(message);
}

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

function assertDry(request: QuoteRequest, response: QuoteResponse): void {
  if (request.dry !== true || response.quoteRequest.dry !== true) {
    fail("1Click returned a non-dry quote to a dry request");
  }
  if (readQuoteDepositAddress(response, { require: false }) !== null) {
    fail("1Click returned a deposit address for a dry quote");
  }
  if (response.signature.trim().length === 0) {
    fail("1Click quote is missing its signature");
  }
}

async function main(): Promise<void> {
  const config = NearConfigPresets.testnet();
  const client = new OneClickClient({
    baseUrl: config.oneClickBaseUrl,
    apiKey: "",
    timeoutMs: TIMEOUT_MS,
  });

  console.log(`network=${config.network} contract=${config.contractId} funds=0 apiKey=none`);

  const token = selectNearUsdc(await client.getTokens());
  const tokenContract = token.contractAddress;
  if (tokenContract === undefined) {
    fail("resolved token has no NEAR contract address");
  }
  const assetId = `nep141:${tokenContract}`;
  console.log(`asset=${token.symbol} assetId=${assetId} (source /v0/tokens)`);

  const commitment = commitmentHash({
    employer: EMPLOYER,
    employee: EMPLOYEES[0],
    token: tokenContract,
    cycleId: CYCLE_ID,
    amount: AMOUNTS[0],
    salt: "00".repeat(32),
  });
  const verified = verifyCommitment(
    {
      employer: EMPLOYER,
      employee: EMPLOYEES[0],
      token: tokenContract,
      cycleId: CYCLE_ID,
      amount: AMOUNTS[0],
      salt: "00".repeat(32),
    },
    commitment,
  );
  if (!verified) {
    fail("local commitment verification failed");
  }
  console.log(`commitment=${commitment} verified=true`);

  const requests = EMPLOYEES.map((employee, index) =>
    buildPayoutQuoteRequest({
      dry: true,
      assetId,
      amount: AMOUNTS[index].toString(),
      recipient: employee,
      refundTo: EMPLOYER,
    }),
  );

  let confidential = "ok";
  try {
    for (const request of requests) {
      const quote = await client.getQuote(request);
      assertDry(request, quote);
    }
    console.log("confidential quote: dry=true recipientType=CONFIDENTIAL_INTENTS depositAddress=none");
  } catch (error) {
    if (!isConfidentialAuthGate(error)) {
      throw error;
    }
    confidential = "gated";
    for (const request of requests) {
      validateQuoteRequest(request);
    }
    console.log("confidential quote: gated=401 User-Session-required; requests validated locally");
  }

  let publicDryQuotes = 0;
  if (confidential === "gated") {
    const publicRequest: QuoteRequest = {
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: assetId,
      depositType: "INTENTS",
      destinationAsset: assetId,
      amount: AMOUNTS[0].toString(),
      refundTo: EMPLOYER,
      refundType: "INTENTS",
      recipient: EMPLOYER,
      recipientType: "INTENTS",
      deadline: new Date(Date.now() + 3 * 60_000).toISOString(),
    };
    validateQuoteRequest(publicRequest);
    const quote = await client.getQuote(publicRequest);
    assertDry(publicRequest, quote);
    publicDryQuotes += 1;
    console.log("public quote: dry=true recipientType=INTENTS depositAddress=none signature=present");
  }

  console.log(
    `simulation complete: commitments=1 verified=1 confidential=${confidential} ` +
      `publicDryQuotes=${publicDryQuotes} fundsMoved=0`,
  );
}

main().catch((error: unknown) => {
  console.error(
    `private-payroll-simulation failed: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
});
