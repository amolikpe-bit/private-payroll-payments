/** Environment-driven relayer configuration. Testnet only, by construction. */

import {
  DEFAULT_MAX_TTL_BLOCKS,
  DEFAULT_RETIRE_RESERVE_YOCTO,
  DEFAULT_TESTNET_RPC_URL,
} from "./constants.js";
import { RelayerError } from "./errors.js";

export interface RelayerEnvConfig {
  readonly relayerAccountId: string;
  /** Secret gas-key material; never logged. */
  readonly gasKeySecret: string;
  readonly rpcUrl: string;
  readonly host: string;
  readonly port: number;
  readonly apiToken?: string;
  readonly maxTtlBlocks: number;
  readonly retireReserveYocto: bigint;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const LOOPBACK_HOSTS: Readonly<Record<string, true>> = {
  localhost: true,
  "127.0.0.1": true,
  "::1": true,
  "[::1]": true,
};

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new RelayerError("INVALID_REQUEST", `${name} is required.`);
  }
  return value;
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function parsePositiveInt(value: string, name: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new RelayerError("INVALID_REQUEST", `${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RelayerError("INVALID_REQUEST", `${name} must be a positive integer.`);
  }
  return parsed;
}

function parsePort(value: string): number {
  const port = parsePositiveInt(value, "RELAYER_PORT");
  if (port > 65_535) {
    throw new RelayerError("INVALID_REQUEST", "RELAYER_PORT must be at most 65535.");
  }
  return port;
}

function parseBigIntEnv(value: string, name: string): bigint {
  if (!/^[0-9]+$/.test(value)) {
    throw new RelayerError("INVALID_REQUEST", `${name} must be a non-negative integer string.`);
  }
  return BigInt(value);
}

/**
 * Reject mainnet endpoints and non-local plaintext HTTP.
 *
 * Custom testnet RPCs (including a local sandbox) are allowed; anything whose
 * hostname names mainnet is not.
 */
export function assertTestnetRpcUrl(rpcUrl: string): void {
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch (error) {
    throw new RelayerError("INVALID_REQUEST", "RELAYER_RPC_URL is not a valid URL.", { cause: error });
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname.includes("mainnet")) {
    throw new RelayerError(
      "NETWORK_NOT_ALLOWED",
      "Mainnet is not supported: the relayer serves subrosa.testnet only.",
    );
  }
  if (url.protocol === "http:" && LOOPBACK_HOSTS[hostname] !== true) {
    throw new RelayerError(
      "INVALID_REQUEST",
      "Plaintext HTTP is only allowed for a loopback sandbox RPC.",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new RelayerError("INVALID_REQUEST", "RELAYER_RPC_URL must use https (or http on loopback).");
  }
}

/** Build configuration, failing closed when any required secret is absent. */
export function resolveRelayerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RelayerEnvConfig {
  const relayerAccountId = requiredEnv(env, "RELAYER_ACCOUNT_ID");
  const gasKeySecret = requiredEnv(env, "RELAYER_GAS_KEY");
  const rpcUrl = optionalEnv(env, "RELAYER_RPC_URL") ?? DEFAULT_TESTNET_RPC_URL;
  assertTestnetRpcUrl(rpcUrl);

  const apiToken = optionalEnv(env, "RELAYER_API_TOKEN");
  const maxTtlBlocksEnv = optionalEnv(env, "RELAYER_MAX_TTL_BLOCKS");
  const reserveEnv = optionalEnv(env, "RELAYER_RETIRE_RESERVE_YOCTO");
  const portEnv = optionalEnv(env, "RELAYER_PORT");

  return {
    relayerAccountId,
    gasKeySecret,
    rpcUrl,
    host: optionalEnv(env, "RELAYER_HOST") ?? DEFAULT_HOST,
    port: portEnv === undefined ? DEFAULT_PORT : parsePort(portEnv),
    ...(apiToken === undefined ? {} : { apiToken }),
    maxTtlBlocks:
      maxTtlBlocksEnv === undefined
        ? DEFAULT_MAX_TTL_BLOCKS
        : parsePositiveInt(maxTtlBlocksEnv, "RELAYER_MAX_TTL_BLOCKS"),
    retireReserveYocto:
      reserveEnv === undefined
        ? DEFAULT_RETIRE_RESERVE_YOCTO
        : parseBigIntEnv(reserveEnv, "RELAYER_RETIRE_RESERVE_YOCTO"),
  };
}
