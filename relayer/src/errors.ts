/** Typed failures for the NEP-366 relayer. */

export type RelayerErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_SIGNED_DELEGATE"
  | "NETWORK_NOT_ALLOWED"
  | "RECEIVER_NOT_ALLOWED"
  | "SENDER_INVALID"
  | "SENDER_IS_RELAYER"
  | "METHOD_NOT_ALLOWED"
  | "ACTION_NOT_ALLOWED"
  | "MULTIPLE_ACTIONS_NOT_ALLOWED"
  | "DEPOSIT_MISMATCH"
  | "DEPOSIT_CAP_EXCEEDED"
  | "GAS_CAP_EXCEEDED"
  | "INVALID_ARGS"
  | "INVALID_NONCE"
  | "INVALID_PUBLIC_KEY"
  | "DELEGATE_EXPIRED"
  | "DELEGATE_TTL_TOO_LONG"
  | "INVALID_SIGNATURE"
  | "INNER_KEY_NOT_FOUND"
  | "INNER_KEY_GAS_KEY_REJECTED"
  | "INNER_KEY_SCOPE_MISMATCH"
  | "INNER_KEY_LOOKUP_FAILED"
  | "UPSTREAM_ERROR"
  | "RELAY_FAILED"
  | "GAS_KEY_REQUIRED"
  | "GAS_KEY_NOT_FOUND"
  | "GAS_KEY_WITHDRAW_FAILED"
  | "GAS_KEY_DELETE_FAILED"
  | "UNAUTHORIZED"
  | "BODY_TOO_LARGE"
  | "NOT_FOUND"
  | "METHOD_HTTP_NOT_ALLOWED"
  | "INTERNAL_ERROR";

const DEFAULT_STATUS: Readonly<Record<RelayerErrorCode, number>> = {
  INVALID_REQUEST: 400,
  INVALID_SIGNED_DELEGATE: 400,
  NETWORK_NOT_ALLOWED: 400,
  RECEIVER_NOT_ALLOWED: 400,
  SENDER_INVALID: 400,
  SENDER_IS_RELAYER: 400,
  METHOD_NOT_ALLOWED: 400,
  ACTION_NOT_ALLOWED: 400,
  MULTIPLE_ACTIONS_NOT_ALLOWED: 400,
  DEPOSIT_MISMATCH: 400,
  DEPOSIT_CAP_EXCEEDED: 400,
  GAS_CAP_EXCEEDED: 400,
  INVALID_ARGS: 400,
  INVALID_NONCE: 400,
  INVALID_PUBLIC_KEY: 400,
  DELEGATE_EXPIRED: 400,
  DELEGATE_TTL_TOO_LONG: 400,
  INVALID_SIGNATURE: 400,
  INNER_KEY_NOT_FOUND: 400,
  INNER_KEY_GAS_KEY_REJECTED: 400,
  INNER_KEY_SCOPE_MISMATCH: 400,
  INNER_KEY_LOOKUP_FAILED: 502,
  UPSTREAM_ERROR: 502,
  RELAY_FAILED: 502,
  GAS_KEY_REQUIRED: 500,
  GAS_KEY_NOT_FOUND: 500,
  GAS_KEY_WITHDRAW_FAILED: 502,
  GAS_KEY_DELETE_FAILED: 502,
  UNAUTHORIZED: 401,
  BODY_TOO_LARGE: 413,
  NOT_FOUND: 404,
  METHOD_HTTP_NOT_ALLOWED: 405,
  INTERNAL_ERROR: 500,
};

/** Non-sensitive structured context: codes, booleans, counters only. */
export type RelayerErrorDetails = Readonly<Record<string, string | number | boolean>>;

export interface RelayerErrorOptions {
  /** HTTP status override; defaults to the code's mapping. */
  status?: number;
  details?: RelayerErrorDetails;
  cause?: unknown;
}

/**
 * Relayer failure with a stable code and an HTTP status.
 *
 * Messages never echo account ids, amounts, salts, keys, or request bodies:
 * callers get a code plus generic remediation text. The original error is kept
 * only as `cause` for server-side diagnostics.
 */
export class RelayerError extends Error {
  readonly code: RelayerErrorCode;
  readonly status: number;
  readonly details?: RelayerErrorDetails;

  constructor(code: RelayerErrorCode, message: string, options: RelayerErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RelayerError";
    this.code = code;
    this.status = options.status ?? DEFAULT_STATUS[code];
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

/** Narrow an unknown thrown value to an Error without leaking its content. */
export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
