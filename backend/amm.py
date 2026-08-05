from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

BPS = 10_000
FEE_BPS = 100


@dataclass(frozen=True)
class PoolState:
    sat: int
    usd: int
    shares: int
    events: tuple[dict[str, Any], ...] = ()

    def validate(self) -> None:
        values = (self.sat, self.usd, self.shares)
        if any(value < 0 for value in values):
            raise ValueError("pool reserves and shares cannot be negative")
        if any(value == 0 for value in values) and any(value != 0 for value in values):
            raise ValueError("pool must be either empty or fully initialized")
        if any(not isinstance(event, dict) for event in self.events):
            raise ValueError("pool events must be objects")


def quote_exact_in(
    reserve_in: int, reserve_out: int, amount_in: int
) -> tuple[int, int, int]:
    if min(reserve_in, reserve_out, amount_in) <= 0:
        raise ValueError("swap amounts must be positive")
    effective = amount_in * (BPS - FEE_BPS)
    amount_out = effective * reserve_out // (reserve_in * BPS + effective)
    if amount_out <= 0 or amount_out >= reserve_out:
        raise ValueError("trade is too small or exceeds available liquidity")
    return amount_out, reserve_in + amount_in, reserve_out - amount_out


def shares_for_deposit(state: PoolState, deposit_sat: int, deposit_usd: int) -> int:
    if min(deposit_sat, deposit_usd) <= 0:
        raise ValueError("deposit amounts must be positive")
    if state.shares == 0:
        shares = math.isqrt(deposit_sat * deposit_usd)
        if shares <= 0:
            raise ValueError("initial deposit is too small to mint shares")
        return shares
    shares = min(
        deposit_sat * state.shares // state.sat,
        deposit_usd * state.shares // state.usd,
    )
    if shares <= 0:
        raise ValueError("deposit is too small to mint shares")
    return shares


def single_sided_deposit_quote(
    state: PoolState, input_asset: str, amount: int
) -> tuple[int, int, int]:
    """Return (shares, swapped_input, counter_asset_amount) for a one-sided zap.

    A single-sided deposit is represented as an internal swap followed by a
    proportional two-asset deposit. The pool must already have a price; the
    empty pool still needs both assets for its initial seed.
    """
    if state.shares <= 0 or min(state.sat, state.usd) <= 0:
        raise ValueError("single-sided deposits require an initialized pool")
    if amount <= 1:
        raise ValueError("single-sided deposit is too small")
    if input_asset not in {"sat", "usd"}:
        raise ValueError("single-sided input asset must be sat or usd")

    reserve_in, reserve_out = (
        (state.sat, state.usd) if input_asset == "sat" else (state.usd, state.sat)
    )

    def candidate(swapped: int) -> tuple[int, int, int] | None:
        if swapped <= 0 or swapped >= amount:
            return None
        try:
            counter, next_in, next_out = quote_exact_in(
                reserve_in, reserve_out, swapped
            )
            post_swap = PoolState(
                sat=next_in if input_asset == "sat" else next_out,
                usd=next_out if input_asset == "sat" else next_in,
                shares=state.shares,
            )
            shares = shares_for_deposit(
                post_swap,
                amount - swapped if input_asset == "sat" else counter,
                counter if input_asset == "sat" else amount - swapped,
            )
            return shares, swapped, counter
        except ValueError:
            return None

    # The limiting side changes monotonically around the optimum. Binary
    # search for that crossover, then check nearby integer candidates because
    # Cashu amounts and AMM outputs are integer-rounded.
    low, high = 1, amount - 1
    candidates: set[int] = set()
    while low <= high:
        middle = (low + high) // 2
        quote = candidate(middle)
        if quote is None:
            low = middle + 1
            continue
        candidates.add(middle)
        swapped, counter = quote[1], quote[2]
        if input_asset == "sat":
            left = (amount - swapped) * (reserve_out - counter)
            right = counter * (reserve_in + swapped)
        else:
            left = (amount - swapped) * (reserve_out - counter)
            right = counter * (reserve_in + swapped)
        if left > right:
            low = middle + 1
        else:
            high = middle - 1

    for center in (low, high):
        candidates.update(range(max(1, center - 3), min(amount, center + 4)))
    best: tuple[int, int, int] | None = None
    for swapped in candidates:
        quote = candidate(swapped)
        if quote is not None and (best is None or quote[0] > best[0]):
            best = quote
    if best is None:
        raise ValueError("single-sided deposit is too small for this pool")
    return best


def redemption_amounts(state: PoolState, shares: int) -> tuple[int, int]:
    if shares <= 0 or shares > state.shares:
        raise ValueError("shares exceed total supply")
    sat = state.sat * shares // state.shares
    usd = state.usd * shares // state.shares
    if min(sat, usd) <= 0:
        raise ValueError("LP amount is too small to redeem both assets")
    return sat, usd
