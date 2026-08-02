import test from "node:test";
import assert from "node:assert/strict";
import { parseInteger, parseUsd } from "./inputs.js";

test("integer inputs accept digits and reject decimal separators", () => {
  assert.equal(parseInteger("10000", "SAT"), 10_000n);
  assert.throws(() => parseInteger("1.2", "SAT"), /inteiro/i);
  assert.throws(() => parseInteger("10,000", "SAT"), /inteiro/i);
});

test("USD inputs parse cents with at most two decimal places", () => {
  assert.equal(parseUsd("5,00"), 500n);
  assert.equal(parseUsd("0.01"), 1n);
  assert.throws(() => parseUsd("1.234"), /duas casas/i);
});
