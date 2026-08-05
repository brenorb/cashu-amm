import { inspectMint } from "./mints.js?v=20260805-2";
import { createTokenWallet } from "./wallet.js?v=20260805-2";

const API_BASE = (window.CASHU_AMM_API_URL || window.location.origin).replace(/\/$/, "");
let snapshot = null;
let direction = "sat-usd";
let mintAsset = "sat";
let lastMintQuote = null;
const pendingOperations = new Map();
const wallet = createTokenWallet(window.localStorage);

const byId = (id) => document.getElementById(id);
const formatInteger = (value) => new Intl.NumberFormat("en-US").format(
  typeof value === "bigint" ? value : BigInt(value)
);
const formatSat = (value) => `${formatInteger(value)} sat`;
const formatUsd = (cents) => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 2
}).format(Number(cents) / 100);
const formatPrice = (value) => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 2
}).format(Number(value));

function formatLpUnitValue(pool, spot, initialized) {
  if (!initialized || !pool.shares) return "—";
  const satPerShare = Number(pool.sat) / Number(pool.shares);
  const usdPerShare = Number(pool.usd) / Number(pool.shares) / 100;
  const markValue = satPerShare * Number(spot) / 100_000_000 + usdPerShare;
  const markLabel = markValue < 0.01 ? `$${markValue.toFixed(4)}` : formatPrice(markValue);
  return `1 LP ≈ ${satPerShare.toFixed(2)} sat + $${usdPerShare.toFixed(4)}; estimated USD value: ${markLabel}`;
}

function integerSqrt(value) {
  if (value < 0n) throw new RangeError("square root of a negative value");
  if (value < 2n) return value;
  let low = 1n;
  let high = value;
  while (low <= high) {
    const middle = (low + high) / 2n;
    const squared = middle * middle;
    if (squared === value) return middle;
    if (squared < value) low = middle + 1n;
    else high = middle - 1n;
  }
  return high;
}

function renderLiquidityEstimate() {
  const satToken = wallet.find(byId("sat-token-input").value.trim());
  const usdToken = wallet.find(byId("usd-token-input").value.trim());
  if (!satToken || satToken.asset !== "sat" || !usdToken || usdToken.asset !== "usd") {
    byId("liquidity-share-amount").textContent = "—";
    byId("liquidity-estimate-note").textContent = "Load both tokens from this browser wallet to estimate shares.";
    return;
  }

  const depositSat = BigInt(satToken.amount);
  const depositUsd = BigInt(usdToken.amount);
  let shares;
  if (!snapshot?.initialized) {
    shares = integerSqrt(depositSat * depositUsd);
  } else {
    const poolShares = BigInt(snapshot.pool.shares);
    shares = depositSat * poolShares / BigInt(snapshot.pool.sat);
    const usdShares = depositUsd * poolShares / BigInt(snapshot.pool.usd);
    if (usdShares < shares) shares = usdShares;
  }
  byId("liquidity-share-amount").textContent = `${formatInteger(shares)} LP shares`;
  byId("liquidity-estimate-note").textContent = "Estimate from the current pool and wallet token amounts. Final shares can be lower after Cashu input fees and rounding.";
}

const walletInputAsset = () => direction === "sat-usd" ? "sat" : "usd";
const tokenCountLabel = (count) => `${count} bearer token${count === 1 ? "" : "s"} stored`;

function demoPairAmounts() {
  const usdGross = 1_001;
  const usdAfterMintFees = 998;
  if (!snapshot?.initialized || !snapshot.pool.usd) return { sat: 20_001, usd: usdGross };
  const satAfterMintFees = Math.max(
    1,
    Math.round(snapshot.pool.sat * usdAfterMintFees / snapshot.pool.usd)
  );
  return { sat: satAfterMintFees + 5, usd: usdGross };
}

