/**
 * NEAR destination validation and the organizational validation-hook gate.
 *
 * The built-in check enforces NEAR account-id rules: 2-64 characters from
 * `a-z0-9._-`, no uppercase, no leading/trailing separator, and no two
 * separators adjacent. There is no legacy address-format exemption: a
 * destination is either a syntactically valid NEAR account id or it is
 * rejected.
 *
 * Host applications may register a process-wide hook for extra policy
 * (allowlists, compliance classification) on top of the syntax check. The hook
 * gate is fail-closed: a throwing hook, a missing result, or a malformed
 * result rejects the destination as `unavailable` instead of approving it.
 * Rejected destinations are never echoed in codes or messages.
 */

import { SubrosaError, ValidationError } from "../core/errors.js";

export const MIN_NEAR_ACCOUNT_ID_LENGTH = 2;
export const MAX_NEAR_ACCOUNT_ID_LENGTH = 64;

const ACCOUNT_ID_CHARSET = /^[a-z0-9._-]+$/;
const UPPERCASE = /[A-Z]/;
const LEADING_OR_TRAILING_SEPARATOR = /^[._-]|[._-]$/;
const CONSECUTIVE_SEPARATORS = /[._-]{2}/;

/** Stable rejection codes produced by the built-in account-id check. */
export const DestinationRejectionCode = {
  TYPE: "DESTINATION_TYPE",
  EMPTY: "DESTINATION_EMPTY",
  LENGTH: "DESTINATION_LENGTH",
  UPPERCASE: "DESTINATION_UPPERCASE",
  CHARSET: "DESTINATION_CHARSET",
  SEPARATOR: "DESTINATION_SEPARATOR",
} as const;

export type DestinationRejectionCodeType =
  (typeof DestinationRejectionCode)[keyof typeof DestinationRejectionCode];

export interface NearAccountIdValidationSuccess {
  ok: true;
  destination: string;
  kind: "near_account";
}

export interface NearAccountIdValidationFailure {
  ok: false;
  code: DestinationRejectionCodeType;
  message: string;
}

export type NearAccountIdValidation =
  | NearAccountIdValidationSuccess
  | NearAccountIdValidationFailure;

function reject(
  code: DestinationRejectionCodeType,
  message: string,
): NearAccountIdValidationFailure {
  return { ok: false, code, message };
}

/**
 * Synchronous, pure NEAR account-id syntax check. Never throws and never
 * echoes the rejected value.
 */
export function validateNearAccountId(value: unknown): NearAccountIdValidation {
  if (typeof value !== "string") {
    return reject(DestinationRejectionCode.TYPE, "Destination must be a NEAR account id string.");
  }
  if (value.length === 0) {
    return reject(DestinationRejectionCode.EMPTY, "Destination must not be empty.");
  }
  if (value.length < MIN_NEAR_ACCOUNT_ID_LENGTH || value.length > MAX_NEAR_ACCOUNT_ID_LENGTH) {
    return reject(
      DestinationRejectionCode.LENGTH,
      `Destination must be ${MIN_NEAR_ACCOUNT_ID_LENGTH}-${MAX_NEAR_ACCOUNT_ID_LENGTH} characters long.`,
    );
  }
  if (UPPERCASE.test(value)) {
    return reject(
      DestinationRejectionCode.UPPERCASE,
      "Destination must not contain uppercase characters.",
    );
  }
  if (!ACCOUNT_ID_CHARSET.test(value)) {
    return reject(
      DestinationRejectionCode.CHARSET,
      "Destination may only contain lowercase letters, digits, '.', '-', and '_'.",
    );
  }
  if (LEADING_OR_TRAILING_SEPARATOR.test(value)) {
    return reject(
      DestinationRejectionCode.SEPARATOR,
      "Destination must not start or end with '.', '-', or '_'.",
    );
  }
  if (CONSECUTIVE_SEPARATORS.test(value)) {
    return reject(
      DestinationRejectionCode.SEPARATOR,
      "Destination must not contain consecutive separators.",
    );
  }

  return { ok: true, destination: value, kind: "near_account" };
}

/**
 * Validate an account-id argument and return it, throwing a
 * {@link ValidationError} with the stable rejection code when invalid.
 */
export function assertNearAccountId(value: unknown, field: string): string {
  const result = validateNearAccountId(value);
  if (!result.ok) {
    throw new ValidationError(result.message, field, result.code);
  }
  return result.destination;
}

/** Successful hook result: optional classification label for the destination. */
export interface DestinationValidationHookSuccess {
  ok: true;
  kind?: string;
}

/** Rejected hook result: caller-supplied stable code and sanitized message. */
export interface DestinationValidationHookFailure {
  ok: false;
  code: string;
  message: string;
  retryable?: boolean;
}

export type DestinationValidationHookResult =
  | DestinationValidationHookSuccess
  | DestinationValidationHookFailure;

/**
 * Extra organizational destination policy. The destination passed in already
 * passed the built-in syntax check. Implementations must not echo the value in
 * their failure messages.
 */
export type DestinationValidationHook = (
  destination: string,
) => DestinationValidationHookResult | Promise<DestinationValidationHookResult>;

