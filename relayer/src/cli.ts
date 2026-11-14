#!/usr/bin/env node
/**
 * Relayer CLI.
 *
 *   subrosa-relayer serve            # start the HTTP relayer
 *   subrosa-relayer retire-gas-key   # withdraw the gas-key balance, then delete
 *
 * Configuration comes from the environment; secrets are never accepted as
 * command-line arguments (they would leak through process listings).
 */

import { resolveRelayerConfigFromEnv } from "./config.js";
import { RelayerError } from "./errors.js";
import { NearRelayerChain } from "./near.js";
import { SubrosaRelayer } from "./relayer.js";
import { createRelayerHttpServer } from "./server.js";

const USAGE = `usage: subrosa-relayer <command>

commands:
  serve            Start the testnet NEP-366 relayer
  retire-gas-key   Withdraw the gas key's balance, then delete the key

environment:
  RELAYER_ACCOUNT_ID       relayer account (required)
  RELAYER_GAS_KEY          curve-prefixed gas-key secret (required)
  RELAYER_RPC_URL          testnet RPC (default https://rpc.testnet.near.org)
  RELAYER_HOST             bind host (default 127.0.0.1)
  RELAYER_PORT             bind port (default 8787)
  RELAYER_API_TOKEN        optional bearer token for POST /v1/relay
  RELAYER_MAX_TTL_BLOCKS   delegate validity cap (default 600)
  RELAYER_RETIRE_RESERVE_YOCTO  balance kept for deletion tx (default 0.01 NEAR)
`;

async function serve(): Promise<void> {
  const config = resolveRelayerConfigFromEnv();
  const chain = await NearRelayerChain.create({
    relayerAccountId: config.relayerAccountId,
    gasKeySecret: config.gasKeySecret,
    rpcUrl: config.rpcUrl,
  });
  const relayer = new SubrosaRelayer({
    relayerAccountId: config.relayerAccountId,
    chain,
    network: "testnet",
    maxTtlBlocks: config.maxTtlBlocks,
  });
  const server = createRelayerHttpServer(
    relayer,
    config.apiToken === undefined ? {} : { apiToken: config.apiToken },
  );

  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(config.port, config.host, () => {
    server.off("error", listening.reject);
    listening.resolve();
  });
  await listening.promise;
  server.on("error", (error) => {
    console.error(`relayer server error: ${error.message}`);
    process.exitCode = 1;
  });
  console.log(
    `subrosa-relayer listening on http://${config.host}:${config.port} ` +
      `(network=testnet, contract=subrosa.testnet, account=${config.relayerAccountId})`,
  );

  const shutdown = (signal: NodeJS.Signals) => {
    console.log(`subrosa-relayer received ${signal}; draining connections`);
    server.close((error) => {
      if (error) {
        console.error(`relayer shutdown error: ${error.message}`);
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function retireGasKey(): Promise<void> {
  const config = resolveRelayerConfigFromEnv();
  const chain = await NearRelayerChain.create({
    relayerAccountId: config.relayerAccountId,
    gasKeySecret: config.gasKeySecret,
    rpcUrl: config.rpcUrl,
  });
  const result = await chain.retireGasKey({ reserveYocto: config.retireReserveYocto });
  console.log(
    `gas key retired: withdrawn=${result.withdrawnYocto.toString()} yocto, deleted=${result.deleted}`,
  );
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  if (command === "serve") {
    await serve();
    return;
  }
  if (command === "retire-gas-key") {
    await retireGasKey();
    return;
  }
  console.error(`unknown command: ${command}`);
  console.error(USAGE);
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  if (error instanceof RelayerError) {
    console.error(`relayer error [${error.code}]: ${error.message}`);
  } else {
    console.error("relayer error [INTERNAL_ERROR]: unexpected failure");
  }
  process.exitCode = 1;
});
