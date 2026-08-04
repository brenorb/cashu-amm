import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("./index.html", import.meta.url), "utf8");

test("the page exposes the two required operations as tabs", () => {
  assert.match(html, /id="trade-tab"[^>]*aria-selected="true"/);
  assert.match(html, /id="liquidity-tab"[^>]*aria-selected="false"/);
  assert.match(html, /aria-controls="liquidity-panel"/);
  assert.match(html, /aria-controls="trade-panel"/);
  assert.match(html, /id="liquidity-panel"[^>]*hidden/);
});

test("the default market view has clickable prices and an AMM curve", () => {
  assert.match(html, /id="sell-price"/);
  assert.match(html, /id="buy-price"/);
  assert.match(html, /data-open-trade/);
  assert.match(html, /id="reserve-point"/);
  assert.match(html, /BTC RESERVE \(x\)/);
  assert.match(html, /USD RESERVE \(y\)/);
});

test("all user-facing copy is English and avoids serialization jargon", () => {
  assert.match(html, /<html lang="en">/);
  assert.doesNotMatch(html, /TokenV4/i);
  assert.doesNotMatch(html, /Liquidez|Obter|Resgatar|Copiar|Você|participação/i);
});

test("frontend assets use a cache-busting version", () => {
  assert.match(html, /styles\.css\?v=\d+-\d+/);
  assert.match(html, /app\.js\?v=\d+-\d+/);
});

test("the site is explicit that it is not a wallet", () => {
  assert.match(html, /Not a wallet\./);
  assert.match(html, /0 balances stored/);
  assert.match(html, /cannot see how much Cashu you own/);
});

test("native asset selection is replaced with styled controls", () => {
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /data-mint-asset="sat"/);
  assert.match(html, /data-mint-asset="usd"/);
  assert.match(html, /class="token-entry"/);
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
