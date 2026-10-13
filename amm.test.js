import test from "node:test";
import assert from "node:assert/strict";
import {
  FEE_BPS,
  amountsForRedemption,
  initialShareSupply,
  integerSqrt,
  poolPriceUsdPerBtc,
  quoteExactIn,
  minimumAmountOut,
  sharesForDeposit
} from "./amm.js";

test("integer square root always rounds down", () => {
  assert.equal(integerSqrt(0n), 0n);
  assert.equal(integerSqrt(15n), 3n);
  assert.equal(integerSqrt(16n), 4n);
  assert.equal(integerSqrt(17n), 4n);
});

test("initial shares use the geometric mean", () => {
  assert.equal(initialShareSupply(1_000_000n, 50_000n), 223_606n);
});

test("one percent fee and floor rounding protect the pool", () => {
  const quote = quoteExactIn(1_000_000n, 50_000n, 10_000n, FEE_BPS);
  assert.equal(quote.amountOut, 490n);
  assert.equal(quote.nextReserveIn, 1_010_000n);
  assert.equal(quote.nextReserveOut, 49_510n);
  assert.ok(quote.nextReserveIn * quote.nextReserveOut >= 1_000_000n * 50_000n);
});

test("liquidity shares follow the limiting proportional deposit", () => {
  const shares = sharesForDeposit(
    1_000_000n,
    50_000n,
    223_606n,
    100_000n,
    5_100n
  );
  assert.equal(shares, 22_360n);
});

test("redemption floors both outputs", () => {
  const amounts = amountsForRedemption(
    1_000_001n,
    50_001n,
    223_606n,
    22_360n
  );
  assert.equal(amounts.sat, 99_997n);
  assert.equal(amounts.usd, 4_999n);
});

test("redemption rejects an LP amount that rounds either output to zero", () => {
  assert.throws(
    () => amountsForRedemption(1_000_000n, 50_000n, 223_606n, 1n),
    /too small/
  );
});

test("redemption rejects shares above total supply", () => {
  assert.throws(
    () => amountsForRedemption(1_000_000n, 50_000n, 223_606n, 223_607n),
    /shares exceed total supply/
  );
});

test("reference reserves price bitcoin at fifty thousand dollars", () => {
  assert.equal(poolPriceUsdPerBtc(1_000_000n, 50_000n), 50_000);
});

test("slippage floor never loses a fractional output unit", () => {
  assert.equal(minimumAmountOut(1n, 100n), 1n);
  assert.equal(minimumAmountOut(101n, 100n), 100n);
  assert.equal(minimumAmountOut(4504n, 100n), 4459n);
  assert.equal(minimumAmountOut(90081n, 0n), 90081n);
  assert.equal(minimumAmountOut(9_007_199_254_740_991n, 1n), 9_006_298_534_815_517n);
  assert.throws(() => minimumAmountOut(1n, 10000n));
  assert.throws(() => minimumAmountOut(0n, 100n));
});
