import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  DelegateAction,
  KeyPair,
  Signature,
  SignedDelegate,
  actions as nearActions,
  encodeDelegateAction,
} from "near-api-js";

import { EMPLOYEE_RECORD_BYTES, SUBROSA_TESTNET_CONTRACT, TGAS, YOCTO_PER_BYTE } from "../src/constants.js";
import { encodeSignedDelegateBase64 } from "../src/delegate.js";
import type { RelayerDescription, RelayerRequestHandler, RelayReceipt } from "../src/relayer.js";
import { createRelayerHttpServer } from "../src/server.js";

function buildDelegate(): SignedDelegate {
  const keyPair = KeyPair.fromRandom("ed25519");
  const delegateAction = new DelegateAction({
    senderId: "alice.testnet",
    receiverId: SUBROSA_TESTNET_CONTRACT,
    actions: [
      nearActions.functionCall(
        "register_employee",
        new TextEncoder().encode(
          JSON.stringify({
            employee: "alice.testnet",
            salary_commitment: "a".repeat(64),
            token: "usdc.testnet",
            metadata: "",
          }),
        ),
        100n * TGAS,
        EMPLOYEE_RECORD_BYTES * YOCTO_PER_BYTE,
      ),
    ],
    nonce: 1n,
    maxBlockHeight: 1_100n,
    publicKey: keyPair.getPublicKey(),
  });
  const digest = new Uint8Array(
    createHash("sha256").update(encodeDelegateAction(delegateAction)).digest(),
  );
  const signed = keyPair.sign(digest);
  return new SignedDelegate({
    delegateAction,
    signature: new Signature({ keyType: keyPair.getPublicKey().keyType, data: signed.signature }),
  });
}

class FakeRelayer implements RelayerRequestHandler {
  relayCalls = 0;
  async relay(): Promise<RelayReceipt> {
    this.relayCalls += 1;
    return { txHash: "11111111111111111111111111111111", status: "success" };
  }
  describe(): RelayerDescription {
    return {
      network: "testnet",
      contractId: SUBROSA_TESTNET_CONTRACT,
      methods: [],
      maxTtlBlocks: 600,
    };
  }
}

async function startServer(
  handler: RelayerRequestHandler,
  options: { apiToken?: string; maxBodyBytes?: number } = {},
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createRelayerHttpServer(handler, options);
  const listening = Promise.withResolvers<number>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    listening.resolve(address.port);
  });
  const port = await listening.promise;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      return closed.promise;
    },
  };
}

test("health and policy routes expose no secrets", async () => {
  const server = await startServer(new FakeRelayer());
  try {
    const health = await fetch(`${server.baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      status: "ok",
      network: "testnet",
      contractId: SUBROSA_TESTNET_CONTRACT,
    });
    const policy = await fetch(`${server.baseUrl}/v1/policy`);
    assert.equal(policy.status, 200);
    const body = (await policy.json()) as { network: string; methods: unknown[] };
    assert.equal(body.network, "testnet");
    assert.deepEqual(body.methods, []);
  } finally {
    await server.close();
  }
});

test("relays a valid signed delegate and reports the receipt", async () => {
  const handler = new FakeRelayer();
  const server = await startServer(handler);
  try {
    const response = await fetch(`${server.baseUrl}/v1/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedDelegate: encodeSignedDelegateBase64(buildDelegate()) }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      txHash: "11111111111111111111111111111111",
      status: "success",
    });
    assert.equal(handler.relayCalls, 1);
  } finally {
    await server.close();
  }
});

test("requires the bearer token when configured", async () => {
  const handler = new FakeRelayer();
  const server = await startServer(handler, { apiToken: "secret-token" });
  try {
    const denied = await fetch(`${server.baseUrl}/v1/relay`, {
      method: "POST",
      body: JSON.stringify({ signedDelegate: encodeSignedDelegateBase64(buildDelegate()) }),
    });
    assert.equal(denied.status, 401);
    const body = (await denied.json()) as { error: { code: string } };
    assert.equal(body.error.code, "UNAUTHORIZED");

    const allowed = await fetch(`${server.baseUrl}/v1/relay`, {
      method: "POST",
      headers: { authorization: "Bearer secret-token" },
      body: JSON.stringify({ signedDelegate: encodeSignedDelegateBase64(buildDelegate()) }),
    });
    assert.equal(allowed.status, 200);
  } finally {
    await server.close();
  }
});

test("rejects malformed and oversized bodies without relaying", async () => {
  const handler = new FakeRelayer();
  const server = await startServer(handler, { maxBodyBytes: 32 });
  try {
    const malformed = await fetch(`${server.baseUrl}/v1/relay`, {
      method: "POST",
      body: "{not json",
    });
    assert.equal(malformed.status, 400);
    const malformedBody = (await malformed.json()) as { error: { code: string } };
    assert.equal(malformedBody.error.code, "INVALID_REQUEST");

    const oversized = await fetch(`${server.baseUrl}/v1/relay`, {
      method: "POST",
      body: JSON.stringify({ signedDelegate: "A".repeat(128) }),
    });
    assert.equal(oversized.status, 413);
    const oversizedBody = (await oversized.json()) as { error: { code: string } };
    assert.equal(oversizedBody.error.code, "BODY_TOO_LARGE");
    assert.equal(handler.relayCalls, 0);
  } finally {
    await server.close();
  }
});

test("returns 404 for unknown routes and 405 for wrong methods", async () => {
  const server = await startServer(new FakeRelayer());
  try {
    const notFound = await fetch(`${server.baseUrl}/nope`);
    assert.equal(notFound.status, 404);
    const wrongMethod = await fetch(`${server.baseUrl}/v1/relay`);
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");
  } finally {
    await server.close();
  }
});
