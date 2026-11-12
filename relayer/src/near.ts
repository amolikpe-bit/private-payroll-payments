/**
 * near-api-js adapters for the relayer.
 *
 * Outer transactions are signed by a NEP-611 **full-access gas key**: near's
 * nonce manager automatically uses a gas-key nonce lane, the gas key prepays
 * the transaction, and the relayer account's liquid balance is untouched.
 *
 * A function-call gas key cannot be used here: `relayMetaTransaction` targets
 * `delegateAction.senderId` (an arbitrary user account), while a function-call
 * gas key is scoped to one receiver contract. A regular full-access key would
 * work technically but defeats NEP-611's isolated prepaid balance and nonce
 * lanes, so it is rejected.
 */

import {
  Account,
  KeyPair,
  type KeyPairString,
  type SignedDelegate,
} from "near-api-js";
import { AccessKeyDoesNotExistError } from "near-api-js/rpc-errors";

import type { AccessKeyPermissionView, RpcTransactionResponse } from "./nearTypes.js";

import {
  DEFAULT_RETIRE_RESERVE_YOCTO,
  DEFAULT_TESTNET_RPC_URL,
} from "./constants.js";
import { assertTestnetRpcUrl } from "./config.js";
import { RelayerError } from "./errors.js";
import type { RelayerChain, RelayReceipt } from "./relayer.js";

/** Minimal view of an access key needed to inspect a gas-key balance. */
export interface GasKeyAccess {
  readonly permission: AccessKeyPermissionView;
}

/** Account operations used by the gas-key retirement path. */
export interface GasKeyAdmin {
  /** `null` when the key does not exist on the account. */
  getAccessKey(publicKey: string): Promise<GasKeyAccess | null>;
  withdrawFromGasKey(publicKey: string, amount: bigint): Promise<unknown>;
  deleteKey(publicKey: string): Promise<unknown>;
}

export interface RetireGasKeyOptions {
  /**
   * YoctoNEAR kept on the key to pay for the withdrawal and deletion
   * transactions. Defaults to 0.01 NEAR.
   */
  reserveYocto?: bigint;
}

export interface RetireGasKeyResult {
  readonly withdrawnYocto: bigint;
  readonly deleted: true;
}

function gasKeyBalance(permission: AccessKeyPermissionView): bigint | null {
  if (typeof permission === "string") {
    return null;
  }
  if ("FunctionCall" in permission) {
    return null;
  }
  if ("GasKeyFunctionCall" in permission) {
    return BigInt(permission.GasKeyFunctionCall.balance);
  }
  if ("GasKeyFullAccess" in permission) {
    return BigInt(permission.GasKeyFullAccess.balance);
  }
  return null;
}

/**
 * Withdraw a gas key's prepaid balance, then delete the key.
 *
 * Deletion burns whatever balance remains on the key, so the withdrawal is a
 * separate, completed transaction *before* `deleteKey` is even attempted. If
 * the withdrawal fails, the key is left intact (and its balance recoverable).
 */
export async function withdrawThenDeleteGasKey(
  admin: GasKeyAdmin,
  publicKey: string,
  options: RetireGasKeyOptions = {},
): Promise<RetireGasKeyResult> {
  const reserve = options.reserveYocto ?? DEFAULT_RETIRE_RESERVE_YOCTO;
  // DeleteKey fails when a gas key would burn more than 1 NEAR.
  if (reserve < 0n || reserve > 10n ** 24n) {
    throw new RelayerError("INVALID_REQUEST", "Retirement reserve must be between 0 and 1 NEAR.");
  }

  let access: GasKeyAccess | null;
  try {
    access = await admin.getAccessKey(publicKey);
  } catch (error) {
    throw new RelayerError("UPSTREAM_ERROR", "Could not read the gas key from RPC.", {
      cause: error,
    });
  }
  if (access === null) {
    throw new RelayerError("GAS_KEY_NOT_FOUND", "Configured gas key does not exist on the account.");
  }

  let balance: bigint | null;
  try {
    balance = gasKeyBalance(access.permission);
  } catch (error) {
    throw new RelayerError("UPSTREAM_ERROR", "Gas-key balance is malformed.", { cause: error });
  }
  if (balance === null) {
    throw new RelayerError(
      "GAS_KEY_REQUIRED",
      "Configured relayer key is not a gas key; refusing to delete it through this path.",
    );
  }

  const withdrawAmount = balance > reserve ? balance - reserve : 0n;
  if (withdrawAmount > 0n) {
    try {
      await admin.withdrawFromGasKey(publicKey, withdrawAmount);
    } catch (error) {
      throw new RelayerError(
        "GAS_KEY_WITHDRAW_FAILED",
        "Gas-key balance withdrawal failed; the key was not deleted.",
        { cause: error },
      );
    }
  }

  try {
    await admin.deleteKey(publicKey);
  } catch (error) {
    throw new RelayerError(
      "GAS_KEY_DELETE_FAILED",
      "Gas-key balance was withdrawn but key deletion failed.",
      { cause: error },
    );
  }

  return { withdrawnYocto: withdrawAmount, deleted: true };
}

export interface NearRelayerChainOptions {
  readonly relayerAccountId: string;
  /** Curve-prefixed secret key of the relayer's full-access gas key. */
  readonly gasKeySecret: string;
  readonly rpcUrl?: string;
}

export class NearRelayerChain implements RelayerChain {
  readonly #account: Account;
  readonly #publicKey: string;

  private constructor(account: Account, publicKey: string) {
    this.#account = account;
    this.#publicKey = publicKey;
  }

