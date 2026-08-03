import { inspectMint } from "./mints.js";

const API_BASE = (window.CASHU_AMM_API_URL || window.location.origin).replace(/\/$/, "");
let snapshot = null;
let direction = "sat-usd";
let lastMintQuote = null;
const pendingOperations = new Map();

const byId = (id) => document.getElementById(id);
const formatInteger = (value) => new Intl.NumberFormat("pt-BR").format(
  typeof value === "bigint" ? value : BigInt(value)
);
const formatSat = (value) => `${formatInteger(value)} sat`;
const formatUsd = (cents) => new Intl.NumberFormat("pt-BR", {
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
    button.textContent = "Copiar";
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
  byId("hero-price").textContent = `${formatPrice(snapshot.price_usd_per_btc)} `;
  byId("pool-sat").textContent = formatSat(pool.sat);
  byId("pool-usd").textContent = formatUsd(pool.usd);
  byId("pool-k").textContent = formatInteger(BigInt(pool.sat) * BigInt(pool.usd));
  byId("pool-shares").textContent = `${formatInteger(pool.shares)} LP`;
  byId("wallet-sat").textContent = "via token Cashu";
  byId("wallet-usd").textContent = "via token Cashu";
  byId("wallet-lp").textContent = "bearer token";
  byId("wallet-share-percent").textContent = "não custodial no navegador";
  renderLedger(snapshot.events || []);
}

function renderLedger(events) {
  const ledger = byId("activity-ledger");
  ledger.replaceChildren();
  if (!events.length) {
    const empty = document.createElement("div");
    empty.className = "ledger-empty";
    empty.textContent = "A pool ainda não tem operações.";
    ledger.append(empty);
    return;
  }
  for (const item of [...events].reverse()) {
    const row = document.createElement("article");
    row.className = "ledger-entry";
    const time = new Date(item.time);
    row.innerHTML = `<time>${time.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</time><b>${item.type}</b><span>${item.description}</span>`;
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
        ? "Backend Nutshell conectado."
        : "Pool vazia: o primeiro depósito SAT + USD define o preço inicial.",
      "success"
    );
  } catch (error) {
    setMessage("connection-message", `Backend indisponível: ${error.message}`, "error");
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
    setMessage("liquidity-message", "Enviando os dois TokenV4 para o backend…");
    try {
      const result = await postOperation("deposit", "/api/liquidity/deposit", {
        sat_token: byId("sat-token-input").value.trim(),
        usd_token: byId("usd-token-input").value.trim()
      });
      byId("lp-token-value").textContent = result.lp_token;
      byId("token-receipt").hidden = false;
      setMessage("liquidity-message", `Depósito concluído: ${formatInteger(result.shares)} LP.`, "success");
      snapshot = result.pool;
      render();
    } catch (error) {
      const refunded = showRefunds(error.body?.refunds);
      setMessage("liquidity-message", refunded ? `${error.message} Tokens devolvidos abaixo.` : error.message, "error");
    }
  });
}

function wireRedemption() {
  byId("redeem-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage("redeem-message", "Resgatando o TokenV4 de LP…");
    try {
      const result = await postOperation("redeem", "/api/liquidity/redeem", {
        lp_token: byId("lp-token-input").value.trim()
      });
      byId("redeem-sat-token").textContent = result.tokens.sat;
      byId("redeem-usd-token").textContent = result.tokens.usd;
      setMessage("redeem-message", "Resgate concluído. Guarde os dois tokens.", "success");
      snapshot = result.pool;
      render();
    } catch (error) {
      const refunded = showRefunds(error.body?.refunds);
      setMessage("redeem-message", refunded ? `${error.message} LP devolvido abaixo.` : error.message, "error");
    }
  });
}

function wireTrade() {
  for (const button of document.querySelectorAll("[data-direction]")) {
    button.addEventListener("click", () => {
      direction = button.dataset.direction;
      for (const candidate of document.querySelectorAll("[data-direction]")) candidate.classList.toggle("active", candidate === button);
      byId("trade-token-input").placeholder = `Cole aqui o TokenV4 ${direction === "sat-usd" ? "SAT" : "USD"}`;
    });
  }
  byId("trade-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage("trade-message", "Executando swap contra a pool…");
    try {
      const result = await postOperation("swap", "/api/swap", {
        direction, token: byId("trade-token-input").value.trim()
      });
      byId("trade-output-token").textContent = result.output_token;
      byId("trade-output-amount").textContent = `${formatInteger(result.amount_out)} unidades`;
      setMessage("trade-message", `Swap concluído: ${formatInteger(result.amount_out)} unidades recebidas.`, "success");
      snapshot = result.pool;
      render();
    } catch (error) {
      const refunded = showRefunds(error.body?.refunds);
      setMessage("trade-message", refunded ? `${error.message} Token de entrada devolvido abaixo.` : error.message, "error");
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
      setMessage("mint-message", "Pague a invoice e depois clique em emitir.", "success");
    } catch (error) { setMessage("mint-message", error.message, "error"); }
  });
  byId("mint-paid").addEventListener("click", async () => {
    if (!lastMintQuote) return;
    try {
      const result = await fetchJson("/api/mint", {
        method: "POST", body: JSON.stringify({ asset: lastMintQuote.asset, amount: lastMintQuote.amount, quote_id: lastMintQuote.quote_id })
      });
      byId("mint-token-output").textContent = result.token;
      setMessage("mint-message", "TokenV4 emitido.", "success");
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