function renderWallet() {
  const sat = wallet.list("sat");
  const usd = wallet.list("usd");
  const lp = wallet.list("lp");
  byId("wallet-sat").textContent = formatSat(wallet.total("sat"));
  byId("wallet-usd").textContent = formatUsd(wallet.total("usd"));
  byId("wallet-lp").textContent = `${formatInteger(wallet.total("lp"))} LP`;
  byId("wallet-sat-count").textContent = tokenCountLabel(sat.length);
  byId("wallet-usd-count").textContent = tokenCountLabel(usd.length);
  byId("wallet-lp-count").textContent = tokenCountLabel(lp.length);
  const lpValue = snapshot
    ? formatLpUnitValue(snapshot.pool, snapshot.price_usd_per_btc, snapshot.initialized)
    : "1 LP share value unavailable until the pool is loaded";
  byId("wallet-lp-value").textContent = lpValue;
  byId("wallet-token-count").textContent = `${sat.length + usd.length + lp.length} tokens`;
  renderLiquidityEstimate();
  const demoPair = demoPairAmounts();
  byId("demo-pair-amounts").textContent = `${formatInteger(demoPair.sat)} sat + ${formatUsd(demoPair.usd)}`;

  for (const button of document.querySelectorAll('[data-wallet-use="sat"]')) button.disabled = sat.length === 0;
  for (const button of document.querySelectorAll('[data-wallet-use="usd"]')) button.disabled = usd.length === 0;
  for (const button of document.querySelectorAll('[data-wallet-use="lp"]')) button.disabled = lp.length === 0;
  for (const button of document.querySelectorAll("[data-wallet-liquidity]")) {
    button.disabled = sat.length === 0 || usd.length === 0;
  }
  byId("use-wallet-trade").disabled = wallet.list(walletInputAsset()).length === 0;
}

function storeWalletToken(asset, amount, token) {
  wallet.add(asset, Number(amount), token);
  renderWallet();
}

const pause = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

async function mintDirectlyToWallet(asset, amount) {
  const quote = await fetchJson("/api/mint/quote", {
    method: "POST",
    body: JSON.stringify({ asset, amount })
  });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const result = await fetchJson("/api/mint", {
        method: "POST",
        body: JSON.stringify({ asset, amount, quote_id: quote.quote_id })
      });
      storeWalletToken(result.asset, result.amount, result.token);
      return result;
    } catch (error) {
      if (!error.message.toLowerCase().includes("not paid")) throw error;
      await pause(250);
    }
  }
  throw new Error(`${asset.toUpperCase()} test mint did not settle in time`);
}

function replaceWalletRefund(asset, originalToken, refundToken) {
  const original = wallet.find(originalToken);
  if (!original || original.asset !== asset) return;
  wallet.remove(originalToken);
  storeWalletToken(asset, original.amount, refundToken);
}

function renderRedemptionQuote() {
  const token = byId("lp-token-input").value.trim();
  const entry = wallet.find(token);
  const estimate = byId("redeem-estimate");
  if (!snapshot?.initialized || !entry || entry.asset !== "lp") {
    estimate.hidden = true;
    byId("redeem-sat-amount").textContent = "—";
    byId("redeem-usd-amount").textContent = "—";
    return;
  }

  const shares = BigInt(entry.amount);
  const totalShares = BigInt(snapshot.pool.shares);
  const sat = BigInt(snapshot.pool.sat) * shares / totalShares;
  const usd = BigInt(snapshot.pool.usd) * shares / totalShares;
  byId("redeem-sat-amount").textContent = `${formatInteger(sat)} sat`;
  byId("redeem-usd-amount").textContent = formatUsd(usd);
  byId("redeem-estimate-note").textContent = `Based on ${formatInteger(shares)} LP shares at the current pool state. Final amounts are floored at redemption.`;
  estimate.hidden = false;
}

function showRedemptionAmounts(sat, usd, note) {
  byId("redeem-sat-amount").textContent = `${formatInteger(sat)} sat`;
  byId("redeem-usd-amount").textContent = formatUsd(usd);
  byId("redeem-estimate-note").textContent = note;
  byId("redeem-estimate").hidden = false;
}

function setMessage(id, text, type = "") {
  const element = byId(id);
  if (!element) return;
  element.textContent = text;
  element.className = `form-message ${type}`.trim();
}

