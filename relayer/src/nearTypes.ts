/**
 * near-api-js 7.5.3 type aliases.
 *
 * The package exposes `AccessKeyView` but not the nested permission name at
 * the root. The RPC response is narrowed to the fields the relayer reads.
 */

import type { AccessKeyView } from "near-api-js";

export type AccessKeyPermissionView = AccessKeyView["permission"];

export interface RpcTransactionResponse {
  status: unknown;
  final_execution_status?: unknown;
  transaction: { hash: string };
}
