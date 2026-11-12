/**
 * Delegate action policy.
 *
 * The relayer sponsors gas *and* inner attached deposits, so every field is
 * checked locally before anything reaches RPC. Function-call-key allowances are
 * deliberately not consulted: NEP-366 does not check them for meta
 * transactions, which is exactly why receiver/method/deposit caps live here.
 */

import { createHash } from "node:crypto";

import {
  PublicKey,
  SignedDelegate,
  encodeDelegateAction,
} from "near-api-js";

import type { AccessKeyPermissionView } from "./nearTypes.js";

import {
  ALLOWED_METHODS,
  RELAYER_NETWORK,
  SUBROSA_TESTNET_CONTRACT,
  type DepositRule,
  type MethodPolicy,
  type RelayerNetwork,
} from "./constants.js";
import { RelayerError } from "./errors.js";

const ACCOUNT_ID_PATTERN = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const MIN_ACCOUNT_ID_LENGTH = 2;
const MAX_ACCOUNT_ID_LENGTH = 64;
const U64_MAX = (1n << 64n) - 1n;

/** Policy applied to every incoming signed delegate. */
export interface DelegatePolicy {
  readonly network: RelayerNetwork;
  readonly contractId: string;
  readonly relayerAccountId: string;
  /** Current finalized block height fetched by the service. */
  readonly currentBlockHeight: bigint;
  readonly maxTtlBlocks: number;
  readonly methods: Readonly<Record<string, MethodPolicy>>;
}

/** Delegate policy that does not need a block height yet. */
export type DelegateShapePolicy = Omit<DelegatePolicy, "currentBlockHeight">;

/** Result of local policy validation; contains only public metadata. */
export interface ValidatedDelegate {
  readonly senderId: string;
  readonly receiverId: string;
  readonly method: string;
  readonly gas: bigint;
  readonly depositYocto: bigint;
  readonly nonce: bigint;
  readonly maxBlockHeight: bigint;
  readonly publicKey: string;
}

/** Reject any network other than testnet. */
export function assertTestnetNetwork(network: unknown): asserts network is RelayerNetwork {
  if (network !== RELAYER_NETWORK) {
    throw new RelayerError(
      "NETWORK_NOT_ALLOWED",
      "This relayer serves testnet only. Delegate actions for any other network are rejected.",
    );
  }
}

function assertAccountId(value: unknown, field: "sender" | "receiver"): string {
  if (
    typeof value !== "string" ||
    value.length < MIN_ACCOUNT_ID_LENGTH ||
    value.length > MAX_ACCOUNT_ID_LENGTH ||
    !ACCOUNT_ID_PATTERN.test(value)
  ) {
    throw new RelayerError(
      field === "sender" ? "SENDER_INVALID" : "RECEIVER_NOT_ALLOWED",
      `${field === "sender" ? "Sender" : "Receiver"} is not a valid NEAR account id.`,
    );
  }
  return value;
}

