/**
 * SDK error hierarchy.
 *
 * Every error the SDK throws deliberately about its own behaviour extends
 * {@link SubrosaError}, so callers can catch the whole family with one
 * `instanceof` check while still switching on the stable `code` string.
 * Messages never carry private payroll values; callers that need to attach
 * diagnostics must use the redaction helpers.
 */

/** Context metadata attached to SDK errors for debugging. */
export interface ErrorContext {
  transactionId?: string;
  contractId?: string;
  network?: string;
  [key: string]: unknown;
}

/** Base error class for every SDK-level failure. */
export class SubrosaError extends Error {
  public readonly cause?: unknown;

  constructor(
    message: string,
    public readonly code: string,
    public readonly context: ErrorContext = {},
    cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.cause = cause;
  }
}

/** Thrown when a network request fails (RPC calls, REST calls, downloads). */
export class NetworkError extends SubrosaError {
  constructor(
    message: string,
    code: string = "NETWORK_ERROR",
    context: ErrorContext = {},
    public readonly statusCode?: number,
    cause?: unknown,
  ) {
    super(message, code, context, cause);
  }
}

/** Thrown when proof generation fails (circuit, artifact, or witness issues). */
export class ProofGenerationError extends SubrosaError {
  constructor(
    message: string,
    code: string = "PROOF_GENERATION_FAILED",
    context: ErrorContext = {},
    cause?: unknown,
  ) {
    super(message, code, context, cause);
  }
}

/** Stable codes for RPC and contract-execution failures. */
export const ContractErrorCode = {
  SIMULATION_FAILED: "SIMULATION_FAILED",
  TRANSACTION_SUBMISSION_FAILED: "TRANSACTION_SUBMISSION_FAILED",
  TRANSACTION_TIMEOUT: "TRANSACTION_TIMEOUT",
  RPC_TIMEOUT: "RPC_TIMEOUT",
  INSUFFICIENT_FEE: "INSUFFICIENT_FEE",
  CONTRACT_REVERT: "CONTRACT_REVERT",
  CONTRACT_PAUSED: "CONTRACT_PAUSED",
  INVALID_RESPONSE: "INVALID_RESPONSE",
  UNKNOWN_RPC_ERROR: "UNKNOWN_RPC_ERROR",
} as const;

export type ContractErrorCodeType = (typeof ContractErrorCode)[keyof typeof ContractErrorCode];

/** Coarse classification used by timeout/retry decisions. */
export const TimeoutFailureState = {
  RETRYABLE: "RETRYABLE",
  EXPIRED: "EXPIRED",
  UNKNOWN: "UNKNOWN",
  TERMINAL: "TERMINAL",
} as const;

export type TimeoutFailureStateType =
  (typeof TimeoutFailureState)[keyof typeof TimeoutFailureState];

export function classifyContractErrorCode(code: ContractErrorCodeType): TimeoutFailureStateType {
  switch (code) {
    case ContractErrorCode.TRANSACTION_TIMEOUT:
    case ContractErrorCode.RPC_TIMEOUT:
      return TimeoutFailureState.EXPIRED;
    case ContractErrorCode.SIMULATION_FAILED:
    case ContractErrorCode.CONTRACT_REVERT:
    case ContractErrorCode.CONTRACT_PAUSED:
      return TimeoutFailureState.TERMINAL;
    case ContractErrorCode.INSUFFICIENT_FEE:
    case ContractErrorCode.TRANSACTION_SUBMISSION_FAILED:
    case ContractErrorCode.INVALID_RESPONSE:
      return TimeoutFailureState.RETRYABLE;
    case ContractErrorCode.UNKNOWN_RPC_ERROR:
    default:
      return TimeoutFailureState.UNKNOWN;
  }
}

/** Thrown when a contract call fails to build, submit, execute, or confirm. */
export class ContractExecutionError extends SubrosaError {
  public readonly failureState: TimeoutFailureStateType;

  constructor(
    message: string,
    code: ContractErrorCodeType = ContractErrorCode.UNKNOWN_RPC_ERROR,
    context: ErrorContext = {},
    cause?: unknown,
  ) {
    super(message, code, context, cause);
    this.failureState = classifyContractErrorCode(code);
  }
}

/** Thrown when a bounded RPC wait (submission/polling) exceeds its deadline. */
export class RpcTimeoutError extends ContractExecutionError {
  constructor(
    message: string = "RPC request timed out",
    context: ErrorContext = {},
    cause?: unknown,
    code: ContractErrorCodeType = ContractErrorCode.RPC_TIMEOUT,
  ) {
    super(message, code, context, cause);
    this.name = "RpcTimeoutError";
  }
}

/** Thrown when an RPC response is malformed or has an unexpected shape. */
export class InvalidResponseError extends ContractExecutionError {
  constructor(
    message: string = "RPC returned malformed or unexpected data",
    context: ErrorContext = {},
    cause?: unknown,
    code: ContractErrorCodeType = ContractErrorCode.INVALID_RESPONSE,
  ) {
    super(message, code, context, cause);
    this.name = "InvalidResponseError";
  }
}

/** Thrown when local input validation rejects a request before any I/O. */
export class ValidationError extends SubrosaError {
  constructor(
    message: string,
    public readonly field: string,
    code: string = "VALIDATION_ERROR",
    context: ErrorContext = {},
    cause?: unknown,
  ) {
    super(message, code, context, cause);
    this.name = "ValidationError";
  }
}
