/**
 * Policy constants for the subrosa.testnet relayer.
 *
 * The relayer sponsors both gas and any attached storage deposit of the inner
 * actions (NEP-366: "If the inner actions have an attached token balance, this
 * is also paid for by the relayer"). Every limit below is therefore a spending
 * limit on the relayer's account, not a formality.
 */

/** The only network this relayer serves. Mainnet is rejected by construction. */
export const RELAYER_NETWORK = "testnet" as const;
export type RelayerNetwork = typeof RELAYER_NETWORK;

/** The only contract this relayer will submit calls to. */
export const SUBROSA_TESTNET_CONTRACT = "subrosa.testnet";

/** Public RPC used when `RELAYER_RPC_URL` is unset. */
export const DEFAULT_TESTNET_RPC_URL = "https://rpc.testnet.near.org";

/** 1 yoctoNEAR per storage byte (the protocol's `storage_byte_cost`). */
export const YOCTO_PER_BYTE = 10n ** 19n;

/** Runtime record sizes from the contract's documented storage model. */
export const EMPLOYEE_RECORD_BYTES = 567n;
export const COMMITMENT_RECORD_BYTES = 182n;
/** `batch_commit_salaries` cap (`MAX_BATCH_COMMITS` in the contract). */
export const MAX_BATCH_COMMITS = 50;

/** 1 TGas in gas units. */
export const TGAS = 10n ** 12n;

/**
 * Storage deposit an inner action may attach.
 *
 * - `exact`: the action must attach exactly this deposit (the contract retains
 *   a surplus, so overpaying is a relayer loss).
 * - `per-item`: the deposit must equal `items * yoctoPerItem` after the batch
 *   argument list is parsed.
 */
export type DepositRule =
  | { readonly kind: "exact"; readonly yocto: bigint }
  | { readonly kind: "per-item"; readonly yoctoPerItem: bigint; readonly maxItems: number }
  | {
      readonly kind: "register";
      readonly baseYocto: bigint;
      readonly perMetadataByteYocto: bigint;
      readonly maxMetadataBytes: number;
    };

/** Local limits for one allowlisted contract method. */
export interface MethodPolicy {
  readonly maxGas: bigint;
  readonly deposit: DepositRule;
}

/**
 * The only methods a meta transaction may call. Registration and salary
 * commitments are the cold-start path: the employer can hold zero NEAR because
 * the relayer pays gas *and* the storage deposit.
 */
export const ALLOWED_METHODS = {
  register_employee: {
    maxGas: 100n * TGAS,
    // register_employee charges EMPLOYEE_RECORD_BYTES + metadata bytes.
    deposit: {
      kind: "register",
      baseYocto: EMPLOYEE_RECORD_BYTES * YOCTO_PER_BYTE,
      perMetadataByteYocto: YOCTO_PER_BYTE,
      maxMetadataBytes: 256,
    },
  },
  commit_salary: {
    maxGas: 100n * TGAS,
    deposit: { kind: "exact", yocto: COMMITMENT_RECORD_BYTES * YOCTO_PER_BYTE },
  },
  batch_commit_salaries: {
    maxGas: 300n * TGAS,
    deposit: {
      kind: "per-item",
      yoctoPerItem: COMMITMENT_RECORD_BYTES * YOCTO_PER_BYTE,
      maxItems: MAX_BATCH_COMMITS,
    },
  },
} as const satisfies Record<string, MethodPolicy>;

/** Maximum validity window accepted for a delegate action, in blocks. */
export const DEFAULT_MAX_TTL_BLOCKS = 600;

/** In-process sponsored-deposit budget per sender (1 NEAR). */
export const DEFAULT_MAX_SPONSORED_DEPOSIT_PER_SENDER_YOCTO = 10n ** 24n;

/** Maximum serialized signed-delegate size accepted over HTTP (48 KiB). */
export const MAX_SIGNED_DELEGATE_BYTES = 48 * 1024;

/** Maximum JSON request body accepted by the relayer HTTP surface (96 KiB). */
export const MAX_HTTP_BODY_BYTES = 96 * 1024;

/**
 * YoctoNEAR kept on the gas key while retiring it. The gas key pays for the
 * withdrawal and deletion transactions; withdrawing the whole balance would
 * leave nothing to pay those fees. 0.01 NEAR covers both with a wide margin.
 */
export const DEFAULT_RETIRE_RESERVE_YOCTO = 10n ** 22n;
