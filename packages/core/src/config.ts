/**
 * Network selection and client configuration for the subrosa SDK.
 *
 * Presets cover the two supported networks and apply explicit overrides.
 * Environment loading is intentionally left to the application.
 */

export type SubrosaNetwork = "testnet" | "mainnet";

export interface NearClientConfig {
  network: SubrosaNetwork;
  rpcUrl: string;
  /** Optional same-network failover endpoints; `rpcUrl` is always primary. */
  rpcUrls?: readonly string[];
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


function preferEnv(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
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