function showRefunds(refunds = {}, originals = {}) {
  const entries = Object.entries(refunds).filter(([, token]) => token);
  const receipt = byId("refund-receipt");
  receipt.hidden = entries.length === 0;
  const outputs = byId("refund-token-value");
  outputs.replaceChildren();
  for (const [asset, token] of entries) {
    replaceWalletRefund(asset, originals[asset], token);
    const row = document.createElement("div");
    row.className = "token-output-row";
    const label = document.createElement("b");
    label.textContent = asset.toUpperCase();
    const code = document.createElement("code");
    code.textContent = token;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Copy";
    button.addEventListener("click", () => navigator.clipboard.writeText(token));
    row.append(label, code, button);
    outputs.append(row);
  }
  return entries.length > 0;
}

function wireCopyButton(buttonId, sourceId) {
  byId(buttonId).addEventListener("click", async () => {
    await navigator.clipboard.writeText(byId(sourceId).textContent);
  });
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" }, ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || body.error || `HTTP ${response.status}`);
    error.body = body;
    throw error;
  }
  return body;
}

async function postOperation(kind, path, payload) {
  const fingerprint = JSON.stringify(payload);
  let pending = pendingOperations.get(kind);
  if (!pending || pending.fingerprint !== fingerprint) {
    pending = { fingerprint, operationId: crypto.randomUUID() };
    pendingOperations.set(kind, pending);
  }
  try {
    const result = await fetchJson(path, {
      method: "POST",
      body: JSON.stringify({ operation_id: pending.operationId, ...payload })
    });
    pendingOperations.delete(kind);
    return result;
  } catch (error) {
    // An HTTP error means the server answered. A network error may mean the
    // operation committed but its response was lost, so the next click reuses
    // the same ID and receives the cached bearer tokens.
    if (error.body) pendingOperations.delete(kind);
    throw error;
  }
}

function render() {
  renderWallet();
  if (!snapshot) return;
  const pool = snapshot.pool;
  const initialized = snapshot.initialized;
  const spot = Number(snapshot.price_usd_per_btc);
  const sellPrice = initialized ? spot * (1 - snapshot.fee_bps / 10_000) : 0;
  const buyPrice = initialized ? spot / (1 - snapshot.fee_bps / 10_000) : 0;
  byId("hero-price").textContent = initialized ? formatPrice(spot) : "—";
  byId("sell-price").textContent = initialized ? formatPrice(sellPrice) : "—";
  byId("buy-price").textContent = initialized ? formatPrice(buyPrice) : "—";
  byId("trade-sell-price").textContent = initialized ? formatPrice(sellPrice) : "—";
  byId("trade-buy-price").textContent = initialized ? formatPrice(buyPrice) : "—";
  for (const quote of document.querySelectorAll("[data-open-trade]")) {
    quote.disabled = !initialized;
  }
  byId("pool-sat").textContent = formatSat(pool.sat);
  byId("pool-usd").textContent = formatUsd(pool.usd);
  byId("pool-k").textContent = initialized
    ? formatInteger(BigInt(pool.sat) * BigInt(pool.usd))
    : "Not initialized";
  byId("pool-shares").textContent = `${formatInteger(pool.shares)} LP`;
  byId("lp-unit-value").textContent = formatLpUnitValue(pool, spot, initialized);
  renderCurve(pool, spot, initialized);
  renderLedger(snapshot.events || []);
  renderRedemptionQuote();
}

function renderCurve(pool, spot, initialized) {
  const point = byId("reserve-point");
  const guideX = byId("curve-guide-x");
  const guideY = byId("curve-guide-y");
  const curvePoints = Array.from({ length: 61 }, (_, index) =>
    curveCoordinates(0.08 + (index / 60) * 0.92)
  );
  const line = curvePoints.map(({ x, y }, index) =>
    `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`
  ).join(" ");
  byId("curve-line").setAttribute("d", line);
  byId("curve-area").setAttribute("d", `${line} L377 262 L54 262 Z`);
  if (!initialized) {
    for (const element of [point, guideX, guideY]) element.style.display = "none";
    byId("curve-state").textContent = "Waiting for the first liquidity deposit";
    return;
  }

  const pricePosition = Math.min(1, Math.max(0, (Math.log10(spot) - 3) / 3));
  const { x, y } = curveCoordinates(0.08 + (1 - pricePosition) * 0.92);
  for (const element of [point, guideX, guideY]) element.style.display = "";
  point.setAttribute("cx", x);
  point.setAttribute("cy", y);
  guideX.setAttribute("x1", x);
  guideX.setAttribute("x2", x);
  guideX.setAttribute("y1", y);
  guideY.setAttribute("x2", x);
  guideY.setAttribute("y1", y);
  guideY.setAttribute("y2", y);
  byId("curve-state").textContent = `${formatSat(pool.sat)} × ${formatInteger(pool.usd)} USD units`;
}

