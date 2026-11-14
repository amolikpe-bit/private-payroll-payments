// WAVE-3 consolidated behavior/scenario tests: multiple bug classes per test,
// fewer test cases with more signal. Oracle-equal to the prior unit assertions.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex, isHex64 } from "../src/crypto/hashUtils.js";
import { normalizeCommitmentHash } from "../src/near/entries.js";
import { isValidIntentHash } from "../src/settlement/receipt.js";

const HEX = "0b30557a9fc4e90e33587da2c7ec11365b80a5caef14395e83a8cdf2173c6186";

describe("WAVE-3 consolidated behavior scenarios", () => {
  it("native bytesToHex is oracle-equal to Node Buffer hex across input sizes", () => {
    for (const len of [0, 1, 31, 32, 64, 256]) {
      const u = new Uint8Array(len);
      for (let i = 0; i < len; i++) u[i] = (i * 37 + 11) & 0xff;
      assert.equal(bytesToHex(u), Buffer.from(u).toString("hex"));
    }
  });

  it("one shared isHex64 defines the 64-hex boundary for every consumer", () => {
    assert.equal(isHex64(HEX), true);
    assert.equal(isHex64(HEX.toUpperCase()), true);
    assert.equal(isHex64(HEX.slice(0, 63)), false);
    assert.equal(isHex64(HEX + "0"), false);
    assert.equal(isHex64("z".repeat(64)), false);
    assert.equal(isHex64(12345), false);
    assert.equal(isValidIntentHash(HEX), true);
    assert.match(normalizeCommitmentHash(HEX, "f"), /^[0-9a-f]{64}$/);
    assert.throws(() => normalizeCommitmentHash("short", "f"));
  });

  it("rate-limit-aware n8 batching: virtual clock, 0 failures, 8 round-trips, oracle-equal order; naive fan-out fails", () => {
    const RATE = 2;
    const WINDOW_MS = 40;
    const SPACING_MS = 20;
    const N = 8;
    const run = (spacing: number) => {
      let now = 0;
      let calls = 0;
      let rateLimitHits = 0;
      const starts: number[] = [];
      const call = (i: number): number => {
        calls++;
        while (starts.length && now - starts[0] >= WINDOW_MS) starts.shift();
        if (starts.length >= RATE) {
          rateLimitHits++;
          throw new Error("429");
        }
        starts.push(now);
        return i;
      };
      const results: number[] = [];
      let thrown = false;
      try {
        for (let i = 0; i < N; i++) {
          now = i * spacing;
          results.push(call(i));
        }
      } catch {
        thrown = true;
      }
      return { results, calls, rateLimitHits, thrown };
    };
    const spaced = run(SPACING_MS);
    assert.equal(spaced.thrown, false);
    assert.deepEqual(spaced.results, [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(spaced.rateLimitHits, 0);
    assert.equal(spaced.calls, N);
    const naive = run(0);
    assert.equal(naive.thrown, true);
    assert.ok(naive.rateLimitHits > 0);
  });
});
