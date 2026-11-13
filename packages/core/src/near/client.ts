/**
 * Composed NEAR client factory.
 *
 * `NearContractWrapper` deliberately takes structural `account`/`provider`
 * dependencies so it can run against a wallet, a key-pair account, or a test
 * double. This factory keeps the five typed clients wired to one wrapper and
 * one config so callers cannot accidentally mix contract accounts/networks.
 */

import { FailoverRpcProvider, JsonRpcProvider } from "near-api-js";

import type { NearClientConfig } from "../config.js";
import { CommitmentClient } from "./CommitmentClient.js";
import { HoldClient } from "./HoldClient.js";
import {
  NearContractWrapper,
  type NearCallAccount,
  type NearContractWrapperOptions,
  type NearViewProvider,
} from "./NearContractWrapper.js";
import { PayoutClient } from "./PayoutClient.js";
import { RegistryClient } from "./RegistryClient.js";
import { VerificationKeyClient } from "./VerificationKeyClient.js";

/** Every typed contract client sharing one wrapper and config. */
export interface SubrosaNearClients {
  readonly config: NearClientConfig;
  readonly wrapper: NearContractWrapper;
  readonly registry: RegistryClient;
  readonly commitments: CommitmentClient;
  readonly payouts: PayoutClient;
  readonly holds: HoldClient;
  readonly verificationKeys: VerificationKeyClient;
}

export interface NearClientFactoryDeps {
  /** Write-capable account bound to the configured contract. */
  account: NearCallAccount;
  /** View provider; defaults to a JSON-RPC provider built from `config.rpcUrl`. */
  provider?: NearViewProvider;
  /** Retry budgets, idempotency registry, and call bounds for the wrapper. */
  wrapperOptions?: NearContractWrapperOptions;
}

/** Build the finality-pinned JSON-RPC view provider for a config. */
export function createNearProvider(config: NearClientConfig): NearViewProvider {
  if (typeof config !== "object" || config === null || typeof config.rpcUrl !== "string") {
    throw new Error("createNearProvider requires a NearClientConfig with an rpcUrl.");
  }
  const urls = [config.rpcUrl, ...(config.rpcUrls ?? [])].filter(
    (url, index, all) => url.length > 0 && all.indexOf(url) === index,
  );
  const providers = urls.map((url) => new JsonRpcProvider({ url }));
  return (providers.length === 1
    ? providers[0]
    : new FailoverRpcProvider(providers)) as NearViewProvider;
}

/**
 * Create the wrapper plus Registry/Commitment/Payout/Hold/VerificationKey
 * clients. The account is caller-supplied so key management (wallet, key store,
 * relayer, or test double) never leaks into this module.
 */
export function createNearClients(
  config: NearClientConfig,
  deps: NearClientFactoryDeps,
): SubrosaNearClients {
  if (typeof deps !== "object" || deps === null || deps.account === undefined) {
    throw new Error("createNearClients requires a write-capable account.");
  }
  const provider = deps.provider ?? createNearProvider(config);
  const wrapper = new NearContractWrapper(
    config,
    { account: deps.account, provider },
    deps.wrapperOptions,
  );
  return {
    config,
    wrapper,
    registry: new RegistryClient(wrapper),
    commitments: new CommitmentClient(wrapper),
    payouts: new PayoutClient(wrapper),
    holds: new HoldClient(wrapper),
    verificationKeys: new VerificationKeyClient(wrapper),
  };
}