function curveCoordinates(normalizedX) {
  const normalizedY = 0.08 / normalizedX;
  return {
    x: 54 + ((normalizedX - 0.08) / 0.92) * 323,
    y: 38 + (1 - normalizedY) * 212
  };
}

function renderLedger(events) {
  const ledger = byId("activity-ledger");
  ledger.replaceChildren();
  byId("ledger-count").textContent = events.length
    ? `Showing the latest ${Math.min(events.length, 12)} of ${events.length} server-side events.`
    : "Server-side event log returned by the Nutshell backend.";
  if (!events.length) {
    const empty = document.createElement("div");
    empty.className = "ledger-empty";
    empty.textContent = "No market activity yet.";
    ledger.append(empty);
    return;
  }
  for (const item of events.slice(-12).reverse()) {
    const row = document.createElement("article");
    row.className = "ledger-entry";
    const time = new Date(item.time);
    row.innerHTML = `<time>${time.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</time><b>${item.type}</b><span>${item.description}</span>`;
    ledger.append(row);
  }
}

async function refreshPool() {
  try {
    snapshot = await fetchJson("/api/pool");
    render();
    setMessage(
      "connection-message",
      snapshot.initialized
        ? "Nutshell backend connected. BTCUSD trading is live."
        : "Market not initialized: the first SAT + USD deposit sets the opening price.",
      "success"
    );
  } catch (error) {
    setMessage("connection-message", `Backend unavailable: ${error.message}`, "error");
  }
}

function wireTabs() {
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    tab.addEventListener("click", () => {
      for (const candidate of document.querySelectorAll('[role="tab"]')) {
        const selected = candidate === tab;
        candidate.setAttribute("aria-selected", String(selected));
        const panel = byId(candidate.getAttribute("aria-controls"));
        panel.hidden = !selected;
        panel.classList.toggle("active", selected);
      }
    });
  }
}

function wireLiquidity() {
  byId("sat-token-input").addEventListener("input", renderLiquidityEstimate);
  byId("usd-token-input").addEventListener("input", renderLiquidityEstimate);
  byId("liquidity-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage("liquidity-message", "Sending both Cashu tokens to the pool…");
    const satToken = byId("sat-token-input").value.trim();
    const usdToken = byId("usd-token-input").value.trim();
    try {
      const result = await postOperation("deposit", "/api/liquidity/deposit", {
        sat_token: satToken,
        usd_token: usdToken
      });
      wallet.remove(satToken);
      wallet.remove(usdToken);
      storeWalletToken("lp", result.shares, result.lp_token);
      byId("liquidity-share-amount").textContent = `${formatInteger(result.shares)} LP shares`;
      byId("liquidity-estimate-note").textContent = "Actual shares issued by the pool.";
      byId("lp-token-value").textContent = result.lp_token;
      byId("token-receipt").hidden = false;
      setMessage("liquidity-message", `Deposit complete: ${formatInteger(result.shares)} LP shares saved to this browser.`, "success");
      snapshot = result.pool;
      render();
    } catch (error) {
      const refunded = showRefunds(error.body?.refunds, { sat: satToken, usd: usdToken });
      setMessage("liquidity-message", refunded ? `${error.message} Returned tokens are shown below.` : error.message, "error");
    }
  });
}

function wireRedemption() {
  byId("lp-token-input").addEventListener("input", renderRedemptionQuote);
  byId("redeem-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage("redeem-message", "Redeeming the Cashu LP share token…");
    const lpToken = byId("lp-token-input").value.trim();
    try {
      const result = await postOperation("redeem", "/api/liquidity/redeem", {
        lp_token: lpToken
      });
      wallet.remove(lpToken);
      storeWalletToken("sat", result.amounts.sat, result.tokens.sat);
      storeWalletToken("usd", result.amounts.usd, result.tokens.usd);
      showRedemptionAmounts(result.amounts.sat, result.amounts.usd, "Actual amounts returned by the pool.");
      byId("redeem-sat-token").textContent = result.tokens.sat;
      byId("redeem-usd-token").textContent = result.tokens.usd;
      setMessage("redeem-message", "Redemption complete. Both output tokens were saved to this browser.", "success");
      snapshot = result.pool;
      render();
    } catch (error) {
      const refunded = showRefunds(error.body?.refunds, { lp: lpToken });
      setMessage("redeem-message", refunded ? `${error.message} The returned LP token is shown below.` : error.message, "error");
    }
  });
}