/**
 * - `validated` - built-in and extension checks passed.
 * - `rejected` - a check failed.
 * - `unavailable` - the extension hook itself failed; the destination is
 *   rejected defensively rather than silently accepted.
 */
export type DestinationValidationState = "validated" | "rejected" | "unavailable";

export interface DestinationWorkflowValidationSuccess {
  ok: true;
  destination: string;
  kind: string;
  state: "validated";
}

export interface DestinationWorkflowValidationFailure {
  ok: false;
  code: string;
  message: string;
  state: Exclude<DestinationValidationState, "validated">;
  retryable?: boolean;
}

export type DestinationWorkflowValidation =
  | DestinationWorkflowValidationSuccess
  | DestinationWorkflowValidationFailure;

export interface DestinationValidationOptions {
  /** Per-call hook; `null` explicitly disables the module-level hook. */
  hook?: DestinationValidationHook | null;
  /** Resolve the hook for this call only (takes effect when `hook` is omitted). */
  resolveHook?: () => DestinationValidationHook | undefined;
}

/** Thrown by payment workflows when the destination gate does not validate. */
export class DestinationValidationError extends SubrosaError {
  readonly state: DestinationValidationState;
  readonly retryable?: boolean;

  constructor(
    code: string,
    message: string,
    state: DestinationValidationState,
    retryable?: boolean,
  ) {
    super(message, code);
    this.name = "DestinationValidationError";
    this.state = state;
    if (retryable !== undefined) {
      this.retryable = retryable;
    }
  }

  static fromResult(result: DestinationWorkflowValidationFailure): DestinationValidationError {
    return new DestinationValidationError(
      result.code,
      result.message,
      result.state,
      result.retryable,
    );
  }
}

/** Shared module-level hook registration (process-wide default). */
let registeredHook: DestinationValidationHook | undefined;

/**
 * Register the process-wide destination validation hook. Pass `null` or
 * `undefined` to remove it and restore built-in-only validation.
 */
export function setDestinationValidationHook(hook?: DestinationValidationHook | null): void {
  registeredHook = hook ?? undefined;
}

/** Remove the process-wide hook. */
export function resetDestinationValidationHook(): void {
  registeredHook = undefined;
}

/** Read the registered hook without invoking it. */
export function getRegisteredDestinationValidationHook(): DestinationValidationHook | undefined {
  return registeredHook;
}

function unavailable(): DestinationWorkflowValidationFailure {
  return {
    ok: false,
    code: "DESTINATION_VALIDATION_UNAVAILABLE",
    message:
      "Destination validation could not complete because the extension validator is unavailable. The payment was not submitted; resolve the validator and retry.",
    state: "unavailable",
  };
}


function resolveHook(
  options: DestinationValidationOptions,
): DestinationValidationHook | undefined {
  if (options.hook !== undefined) {
    return options.hook ?? undefined;
  }
  if (options.resolveHook) {
    return options.resolveHook();
  }
  return registeredHook;
}

/**
 * Run the full destination gate: built-in account-id validation first, then
 * the extension hook when one is configured. Never throws; failures are
 * returned as an explicit union so callers can branch on `state`.
 */
export async function validateNearDestination(
  value: unknown,
  options: DestinationValidationOptions = {},
): Promise<DestinationWorkflowValidation> {
  const builtIn = validateNearAccountId(value);
  if (!builtIn.ok) {
    return { ok: false, code: builtIn.code, message: builtIn.message, state: "rejected" };
  }

  let hook: DestinationValidationHook | undefined;
  try {
    hook = resolveHook(options);
  } catch {
    return unavailable();
  }
  if (!hook) {
    return {
      ok: true,
      destination: builtIn.destination,
      kind: builtIn.kind,
      state: "validated",
    };
  }

  let hookResult: unknown;
  try {
    hookResult = await hook(builtIn.destination);
  } catch {
    // Fail closed and discard the fault detail so nothing sensitive leaks.
    return unavailable();
  }

  if (
    typeof hookResult !== "object" ||
    hookResult === null ||
    !("ok" in hookResult) ||
    typeof hookResult.ok !== "boolean"
  ) {
    return unavailable();
  }

  if (hookResult.ok) {
    const kind =
      "kind" in hookResult && typeof hookResult.kind === "string" && hookResult.kind.length > 0
        ? hookResult.kind
        : builtIn.kind;
    return { ok: true, destination: builtIn.destination, kind, state: "validated" };
  }

  const code =
    "code" in hookResult && typeof hookResult.code === "string" && hookResult.code.trim()
      ? hookResult.code
      : "DESTINATION_REJECTED";
  const message =
    "message" in hookResult && typeof hookResult.message === "string" && hookResult.message.trim()
      ? hookResult.message
      : "Destination rejected by the registered validation hook.";
  const retryable =
    "retryable" in hookResult && typeof hookResult.retryable === "boolean"
      ? hookResult.retryable
      : undefined;
  return {
    ok: false,
    code,
    message,
    state: "rejected",
    ...(retryable !== undefined ? { retryable } : {}),
  };
}
