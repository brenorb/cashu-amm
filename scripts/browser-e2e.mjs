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
  await page.locator("#mint-asset").selectOption(asset);
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

  const satLiquidity = await mint("sat", 20_001);
  const usdLiquidity = await mint("usd", 1_001);
  await page.locator("#sat-token-input").fill(satLiquidity);
  await page.locator("#usd-token-input").fill(usdLiquidity);
  await page.locator("#liquidity-form button[type=submit]").click();
  await page.waitForFunction(() =>
    document.querySelector("#lp-token-value")?.textContent?.startsWith("cashu")
  );
  const lpToken = await page.locator("#lp-token-value").textContent();
  assert.ok(lpToken?.startsWith("cashu"));

  const satTrade = await mint("sat", 501);
  await page.locator("#trade-tab").click();
  await page.locator('[data-direction="sat-usd"]').click();
  await page.locator("#trade-token-input").fill(satTrade);
  await page.locator("#trade-form button[type=submit]").click();
  await page.waitForFunction(() =>
    document.querySelector("#trade-output-token")?.textContent?.startsWith("cashu")
  );
  const satToUsdAmount = await page.locator("#trade-output-amount").textContent();

  const priorTradeToken = await page.locator("#trade-output-token").textContent();
  const usdTrade = await mint("usd", 51);
  await page.locator("#trade-tab").click();
  await page.locator('[data-direction="usd-sat"]').click();
  await page.locator("#trade-token-input").fill(usdTrade);
  await page.locator("#trade-form button[type=submit]").click();
  await page.waitForFunction(
    (previous) => {
      const token = document.querySelector("#trade-output-token")?.textContent || "";
      return token.startsWith("cashu") && token !== previous;
    },
    priorTradeToken
  );
  const usdToSatAmount = await page.locator("#trade-output-amount").textContent();

  await page.locator("#liquidity-tab").click();
  await page.locator(".redeem-drawer summary").click();
  await page.locator("#lp-token-input").fill(lpToken);
  await page.locator("#redeem-form button[type=submit]").click();
  await page.waitForFunction(() =>
    ["#redeem-sat-token", "#redeem-usd-token"].every((selector) =>
      document.querySelector(selector)?.textContent?.startsWith("cashu")
    )
  );

  const final = await page.evaluate(async () => (await fetch("/api/pool")).json());
  assert.deepEqual(final.pool, { sat: 0, usd: 0, shares: 0 });
  assert.deepEqual(pageErrors, []);
  await mkdir(dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });

  console.log(JSON.stringify({
    result: "ok",
    flow: ["mint SAT/USD", "deposit", "mint LP", "SAT→USD", "USD→SAT", "redeem"],
    sat_to_usd: satToUsdAmount,
    usd_to_sat: usdToSatAmount,
    final_pool: final.pool,
    screenshot: screenshotPath
  }, null, 2));
} finally {
  await browser.close();
}
