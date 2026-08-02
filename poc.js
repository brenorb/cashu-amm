import {
  FEE_BPS,
  amountsForRedemption,
  initialShareSupply,
  quoteExactIn,
  sharesForDeposit
} from "./amm.js";

export const INITIAL_RESERVE_SAT = 1_000_000n;
export const INITIAL_RESERVE_USD = 50_000n;
export const FAUCET_AMOUNTS = Object.freeze({
  sat: 250_000n,
  usd: 25_000n
});

function isBigInt(value) {
  return typeof value === "bigint";
}

function randomId(prefix = "event") {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function eventMeta(meta = {}) {
  return {
    id: meta.id ?? randomId(),
    time: meta.time ?? new Date().toISOString()
  };
}

function cloneState(state) {
  return {
    pool: { ...state.pool },
    wallet: { ...state.wallet },
    activities: state.activities.map((activity) => ({ ...activity })),
    lastLpToken: state.lastLpToken
  };
}

function assertAmount(value, label) {
  if (!isBigInt(value) || value < 0n) throw new Error(`${label} inválido`);
}

export function assertState(state) {
  if (!state || typeof state !== "object") throw new Error("estado inválido");
  if (!state.pool || !state.wallet || !Array.isArray(state.activities)) {
    throw new Error("estado inválido");
  }

  for (const [value, label] of [
    [state.pool.sat, "reserva SAT"],
    [state.pool.usd, "reserva USD"],
    [state.pool.shares, "supply LP"],
    [state.wallet.sat, "saldo SAT"],
    [state.wallet.usd, "saldo USD"],
    [state.wallet.lp, "saldo LP"]
  ]) assertAmount(value, label);

  if (state.pool.sat === 0n || state.pool.usd === 0n || state.pool.shares === 0n) {
    throw new Error("estado inválido: a pool precisa ter seed");
  }
  if (state.wallet.lp > state.pool.shares) throw new Error("estado inválido: LP acima do supply");
  if (typeof state.lastLpToken !== "string") throw new Error("estado inválido: receipt");
  for (const activity of state.activities) {
    if (!activity || typeof activity !== "object" || typeof activity.type !== "string") {
      throw new Error("estado inválido: ledger");
    }
  }
  return true;
}

export function createInitialState() {
  const state = {
    pool: {
      sat: INITIAL_RESERVE_SAT,
      usd: INITIAL_RESERVE_USD,
      shares: initialShareSupply(INITIAL_RESERVE_SAT, INITIAL_RESERVE_USD)
    },
    wallet: { sat: 0n, usd: 0n, lp: 0n },
    activities: [],
    lastLpToken: ""
  };
  assertState(state);
  return state;
}

function appendActivity(state, type, description, amount, meta) {
  const identity = eventMeta(meta);
  state.activities.push({
    id: identity.id,
    time: identity.time,
    type,
    description,
    amount
  });
}

export function applyFaucet(state, asset, meta = {}) {
  assertState(state);
  if (!(asset in FAUCET_AMOUNTS)) throw new Error("ativo de faucet inválido");

  const next = cloneState(state);
  const amount = FAUCET_AMOUNTS[asset];
  next.wallet[asset] += amount;
  appendActivity(
    next,
    "Faucet",
    `Mock ${asset.toUpperCase()} emitido para a carteira local`,
    `${amount.toString()} ${asset.toUpperCase()}`,
    meta
  );
  assertState(next);
  return next;
}

function encodeBase64(value) {
  if (typeof btoa === "function") return btoa(value);
  if (typeof Buffer !== "undefined") return Buffer.from(value, "utf8").toString("base64");
  throw new Error("base64 indisponível");
}

function decodeBase64(value) {
  if (typeof atob === "function") return atob(value);
  if (typeof Buffer !== "undefined") return Buffer.from(value, "base64").toString("utf8");
  throw new Error("base64 indisponível");
}

export function createMockLpToken(amount, nonce = randomId("lp")) {
  if (!isBigInt(amount) || amount <= 0n) throw new Error("amount LP inválido");
  const payload = {
    mock: true,
    kind: "cashu-amm-lp",
    pool: "btc-usd-poc",
    amount: amount.toString(),
    nonce
  };
  return `cashu-amm-mock:${encodeBase64(JSON.stringify(payload)).replaceAll("=", "")}`;
}

export function decodeMockLpToken(token) {
  if (typeof token !== "string" || !token.startsWith("cashu-amm-mock:")) {
    throw new Error("receipt mock inválido");
  }
  try {
    const payload = JSON.parse(decodeBase64(token.slice("cashu-amm-mock:".length)));
    if (
      payload.mock !== true ||
      payload.kind !== "cashu-amm-lp" ||
      payload.pool !== "btc-usd-poc" ||
      typeof payload.amount !== "string" ||
      typeof payload.nonce !== "string"
    ) throw new Error("receipt mock inválido");
    return payload;
  } catch {
    throw new Error("receipt mock inválido");
  }
}

export function depositLiquidity(state, depositSat, depositUsd, meta = {}) {
  assertState(state);
  assertAmount(depositSat, "depósito SAT");
  assertAmount(depositUsd, "depósito USD");
  if (depositSat === 0n || depositUsd === 0n) throw new Error("depósito precisa ser maior que zero");
  if (depositSat > state.wallet.sat || depositUsd > state.wallet.usd) {
    throw new Error("saldo insuficiente para depósito");
  }

  const shares = sharesForDeposit(
    state.pool.sat,
    state.pool.usd,
    state.pool.shares,
    depositSat,
    depositUsd
  );
  const next = cloneState(state);
  const token = createMockLpToken(shares, meta.nonce ?? randomId("lp"));
  next.wallet.sat -= depositSat;
  next.wallet.usd -= depositUsd;
  next.wallet.lp += shares;
  next.pool.sat += depositSat;
  next.pool.usd += depositUsd;
  next.pool.shares += shares;
  next.lastLpToken = token;
  appendActivity(next, "Liquidity", "Depósito proporcional e LP token emitido", `${shares} LP`, meta);
  assertState(next);
  return { state: next, shares, token };
}

export function executeSwap(state, direction, amountIn, meta = {}) {
  assertState(state);
  assertAmount(amountIn, "input");
  if (amountIn === 0n) throw new Error("input precisa ser maior que zero");
  if (direction !== "sat-usd" && direction !== "usd-sat") throw new Error("direção de swap inválida");

  const satToUsd = direction === "sat-usd";
  const walletAsset = satToUsd ? "sat" : "usd";
  if (amountIn > state.wallet[walletAsset]) throw new Error("saldo insuficiente para swap");

  const quote = satToUsd
    ? quoteExactIn(state.pool.sat, state.pool.usd, amountIn, FEE_BPS)
    : quoteExactIn(state.pool.usd, state.pool.sat, amountIn, FEE_BPS);
  const next = cloneState(state);
  const outputAsset = satToUsd ? "usd" : "sat";
  next.wallet[walletAsset] -= amountIn;
  next.wallet[outputAsset] += quote.amountOut;
  next.pool[walletAsset] = quote.nextReserveIn;
  next.pool[outputAsset] = quote.nextReserveOut;
  appendActivity(
    next,
    "Swap",
    satToUsd ? "SAT trocado por USD" : "USD trocado por SAT",
    `${amountIn} ${walletAsset.toUpperCase()} → ${quote.amountOut} ${outputAsset.toUpperCase()}`,
    meta
  );
  assertState(next);
  return {
    state: next,
    amountOut: quote.amountOut,
    feeAmount: quote.feeAmount,
    quote
  };
}

export function redeemLiquidity(state, shares, meta = {}) {
  assertState(state);
  assertAmount(shares, "shares");
  if (shares === 0n) throw new Error("shares precisam ser maiores que zero");
  if (shares > state.wallet.lp) throw new Error("shares acima do saldo");

  const amounts = amountsForRedemption(
    state.pool.sat,
    state.pool.usd,
    state.pool.shares,
    shares
  );
  const next = cloneState(state);
  next.wallet.lp -= shares;
  next.wallet.sat += amounts.sat;
  next.wallet.usd += amounts.usd;
  next.pool.shares -= shares;
  next.pool.sat -= amounts.sat;
  next.pool.usd -= amounts.usd;
  appendActivity(
    next,
    "Redeem",
    "LP shares resgatadas pro rata",
    `${amounts.sat} SAT + ${amounts.usd} USD`,
    meta
  );
  assertState(next);
  return { state: next, amounts };
}

export function serializeState(state) {
  assertState(state);
  return JSON.stringify({
    pool: {
      sat: state.pool.sat.toString(),
      usd: state.pool.usd.toString(),
      shares: state.pool.shares.toString()
    },
    wallet: {
      sat: state.wallet.sat.toString(),
      usd: state.wallet.usd.toString(),
      lp: state.wallet.lp.toString()
    },
    activities: state.activities,
    lastLpToken: state.lastLpToken
  });
}

export function deserializeState(serialized) {
  try {
    const raw = JSON.parse(serialized);
    const state = {
      pool: {
        sat: BigInt(raw.pool.sat),
        usd: BigInt(raw.pool.usd),
        shares: BigInt(raw.pool.shares)
      },
      wallet: {
        sat: BigInt(raw.wallet.sat),
        usd: BigInt(raw.wallet.usd),
        lp: BigInt(raw.wallet.lp)
      },
      activities: raw.activities,
      lastLpToken: raw.lastLpToken
    };
    assertState(state);
    return state;
  } catch {
    throw new Error("estado inválido");
  }
}

