/**
 * Pinned 1Click OpenAPI field check (step 13 / ST13-09 / P5-07).
 *
 * Asserts the fields this SDK depends on against the committed snapshot
 * `testdata/oneclick-openapi-0.1.10.yaml`. No network access: the snapshot is
 * the contract. Any drift in the snapshot, the version, or the six fields fails
 * with exit code 1.
 *
 * Run: node scripts/check-oneclick-schema.ts [--spec <path>]
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SPEC = resolve(REPO_ROOT, "testdata/oneclick-openapi-0.1.10.yaml");

/** SHA-256 of the pinned 0.1.10 snapshot, verified on 2026-11-12. */
const PINNED_SHA256 = "9a2e676682aa6dec6905c82f1b2cc0ec72eda97964369aa51ec35eb82ccac0a3";
const EXPECTED_VERSION = "0.1.10";

interface Spec {
  readonly path: string;
  readonly text: string;
  readonly lines: readonly string[];
}

class DriftError extends Error {}

function fail(message: string): never {
  throw new DriftError(message);
}

function indentation(line: string): number {
  const match = /^( *)/.exec(line);
  return match === null ? 0 : match[1].length;
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/** Lines of a top-level `components.schemas.<name>` block (schema indent 4). */
function schemaBlock(spec: Spec, name: string): string[] {
  const header = `    ${name}:`;
  const start = spec.lines.findIndex((line) => line === header);
  if (start < 0) {
    fail(`schema ${name} is missing`);
  }
  const block: string[] = [];
  for (let index = start + 1; index < spec.lines.length; index += 1) {
    const line = spec.lines[index];
    if (!isBlank(line) && indentation(line) <= 4) {
      break;
    }
    block.push(line);
  }
  return block;
}

/** Direct child mapping block of a schema/property block, e.g. `required:`. */
function childBlock(block: readonly string[], parentIndent: number, key: string): string[] | null {
  const header = `${" ".repeat(parentIndent + 2)}${key}:`;
  const start = block.findIndex(
    (line) => indentation(line) === parentIndent + 2 && line.startsWith(header),
  );
  if (start < 0) {
    return null;
  }
  const child: string[] = [];
  for (let index = start + 1; index < block.length; index += 1) {
    const line = block[index];
    if (!isBlank(line) && indentation(line) <= parentIndent + 2) {
      break;
    }
    child.push(line);
  }
  return child;
}

function listValues(block: readonly string[], listIndent: number): string[] {
  const values: string[] = [];
  for (const line of block) {
    if (isBlank(line) || indentation(line) !== listIndent) {
      continue;
    }
    const match = /^\s*-\s+(.+?)\s*$/.exec(line);
    if (match !== null) {
      values.push(match[1].replace(/^['"]|['"]$/g, ""));
    }
  }
  return values;
}

function requireChild(
  block: readonly string[],
  parentIndent: number,
  key: string,
  context: string,
): string[] {
  const child = childBlock(block, parentIndent, key);
  if (child === null) {
    fail(`${context} is missing its ${key} block`);
  }
  return child;
}

function propertyBlock(schema: readonly string[], property: string): string[] | null {
  const properties = childBlock(schema, 4, "properties");
  if (properties === null) {
    return null;
  }
  return childBlock(properties, 6, property);
}

interface FieldCheck {
  readonly label: string;
  readonly run: (spec: Spec) => void;
}

const CHECKS: readonly FieldCheck[] = [
  {
    label: "QuoteRequest.required includes slippageTolerance",
    run: (spec) => {
      const schema = schemaBlock(spec, "QuoteRequest");
      const required = requireChild(schema, 4, "required", "QuoteRequest");
      if (!listValues(required, 8).includes("slippageTolerance")) {
        fail("QuoteRequest.required does not list slippageTolerance");
      }
      if (propertyBlock(schema, "slippageTolerance") === null) {
        fail("QuoteRequest.properties.slippageTolerance is missing");
      }
    },
  },
  {
    label: "QuoteRequest.required includes deadline",
    run: (spec) => {
      const schema = schemaBlock(spec, "QuoteRequest");
      const required = requireChild(schema, 4, "required", "QuoteRequest");
      if (!listValues(required, 8).includes("deadline")) {
        fail("QuoteRequest.required does not list deadline");
      }
      if (propertyBlock(schema, "deadline") === null) {
        fail("QuoteRequest.properties.deadline is missing");
      }
    },
  },
  {
    label: "Quote.properties includes depositAddress",
    run: (spec) => {
      const quote = schemaBlock(spec, "Quote");
      if (propertyBlock(quote, "depositAddress") === null) {
        fail("Quote.properties.depositAddress is missing");
      }
    },
  },
  {
    // OpenAPI 0.1.10 carries the quote signature at the QuoteResponse level
    // (required), not nested under `quote`. Assert the real path.
    label: "QuoteResponse requires signature",
    run: (spec) => {
      const response = schemaBlock(spec, "QuoteResponse");
      const required = requireChild(response, 4, "required", "QuoteResponse");
      if (!listValues(required, 8).includes("signature")) {
        fail("QuoteResponse.required does not list signature");
      }
      if (propertyBlock(response, "signature") === null) {
        fail("QuoteResponse.properties.signature is missing");
      }
      const quote = propertyBlock(response, "quote");
      if (quote === null || !quote.some((line) => line.includes("#/components/schemas/Quote"))) {
        fail("QuoteResponse.properties.quote does not reference the Quote schema");
      }
    },
  },
  {
    label: "QuoteRequest.confidentiality enum is public|basic|advanced",
    run: (spec) => {
      const schema = schemaBlock(spec, "QuoteRequest");
      const confidentiality = propertyBlock(schema, "confidentiality");
      if (confidentiality === null) {
        fail("QuoteRequest.properties.confidentiality is missing");
      }
      const values = listValues(
        requireChild(confidentiality, 8, "enum", "QuoteRequest.confidentiality"),
        12,
      );
      if (values.join(",") !== "public,basic,advanced") {
        fail(`confidentiality enum drifted: ${values.join(",") || "<empty>"}`);
      }
    },
  },
  {
    label: "GetExecutionStatusResponse requires quoteResponse",
    run: (spec) => {
      const schema = schemaBlock(spec, "GetExecutionStatusResponse");
      const required = requireChild(schema, 4, "required", "GetExecutionStatusResponse");
      if (!listValues(required, 8).includes("quoteResponse")) {
        fail("GetExecutionStatusResponse.required does not list quoteResponse");
      }
      const quoteResponse = propertyBlock(schema, "quoteResponse");
      if (
        quoteResponse === null ||
        !quoteResponse.some((line) => line.includes("#/components/schemas/QuoteResponse"))
      ) {
        fail("GetExecutionStatusResponse.properties.quoteResponse does not reference QuoteResponse");
      }
    },
  },
];

function loadSpec(path: string): Spec {
  const bytes = readFileSync(path);
  return {
    path,
    text: bytes.toString("utf8"),
    lines: bytes.toString("utf8").split(/\r?\n/),
  };
}

function parseSpecArg(argv: readonly string[]): string {
  const index = argv.indexOf("--spec");
  if (index < 0) {
    return DEFAULT_SPEC;
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error("check-oneclick-schema: --spec requires a path");
    process.exit(2);
  }
  return resolve(value);
}

function main(): void {
  const specPath = parseSpecArg(process.argv.slice(2));
  const spec = loadSpec(specPath);

  const digest = createHash("sha256").update(spec.text, "utf8").digest("hex");
  console.log(`oneclick schema check: ${specPath}`);
  console.log(`snapshot sha256=${digest}`);

  const problems: string[] = [];
  if (specPath === DEFAULT_SPEC && digest !== PINNED_SHA256) {
    problems.push(`snapshot SHA-256 drifted from the pinned value (${PINNED_SHA256})`);
  }
  if (!new RegExp(`^  version: ${EXPECTED_VERSION.replace(/\./g, "\\.")}$`, "m").test(spec.text)) {
    problems.push(`info.version is not ${EXPECTED_VERSION}`);
  }
  for (const route of ["/v0/quote", "/v0/status"]) {
    if (!spec.lines.includes(`  ${route}:`)) {
      problems.push(`path ${route} is missing`);
    }
  }

  for (const check of CHECKS) {
    try {
      check.run(spec);
      console.log(`PASS ${check.label}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`DRIFT ${check.label}: ${message}`);
      problems.push(`${check.label}: ${message}`);
    }
  }

  if (problems.length > 0) {
    console.error(`\noneclick schema check FAILED (${problems.length} drift item(s)).`);
    process.exitCode = 1;
    return;
  }
  console.log(`\noneclick schema check PASSED: ${CHECKS.length}/${CHECKS.length} fields pinned.`);
}

main();
