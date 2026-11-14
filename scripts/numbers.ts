/**
 * W4 numbers pin: measured gross gas and storage for one salary commitment,
 * and its pinned arithmetic.
 *
 * The script consumes a raw capture from the pinned sandbox run on the W4
 * Celesto box. It never invents a value: the capture (a cargo test log line or
 * a JSON file) is the only source of the measured gas and storage delta, and
 * the script fails closed when it is absent, malformed, or disagrees with the
 * pinned claim recorded in `NUMBERS.md`.
 *
 * Capture formats
 * ---------------
 * Text (cargo test output, any surrounding lines allowed):
 *
 *   W4_CAPTURE commitment_gas_burnt=<u64> commitment_storage_delta=<u64>
 *
 * JSON:
 *
 *   {
 *     "schema": "subrosa/numbers-capture/v1",
 *     "network": "sandbox",
 *     "nearcore": "2.14.0",
 *     "captured_at": "<ISO-8601>",
 *     "tx_hash": "<base58>",
 *     "storage_byte_cost_yocto": "10000000000000000000",
 *     "commitment_gas_burnt": "2349590622921",
 *     "commitment_storage_delta": 374
 *   }
 *
 * `commitment_gas_burnt` is the gross gas burnt by the single `commit_salary`
 * call (`ExecutionFinalResult.total_gas_burnt`: transaction outcome + every
 * receipt outcome), in gas units. `commitment_storage_delta` is the contract
 * account `storage_usage` growth in bytes. There is no rebate: the 30%
 * developer rebate was removed in nearcore 2.14.0 (HSP-027, PV87), so the
 * claim is gross.
 *
 * Run: npm run numbers -- --capture <path> [--json]
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const CAPTURE_MARKER = "W4_CAPTURE";
const CAPTURE_SCHEMA = "subrosa/numbers-capture/v1";
const REPORT_SCHEMA = "subrosa/numbers-report/v1";

/** Sandbox storage price: 1e19 yoctoNEAR per byte (`contract/tests/sandbox.rs`). */
const YOCTO_NEAR_PER_BYTE = 10n ** 19n;
const YOCTO_NEAR_PER_NEAR = 10n ** 24n;
const GAS_PER_TGAS = 10n ** 12n;
/** Protocol cap: 1 PGas of prepaid gas per transaction. */
const MAX_GAS_PER_TRANSACTION = 10n ** 15n;
const U64_MAX = (1n << 64n) - 1n;

/**
 * The measured claim, pinned from the W4 box run. A capture that disagrees
 * means the claim in `NUMBERS.md` must be re-verified and updated together
 * with these constants; the script never silently reports a different number.
 */
const PINNED_GAS_BURNT = 2_349_590_622_921n;
const PINNED_STORAGE_DELTA_BYTES = 374n;


class NumbersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NumbersError";
  }
}

