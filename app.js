import {
  FEE_BPS,
  amountsForRedemption,
  poolPriceUsdPerBtc,
  quoteExactIn,
  sharesForDeposit
} from "./amm.js";
import {
  applyFaucet,
  createInitialState,
  depositLiquidity,
  deserializeState,
  executeSwap,
  redeemLiquidity,
  serializeState
} from "./poc.js";
import { inspectMint } from "./mints.js";

const STORAGE_KEY = "cashu-amm-poc-v1";

function loadState() {
  try {
    const serialized = localStorage.getItem(STORAGE_KEY);
    return serialized ? deserializeState(serialized) : createInitialState();
  } catch {
    return createInitialState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, serializeState(state));
}

function byId(id) {
  return document.getElementById(id);
}

function formatInteger(value) {
  return new Intl.NumberFormat("pt-BR").format(value);
}

function formatSat(value) {
  return `${formatInteger(value)} sat`;
}

function formatUsd(cents) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2
  }).format(Number(cents) / 100);
}

function formatPrice(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  }).format(value);
}

function parseInteger(value, label) {
  const normalized = value.trim().replace(/\./g, "").replace(/,/g, "");
  if (!/^\d+$/.test(normalized) || normalized === "0") throw new Error(`${label} precisa ser maior que zero.`);
  return BigInt(normalized);
}

function parseUsd(value, label = "USD") {
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{0,2})?$/.test(normalized)) throw new Error(`${label} deve ter no máximo duas casas decimais.`);
  const [whole, fraction = ""] = normalized.split(".");
  const cents = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
  if (cents <= 0n) throw new Error(`${label} precisa ser maior que zero.`);
  return cents;
}

function setMessage(id, text, type = "") {
  const element = byId(id);
  element.textContent = text;
  element.className = `form-message ${type}`.trim();
}

function currentPrice() {
  return poolPriceUsdPerBtc(state.pool.sat, state.pool.usd);
}

function render() {
  const price = currentPrice();
  byId("hero-price").textContent = formatPrice(price).replace("$", "$ ");
  byId("pool-sat").textContent = formatSat(state.pool.sat);
  byId("pool-usd").textContent = formatUsd(state.pool.usd);
  byId("pool-k").textContent = `${(state.pool.sat * state.pool.usd).toString().slice(0, 8)}…`;
  byId("pool-shares").textContent = `${formatInteger(state.pool.shares)} LP`;

  byId("wallet-sat").textContent = formatSat(state.wallet.sat);
  byId("wallet-usd").textContent = formatUsd(state.wallet.usd);
  byId("wallet-lp").textContent = `${formatInteger(state.wallet.lp)} LP`;
  const sharePercent = state.wallet.lp === 0n
    ? 0
    : Number(state.wallet.lp) / Number(state.pool.shares) * 100;
  byId("wallet-share-percent").textContent = `${sharePercent.toFixed(2)}% da pool`;
  byId("liquidity-sat-balance").textContent = `Disponível: ${formatSat(state.wallet.sat)}`;
  byId("liquidity-usd-balance").textContent = `Disponível: ${formatUsd(state.wallet.usd)}`;

  const receipt = byId("token-receipt");
  receipt.hidden = !state.lastLpToken;
  byId("lp-token-value").textContent = state.lastLpToken;

  renderLedger();
  updateLiquidityPreview("sat");
  updateRedemptionPreview();
  updateTradePreview();
}

function renderLedger() {
  const ledger = byId("activity-ledger");
  ledger.replaceChildren();
  if (state.activities.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ledger-empty";
    empty.textContent = "A mesa está quieta. Pegue tokens de teste para começar.";
    ledger.append(empty);
    return;
  }

  for (const item of state.activities) {
    const row = document.createElement("article");
    row.className = "ledger-entry";
    const time = new Date(item.time);
    row.innerHTML = `
      <time>${time.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</time>
      <b>${item.type}</b>
      <span>${item.description}</span>
      <small>${item.amount}</small>
    `;
    ledger.append(row);
  }
}

function updateLiquidityPreview(changed = "sat") {
  try {
    if (changed === "sat") {
      const sat = parseInteger(byId("liquidity-sat").value, "SAT");
      const usd = (sat * state.pool.usd + state.pool.sat - 1n) / state.pool.sat;
      byId("liquidity-usd").value = (Number(usd) / 100).toFixed(2);
    } else {
      const usd = parseUsd(byId("liquidity-usd").value);
      const sat = (usd * state.pool.sat + state.pool.usd - 1n) / state.pool.usd;
      byId("liquidity-sat").value = sat.toString();
    }
    const sat = parseInteger(byId("liquidity-sat").value, "SAT");
    const usd = parseUsd(byId("liquidity-usd").value);
    const shares = sharesForDeposit(state.pool.sat, state.pool.usd, state.pool.shares, sat, usd);
    const nextSupply = state.pool.shares + shares;
    byId("liquidity-preview").textContent = `${formatInteger(shares)} LP`;
    byId("liquidity-share-preview").textContent = `${(Number(shares) / Number(nextSupply) * 100).toFixed(2)}%`;
  } catch {
    byId("liquidity-preview").textContent = "— LP";
    byId("liquidity-share-preview").textContent = "—";
  }
}

function updateRedemptionPreview() {
  try {
    const shares = parseInteger(byId("redeem-shares").value, "Shares");
    if (shares > state.wallet.lp) throw new Error("Saldo insuficiente");
    const amounts = amountsForRedemption(state.pool.sat, state.pool.usd, state.pool.shares, shares);
    byId("redeem-preview").textContent = `Você receberá ${formatSat(amounts.sat)} + ${formatUsd(amounts.usd)}`;
  } catch {
    byId("redeem-preview").textContent = "Você receberá —";
  }
}

