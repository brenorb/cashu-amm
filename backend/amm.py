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


def redemption_amounts(state: PoolState, shares: int) -> tuple[int, int]:
    if shares <= 0 or shares > state.shares:
        raise ValueError("shares exceed total supply")
    sat = state.sat * shares // state.shares
    usd = state.usd * shares // state.shares
    if min(sat, usd) <= 0:
        raise ValueError("LP amount is too small to redeem both assets")
    return sat, usd
