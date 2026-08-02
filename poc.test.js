import test from "node:test";
import assert from "node:assert/strict";
import {
  FAUCET_AMOUNTS,
  applyFaucet,
  createInitialState,
  decodeMockLpToken,
  depositLiquidity,
  deserializeState,
  executeSwap,
  redeemLiquidity,
  serializeState,
  assertState
} from "./poc.js";

const seed = () => createInitialState();

test("initial state matches the SPEC seed and is valid", () => {
  const state = seed();
  assert.deepEqual(state.pool, {
    sat: 1_000_000n,
    usd: 50_000n,
    shares: 223_606n
  });
  assert.deepEqual(state.wallet, { sat: 0n, usd: 0n, lp: 0n });
  assert.deepEqual(state.activities, []);
  assert.equal(state.lastLpToken, "");
  assert.doesNotThrow(() => assertState(state));
});

test("faucet credits synthetic units and records an event", () => {
  const withSat = applyFaucet(seed(), "sat", { id: "faucet-1", time: "2026-01-01T00:00:00.000Z" });
  const state = applyFaucet(withSat, "usd", { id: "faucet-2", time: "2026-01-01T00:00:01.000Z" });

  assert.equal(state.wallet.sat, FAUCET_AMOUNTS.sat);
  assert.equal(state.wallet.usd, FAUCET_AMOUNTS.usd);
  assert.deepEqual(state.activities.map(({ type }) => type), ["Faucet", "Faucet"]);
});

test("proportional deposit debits wallet, mints shares, and returns a mock bearer receipt", () => {
  let state = applyFaucet(seed(), "sat", { id: "faucet-sat", time: "2026-01-01T00:00:00.000Z" });
  state = applyFaucet(state, "usd", { id: "faucet-usd", time: "2026-01-01T00:00:01.000Z" });
  const result = depositLiquidity(state, 100_000n, 5_100n, { id: "deposit-1", time: "2026-01-01T00:00:02.000Z", nonce: "nonce-1" });

  assert.equal(result.shares, 22_360n);
  assert.equal(result.state.wallet.sat, 150_000n);
  assert.equal(result.state.wallet.usd, 19_900n);
  assert.equal(result.state.wallet.lp, 22_360n);
  assert.equal(result.state.pool.sat, 1_100_000n);
  assert.equal(result.state.pool.usd, 55_100n);
  assert.equal(result.state.pool.shares, 245_966n);
  assert.deepEqual(decodeMockLpToken(result.token), {
    mock: true,
    kind: "cashu-amm-lp",
    pool: "btc-usd-poc",
    amount: "22360",
    nonce: "nonce-1"
  });
  assert.equal(result.state.lastLpToken, result.token);
});

test("deposit failure is atomic when the wallet lacks either asset", () => {
  const state = applyFaucet(seed(), "sat", { id: "faucet-1", time: "2026-01-01T00:00:00.000Z" });
  assert.throws(() => depositLiquidity(state, 100_000n, 5_000n), /saldo/i);
  assert.equal(state.wallet.sat, FAUCET_AMOUNTS.sat);
  assert.equal(state.wallet.usd, 0n);
  assert.equal(state.activities.length, 1);
});

test("swaps work in both directions, keep LP supply fixed, and increase k", () => {
  let state = applyFaucet(seed(), "sat", { id: "faucet-sat", time: "2026-01-01T00:00:00.000Z" });
  state = applyFaucet(state, "usd", { id: "faucet-usd", time: "2026-01-01T00:00:01.000Z" });
  const initialK = state.pool.sat * state.pool.usd;
  const first = executeSwap(state, "sat-usd", 10_000n, { id: "swap-1", time: "2026-01-01T00:00:02.000Z" });

  assert.equal(first.amountOut, 490n);
  assert.equal(first.state.wallet.sat, 240_000n);
  assert.equal(first.state.wallet.usd, 25_490n);
  assert.equal(first.state.pool.shares, 223_606n);
  assert.ok(first.state.pool.sat * first.state.pool.usd >= initialK);

  const second = executeSwap(first.state, "usd-sat", 500n, { id: "swap-2", time: "2026-01-01T00:00:03.000Z" });
  assert.equal(second.amountOut, 9_998n);
  assert.equal(second.state.wallet.usd, 24_990n);
  assert.equal(second.state.activities.at(-1).type, "Swap");
  assert.doesNotThrow(() => assertState(second.state));
});

test("swap failure is atomic when the wallet lacks input", () => {
  const state = seed();
  assert.throws(() => executeSwap(state, "sat-usd", 1n), /saldo/i);
  assert.deepEqual(state, seed());
});

test("redemption returns both assets, burns shares, and preserves state validity", () => {
  let state = applyFaucet(seed(), "sat", { id: "faucet-sat", time: "2026-01-01T00:00:00.000Z" });
  state = applyFaucet(state, "usd", { id: "faucet-usd", time: "2026-01-01T00:00:01.000Z" });
  state = depositLiquidity(state, 100_000n, 5_000n, { id: "deposit-1", time: "2026-01-01T00:00:02.000Z", nonce: "nonce-1" }).state;
  const result = redeemLiquidity(state, 22_360n, { id: "redeem-1", time: "2026-01-01T00:00:03.000Z" });

  assert.equal(result.amounts.sat, 99_997n);
  assert.equal(result.amounts.usd, 4_999n);
  assert.equal(result.state.wallet.lp, 0n);
  assert.equal(result.state.pool.shares, 223_606n);
  assert.equal(result.state.activities.at(-1).type, "Redeem");
  assert.doesNotThrow(() => assertState(result.state));
});

test("serialization round-trips BigInt state and rejects invalid state", () => {
  let state = applyFaucet(seed(), "sat", { id: "faucet-1", time: "2026-01-01T00:00:00.000Z" });
  state = applyFaucet(state, "usd", { id: "faucet-2", time: "2026-01-01T00:00:01.000Z" });
  const restored = deserializeState(serializeState(state));
  assert.deepEqual(restored, state);
  assert.throws(() => deserializeState(JSON.stringify({ wallet: { sat: "-1" } })), /estado inválido/i);
});

test("invalid operations fail without changing the input state", () => {
  const state = seed();
  assert.throws(() => applyFaucet(state, "eur"), /faucet inválido/i);
  assert.throws(() => executeSwap(state, "sat-usd", 0n), /maior que zero/i);
  assert.throws(() => executeSwap(state, "not-a-direction", 1n), /direção de swap inválida/i);
  assert.throws(() => redeemLiquidity(state, 1n), /shares acima do saldo/i);
  assert.throws(() => decodeMockLpToken("cashu-amm-mock:not-valid"), /receipt mock inválido/i);
  assert.deepEqual(state, seed());
});

test("the pool price changes after a valid swap", () => {
  let state = applyFaucet(seed(), "sat", { id: "faucet-1", time: "2026-01-01T00:00:00.000Z" });
  const before = state.pool.usd * 1_000_000n / state.pool.sat;
  state = executeSwap(state, "sat-usd", 100_000n, { id: "swap-1", time: "2026-01-01T00:00:01.000Z" }).state;
  const after = state.pool.usd * 1_000_000n / state.pool.sat;
  assert.ok(after < before);
});