  /**
   * Build the adapter and fail closed unless the configured key is a
   * full-access gas key belonging to the relayer account.
   */
  static async create(options: NearRelayerChainOptions): Promise<NearRelayerChain> {
    const secret = options.gasKeySecret?.trim();
    if (!secret || !/^(ed25519|secp256k1|ml-dsa-65):[1-9A-HJ-NP-Za-km-z]+$/.test(secret)) {
      throw new RelayerError(
        "GAS_KEY_REQUIRED",
        "RELAYER_GAS_KEY must be a curve-prefixed NEAR secret key.",
      );
    }
    let keyPair: KeyPair;
    try {
      keyPair = KeyPair.fromString(secret as KeyPairString);
    } catch (error) {
      throw new RelayerError("GAS_KEY_REQUIRED", "RELAYER_GAS_KEY is not a valid NEAR secret key.", {
        cause: error,
      });
    }
    const rpcUrl = options.rpcUrl ?? DEFAULT_TESTNET_RPC_URL;
    assertTestnetRpcUrl(rpcUrl);
    const account = new Account(options.relayerAccountId, rpcUrl, secret as KeyPairString);
    let networkId: string;
    try {
      networkId = await account.provider.getNetworkId();
    } catch (error) {
      throw new RelayerError("UPSTREAM_ERROR", "Could not read the chain id from RPC.", {
        cause: error,
      });
    }
    if (networkId === "mainnet") {
      throw new RelayerError(
        "NETWORK_NOT_ALLOWED",
        "Mainnet is not supported: the relayer serves subrosa.testnet only.",
      );
    }
    const chain = new NearRelayerChain(account, keyPair.getPublicKey().toString());
    await chain.#assertFullAccessGasKey();
    return chain;
  }

  get publicKey(): string {
    return this.#publicKey;
  }

  async #viewAccessKey(publicKey: string) {
    return this.#account.provider.viewAccessKey({
      accountId: this.#account.accountId,
      publicKey,
      finalityQuery: { finality: "final" },
    });
  }

  async #assertFullAccessGasKey(): Promise<void> {
    let permission: AccessKeyPermissionView;
    try {
      permission = (await this.#viewAccessKey(this.#publicKey)).permission;
    } catch (error) {
      if (error instanceof AccessKeyDoesNotExistError) {
        throw new RelayerError(
          "GAS_KEY_NOT_FOUND",
          "Relayer gas key does not exist on the relayer account.",
          { cause: error },
        );
      }
      throw new RelayerError("UPSTREAM_ERROR", "Could not read the relayer gas key from RPC.", {
        cause: error,
      });
    }
    if (typeof permission === "string") {
      throw new RelayerError(
        "GAS_KEY_REQUIRED",
        "The relayer must sign outer transactions with a full-access gas key (NEP-611), not a regular key.",
      );
    }
    if ("FunctionCall" in permission) {
      throw new RelayerError(
        "GAS_KEY_REQUIRED",
        "The relayer must sign outer transactions with a full-access gas key (NEP-611), not a regular key.",
      );
    }
    if ("GasKeyFunctionCall" in permission) {
      throw new RelayerError(
        "GAS_KEY_REQUIRED",
        "A function-call gas key cannot relay: outer transactions target arbitrary sender accounts.",
      );
    }
    if (!("GasKeyFullAccess" in permission)) {
      throw new RelayerError(
        "GAS_KEY_REQUIRED",
        "The relayer key is not a recognized full-access gas key.",
      );
    }
  }

  async currentBlockHeight(): Promise<bigint> {
    const block = await this.#account.provider.viewBlock({ finality: "final" });
    return BigInt(block.header.height);
  }

  async getAccessKey(
    accountId: string,
    publicKey: string,
  ): Promise<AccessKeyPermissionView | null> {
    try {
      const view = await this.#account.provider.viewAccessKey({
        accountId,
        publicKey,
        finalityQuery: { finality: "final" },
      });
      return view.permission;
    } catch (error) {
      if (error instanceof AccessKeyDoesNotExistError) {
        return null;
      }
      throw error;
    }
  }

  async relay(signedDelegate: SignedDelegate): Promise<RelayReceipt> {
    let response: RpcTransactionResponse;
    try {
      // near-api-js reserves a gas-key nonce lane and signs the outer tx with
      // the configured gas key, which pays the gas.
      response = await this.#account.relayMetaTransaction(signedDelegate);
    } catch (error) {
      throw new RelayerError("RELAY_FAILED", "Meta transaction submission failed.", {
        cause: error,
      });
    }
    const failed =
      typeof response.status === "object" &&
      response.status !== null &&
      "Failure" in response.status;
    const finalExecutionStatus =
      typeof response.final_execution_status === "string"
        ? response.final_execution_status
        : undefined;
    return {
      txHash: response.transaction.hash,
      status: failed ? "failure" : "success",
      ...(finalExecutionStatus === undefined ? {} : { finalExecutionStatus }),
    };
  }

  /** Withdraw the gas key's prepaid balance, then delete the key. */
  async retireGasKey(options: RetireGasKeyOptions = {}): Promise<RetireGasKeyResult> {
    const admin: GasKeyAdmin = {
      getAccessKey: async (publicKey) => {
        try {
          const view = await this.#viewAccessKey(publicKey);
          return { permission: view.permission };
        } catch (error) {
          if (error instanceof AccessKeyDoesNotExistError) {
            return null;
          }
          throw error;
        }
      },
      withdrawFromGasKey: (publicKey, amount) =>
        this.#account.withdrawFromGasKey(publicKey, amount),
      deleteKey: (publicKey) => this.#account.deleteKey(publicKey),
    };
    return withdrawThenDeleteGasKey(admin, this.#publicKey, options);
  }
}
