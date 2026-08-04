import test from "node:test";
import assert from "node:assert/strict";
import { describeMintInfo, inspectMint } from "./mints.js";

test("mint info identifies both SAT and USD issuance", () => {
  assert.deepEqual(
    describeMintInfo({
      nuts: {
        "4": {
          methods: [
            { method: "bolt11", unit: "sat" },
            { method: "bolt11", unit: "usd" }
          ]
        }
      }
    }),
    { supportsSat: true, supportsUsd: true, label: "sat + usd online" }
  );
});

test("mint info reports partial unit support", () => {
  assert.deepEqual(
    describeMintInfo({ nuts: { "4": { methods: [{ method: "bolt11", unit: "sat" }] } } }),
    { supportsSat: true, supportsUsd: false, label: "online" }
  );
});

test("mint inspection requests /v1/info and returns a normalized result", async () => {
  const calls = [];
  const result = await inspectMint("https://mint.example/", async (url, options) => {
    calls.push({ url, signal: options.signal });
    return {
      ok: true,
      async json() {
        return { nuts: { "4": { methods: [{ unit: "sat" }, { unit: "usd" }] } } };
      }
    };
  });

  assert.equal(result.status, "online");
  assert.equal(result.label, "sat + usd online");
  assert.equal(calls[0].url, "https://mint.example/v1/info");
  assert.equal(calls[0].signal.aborted, false);
});

test("mint inspection reports HTTP and network failures without throwing", async () => {
  const httpFailure = await inspectMint("https://mint.example", async () => ({ ok: false, status: 503 }));
  assert.deepEqual(httpFailure, { status: "offline", label: "HTTP 503" });

  const networkFailure = await inspectMint("https://mint.example", async () => {
    throw new Error("offline");
  });
  assert.deepEqual(networkFailure, { status: "offline", label: "unavailable / CORS" });
});
