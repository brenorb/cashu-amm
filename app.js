import { inspectMint } from "./mints.js";

const API_BASE = (window.CASHU_AMM_API_URL || window.location.origin).replace(/\/$/, "");
let snapshot = null;
let direction = "sat-usd";
let lastMintQuote = null;
const pendingOperations = new Map();

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

function setMessage(id, text, type = "") {
  const element = byId(id);
  if (!element) return;
  element.textContent = text;
  element.className = `form-message ${type}`.trim();
}

function showRefunds(refunds = {}) {
  const entries = Object.entries(refunds).filter(([, token]) => token);
  const receipt = byId("refund-receipt");
  receipt.hidden = entries.length === 0;
  const outputs = byId("refund-token-value");
  outputs.replaceChildren();
  for (const [asset, token] of entries) {
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
  byId("wallet-sat").textContent = "Cashu token";
  byId("wallet-usd").textContent = "Cashu token";
  byId("wallet-lp").textContent = "LP share token";
  byId("wallet-share-percent").textContent = "Your pro-rata claim on the pool";
  renderCurve(pool, spot, initialized);
  renderLedger(snapshot.events || []);
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
  if (!events.length) {
    const empty = document.createElement("div");
    empty.className = "ledger-empty";
    empty.textContent = "No market activity yet.";
    ledger.append(empty);
    return;
  }
  for (const item of [...events].reverse()) {
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
  byId("liquidity-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage("liquidity-message", "Sending both Cashu tokens to the pool…");
    try {
      const result = await postOperation("deposit", "/api/liquidity/deposit", {
        sat_token: byId("sat-token-input").value.trim(),
        usd_token: byId("usd-token-input").value.trim()
      });
      byId("lp-token-value").textContent = result.lp_token;
      byId("token-receipt").hidden = false;
      setMessage("liquidity-message", `Deposit complete: ${formatInteger(result.shares)} LP shares issued.`, "success");
      snapshot = result.pool;
      render();
    } catch (error) {
      const refunded = showRefunds(error.body?.refunds);
      setMessage("liquidity-message", refunded ? `${error.message} Returned tokens are shown below.` : error.message, "error");
    }
  });
}

function wireRedemption() {
  byId("redeem-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage("redeem-message", "Redeeming the Cashu LP share token…");
    try {
      const result = await postOperation("redeem", "/api/liquidity/redeem", {
        lp_token: byId("lp-token-input").value.trim()
      });
      byId("redeem-sat-token").textContent = result.tokens.sat;
      byId("redeem-usd-token").textContent = result.tokens.usd;
      setMessage("redeem-message", "Redemption complete. Save both output tokens.", "success");
      snapshot = result.pool;
      render();
    } catch (error) {
      const refunded = showRefunds(error.body?.refunds);
      setMessage("redeem-message", refunded ? `${error.message} The returned LP token is shown below.` : error.message, "error");
    }
  });
}

function wireTrade() {
  for (const button of document.querySelectorAll("[data-direction]")) {
    button.addEventListener("click", () => {
      direction = button.dataset.direction;
      for (const candidate of document.querySelectorAll("[data-direction]")) {
        candidate.classList.toggle("active", candidate.dataset.direction === direction);
      }
      byId("trade-token-input").placeholder = `Paste a Cashu ${direction === "sat-usd" ? "SAT" : "USD"} token`;
      byId("trade-output-unit").textContent = direction === "sat-usd" ? "USD units" : "sat";
      byId("trade-form").querySelector(".primary-action span").textContent = direction === "sat-usd"
        ? "Sell BTC for USD"
        : "Buy BTC with USD";
      if (button.hasAttribute("data-open-trade")) {
        byId("trade-tab").click();
        byId("trade-panel").scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }
  byId("trade-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage("trade-message", "Executing against the current liquidity curve…");
    try {
      const result = await postOperation("swap", "/api/swap", {
        direction, token: byId("trade-token-input").value.trim()
      });
      byId("trade-output-token").textContent = result.output_token;
      byId("trade-output-amount").textContent = formatInteger(result.amount_out);
      setMessage("trade-message", `Trade complete: ${formatInteger(result.amount_out)} units received.`, "success");
      snapshot = result.pool;
      render();
    } catch (error) {
      const refunded = showRefunds(error.body?.refunds);
      setMessage("trade-message", refunded ? `${error.message} The returned input token is shown below.` : error.message, "error");
    }
  });
}

function wireMint() {
  byId("mint-quote-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      lastMintQuote = await fetchJson("/api/mint/quote", {
        method: "POST", body: JSON.stringify({ asset: byId("mint-asset").value, amount: Number(byId("mint-amount").value) })
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
      byId("mint-token-output").textContent = result.token;
      setMessage("mint-message", "Cashu token minted.", "success");
    } catch (error) { setMessage("mint-message", error.message, "error"); }
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
byId("refresh-pool").addEventListener("click", refreshPool);
byId("refresh-mints").addEventListener("click", checkMints);
wireCopyButton("copy-lp-token", "lp-token-value");
wireCopyButton("copy-redeem-sat", "redeem-sat-token");
wireCopyButton("copy-redeem-usd", "redeem-usd-token");
wireCopyButton("copy-trade-token", "trade-output-token");
wireCopyButton("copy-mint-token", "mint-token-output");
refreshPool();
checkMints();