let direction = "sat-usd";

function tradeInputAmount() {
  return direction === "sat-usd"
    ? parseInteger(byId("trade-input").value, "SAT")
    : parseUsd(byId("trade-input").value);
}

function getTradeQuote() {
  const amount = tradeInputAmount();
  return direction === "sat-usd"
    ? quoteExactIn(state.pool.sat, state.pool.usd, amount, FEE_BPS)
    : quoteExactIn(state.pool.usd, state.pool.sat, amount, FEE_BPS);
}

function updateTradePreview() {
  const satToUsd = direction === "sat-usd";
  byId("trade-input-unit").textContent = satToUsd ? "SAT" : "USD";
  byId("trade-output-unit").textContent = satToUsd ? "USD" : "SAT";
  byId("trade-balance").textContent = satToUsd
    ? `Disponível: ${formatSat(state.wallet.sat)}`
    : `Disponível: ${formatUsd(state.wallet.usd)}`;

  try {
    const input = tradeInputAmount();
    const quote = getTradeQuote();
    const nextSat = satToUsd ? quote.nextReserveIn : quote.nextReserveOut;
    const nextUsd = satToUsd ? quote.nextReserveOut : quote.nextReserveIn;
    const spot = currentPrice();
    const executionPrice = satToUsd
      ? Number(quote.amountOut) / 100 / (Number(input) / 100_000_000)
      : (Number(input) / 100) / (Number(quote.amountOut) / 100_000_000);
    const impact = Math.max(0, Math.abs(executionPrice - spot) / spot * 100);

    byId("trade-output").textContent = satToUsd
      ? formatUsd(quote.amountOut)
      : formatInteger(quote.amountOut);
    byId("trade-fee").textContent = satToUsd
      ? formatSat(quote.feeAmount)
      : formatUsd(quote.feeAmount);
    byId("trade-impact").textContent = `${impact.toFixed(2)}%`;
    byId("trade-next-price").textContent = formatPrice(poolPriceUsdPerBtc(nextSat, nextUsd));
  } catch {
    byId("trade-output").textContent = "—";
    byId("trade-fee").textContent = "—";
    byId("trade-impact").textContent = "—";
    byId("trade-next-price").textContent = "—";
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

function wireFaucet() {
  for (const button of document.querySelectorAll("[data-faucet]")) {
    button.addEventListener("click", () => {
      state = applyFaucet(state, button.dataset.faucet);
      saveState();
      render();
    });
  }
}

function wireLiquidity() {
  byId("liquidity-sat").addEventListener("input", () => updateLiquidityPreview("sat"));
  byId("liquidity-usd").addEventListener("input", () => updateLiquidityPreview("usd"));
  byId("liquidity-form").addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const sat = parseInteger(byId("liquidity-sat").value, "SAT");
      const usd = parseUsd(byId("liquidity-usd").value);
      const result = depositLiquidity(state, sat, usd);
      state = result.state;
      saveState();
      setMessage("liquidity-message", "Depósito concluído. O bearer receipt mock está abaixo.", "success");
      render();
    } catch (error) {
      setMessage("liquidity-message", error.message, "error");
    }
  });

  byId("copy-lp-token").addEventListener("click", async () => {
    await navigator.clipboard.writeText(state.lastLpToken);
    byId("copy-lp-token").textContent = "Copiado";
    setTimeout(() => { byId("copy-lp-token").textContent = "Copiar"; }, 1400);
  });
}

function wireRedemption() {
  byId("redeem-shares").addEventListener("input", updateRedemptionPreview);
  byId("redeem-form").addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const shares = parseInteger(byId("redeem-shares").value, "Shares");
      const result = redeemLiquidity(state, shares);
      state = result.state;
      saveState();
      byId("redeem-shares").value = "";
      setMessage("redeem-message", "Participação resgatada.", "success");
      render();
    } catch (error) {
      setMessage("redeem-message", error.message, "error");
    }
  });
}

function wireTrade() {
  for (const button of document.querySelectorAll("[data-direction]")) {
    button.addEventListener("click", () => {
      direction = button.dataset.direction;
      for (const candidate of document.querySelectorAll("[data-direction]")) {
        candidate.classList.toggle("active", candidate === button);
      }
      byId("trade-input").value = direction === "sat-usd" ? "10000" : "5.00";
      setMessage("trade-message", "");
      updateTradePreview();
    });
  }

  byId("trade-input").addEventListener("input", updateTradePreview);
  byId("trade-form").addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const input = tradeInputAmount();
      const satToUsd = direction === "sat-usd";
      const result = executeSwap(state, direction, input);
      state = result.state;
      saveState();
      setMessage("trade-message", "Swap executado contra a nova reserva.", "success");
      render();
    } catch (error) {
      setMessage("trade-message", error.message, "error");
    }
  });
}

async function checkMints() {
  const rows = [...document.querySelectorAll("[data-mint]")];
  await Promise.all(rows.map(async (row) => {
    row.classList.remove("online", "offline");
    row.querySelector("small").textContent = "verificando…";
    const result = await inspectMint(row.dataset.mint);
    row.classList.add(result.status);
    row.querySelector("small").textContent = result.label;
  }));
}

let state = loadState();

wireTabs();
wireFaucet();
wireLiquidity();
wireRedemption();
wireTrade();
byId("refresh-mints").addEventListener("click", checkMints);
byId("reset-demo").addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEY);
  state = createInitialState();
  setMessage("liquidity-message", "Demo reiniciada.", "success");
  setMessage("trade-message", "");
  render();
});

render();
checkMints();
