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

test("the page exposes faucet, liquidity, trade, redemption, and mint status controls", () => {
  for (const id of [
    "reset-demo",
    "liquidity-form",
    "trade-form",
    "redeem-form",
    "activity-ledger",
    "refresh-mints"
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /data-faucet="sat"/);
  assert.match(html, /data-faucet="usd"/);
});