class UsageError extends NumbersError {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

class CaptureMissingError extends NumbersError {
  constructor(capturePath: string) {
    super(`capture not found: ${capturePath}`);
    this.name = "CaptureMissingError";
  }
}

interface CliOptions {
  readonly capturePath: string;
  readonly json: boolean;
  readonly help: boolean;
}

type CaptureFormat = "json" | "text";

interface Capture {
  readonly format: CaptureFormat;
  readonly gasBurnt: bigint;
  readonly storageDeltaBytes: bigint;
  readonly nearcore: string | null;
  readonly capturedAt: string | null;
  readonly txHash: string | null;
  readonly network: string | null;
  readonly declaredStorageByteCostYocto: bigint | null;
}


function check(condition: unknown, message: string): void {
  if (!condition) {
    throw new NumbersError(message);
  }
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new NumbersError(`${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new NumbersError(`${field} must be a string when present`);
  }
  return value;
}

function parseU64(value: unknown, field: string): bigint {
  let parsed: bigint;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    parsed = BigInt(value);
  } else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    parsed = BigInt(value);
  } else {
    throw new NumbersError(
      `${field} must be a non-negative decimal integer (a string when it exceeds ` +
        "Number.MAX_SAFE_INTEGER)",
    );
  }
  check(parsed <= U64_MAX, `${field} exceeds the u64 range`);
  return parsed;
}

function parseU64Text(value: string, field: string): bigint {
  check(/^[0-9]+$/.test(value), `${field} must be a decimal integer, got "${value}"`);
  const parsed = BigInt(value);
  check(parsed <= U64_MAX, `${field} exceeds the u64 range`);
  return parsed;
}

function parseJsonCapture(text: string, capturePath: string): Capture {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new NumbersError(`${capturePath}: invalid JSON (${message})`);
  }

  const record = asRecord(parsed, `${capturePath}: capture`);
  const schema = optionalString(record.schema, "schema");
  if (schema !== null) {
    check(
      schema === CAPTURE_SCHEMA,
      `${capturePath}: unsupported capture schema "${schema}" (expected "${CAPTURE_SCHEMA}")`,
    );
  }
  const network = optionalString(record.network, "network");
  if (network !== null) {
    check(
      network === "sandbox",
      `${capturePath}: capture network must be "sandbox", got "${network}"`,
    );
  }
  const declaredStorageByteCostYocto =
    record.storage_byte_cost_yocto === undefined
      ? null
      : parseU64(record.storage_byte_cost_yocto, "storage_byte_cost_yocto");
  if (declaredStorageByteCostYocto !== null) {
    check(
      declaredStorageByteCostYocto === YOCTO_NEAR_PER_BYTE,
      `${capturePath}: storage_byte_cost_yocto is ${declaredStorageByteCostYocto}; ` +
        `the sandbox price used by this claim is ${YOCTO_NEAR_PER_BYTE}`,
    );
  }

  return {
    format: "json",
    gasBurnt: parseU64(record.commitment_gas_burnt, "commitment_gas_burnt"),
    storageDeltaBytes: parseU64(record.commitment_storage_delta, "commitment_storage_delta"),
    nearcore: optionalString(record.nearcore, "nearcore"),
    capturedAt: optionalString(record.captured_at, "captured_at"),
    txHash: optionalString(record.tx_hash, "tx_hash"),
    network,
    declaredStorageByteCostYocto,
  };
}

function parseTextCapture(text: string, capturePath: string): Capture {
  const captures: Array<{ line: number; gasBurnt: bigint; storageDeltaBytes: bigint }> = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = stripVTControlCharacters(lines[index]).trim();
    const markerAt = line.indexOf(CAPTURE_MARKER);
    if (markerAt === -1 || !/(?:^|\s)W4_CAPTURE(?:\s|$)/.test(line)) {
      continue;
    }

    const rest = line.slice(markerAt + CAPTURE_MARKER.length).trim();
    check(rest.length > 0, `${capturePath}:${index + 1}: W4_CAPTURE line has no fields`);

    const fields = new Map<string, string>();
    for (const token of rest.split(/\s+/)) {
      const match = /^([A-Za-z][A-Za-z0-9_]*)=([^\s=]+)$/.exec(token);
      if (match === null) {
        throw new NumbersError(
          `${capturePath}:${index + 1}: malformed W4_CAPTURE field "${token}"`,
        );
      }
      const key = match[1];
      if (fields.has(key)) {
        throw new NumbersError(`${capturePath}:${index + 1}: duplicate W4_CAPTURE field "${key}"`);
      }
      fields.set(key, match[2]);
    }

    const gas = fields.get("commitment_gas_burnt");
    const delta = fields.get("commitment_storage_delta");
    if (gas === undefined || delta === undefined) {
      throw new NumbersError(
        `${capturePath}:${index + 1}: W4_CAPTURE requires commitment_gas_burnt and ` +
          "commitment_storage_delta",
      );
    }

    captures.push({
      line: index + 1,
      gasBurnt: parseU64Text(gas, "commitment_gas_burnt"),
      storageDeltaBytes: parseU64Text(delta, "commitment_storage_delta"),
    });
  }

  check(
    captures.length > 0,
    `${capturePath}: no "${CAPTURE_MARKER} commitment_gas_burnt=<u64> ` +
      'commitment_storage_delta=<u64>" line found',
  );

  const first = captures[0];
  for (const candidate of captures.slice(1)) {
    check(
      candidate.gasBurnt === first.gasBurnt &&
        candidate.storageDeltaBytes === first.storageDeltaBytes,
      `${capturePath}: conflicting W4_CAPTURE lines at ${first.line} and ${candidate.line}; ` +
        "capture exactly one sandbox run",
    );
  }

  return {
    format: "text",
    gasBurnt: first.gasBurnt,
    storageDeltaBytes: first.storageDeltaBytes,
    nearcore: null,
    capturedAt: null,
    txHash: null,
    network: null,
    declaredStorageByteCostYocto: null,
  };
}

function loadCapture(capturePath: string): Capture {
  let text: string;
  try {
    text = readFileSync(capturePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new CaptureMissingError(capturePath);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new NumbersError(`cannot read capture ${capturePath}: ${message}`);
  }

  const stripped = stripVTControlCharacters(text).replace(/^\uFEFF/, "");
  check(stripped.trim().length > 0, `${capturePath}: capture is empty`);
  const first = stripped.trimStart()[0];
  return first === "{" || first === "["
    ? parseJsonCapture(stripped, capturePath)
    : parseTextCapture(stripped, capturePath);
}

function validateCapture(capture: Capture): void {
  check(capture.gasBurnt > 0n, "capture commitment_gas_burnt must be greater than zero");
  check(
    capture.storageDeltaBytes > 0n,
    "capture commitment_storage_delta must be greater than zero",
  );
  check(
    capture.gasBurnt <= MAX_GAS_PER_TRANSACTION,
    `capture commitment_gas_burnt ${capture.gasBurnt} exceeds the 1 PGas per-transaction cap; ` +
      "the capture does not describe one call",
  );

  if (capture.storageDeltaBytes !== PINNED_STORAGE_DELTA_BYTES) {
    throw new NumbersError(
      `capture reports a ${capture.storageDeltaBytes} B commitment storage delta; the pinned ` +
        `model is ${PINNED_STORAGE_DELTA_BYTES} B. Re-run the pinned sandbox capture; if the ` +
        "change is real, update PINNED_STORAGE_DELTA_BYTES in scripts/numbers.ts and " +
        "the measured values in NUMBERS.md together.",
    );
  }
  if (capture.gasBurnt !== PINNED_GAS_BURNT) {
    throw new NumbersError(
      `capture reports ${capture.gasBurnt} gas; the pinned measurement is ${PINNED_GAS_BURNT} ` +
        "gas. Re-run the pinned sandbox capture (cargo +1.95.0, sandbox test, one thread); " +
        "if the change is real, update PINNED_GAS_BURNT in scripts/numbers.ts and the " +
        "measured values in NUMBERS.md together.",
    );
  }
}

function groupDigits(value: bigint): string {
  const digits = value.toString();
  let grouped = "";
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) {
      grouped += ",";
    }
    grouped += digits[index];
  }
  return grouped;
}

function formatTgasValue(gas: bigint): string {
  const whole = gas / GAS_PER_TGAS;
  const fraction = (gas % GAS_PER_TGAS).toString().padStart(12, "0").replace(/0+$/, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

function formatNearValue(yocto: bigint): string {
  const whole = yocto / YOCTO_NEAR_PER_NEAR;
  const fraction = (yocto % YOCTO_NEAR_PER_NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

function formatCaptureSource(capture: Capture): string {
  const metadata = [
    capture.nearcore === null ? null : `nearcore ${capture.nearcore}`,
    capture.network === null ? null : `network ${capture.network}`,
    capture.capturedAt === null ? null : `captured ${capture.capturedAt}`,
    capture.txHash === null ? null : `tx ${capture.txHash}`,
  ].filter((value): value is string => value !== null);
  return metadata.length === 0 ? capture.format : `${capture.format}; ${metadata.join(", ")}`;
}

function printReport(capturePath: string, capture: Capture): void {
  const storageCostYocto = capture.storageDeltaBytes * YOCTO_NEAR_PER_BYTE;

  console.log("subrosa W4 numbers pin — measured, gross gas (no rebate)");
  console.log("");
  console.log(`capture: ${resolve(capturePath)} (${formatCaptureSource(capture)})`);
  console.log(
    `  gross gas burnt: ${groupDigits(capture.gasBurnt)} gas = ` +
      `${formatTgasValue(capture.gasBurnt)} TGas`,
  );
  console.log(
    `  storage delta:   ${groupDigits(capture.storageDeltaBytes)} B (measured); ` +
      `model ${PINNED_STORAGE_DELTA_BYTES} B per commitment record`,
  );
  console.log(
    `  storage cost:    ${groupDigits(capture.storageDeltaBytes)} B × ` +
      `${groupDigits(YOCTO_NEAR_PER_BYTE)} yocto/B`,
  );
  console.log(`                   = ${groupDigits(storageCostYocto)} yoctoNEAR`);
  console.log(`                   = ${formatNearValue(storageCostYocto)} NEAR`);
  console.log(
    "  accounting:      gross only; the 30% developer gas rebate was removed in nearcore 2.14.0",
  );
  console.log("");
  console.log("OK: capture matches the pinned claim in NUMBERS.md.");
}

function printJsonReport(capturePath: string, capture: Capture): void {
  const storageCostYocto = capture.storageDeltaBytes * YOCTO_NEAR_PER_BYTE;
  const report = {
    schema: REPORT_SCHEMA,
    capture: {
      path: resolve(capturePath),
      format: capture.format,
      nearcore: capture.nearcore,
      captured_at: capture.capturedAt,
      tx_hash: capture.txHash,
      network: capture.network,
      gross_gas_burnt: capture.gasBurnt.toString(),
      gross_gas_tgas: formatTgasValue(capture.gasBurnt),
      storage_delta_bytes: capture.storageDeltaBytes.toString(),
      storage_byte_cost_yocto: YOCTO_NEAR_PER_BYTE.toString(),
      storage_cost_yocto: storageCostYocto.toString(),
      storage_cost_near: formatNearValue(storageCostYocto),
    },
    pinned_model: {
      gas_burnt: PINNED_GAS_BURNT.toString(),
      gas_tgas: formatTgasValue(PINNED_GAS_BURNT),
      storage_delta_bytes: PINNED_STORAGE_DELTA_BYTES.toString(),
      storage_cost_near: formatNearValue(PINNED_STORAGE_DELTA_BYTES * YOCTO_NEAR_PER_BYTE),
    },
    accounting: {
      gross: true,
      rebate: "none",
    },
  };
  console.log(JSON.stringify(report, null, 2));
}

function usage(): string {
  return [
    "Usage: npm run numbers -- --capture <path> [--json]",
    "",
    "  --capture <path>  sandbox capture: a cargo test log with a W4_CAPTURE line,",
    "                    or a JSON capture with commitment_gas_burnt and",
    "                    commitment_storage_delta (required)",
    "  --json            print the report as JSON (stable shape, for rerun diffing)",
    "  -h, --help        show this help",
  ].join("\n");
}

function capturePrerequisite(): string {
  return [
    "The numbers pin only reports a measured capture; it does not fabricate one.",
    "Produce it on the pinned sandbox box:",
    "",
    "  mkdir -p target/numbers",
    "  cargo +1.95.0 test -p subrosa-contract --test sandbox \\",
    "    sandbox_registry_commitments_and_pause -- --test-threads=1 --nocapture \\",
    "    2>&1 | tee target/numbers/capture.log",
    "  npm run numbers -- --capture target/numbers/capture.log",
    "",
    `The capture must contain: ${CAPTURE_MARKER} commitment_gas_burnt=<u64> ` +
      "commitment_storage_delta=<u64>",
    "See NUMBERS.md for the JSON form and the units.",
  ].join("\n");
}

function parseArguments(argv: readonly string[]): CliOptions {
  let capturePath: string | undefined;
  let json = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      json = true;
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--capture") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError("--capture requires a path");
      }
      if (capturePath !== undefined) {
        throw new UsageError("--capture was provided more than once");
      }
      capturePath = value;
      index += 1;
    } else if (argument.startsWith("--capture=")) {
      if (capturePath !== undefined) {
        throw new UsageError("--capture was provided more than once");
      }
      capturePath = argument.slice("--capture=".length);
      if (capturePath.length === 0) {
        throw new UsageError("--capture requires a path");
      }
    } else {
      throw new UsageError(`unknown argument: ${argument}`);
    }
  }

  if (help) {
    return { capturePath: capturePath ?? "", json, help: true };
  }
  if (capturePath === undefined) {
    throw new UsageError("--capture <path> is required");
  }
  return { capturePath, json, help: false };
}

function main(): void {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const capture = loadCapture(options.capturePath);
  validateCapture(capture);

  if (options.json) {
    printJsonReport(options.capturePath, capture);
  } else {
    printReport(options.capturePath, capture);
  }
}

try {
  main();
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`numbers: ${error.message}`);
    console.error("");
    console.error(usage());
    process.exitCode = 2;
  } else if (error instanceof CaptureMissingError) {
    console.error(`numbers: ${error.message}`);
    console.error("");
    console.error(capturePrerequisite());
    process.exitCode = 1;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`numbers: ${message}`);
    process.exitCode = 1;
  }
}
