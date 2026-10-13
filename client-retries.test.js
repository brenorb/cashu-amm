import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Execute the actual request helper in isolation from the DOM startup code.
const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
const start = source.indexOf("async function postOperation(");
const end = source.indexOf("\nfunction render()", start);
assert.ok(start >= 0 && end > start);
const helper = source.slice(start, end);

for (const failure of ["network", "server"]) {
  test(`${failure} interruption preserves ID and submitted constraints for recovery`, async () => {
    const pendingOperations = new Map();
    const requests = [];
    let nextId = 0;
    const context = vm.createContext({
      pendingOperations,
      crypto: { randomUUID: () => `operation-${++nextId}` },
      fetchJson: async (_path, options) => {
        requests.push(JSON.parse(options.body));
        if (requests.length === 1) {
          const error = new Error("fixture interruption");
          if (failure === "server") { error.body = {}; error.status = 503; }
          throw error;
        }
        return { output_token: "cashuB-fixture-output", amount_out: 99 };
      }
    });
    vm.runInContext(helper, context);
    const submitted = { direction: "sat-usd", token: "cashuB-fixture-input", minimum_amount_out: 99, quote_deadline_ms: 1000 };
    await assert.rejects(context.postOperation("swap", "/api/swap", submitted));
    assert.equal(pendingOperations.size, 1);
    // A new displayed quote or caller mutation must not alter the saved retry.
    submitted.minimum_amount_out = 1;
    submitted.quote_deadline_ms = 9999;
    const saved = pendingOperations.get("swap").payload;
    const result = await context.postOperation("swap", "/api/swap", saved);
    assert.equal(result.output_token, "cashuB-fixture-output");
    assert.deepEqual(requests[1], requests[0]);
    assert.equal(requests[1].minimum_amount_out, 99);
    assert.equal(requests[1].quote_deadline_ms, 1000);
    assert.equal(nextId, 1);
    assert.equal(pendingOperations.size, 0);
  });
}

test("a definitive refunded rejection frees the next operation ID", async () => {
  const pendingOperations = new Map();
  let nextId = 0;
  const ids = [];
  const context = vm.createContext({
    pendingOperations,
    crypto: { randomUUID: () => `operation-${++nextId}` },
    fetchJson: async (_path, options) => {
      ids.push(JSON.parse(options.body).operation_id);
      const error = new Error("slippage exceeded");
      error.body = { code: "slippage_exceeded", refunds: { sat: "cashuB-fixture-refund" } };
      error.status = 409;
      throw error;
    }
  });
  vm.runInContext(helper, context);
  const payload = { direction: "sat-usd", token: "cashuB-fixture-input", minimum_amount_out: 99 };
  await assert.rejects(context.postOperation("swap", "/api/swap", payload));
  assert.equal(pendingOperations.size, 0);
  await assert.rejects(context.postOperation("swap", "/api/swap", { ...payload, token: "cashuB-fixture-refund" }));
  assert.notEqual(ids[0], ids[1]);
});