function selectTradeDirection(nextDirection, openTrade = false) {
  direction = nextDirection;
  for (const candidate of document.querySelectorAll("[data-direction]")) {
    candidate.classList.toggle("active", candidate.dataset.direction === direction);
  }
  const inputAsset = walletInputAsset();
  byId("trade-token-input").placeholder = `Paste a Cashu ${inputAsset.toUpperCase()} token`;
  byId("trade-output-unit").textContent = direction === "sat-usd" ? "USD units" : "sat";
  byId("trade-form").querySelector(".primary-action span").textContent = direction === "sat-usd"
    ? "Sell BTC for USD"
    : "Buy BTC with USD";
  byId("use-wallet-trade").textContent = `Use latest ${inputAsset.toUpperCase()} token`;
  renderWallet();
  if (openTrade) {
    byId("trade-tab").click();
    byId("trade-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function wireTrade() {
  for (const button of document.querySelectorAll("[data-direction]")) {
    button.addEventListener("click", () => {
      selectTradeDirection(button.dataset.direction, button.hasAttribute("data-open-trade"));
    });
  }
  byId("trade-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage("trade-message", "Executing against the current liquidity curve…");
    const inputToken = byId("trade-token-input").value.trim();
    const inputAsset = walletInputAsset();
    const outputAsset = inputAsset === "sat" ? "usd" : "sat";
    try {
      const result = await postOperation("swap", "/api/swap", {
        direction, token: inputToken
      });
      wallet.remove(inputToken);
      storeWalletToken(outputAsset, result.amount_out, result.output_token);
      byId("trade-output-token").textContent = result.output_token;
      byId("trade-output-amount").textContent = formatInteger(result.amount_out);
      byId("trade-token-title").textContent = direction === "sat-usd"
        ? "Your Cashu USD token is ready"
        : "Your Cashu SAT token is ready";
      byId("trade-token-receipt").hidden = false;
      setMessage("trade-message", `Trade complete: ${formatInteger(result.amount_out)} units saved to this browser.`, "success");
      snapshot = result.pool;
      render();
    } catch (error) {
      const refunded = showRefunds(error.body?.refunds, { [inputAsset]: inputToken });
      setMessage("trade-message", refunded ? `${error.message} The returned input token is shown below.` : error.message, "error");
    }
  });
}

function wireMint() {
  for (const button of document.querySelectorAll("[data-mint-asset]")) {
    button.addEventListener("click", () => {
      mintAsset = button.dataset.mintAsset;
      for (const candidate of document.querySelectorAll("[data-mint-asset]")) {
        candidate.classList.toggle("active", candidate === button);
      }
    });
  }
  byId("mint-quote-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      lastMintQuote = await fetchJson("/api/mint/quote", {
        method: "POST", body: JSON.stringify({ asset: mintAsset, amount: Number(byId("mint-amount").value) })
      });
      byId("mint-invoice").textContent = lastMintQuote.request;
      byId("mint-quote-id").textContent = lastMintQuote.quote_id;
      byId("mint-pay-step").hidden = false;
      setMessage("mint-message", "Wait for Testnut to settle the test invoice, then mint the token.", "success");
    } catch (error) { setMessage("mint-message", error.message, "error"); }
  });
  byId("mint-paid").addEventListener("click", async () => {
    if (!lastMintQuote) return;
    try {
      const result = await fetchJson("/api/mint", {
        method: "POST", body: JSON.stringify({ asset: lastMintQuote.asset, amount: lastMintQuote.amount, quote_id: lastMintQuote.quote_id })
      });
      storeWalletToken(result.asset, result.amount, result.token);
      byId("mint-token-output").textContent = result.token;
      byId("mint-token-receipt").hidden = false;
      setMessage("mint-message", "Cashu token minted and saved to this browser.", "success");
    } catch (error) { setMessage("mint-message", error.message, "error"); }
  });
}

