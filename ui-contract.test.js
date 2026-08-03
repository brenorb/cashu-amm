import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("./index.html", import.meta.url), "utf8");

test("the page exposes the two required operations as tabs", () => {
  assert.match(html, /id="liquidity-tab"[^>]*role="tab"/);
  assert.match(html, /id="trade-tab"[^>]*role="tab"/);
  assert.match(html, /aria-controls="liquidity-panel"/);
  assert.match(html, /aria-controls="trade-panel"/);
});

test("the page exposes Cashu token operations and mint status controls", () => {
  for (const id of [
    "refresh-pool",
    "liquidity-form",
    "trade-form",
    "redeem-form",
    "activity-ledger",
    "refresh-mints",
    "sat-token-input",
    "usd-token-input",
    "trade-token-input",
    "lp-token-input",
    "mint-quote-form",
    "mint-paid",
    "copy-lp-token",
    "copy-redeem-sat",
    "copy-redeem-usd",
    "copy-trade-token",
    "copy-mint-token"
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /data-faucet=/);
  assert.doesNotMatch(html, /MOCK BEARER RECEIPT/);
});

test("the browser client delegates state to the backend API", async () => {
  const app = await readFile(new URL("./app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /localStorage/);
  assert.match(app, /\/api\/liquidity\/deposit/);
  assert.match(app, /\/api\/swap/);
  assert.match(app, /\/api\/liquidity\/redeem/);
  assert.match(app, /crypto\.randomUUID\(\)/);
  assert.match(app, /operation_id/);
});
