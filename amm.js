export const BPS = 10_000n;
export const FEE_BPS = 100n;

function requireNonNegative(value, label) {
  if (typeof value !== "bigint" || value < 0n) {
    throw new TypeError(`${label} must be a non-negative bigint`);
  }
}

function requirePositive(value, label) {
  requireNonNegative(value, label);
  if (value === 0n) throw new RangeError(`${label} must be greater than zero`);
}

export function integerSqrt(value) {
  requireNonNegative(value, "value");
  if (value < 2n) return value;

  let left = 1n;
  let right = value / 2n + 1n;
  while (left <= right) {
    const middle = (left + right) / 2n;
    const square = middle * middle;
    if (square === value) return middle;
    if (square < value) left = middle + 1n;
    else right = middle - 1n;
  }
  return right;
}

export function initialShareSupply(reserveSat, reserveUsd) {
  requirePositive(reserveSat, "reserveSat");
  requirePositive(reserveUsd, "reserveUsd");
  return integerSqrt(reserveSat * reserveUsd);
}

export function quoteExactIn(reserveIn, reserveOut, amountIn, feeBps = FEE_BPS) {
  requirePositive(reserveIn, "reserveIn");
  requirePositive(reserveOut, "reserveOut");
  requirePositive(amountIn, "amountIn");
  requireNonNegative(feeBps, "feeBps");
  if (feeBps >= BPS) throw new RangeError("feeBps must be lower than 10000");

  const amountInWithFee = amountIn * (BPS - feeBps);
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * BPS + amountInWithFee;
  const amountOut = numerator / denominator;
  if (amountOut <= 0n || amountOut >= reserveOut) {
    throw new RangeError("trade is too small or exceeds available liquidity");
  }

  return {
    amountOut,
    feeAmount: amountIn - amountInWithFee / BPS,
    nextReserveIn: reserveIn + amountIn,
    nextReserveOut: reserveOut - amountOut
  };
}

export function sharesForDeposit(
  reserveSat,
  reserveUsd,
  totalShares,
  depositSat,
  depositUsd
) {
  for (const [value, label] of [
    [reserveSat, "reserveSat"],
    [reserveUsd, "reserveUsd"],
    [totalShares, "totalShares"],
    [depositSat, "depositSat"],
    [depositUsd, "depositUsd"]
  ]) requirePositive(value, label);

  const bySat = depositSat * totalShares / reserveSat;
  const byUsd = depositUsd * totalShares / reserveUsd;
  const shares = bySat < byUsd ? bySat : byUsd;
  if (shares <= 0n) throw new RangeError("deposit is too small to mint a share");
  return shares;
}

export function amountsForRedemption(
  reserveSat,
  reserveUsd,
  totalShares,
  shares
) {
  for (const [value, label] of [
    [reserveSat, "reserveSat"],
    [reserveUsd, "reserveUsd"],
    [totalShares, "totalShares"],
    [shares, "shares"]
  ]) requirePositive(value, label);
  if (shares > totalShares) throw new RangeError("shares exceed total supply");

  const sat = reserveSat * shares / totalShares;
  const usd = reserveUsd * shares / totalShares;
  if (sat <= 0n || usd <= 0n) {
    throw new RangeError("LP amount is too small to redeem both assets");
  }
  return { sat, usd };
}

export function poolPriceUsdPerBtc(reserveSat, reserveUsd) {
  requirePositive(reserveSat, "reserveSat");
  requirePositive(reserveUsd, "reserveUsd");
  return Number(reserveUsd) * 1_000_000 / Number(reserveSat);
}