function loadWalletTrade(asset) {
  const entry = wallet.latest(asset);
  if (!entry) return;
  selectTradeDirection(asset === "sat" ? "sat-usd" : "usd-sat", true);
  byId("trade-token-input").value = entry.token;
  setMessage("trade-message", `${formatInteger(entry.amount)} ${asset.toUpperCase()} loaded from this browser.`, "success");
}

function loadWalletLiquidity() {
  const sat = wallet.latest("sat");
  const usd = wallet.latest("usd");
  if (!sat || !usd) return;
  byId("liquidity-tab").click();
  byId("sat-token-input").value = sat.token;
  byId("usd-token-input").value = usd.token;
  renderLiquidityEstimate();
  byId("liquidity-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  setMessage("liquidity-message", `${formatSat(sat.amount)} and ${formatUsd(usd.amount)} loaded from this browser.`, "success");
}

function loadWalletRedemption() {
  const entry = wallet.latest("lp");
  if (!entry) return;
  byId("liquidity-tab").click();
  const drawer = document.querySelector(".redeem-drawer");
  drawer.open = true;
  byId("lp-token-input").value = entry.token;
  renderRedemptionQuote();
  drawer.scrollIntoView({ behavior: "smooth", block: "center" });
  setMessage("redeem-message", `${formatInteger(entry.amount)} LP loaded from this browser.`, "success");
}

function openMint(asset) {
  document.querySelector(`[data-mint-asset="${asset}"]`).click();
  document.querySelector(".mint-section").scrollIntoView({ behavior: "smooth", block: "start" });
  byId("mint-amount").focus({ preventScroll: true });
}

function wireWallet() {
  byId("get-demo-funds").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const amounts = demoPairAmounts();
    button.disabled = true;
    setMessage("wallet-message", "Minting a proportional SAT + USD test pair…");
    try {
      await mintDirectlyToWallet("sat", amounts.sat);
      await mintDirectlyToWallet("usd", amounts.usd);
      setMessage("wallet-message", "Liquidity test tokens ready. Click Add liquidity.", "success");
    } catch (error) {
      setMessage("wallet-message", error.message, "error");
    } finally {
      button.disabled = false;
    }
  });
  for (const button of document.querySelectorAll("[data-wallet-mint]")) {
    button.addEventListener("click", () => openMint(button.dataset.walletMint));
  }
  for (const button of document.querySelectorAll('[data-wallet-use="sat"], [data-wallet-use="usd"]')) {
    button.addEventListener("click", () => loadWalletTrade(button.dataset.walletUse));
  }
  for (const button of document.querySelectorAll('[data-wallet-use="lp"]')) {
    button.addEventListener("click", loadWalletRedemption);
  }
  for (const button of document.querySelectorAll("[data-wallet-liquidity]")) {
    button.addEventListener("click", loadWalletLiquidity);
  }
  byId("use-wallet-trade").addEventListener("click", () => loadWalletTrade(walletInputAsset()));
  byId("clear-wallet").addEventListener("click", () => {
    if (!window.confirm("Remove all locally stored testnet bearer tokens from this browser?")) return;
    wallet.clear();
    renderWallet();
    setMessage("wallet-message", "Local test wallet cleared.", "success");
  });
}

async function checkMints() {
  await Promise.all([...document.querySelectorAll("[data-mint]")].map(async (row) => {
    row.classList.remove("online", "offline");
    const result = await inspectMint(row.dataset.mint);
    row.classList.add(result.status);
    row.querySelector("small").textContent = result.label;
  }));
}

wireTabs();
wireLiquidity();
wireRedemption();
wireTrade();
wireMint();
wireWallet();
byId("refresh-pool").addEventListener("click", refreshPool);
byId("refresh-mints").addEventListener("click", checkMints);
wireCopyButton("copy-lp-token", "lp-token-value");
wireCopyButton("copy-redeem-sat", "redeem-sat-token");
wireCopyButton("copy-redeem-usd", "redeem-usd-token");
wireCopyButton("copy-trade-token", "trade-output-token");
wireCopyButton("copy-mint-token", "mint-token-output");
renderWallet();
refreshPool();
checkMints();
