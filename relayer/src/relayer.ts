/**
 * NEP-366 relayer service.
 *
 * Flow: local policy and caps -> signature verification -> inner access-key
 * checks (regular key only, contract-scoped) -> submit with the relayer's gas
 * key. No RPC call happens before every local check passes.
 */

import type { AccessKeyPermissionView, SignedDelegate } from "near-api-js";

import {
  DEFAULT_MAX_TTL_BLOCKS,
  RELAYER_NETWORK,
  SUBROSA_TESTNET_CONTRACT,
  type MethodPolicy,
} from "./constants.js";
import { RelayerError } from "./errors.js";
import {
  DEFAULT_METHODS,
  assertTestnetNetwork,
  publicMethodPolicies,
  validateDelegateShape,
  validateDelegateWindow,
  validateInnerAccessKey,
  verifyDelegateSignature,
  type DelegateShapePolicy,
  type PublicMethodPolicy,
} from "./policy.js";

/** Chain access needed by the relayer; injectable for deterministic tests. */
export interface RelayerChain {
  currentBlockHeight(): Promise<bigint>;
  /** `null` when the key does not exist on the account. */
  getAccessKey(accountId: string, publicKey: string): Promise<AccessKeyPermissionView | null>;
  relay(signedDelegate: SignedDelegate): Promise<RelayReceipt>;
}

/** Result of an executed meta transaction. */
export interface RelayReceipt {
  readonly txHash: string;
  readonly status: "success" | "failure";
  readonly finalExecutionStatus?: string;
}

/** Public relayer description; safe to serve without auth. */
export interface RelayerDescription {
  readonly network: typeof RELAYER_NETWORK;
  readonly contractId: string;
  readonly methods: readonly PublicMethodPolicy[];
  readonly maxTtlBlocks: number;
}

export interface SubrosaRelayerOptions {
  readonly relayerAccountId: string;
  readonly chain: RelayerChain;
  /** Checked at runtime; only `"testnet"` is accepted. */
  readonly network?: string;
  readonly maxTtlBlocks?: number;
  readonly methods?: Readonly<Record<string, MethodPolicy>>;
}

const ACCOUNT_ID_PATTERN = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** The relayer request handler consumed by the HTTP layer. */
export interface RelayerRequestHandler {
  relay(signedDelegate: SignedDelegate): Promise<RelayReceipt>;
  describe(): RelayerDescription;
}

export class SubrosaRelayer implements RelayerRequestHandler {
  readonly #relayerAccountId: string;
  readonly #chain: RelayerChain;
  readonly #network: string;
  readonly #maxTtlBlocks: number;
  readonly #methods: Readonly<Record<string, MethodPolicy>>;

  constructor(options: SubrosaRelayerOptions) {
    if (
      typeof options.relayerAccountId !== "string" ||
      !ACCOUNT_ID_PATTERN.test(options.relayerAccountId)
    ) {
      throw new RelayerError("INVALID_REQUEST", "Relayer account id is invalid.");
    }
    const network = options.network ?? RELAYER_NETWORK;
    assertTestnetNetwork(network);
    const maxTtlBlocks = options.maxTtlBlocks ?? DEFAULT_MAX_TTL_BLOCKS;
    if (!Number.isSafeInteger(maxTtlBlocks) || maxTtlBlocks <= 0) {
      throw new RelayerError("INVALID_REQUEST", "maxTtlBlocks must be a positive integer.");
    }
    this.#relayerAccountId = options.relayerAccountId;
    this.#chain = options.chain;
    this.#network = network;
    this.#maxTtlBlocks = maxTtlBlocks;
    this.#methods = options.methods ?? DEFAULT_METHODS;
  }

  describe(): RelayerDescription {
    return {
      network: RELAYER_NETWORK,
      contractId: SUBROSA_TESTNET_CONTRACT,
      methods: publicMethodPolicies(this.#methods),
      maxTtlBlocks: this.#maxTtlBlocks,
    };
  }

  async relay(signedDelegate: SignedDelegate): Promise<RelayReceipt> {
    assertTestnetNetwork(this.#network);

    // Every structural and spending limit is local; only the validity window
    // needs the chain head, so malformed or over-cap delegates cost no RPC.
    const shapePolicy: DelegateShapePolicy = {
      network: RELAYER_NETWORK,
      contractId: SUBROSA_TESTNET_CONTRACT,
      relayerAccountId: this.#relayerAccountId,
      maxTtlBlocks: this.#maxTtlBlocks,
      methods: this.#methods,
    };
    const validated = validateDelegateShape(signedDelegate, shapePolicy);
    verifyDelegateSignature(signedDelegate);

    let currentBlockHeight: bigint;
    try {
      currentBlockHeight = await this.#chain.currentBlockHeight();
    } catch (error) {
      throw new RelayerError("UPSTREAM_ERROR", "Could not read the current block height.", {
        cause: error,
      });
    }
    validateDelegateWindow(validated.maxBlockHeight, currentBlockHeight, this.#maxTtlBlocks);

    let permission: AccessKeyPermissionView | null;
    try {
      permission = await this.#chain.getAccessKey(validated.senderId, validated.publicKey);
    } catch (error) {
      throw new RelayerError(
        "INNER_KEY_LOOKUP_FAILED",
        "Could not read the inner signer's access key from RPC.",
        { cause: error },
      );
    }
    validateInnerAccessKey(permission, validated.method, SUBROSA_TESTNET_CONTRACT);

    try {
      return await this.#chain.relay(signedDelegate);
    } catch (error) {
      if (error instanceof RelayerError) {
        throw error;
      }
      throw new RelayerError("RELAY_FAILED", "Meta transaction submission failed.", {
        cause: error,
      });
    }
  }
}
