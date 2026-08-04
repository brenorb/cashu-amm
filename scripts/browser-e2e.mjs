#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright-core";

const baseUrl = process.env.CASHU_AMM_E2E_URL || "http://127.0.0.1:8090";
const screenshotPath = resolve(
  process.env.CASHU_AMM_E2E_SCREENSHOT || "artifacts/browser-e2e.png"
);

const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
  headless: true
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(30_000);

const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

async function mint(asset, amount) {
  const priorQuote = await page.locator("#mint-quote-id").textContent();
  const priorToken = await page.locator("#mint-token-output").textContent();
  await page.locator(`[data-mint-asset="${asset}"]`).click();
  await page.locator("#mint-amount").fill(String(amount));
  await page.locator("#mint-quote-form button[type=submit]").click();
  await page.waitForFunction(
    (previous) => {
      const current = document.querySelector("#mint-quote-id")?.textContent || "";
      return current.length > 0 && current !== previous;
    },
    priorQuote
  );

  for (let attempt = 0; attempt < 25; attempt += 1) {
    await page.locator("#mint-paid").click();
    await page.waitForTimeout(250);
    const token = await page.locator("#mint-token-output").textContent();
    if (token?.startsWith("cashu") && token !== priorToken) return token;
  }
  throw new Error(`${asset} Testnut token was not mintable from the website`);
}

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const initial = await page.evaluate(async () => (await fetch("/api/pool")).json());
  assert.equal(initial.initialized, false, "browser E2E requires an empty pool");
  assert.equal(await page.locator("#wallet-sat").textContent(), "0 sat");
  assert.equal(await page.locator("#wallet-usd").textContent(), "$0.00");

  await page.locator("#get-demo-funds").click();
  await page.waitForFunction(() =>
    document.querySelector("#wallet-token-count")?.textContent === "2 tokens"
  );
  await page.locator('.wallet-panel [data-wallet-liquidity]').click();
  const satLiquidity = await page.locator("#sat-token-input").inputValue();
  const usdLiquidity = await page.locator("#usd-token-input").inputValue();
  assert.ok(satLiquidity.startsWith("cashu"));
  assert.ok(usdLiquidity.startsWith("cashu"));
  assert.equal(await page.locator("#sat-token-input").inputValue(), satLiquidity);
  assert.equal(await page.locator("#usd-token-input").inputValue(), usdLiquidity);
  await page.locator("#liquidity-form button[type=submit]").click();
  await page.waitForFunction(() =>
    document.querySelector("#lp-token-value")?.textContent?.startsWith("cashu")
  );
  const lpToken = await page.locator("#lp-token-value").textContent();
  assert.ok(lpToken?.startsWith("cashu"));
  const sellPrice = await page.locator("#sell-price").textContent();
  const buyPrice = await page.locator("#buy-price").textContent();
  assert.notEqual(sellPrice, "—");
  assert.notEqual(buyPrice, "—");

  await page.locator(".market-quote.buy").click();
  await page.waitForFunction(() =>
    document.querySelector('[data-direction="usd-sat"]')?.classList.contains("active")
  );

  const satTrade = await mint("sat", 501);
  await page.locator('.wallet-panel [data-wallet-use="sat"]').click();
  assert.equal(await page.locator("#trade-token-input").inputValue(), satTrade);
  await page.locator("#trade-form button[type=submit]").click();
  await page.waitForFunction(() =>
    document.querySelector("#trade-output-token")?.textContent?.startsWith("cashu")
  );
  const satToUsdAmount = `${await page.locator("#trade-output-amount").textContent()} ${await page.locator("#trade-output-unit").textContent()}`;

  const priorTradeToken = await page.locator("#trade-output-token").textContent();
  const usdTrade = await mint("usd", 51);
  await page.locator('.wallet-panel [data-wallet-use="usd"]').click();
  assert.equal(await page.locator("#trade-token-input").inputValue(), usdTrade);
  await page.locator("#trade-form button[type=submit]").click();
  await page.waitForFunction(
    (previous) => {
      const token = document.querySelector("#trade-output-token")?.textContent || "";
      return token.startsWith("cashu") && token !== previous;
    },
    priorTradeToken
  );
  const usdToSatAmount = `${await page.locator("#trade-output-amount").textContent()} ${await page.locator("#trade-output-unit").textContent()}`;

  await page.locator('.wallet-panel [data-wallet-use="lp"]').click();
  assert.equal(await page.locator("#lp-token-input").inputValue(), lpToken);
  await page.locator("#redeem-form button[type=submit]").click();
  await page.waitForFunction(() =>
    ["#redeem-sat-token", "#redeem-usd-token"].every((selector) =>
      document.querySelector(selector)?.textContent?.startsWith("cashu")
    )
  );

  const final = await page.evaluate(async () => (await fetch("/api/pool")).json());
  assert.deepEqual(final.pool, { sat: 0, usd: 0, shares: 0 });
  assert.equal(await page.locator("#wallet-lp").textContent(), "0 LP");
  assert.notEqual(await page.locator("#wallet-sat").textContent(), "0 sat");
  assert.notEqual(await page.locator("#wallet-usd").textContent(), "$0.00");
  assert.deepEqual(pageErrors, []);
  await mkdir(dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });

  console.log(JSON.stringify({
    result: "ok",
    flow: ["one-click SAT/USD wallet funding", "wallet-funded deposit", "mint LP", "wallet-funded SAT→USD", "wallet-funded USD→SAT", "wallet LP redemption"],
    sat_to_usd: satToUsdAmount,
    usd_to_sat: usdToSatAmount,
    final_pool: final.pool,
    screenshot: screenshotPath
  }, null, 2));
} finally {
  await browser.close();
}
