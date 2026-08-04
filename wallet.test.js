import test from "node:test";
import assert from "node:assert/strict";
import { createTokenWallet } from "./wallet.js";

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}

test("wallet persists known Cashu tokens and totals each asset", () => {
  const storage = new MemoryStorage();
  const wallet = createTokenWallet(storage);
  wallet.add("sat", 1_000, "cashuB-sat-one");
  wallet.add("sat", 500, "cashuB-sat-two");
  wallet.add("usd", 250, "cashuB-usd");

  const reopened = createTokenWallet(storage);
  assert.equal(reopened.total("sat"), 1_500);
  assert.equal(reopened.total("usd"), 250);
  assert.equal(reopened.latest("sat").token, "cashuB-sat-two");
});

test("wallet never stores the same bearer token twice", () => {
  const wallet = createTokenWallet(new MemoryStorage());
  wallet.add("sat", 1_000, "cashuB-same");
  wallet.add("usd", 100, "cashuB-same");

  assert.equal(wallet.total("sat"), 0);
  assert.equal(wallet.total("usd"), 100);
});

test("wallet removes spent tokens and can be cleared", () => {
  const storage = new MemoryStorage();
  const wallet = createTokenWallet(storage);
  wallet.add("lp", 42, "cashuB-lp");

  assert.equal(wallet.remove("cashuB-lp"), true);
  assert.equal(wallet.total("lp"), 0);
  wallet.add("sat", 10, "cashuB-sat");
  wallet.clear();
  assert.equal(createTokenWallet(storage).total("sat"), 0);
});

test("wallet ignores malformed persisted data", () => {
  const storage = new MemoryStorage();
  storage.setItem("cashu-amm:test-wallet:v1", "not json");
  const wallet = createTokenWallet(storage);
  assert.deepEqual(wallet.list("sat"), []);
});
