/**
 * Minimal HTTP surface for the relayer.
 *
 * `POST /v1/relay` is the only mutating route. It accepts exactly one field,
 * `{ "signedDelegate": "<base64 borsh SignedDelegate>" }`, and never echoes the
 * payload, account ids, or RPC error text back to the caller.
 */

import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { MAX_HTTP_BODY_BYTES } from "./constants.js";
import { decodeSignedDelegateBase64 } from "./delegate.js";
import { RelayerError, asError } from "./errors.js";
import type { RelayerRequestHandler } from "./relayer.js";

export interface RelayerHttpServerOptions {
  /** When set, `POST /v1/relay` requires `Authorization: Bearer <token>`. */
  readonly apiToken?: string;
  readonly maxBodyBytes?: number;
}

interface JsonBody {
  readonly signedDelegate?: unknown;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.writableEnded) {
    return;
  }
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function sendError(response: ServerResponse, error: RelayerError): void {
  sendJson(response, error.status, {
    error: {
      code: error.code,
      message: error.message,
    },
  });
}

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string") {
    return undefined;
  }
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1];
}

function tokensEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function requireAuthorized(request: IncomingMessage, apiToken: string | undefined): void {
  if (apiToken === undefined) {
    return;
  }
  const supplied = bearerToken(request);
  if (supplied === undefined || !tokensEqual(supplied, apiToken)) {
    throw new RelayerError("UNAUTHORIZED", "A valid bearer token is required.");
  }
}

function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<JsonBody> {
  const { promise, resolve, reject } = Promise.withResolvers<JsonBody>();
  const chunks: Buffer[] = [];
  let total = 0;
  let settled = false;

  const fail = (error: RelayerError) => {
    if (settled) {
      return;
    }
    settled = true;
    reject(error);
  };
  const succeed = (body: JsonBody) => {
    if (settled) {
      return;
    }
    settled = true;
    resolve(body);
  };

  request.on("data", (chunk: Buffer) => {
    total += chunk.length;
    if (total > maxBodyBytes) {
      fail(new RelayerError("BODY_TOO_LARGE", "Request body exceeds the size limit."));
      request.resume();
      return;
    }
    chunks.push(chunk);
  });
  request.on("error", (error) => {
    fail(new RelayerError("INVALID_REQUEST", "Request body could not be read.", { cause: error }));
  });
  request.on("end", () => {
    if (settled) {
      return;
    }
    const text = Buffer.concat(chunks).toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      fail(new RelayerError("INVALID_REQUEST", "Request body must be JSON.", { cause: error }));
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      fail(new RelayerError("INVALID_REQUEST", "Request body must be a JSON object."));
      return;
    }
    succeed(parsed as JsonBody);
  });
  return promise;
}

/** Build an HTTP server; the caller owns `listen`/`close`. */
export function createRelayerHttpServer(
  relayer: RelayerRequestHandler,
  options: RelayerHttpServerOptions = {},
): Server {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_HTTP_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new RelayerError("INVALID_REQUEST", "maxBodyBytes must be a positive integer.");
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response, relayer, options.apiToken, maxBodyBytes);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  relayer: RelayerRequestHandler,
  apiToken: string | undefined,
  maxBodyBytes: number,
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://relayer.invalid");
    const path = url.pathname;

    if (path === "/healthz") {
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        throw new RelayerError("METHOD_HTTP_NOT_ALLOWED", "Use GET /healthz.");
      }
      const description = relayer.describe();
      sendJson(response, 200, {
        status: "ok",
        network: description.network,
        contractId: description.contractId,
      });
      return;
    }

    if (path === "/v1/policy") {
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        throw new RelayerError("METHOD_HTTP_NOT_ALLOWED", "Use GET /v1/policy.");
      }
      sendJson(response, 200, relayer.describe());
      return;
    }

    if (path === "/v1/relay") {
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        throw new RelayerError("METHOD_HTTP_NOT_ALLOWED", "Use POST /v1/relay.");
      }
      requireAuthorized(request, apiToken);
      const body = await readJsonBody(request, maxBodyBytes);
      const signedDelegate = decodeSignedDelegateBase64(body.signedDelegate);
      const receipt = await relayer.relay(signedDelegate);
      sendJson(response, 200, {
        txHash: receipt.txHash,
        status: receipt.status,
        ...(receipt.finalExecutionStatus === undefined
          ? {}
          : { finalExecutionStatus: receipt.finalExecutionStatus }),
      });
      return;
    }

    throw new RelayerError("NOT_FOUND", "Route not found.");
  } catch (error) {
    if (error instanceof RelayerError) {
      sendError(response, error);
      return;
    }
    sendError(
      response,
      new RelayerError("INTERNAL_ERROR", "Unexpected relayer failure.", {
        cause: asError(error),
      }),
    );
  }
}
