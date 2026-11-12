/**
 * Safe credential and sensitive payroll data handling.
 *
 * Detects NEAR secret keys, private keys, mnemonic seeds, commitment salts,
 * and plaintext compensation values so they can be blocked from logs,
 * persistence, telemetry, and public metadata. Error messages produced here
 * never echo the sensitive value they describe.
 */

import { SubrosaError, type ErrorContext } from "../core/errors.js";

/** Error codes specific to safe credential handling. */
export type SafeCredentialErrorCode =
  | "SECRET_KEY_DETECTED"
  | "INSECURE_STORAGE"
  | "UNSAFE_LOGGING_ATTEMPT"
  | "UNAUTHORIZED_REVEAL"
  | "INVALID_CREDENTIAL_FORMAT";

/**
 * Thrown when a sensitive credential or private payroll value is found in a
 * context that must not contain it. Neither the message nor the context ever
 * includes the credential itself.
 */
export class SafeCredentialHandlingError extends SubrosaError {
  constructor(
    message: string,
    code: SafeCredentialErrorCode = "SECRET_KEY_DETECTED",
    context: ErrorContext = {}
  ) {
    super(message, code, context);
    this.name = "SafeCredentialHandlingError";
  }
}

/** A single finding produced while scanning a payload. */
export interface SafeCredentialFinding {
  code: SafeCredentialErrorCode;
  severity: "error" | "warning";
  message: string;
  field?: string;
  credentialType?: "near_secret_key" | "hex_private_key" | "mnemonic_seed" | "sensitive_field";
}

/** Result of {@link validateSafeCredentialUsage}. */
export interface SafeCredentialValidationResult {
  safe: boolean;
  findings: SafeCredentialFinding[];
  summary: string;
}

/** Where the inspected value is about to go. */
export type SafeCredentialContext = "logging" | "storage" | "network" | "audit" | "general";

/** Options for {@link validateSafeCredentialUsage}. */
export interface SafeCredentialValidationOptions {
  /** Target context for the validation check. */
  context?: SafeCredentialContext;
  /** Disallow plaintext salary/amount/salt fields (default: true). */
  disallowPlaintextCompensation?: boolean;
  /** Additional field names to treat as sensitive credentials. */
  customSensitiveKeys?: readonly string[];
  /** Treat warnings as acceptable (default: false). */
  allowWarnings?: boolean;
}

/** Options for {@link sanitizeForPersistence}. */
export interface PersistenceSanitizationOptions {
  /** Remove secret fields instead of masking them (default: false). */
  removeSecrets?: boolean;
  /** Redact employee compensation, amounts, and salts (default: true). */
  redactCompensation?: boolean;
  /** Mask employee/recipient identifiers (default: false). */
  maskIdentifiers?: boolean;
  /** Replacement for redacted secrets. */
  secretReplacement?: string;
}

/** Options for {@link maskCredential}. */
export interface MaskCredentialOptions {
  /** Trailing characters to leave visible (default: 4, max: 4). */
  visibleSuffixLength?: number;
  /** Replacement used when the whole value is hidden. */
  fallbackReplacement?: string;
}

// ── Detection patterns ──────────────────────────────────────────────────────

