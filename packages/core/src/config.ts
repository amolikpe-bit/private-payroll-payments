/**
 * Network selection and client configuration for the subrosa SDK.
 *
 * Presets cover the two supported networks; `resolveConfigFromEnv` layers the
 * process environment on top so a backend can point the same code at a custom
 * RPC endpoint or a differently named contract account.
 */

export type SubrosaNetwork = "testnet" | "mainnet";

export interface NearClientConfig {
  network: SubrosaNetwork;
  rpcUrl: string;
  contractId: string;
  oneClickBaseUrl: string;
}

export const RPC_URLS: Record<SubrosaNetwork, string> = {
  testnet: "https://rpc.testnet.near.org",
  mainnet: "https://rpc.mainnet.near.org",
};

export const SUBROSA_CONTRACT_IDS: Record<SubrosaNetwork, string> = {
  testnet: "subrosa.testnet",
  mainnet: "subrosa.near",
};

export const ONECLICK_BASE_URL = "https://1click.chaindefuser.com";

export type NearClientConfigOverrides = Partial<Omit<NearClientConfig, "network">>;

function isSubrosaNetwork(value: string): value is SubrosaNetwork {
  return value === "testnet" || value === "mainnet";
}

function preferEnv(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

/**
 * Parse `SUBROSA_NETWORK`. Unset or blank selects testnet; anything outside the
 * two supported networks is a configuration error, not a silent fallback.
 */
export function parseNetwork(value: string | undefined): SubrosaNetwork {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return "testnet";
  }
  if (isSubrosaNetwork(normalized)) {
    return normalized;
  }
  throw new Error(
    `Unsupported SUBROSA_NETWORK value "${value}": expected "testnet" or "mainnet".`,
  );
}

/** Named presets; explicit overrides take precedence over preset values. */
export class NearConfigPresets {
  static testnet(overrides: NearClientConfigOverrides = {}): NearClientConfig {
    return {
      network: "testnet",
      rpcUrl: preferEnv(overrides.rpcUrl, RPC_URLS.testnet),
      contractId: preferEnv(overrides.contractId, SUBROSA_CONTRACT_IDS.testnet),
      oneClickBaseUrl: preferEnv(overrides.oneClickBaseUrl, ONECLICK_BASE_URL),
    };
  }

  static mainnet(overrides: NearClientConfigOverrides = {}): NearClientConfig {
    return {
      network: "mainnet",
      rpcUrl: preferEnv(overrides.rpcUrl, RPC_URLS.mainnet),
      contractId: preferEnv(overrides.contractId, SUBROSA_CONTRACT_IDS.mainnet),
      oneClickBaseUrl: preferEnv(overrides.oneClickBaseUrl, ONECLICK_BASE_URL),
    };
  }
}

/**
 * Build a config from environment variables, falling back to the preset for
 * the selected network: `SUBROSA_NETWORK`, `NEAR_RPC_URL`, `SUBROSA_CONTRACT`,
 * `ONECLICK_BASE_URL`.
 */
export function resolveConfigFromEnv(env: NodeJS.ProcessEnv = process.env): NearClientConfig {
  const network = parseNetwork(env.SUBROSA_NETWORK);
  const preset = network === "mainnet" ? NearConfigPresets.mainnet() : NearConfigPresets.testnet();

  return {
    network,
    rpcUrl: preferEnv(env.NEAR_RPC_URL, preset.rpcUrl),
    contractId: preferEnv(env.SUBROSA_CONTRACT, preset.contractId),
    oneClickBaseUrl: preferEnv(env.ONECLICK_BASE_URL, preset.oneClickBaseUrl),
  };
}