function decodeJsonArgs(args: Uint8Array): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(args));
  } catch {
    throw new RelayerError(
      "INVALID_ARGS",
      "Function-call arguments are not valid UTF-8 JSON; refusing to sponsor the call.",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RelayerError("INVALID_ARGS", "Function-call arguments must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function batchItemCount(parsed: Record<string, unknown>, policy: MethodPolicy): number {
  if (policy.deposit.kind !== "per-item") {
    throw new RelayerError("INVALID_ARGS", "Batch deposit policy is misconfigured.");
  }
  const items = parsed.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new RelayerError("INVALID_ARGS", "batch_commit_salaries requires a non-empty items array.");
  }
  if (items.length > policy.deposit.maxItems) {
    throw new RelayerError(
      "INVALID_ARGS",
      `batch_commit_salaries accepts at most ${policy.deposit.maxItems} items per call.`,
    );
  }
  return items.length;
}

function maxDepositYocto(policy: MethodPolicy): bigint {
  if (policy.deposit.kind === "exact") {
    return policy.deposit.yocto;
  }
  if (policy.deposit.kind === "per-item") {
    return BigInt(policy.deposit.maxItems) * policy.deposit.yoctoPerItem;
  }
  return (
    policy.deposit.baseYocto +
    BigInt(policy.deposit.maxMetadataBytes) * policy.deposit.perMetadataByteYocto
  );
}

function expectedDepositYocto(
  method: string,
  policy: MethodPolicy,
  args: Uint8Array,
): bigint {
  // Every allowlisted method is storage-gated; parse arguments so the deposit
  // can be checked exactly instead of relying on a broad upper bound.
  const parsed = decodeJsonArgs(args);
  if (policy.deposit.kind === "exact") {
    return policy.deposit.yocto;
  }
  if (policy.deposit.kind === "register") {
    if (method !== "register_employee") {
      throw new RelayerError("INVALID_ARGS", "Register deposit policy is only valid for register_employee.");
    }
    const metadata = parsed.metadata;
    if (typeof metadata !== "string") {
      throw new RelayerError("INVALID_ARGS", "register_employee requires a string metadata field.");
    }
    const metadataBytes = new TextEncoder().encode(metadata).length;
    if (metadataBytes > policy.deposit.maxMetadataBytes) {
      throw new RelayerError(
        "INVALID_ARGS",
        `register_employee metadata exceeds ${policy.deposit.maxMetadataBytes} bytes.`,
      );
    }
    return policy.deposit.baseYocto + BigInt(metadataBytes) * policy.deposit.perMetadataByteYocto;
  }
  if (method !== "batch_commit_salaries") {
    throw new RelayerError("INVALID_ARGS", "Per-item deposit policy is only valid for batch commits.");
  }
  return BigInt(batchItemCount(parsed, policy)) * policy.deposit.yoctoPerItem;
}

/**
 * Validate the delegate structure and every local spending limit that does not
 * need the chain head.
 *
 * The input is always the output of {@link decodeSignedDelegateBase64} or
 * `SignedDelegate.decode`, so its Borsh-typed fields are already guaranteed by
 * near-api-js. Signature verification is a separate call
 * ({@link verifyDelegateSignature}) so malformed payloads are rejected before
 * hashing.
 */
export function validateDelegateShape(
  signedDelegate: SignedDelegate,
  policy: DelegateShapePolicy,
): ValidatedDelegate {
  assertTestnetNetwork(policy.network);
  if (!(signedDelegate instanceof SignedDelegate)) {
    throw new RelayerError("INVALID_SIGNED_DELEGATE", "Signed delegate payload is malformed.");
  }

  const delegate = signedDelegate.delegateAction;
  if (delegate.actions.length === 0) {
    throw new RelayerError("INVALID_SIGNED_DELEGATE", "Delegate action has no actions.");
  }
  if (delegate.actions.length !== 1) {
    throw new RelayerError(
      "MULTIPLE_ACTIONS_NOT_ALLOWED",
      "This relayer sponsors exactly one inner action per meta transaction.",
    );
  }

  const senderId = assertAccountId(delegate.senderId, "sender");
  if (senderId === policy.relayerAccountId) {
    throw new RelayerError("SENDER_IS_RELAYER", "The relayer account cannot relay to itself.");
  }
  const receiverId = assertAccountId(delegate.receiverId, "receiver");
  if (receiverId !== policy.contractId || receiverId !== SUBROSA_TESTNET_CONTRACT) {
    throw new RelayerError(
      "RECEIVER_NOT_ALLOWED",
      `Meta transactions are restricted to ${SUBROSA_TESTNET_CONTRACT}.`,
    );
  }

  const action = delegate.actions[0];
  const call = action.functionCall;
  if (call === undefined) {
    throw new RelayerError(
      "ACTION_NOT_ALLOWED",
      "Only a FunctionCall action against the subrosa contract is allowed.",
    );
  }
  const methodPolicy = policy.methods[call.methodName];
  if (methodPolicy === undefined) {
    throw new RelayerError(
      "METHOD_NOT_ALLOWED",
      "Method is not on the relayer allowlist (register_employee, commit_salary, batch_commit_salaries).",
    );
  }

  if (call.gas <= 0n) {
    throw new RelayerError("INVALID_REQUEST", "Function-call gas must be positive.");
  }
  if (call.gas > methodPolicy.maxGas) {
    throw new RelayerError(
      "GAS_CAP_EXCEEDED",
      `Function-call gas exceeds the ${call.methodName} cap.`,
    );
  }
  if (call.deposit <= 0n) {
    throw new RelayerError("INVALID_REQUEST", "Function-call deposit must be positive.");
  }
  if (call.deposit > maxDepositYocto(methodPolicy)) {
    throw new RelayerError("DEPOSIT_CAP_EXCEEDED", "Attached deposit exceeds the method cap.");
  }
  const expectedDeposit = expectedDepositYocto(call.methodName, methodPolicy, call.args);
  if (call.deposit !== expectedDeposit) {
    throw new RelayerError(
      "DEPOSIT_MISMATCH",
      "Attached deposit does not equal the contract's required storage deposit for this call.",
    );
  }

  if (delegate.nonce <= 0n || delegate.nonce > U64_MAX) {
    throw new RelayerError("INVALID_NONCE", "Delegate nonce is outside the u64 range.");
  }

  const maxBlockHeight = delegate.maxBlockHeight;

  let publicKey: string;
  try {
    publicKey = PublicKey.from(delegate.publicKey).toString();
  } catch (error) {
    throw new RelayerError("INVALID_PUBLIC_KEY", "Delegate public key is invalid.", { cause: error });
  }

  return {
    senderId,
    receiverId,
    method: call.methodName,
    gas: call.gas,
    depositYocto: call.deposit,
    nonce: delegate.nonce,
    maxBlockHeight,
    publicKey,
  };
}

/** Reject a delegate whose validity window is stale or too long. */
export function validateDelegateWindow(
  maxBlockHeight: bigint,
  currentBlockHeight: bigint,
  maxTtlBlocks: number,
): void {
  if (maxBlockHeight <= currentBlockHeight) {
    throw new RelayerError("DELEGATE_EXPIRED", "Delegate action has already expired.");
  }
  if (maxBlockHeight > currentBlockHeight + BigInt(maxTtlBlocks)) {
    throw new RelayerError(
      "DELEGATE_TTL_TOO_LONG",
      `Delegate action validity exceeds the ${maxTtlBlocks}-block limit.`,
    );
  }
}

/** Shape + validity-window validation in one call (tests and offline checks). */
export function validateDelegate(
  signedDelegate: SignedDelegate,
  policy: DelegatePolicy,
): ValidatedDelegate {
  const validated = validateDelegateShape(signedDelegate, policy);
  validateDelegateWindow(validated.maxBlockHeight, policy.currentBlockHeight, policy.maxTtlBlocks);
  return validated;
}

/**
 * Verify the delegate signature over `sha256(borsh(DelegateAction))`.
 *
 * The signature is checked before any RPC access-key lookup, so a forged
 * payload cannot be used to probe sender accounts.
 */
export function verifyDelegateSignature(signedDelegate: SignedDelegate): void {
  let signature: Uint8Array;
  try {
    signature = signedDelegate.signature.data;
  } catch (error) {
    throw new RelayerError("INVALID_SIGNATURE", "Signed delegate has no signature bytes.", {
      cause: error,
    });
  }
  if (signature.length === 0) {
    throw new RelayerError("INVALID_SIGNATURE", "Signed delegate has no signature bytes.");
  }
  const encoded = encodeDelegateAction(signedDelegate.delegateAction);
  const digest = new Uint8Array(createHash("sha256").update(encoded).digest());
  const publicKey = PublicKey.from(signedDelegate.delegateAction.publicKey);
  if (!publicKey.verify(digest, signature)) {
    throw new RelayerError("INVALID_SIGNATURE", "Delegate signature does not verify.");
  }
}

/**
 * Validate the inner signer's on-chain access key.
 *
 * - FullAccess and contract-scoped FunctionCall keys are accepted.
 * - Gas keys are rejected as inner signers: DelegateV2 (gas-key signing) was
 *   removed in protocol 87, so the inner delegate must use a regular key.
 * - A FunctionCall key's allowance is intentionally ignored: NEP-366 does not
 *   apply it, and the relayer's own caps above are the actual spending bound.
 */
export function validateInnerAccessKey(
  permission: AccessKeyPermissionView | null,
  method: string,
  contractId: string,
): void {
  if (permission === null) {
    throw new RelayerError(
      "INNER_KEY_NOT_FOUND",
      "The delegate public key is not an access key on the sender account.",
    );
  }
  if (permission === "FullAccess") {
    return;
  }
  if ("GasKeyFullAccess" in permission || "GasKeyFunctionCall" in permission) {
    throw new RelayerError(
      "INNER_KEY_GAS_KEY_REJECTED",
      "Inner delegate signers must use a regular access key; gas-key-signed DelegateV2 was removed in protocol 87.",
    );
  }
  if ("FunctionCall" in permission) {
    const fn = permission.FunctionCall;
    if (fn.receiver_id !== contractId) {
      throw new RelayerError(
        "INNER_KEY_SCOPE_MISMATCH",
        "Function-call access key is scoped to a different receiver contract.",
      );
    }
    if (fn.method_names.length > 0 && !fn.method_names.includes(method)) {
      throw new RelayerError(
        "INNER_KEY_SCOPE_MISMATCH",
        "Function-call access key does not allow this method.",
      );
    }
    return;
  }
  throw new RelayerError("INNER_KEY_SCOPE_MISMATCH", "Access key permission is not recognized.");
}

/** Public, non-secret policy projection for `GET /v1/policy`. */
export interface PublicMethodPolicy {
  readonly method: string;
  readonly maxGas: string;
  readonly maxDepositYocto: string;
  readonly depositKind: DepositRule["kind"];
  readonly maxItems?: number;
}

export function publicMethodPolicies(
  methods: Readonly<Record<string, MethodPolicy>>,
): PublicMethodPolicy[] {
  return Object.entries(methods).map(([method, policy]) => ({
    method,
    maxGas: policy.maxGas.toString(),
    maxDepositYocto: maxDepositYocto(policy).toString(),
    depositKind: policy.deposit.kind,
    ...(policy.deposit.kind === "per-item"
      ? { maxItems: policy.deposit.maxItems }
      : {}),
  }));
}

/** Default policy map shared by the service and its public projection. */
export const DEFAULT_METHODS: Readonly<Record<string, MethodPolicy>> = ALLOWED_METHODS;