/** `ed25519:<base58>` / `secp256k1:<base58>` secret keys. */
const NEAR_SECRET_KEY_REGEX = /\b(?:ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{40,100}\b/;

/** 64-character hex private key or 32-byte salt. */
const HEX_PRIVATE_KEY_REGEX = /\b(?:0x)?[0-9a-fA-F]{64}\b/;

/** 12–24 word BIP-39 mnemonic heuristic (common latin words). */
const MNEMONIC_HEURISTIC_REGEX = /\b([a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/i;

/** Property names that indicate secrets. Keys are normalized (lowercase, no `-_`). */
const DEFAULT_SECRET_FIELD_NAMES: Readonly<Record<string, true>> = {
  secretkey: true,
  secretseed: true,
  privatekey: true,
  seedphrase: true,
  mnemonic: true,
  witnesssecret: true,
  spendkey: true,
  signerssecret: true,
  signersecret: true,
  apikey: true,
  accesstoken: true,
  refreshtoken: true,
  depositaddress: true,
};

/** Property names that carry plaintext compensation or the commitment salt. */
const DEFAULT_COMPENSATION_FIELD_NAMES: Readonly<Record<string, true>> = {
  amount: true,
  salary: true,
  salaryamount: true,
  compensation: true,
  bonusamount: true,
  withholdingamount: true,
  salt: true,
};

/** Hash-like field names where a 64-hex value is public and must not be flagged. */
const PUBLIC_HASH_FIELD_PATTERN = /hash|digest|checksum|txhash|nullifier/i;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

function detectCredentialType(
  value: string,
  fieldPath?: string
): SafeCredentialFinding["credentialType"] | undefined {
  if (NEAR_SECRET_KEY_REGEX.test(value)) {
    return "near_secret_key";
  }
  if (MNEMONIC_HEURISTIC_REGEX.test(value)) {
    return "mnemonic_seed";
  }
  if (HEX_PRIVATE_KEY_REGEX.test(value)) {
    // 64-hex values in hash fields (commitment hashes, nullifiers, digests)
    // are public and must stay readable.
    const leaf = fieldPath?.split(".").pop() ?? "";
    if (leaf.length > 0 && PUBLIC_HASH_FIELD_PATTERN.test(leaf)) {
      return undefined;
    }
    return "hex_private_key";
  }
  return undefined;
}

function scanValue(
  value: unknown,
  path: string,
  findings: SafeCredentialFinding[],
  options: SafeCredentialValidationOptions,
  visited: WeakSet<object>
): void {
  if (value === null || value === undefined) {
    return;
  }

  if (typeof value === "string") {
    const credentialType = detectCredentialType(value, path);
    if (credentialType) {
      findings.push({
        code: "SECRET_KEY_DETECTED",
        severity: "error",
        message: `Sensitive credential (${credentialType}) detected in ${path || "payload"}. Secret keys must never be exposed or logged.`,
        field: path || undefined,
        credentialType,
      });
    }
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  // Circular references are skipped rather than recursing forever.
  if (visited.has(value as object)) {
    return;
  }
  visited.add(value as object);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      scanValue(value[i], `${path}[${i}]`, findings, options, visited);
    }
    return;
  }

  const sensitiveFieldNames = new Set(Object.keys(DEFAULT_SECRET_FIELD_NAMES));
  for (const extra of options.customSensitiveKeys ?? []) {
    sensitiveFieldNames.add(normalizeKey(extra));
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const currentPath = path ? `${path}.${key}` : key;
    const normalizedKey = normalizeKey(key);

    if (sensitiveFieldNames.has(normalizedKey) && nested !== undefined && nested !== null) {
      findings.push({
        code: "SECRET_KEY_DETECTED",
        severity: "error",
        message: `Field '${key}' holds sensitive secret data and must not be persisted or logged unencrypted.`,
        field: currentPath,
        credentialType: "sensitive_field",
      });
      continue;
    }

    if (
      options.disallowPlaintextCompensation !== false &&
      DEFAULT_COMPENSATION_FIELD_NAMES[normalizedKey] === true &&
      nested !== undefined &&
      nested !== null
    ) {
      findings.push({
        code: "SECRET_KEY_DETECTED",
        severity: "warning",
        message: `Field '${key}' contains plaintext compensation data in ${options.context ?? "general"} context. Ensure the field is redacted or encrypted.`,
        field: currentPath,
        credentialType: "sensitive_field",
      });
    }

    scanValue(nested, currentPath, findings, options, visited);
  }
}

/**
 * Validates that a value does not expose raw secret keys, commitment salts,
 * or plaintext compensation in an unsafe context.
 */
export function validateSafeCredentialUsage(
  target: unknown,
  options: SafeCredentialValidationOptions = {}
): SafeCredentialValidationResult {
  const findings: SafeCredentialFinding[] = [];
  scanValue(target, "", findings, options, new WeakSet<object>());

  const errors = findings.filter((finding) => finding.severity === "error");
  const warnings = findings.filter((finding) => finding.severity === "warning");
  const safe = options.allowWarnings === true ? errors.length === 0 : findings.length === 0;

  return {
    safe,
    findings,
    summary: safe
      ? "Credential check passed: no raw secrets or unredacted credentials detected."
      : `Credential check failed: ${errors.length} error(s), ${warnings.length} warning(s) detected.`,
  };
}

/**
 * Asserts that the target contains no raw credentials or unsafe exposure.
 *
 * @throws {SafeCredentialHandlingError} when any error-severity finding exists.
 */
export function assertSafeCredentialUsage(
  target: unknown,
  options: SafeCredentialValidationOptions = {}
): void {
  const result = validateSafeCredentialUsage(target, options);
  if (!result.safe) {
    const primaryFinding = result.findings[0];
    throw new SafeCredentialHandlingError(
      result.summary,
      primaryFinding?.code ?? "SECRET_KEY_DETECTED",
      {
        findingCount: result.findings.length,
        field: primaryFinding?.field,
        context: options.context ?? "general",
      }
    );
  }
}

/**
 * Masks a secret key, seed, or token for safe display.
 *
 * Keeps the scheme prefix (`ed25519:`) and at most four trailing characters;
 * short values are fully hidden.
 */
export function maskCredential(
  credential?: string | null,
  options: MaskCredentialOptions = {}
): string {
  const fallback = options.fallbackReplacement ?? "[REDACTED]";
  if (!credential || typeof credential !== "string") {
    return fallback;
  }

  const trimmed = credential.trim();
  if (trimmed.length <= 8) {
    return fallback;
  }

  const suffixLength = Math.min(Math.max(options.visibleSuffixLength ?? 4, 1), 4);
  const schemeSeparator = trimmed.indexOf(":");
  const prefix = schemeSeparator > 0 ? trimmed.slice(0, schemeSeparator + 1) : trimmed[0];
  const body = trimmed.slice(prefix.length);
  if (body.length <= suffixLength) {
    return fallback;
  }
  return `${prefix}${"*".repeat(body.length - suffixLength)}${body.slice(-suffixLength)}`;
}
/**
 * Deeply sanitizes a record before persistence to disk, a database, a cache,
 * or telemetry.
 *
 * Secrets are removed or replaced, compensation/amount/salt fields are
 * redacted, and operation metadata plus public hashes are preserved.
 */
export function sanitizeForPersistence<T>(
  data: T,
  options: PersistenceSanitizationOptions = {}
): T {
  const secretReplacement = options.secretReplacement ?? "[REDACTED_SECRET_KEY]";
  const redactCompensation = options.redactCompensation !== false;
  const maskIdentifiers = options.maskIdentifiers === true;
  const removeSecrets = options.removeSecrets === true;

  const visited = new WeakMap<object, unknown>();

  function deepSanitize(value: unknown): unknown {
    if (value === null || value === undefined || typeof value !== "object") {
      if (typeof value === "string" && detectCredentialType(value)) {
        return secretReplacement;
      }
      return value;
    }

    const existing = visited.get(value as object);
    if (existing !== undefined) {
      return existing;
    }

    if (Array.isArray(value)) {
      const copy: unknown[] = [];
      visited.set(value as object, copy);
      for (const item of value) {
        copy.push(deepSanitize(item));
      }
      return copy;
    }

    const copy: Record<string, unknown> = {};
    visited.set(value as object, copy);

    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = normalizeKey(key);

      if (DEFAULT_SECRET_FIELD_NAMES[normalizedKey] === true) {
        if (!removeSecrets) {
          copy[key] = secretReplacement;
        }
        continue;
      }

      if (redactCompensation && DEFAULT_COMPENSATION_FIELD_NAMES[normalizedKey] === true) {
        copy[key] = "[REDACTED_COMPENSATION]";
        continue;
      }

      if (
        maskIdentifiers &&
        (normalizedKey === "employee" || normalizedKey === "recipient" || normalizedKey === "employer")
      ) {
        copy[key] =
          typeof nested === "string" && nested.length > 8
            ? `${nested.slice(0, 4)}…${nested.slice(-4)}`
            : "[REDACTED_IDENTIFIER]";
        continue;
      }

      if (typeof nested === "string") {
        if (detectCredentialType(nested, key)) {
          if (!removeSecrets) {
            copy[key] = secretReplacement;
          }
          continue;
        }
        copy[key] = nested;
        continue;
      }

      copy[key] = deepSanitize(nested);
    }

    return copy;
  }

  return deepSanitize(data) as T;
}

/**
 * Accumulates credential findings across payloads so a caller can assert that
 * an entire workflow stayed clean before exporting or logging it.
 */
export class SafeCredentialAuditor {
  private readonly violations: SafeCredentialFinding[] = [];

  /** Audits a payload and records any findings. */
  public auditPayload(payload: unknown, contextName = "audit"): SafeCredentialValidationResult {
    const result = validateSafeCredentialUsage(payload, {
      context: "audit",
      disallowPlaintextCompensation: true,
    });

    for (const finding of result.findings) {
      this.violations.push({
        ...finding,
        message: `[${contextName}] ${finding.message}`,
      });
    }

    return result;
  }

  /**
   * Asserts that no error-severity violations were recorded.
   *
   * @throws {SafeCredentialHandlingError} when violations exist.
   */
  public assertClean(contextName?: string): void {
    const errors = this.violations.filter((violation) => violation.severity === "error");
    if (errors.length > 0) {
      throw new SafeCredentialHandlingError(
        `${contextName ? `[${contextName}] ` : ""}SafeCredentialAuditor detected ${errors.length} credential leakage violation(s).`,
        "SECRET_KEY_DETECTED",
        {
          violationCount: errors.length,
          firstViolationField: errors[0].field,
        }
      );
    }
  }

  /** Returns all recorded findings (errors and warnings). */
  public getViolations(): readonly SafeCredentialFinding[] {
    return [...this.violations];
  }

  /** True when any error-severity finding was recorded. */
  public hasViolations(): boolean {
    return this.violations.some((violation) => violation.severity === "error");
  }

  /** Clears all recorded findings. */
  public clear(): void {
    this.violations.length = 0;
  }
}
