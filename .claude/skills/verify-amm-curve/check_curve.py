"""Exhaustive bounded check of backend/amm.py.

Runs the real pool math on every pool and every input amount up to BOUND and
checks the promises the pool makes to liquidity providers and traders.
Usage: python .claude/skills/verify-amm-curve/check_curve.py [BOUND]
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from backend.amm import (
    PoolState,
    quote_exact_in,
    redemption_amounts,
    shares_for_deposit,
    single_sided_deposit_quote,
)

BOUND = int(sys.argv[1]) if len(sys.argv) > 1 else 24
failures: list[str] = []


def fail(rule: str, detail: str) -> None:
    if len(failures) < 20:
        failures.append(f"{rule}: {detail}")


def attempt(function, *args):
    try:
        return function(*args)
    except ValueError:
        return None


checked = 0
for sat in range(1, BOUND + 1):
    for usd in range(1, BOUND + 1):
        for shares in range(1, BOUND + 1):
            state = PoolState(sat=sat, usd=usd, shares=shares)
            for amount in range(1, BOUND + 1):
                checked += 1
                # SwapNeverLowersK: a trade never takes value out of the pool.
                quote = attempt(quote_exact_in, sat, usd, amount)
                if quote is not None:
                    out, next_in, next_out = quote
                    if next_in * next_out < sat * usd or next_out <= 0:
                        fail(
                            "SwapNeverLowersK",
                            f"pool {sat}/{usd} in {amount} out {out}",
                        )
                # RedeemIsProRata: an LP never gets more than its share.
                if amount <= shares:
                    paid = attempt(redemption_amounts, state, amount)
                    if paid is not None:
                        rs, ru = paid
                        if rs * shares > sat * amount or ru * shares > usd * amount:
                            fail(
                                "RedeemIsProRata", f"{state} redeem {amount} -> {paid}"
                            )
                        # StateStaysValid: the pool is left empty or fully
                        # initialized, never with one reserve at zero.
                        try:
                            PoolState(sat - rs, usd - ru, shares - amount).validate()
                        except ValueError as error:
                            fail("StateStaysValid", f"{state} redeem {amount}: {error}")
                # DepositRedeemNoProfit: depositing then redeeming at once never
                # returns more of either asset than was deposited.
                for other in (amount, max(1, amount * usd // sat)):
                    minted = attempt(shares_for_deposit, state, amount, other)
                    if minted is None:
                        continue
                    grown = PoolState(sat + amount, usd + other, shares + minted)
                    paid = attempt(redemption_amounts, grown, minted)
                    if paid is not None and (paid[0] > amount or paid[1] > other):
                        fail(
                            "DepositRedeemNoProfit",
                            f"{state} add {amount}/{other} -> {paid}",
                        )
                # ZapRoundTripNoProfit: a single-sided SAT deposit, redeemed at
                # once and swapped back to SAT, never returns more SAT.
                zap = attempt(single_sided_deposit_quote, state, "sat", amount)
                if zap is not None:
                    minted, _swapped, _counter = zap
                    grown = PoolState(sat + amount, usd, shares + minted)
                    paid = attempt(redemption_amounts, grown, minted)
                    if paid is not None:
                        rs, ru = paid
                        rest = PoolState(
                            grown.sat - rs, grown.usd - ru, grown.shares - minted
                        )
                        back = attempt(quote_exact_in, rest.usd, rest.sat, ru)
                        total = rs + (back[0] if back else 0)
                        if total > amount:
                            fail(
                                "ZapRoundTripNoProfit",
                                f"{state} zap {amount} -> {total} sat",
                            )

print(f"checked {checked} cases with BOUND={BOUND}")
if failures:
    print("\n".join(failures))
    sys.exit(1)
print("all curve rules hold")
