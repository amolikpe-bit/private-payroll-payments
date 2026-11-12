/**
 * Redaction engine.
 *
 * Payroll objects carry private witness data that must never reach logs,
 * telemetry, progress callbacks, or thrown error messages: salary amounts,
 * commitment salts, proof witnesses, and credentials. Every helper in this
 * module replaces those values before they leave the SDK.
 *
 * The default field set covers the confidential-payout record (`amount`,
 * `salt`; `asset` is public), credential names, and the 1Click deposit address
 * (which `/v0/status` echoes and must stay private).
 */

import type { RedactionMode, RedactionOptions, RedactionResult } from "./types.js";

/** Default replacement used when `options.replacement` is omitted. */
export const DEFAULT_REDACTION_REPLACEMENT = "[redacted]";

/**
 * Fields that are always treated as sensitive, regardless of caller options.
 *
 * `token` is included because OAuth/partner/User-Session tokens are routinely
 * attached to HTTP error objects. Asset identifiers in this SDK are named
 * `asset`, never `token`.
 */
const DEFAULT_SENSITIVE_FIELDS: readonly string[] = Object.freeze([
  "recipient",
  "employee",
  "amount",
  "salt",
  "witness",
  "witnessSecret",
  "witness_secret",
  "privateKey",
  "private_key",
  "adminKey",
  "secret",
  "password",
  "token",
  "mnemonic",
  "seed",
  "authorization",
  "apiKey",
  "api_key",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "signingKey",
  "depositAddress",
  "deposit_address",
]);

/** A NEAR-formatted secret key (`ed25519:<base58>` / `secp256k1:<base58>`). */
const NEAR_SECRET_KEY_PATTERN = /\b(?:ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{40,100}\b/g;

function buildFieldSet(options: RedactionOptions = {}): Set<string> {
  const set = new Set(DEFAULT_SENSITIVE_FIELDS);
  for (const field of options.additionalFields ?? []) {
    if (typeof field === "string" && field.length > 0) {
      set.add(field);
    }
  }
  return set;
}

function applyRedaction(value: unknown, options: RedactionOptions): unknown {
  const mode: RedactionMode = options.mode ?? "replacement";
  if (mode === "remove") return undefined;
  if (mode === "mask") {
    const str = typeof value === "string" ? value : String(value);
    if (str.length <= 4) return "*".repeat(str.length);
    return str.slice(0, 2) + "*".repeat(str.length - 4) + str.slice(-2);
  }
  return options.replacement ?? DEFAULT_REDACTION_REPLACEMENT;
}

/**
 * Redacts sensitive fields from a plain object (shallow).
 *
 * Returns the cleaned object and the list of keys that were redacted so
 * callers can log or audit what was stripped.
 *
 * @example
 * const { redacted } = redactObject({ employee: "alice.near", amount: 500n, asset: "usdc.near" });
 * // { employee: "[redacted]", amount: "[redacted]", asset: "usdc.near" }
 */
export function redactObject(
  obj: Record<string, unknown>,
  options: RedactionOptions = {}
): RedactionResult<Record<string, unknown>> {
  const sensitiveFields = buildFieldSet(options);
  const result: Record<string, unknown> = {};
  const fieldsRedacted: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (sensitiveFields.has(key)) {
      const replacement = applyRedaction(value, options);
      if (replacement !== undefined) {
        result[key] = replacement;
      }
      fieldsRedacted.push(key);
    } else {
      result[key] = value;
    }
  }

  return { redacted: result, fieldsRedacted };
}

/**
 * Recursively redacts sensitive fields from a nested value.
 *
 * Arrays are traversed element by element; primitives pass through unchanged.
 * Circular references are not supported (plain JSON-shaped payloads only).
 */
export function redactDeep(
  value: unknown,
  options: RedactionOptions = {},
  fieldsRedacted: string[] = []
): RedactionResult<unknown> {
  const sensitiveFields = buildFieldSet(options);

  function walk(current: unknown): unknown {
    if (Array.isArray(current)) {
      return current.map((item) => walk(item));
    }
    if (current !== null && typeof current === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(current as Record<string, unknown>)) {
        if (sensitiveFields.has(key)) {
          const replacement = applyRedaction(nested, options);
          if (replacement !== undefined) {
            out[key] = replacement;
          }
          if (!fieldsRedacted.includes(key)) fieldsRedacted.push(key);
        } else {
          out[key] = walk(nested);
        }
      }
      return out;
    }
    return current;
  }

  return { redacted: walk(value), fieldsRedacted };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactMessage(
  message: string,
  sensitiveFields: ReadonlySet<string>,
  replacement: string
): string {
  let sanitized = message;
  for (const field of sensitiveFields) {
    const pattern = new RegExp(`(${escapeRegExp(field)}\\s*[:=]\\s*)([^\\s,;}\\]]+)`, "gi");
    sanitized = sanitized.replace(pattern, `$1${replacement}`);
  }
  // Credentials often appear unlabelled in RPC/client error text.
  return sanitized.replace(NEAR_SECRET_KEY_PATTERN, replacement);
}

function sanitizeStack(stack: string, originalMessage: string, sanitizedMessage: string): string {
  if (originalMessage.length === 0) return stack;
  return stack.split(originalMessage).join(sanitizedMessage);
}

/**
 * Redacts sensitive values from an error's message, stack, and attached
 * `context` metadata.
 *
 * The returned error keeps the original prototype (so `instanceof` checks and
 * `code`/`field` properties still work for SDK errors) but is a new instance:
 * the original error is never mutated.
 */
export function redactError(error: Error, options: RedactionOptions = {}): Error {
  const sensitiveFields = buildFieldSet(options);
  const replacement = options.replacement ?? DEFAULT_REDACTION_REPLACEMENT;

  const sanitizedMessage = redactMessage(error.message, sensitiveFields, replacement);

  const sanitized = Object.create(Object.getPrototypeOf(error) as object) as Error;
  Object.defineProperties(sanitized, {
    message: {
      value: sanitizedMessage,
      writable: true,
      configurable: true,
      enumerable: false,
    },
    name: {
      value: error.name || "Error",
      writable: true,
      configurable: true,
      enumerable: false,
    },
    stack: {
      value:
        typeof error.stack === "string"
          ? sanitizeStack(error.stack, error.message, sanitizedMessage)
          : undefined,
      writable: true,
      configurable: true,
      enumerable: false,
    },
  });

  for (const key of Object.keys(error)) {
    if (key === "message" || key === "name" || key === "stack") continue;
    const value = (error as unknown as Record<string, unknown>)[key];
    if (key === "context" && value !== null && typeof value === "object") {
      (sanitized as unknown as Record<string, unknown>)[key] = redactDeep(value, options).redacted;
    } else if (sensitiveFields.has(key)) {
      (sanitized as unknown as Record<string, unknown>)[key] = replacement;
    } else {
      (sanitized as unknown as Record<string, unknown>)[key] = value;
    }
  }

  return sanitized;
}

/**
 * Returns the field names the SDK considers sensitive by default.
 * Consumers can use this to align their own logging filters.
 */
export function getDefaultSensitiveFields(): string[] {
  return Array.from(DEFAULT_SENSITIVE_FIELDS);
}
