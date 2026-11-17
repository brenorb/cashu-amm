---
name: verify-amm-curve
description: Exhaustively check the constant-product pool math in backend/amm.py on every small pool and input. Use when changing quote_exact_in, shares_for_deposit, single_sided_deposit_quote, redemption_amounts, PoolState.validate, FEE_BPS, or any rounding in them.
---

# Verify AMM curve math

**Properties**, checked on the real functions in `backend/amm.py`:

- `SwapNeverLowersK`: a swap never lowers `sat × usd`, so trades never take value out of the pool.
- `RedeemIsProRata`: redeeming `n` of `S` LP pays at most `n/S` of each reserve.
- `StateStaysValid`: after a redemption the pool is empty or has both reserves and shares above zero.
- `DepositRedeemNoProfit`: adding liquidity and redeeming it at once never returns more of either asset than was added.
- `ZapRoundTripNoProfit`: a single-sided SAT deposit, redeemed at once and swapped back to SAT, never returns more SAT.

**Harm if broken.** A trader or LP can drain value from the other LPs, or the pool reaches a state that `JsonPoolStore.load` refuses at the next restart.

## Run

```sh
uv run python .claude/skills/verify-amm-curve/check_curve.py 24
```

It checks every pool with `sat`, `usd`, `shares` in 1..24 and every input amount in 1..24 (331,776 cases, about 4 s) and prints `all curve rules hold`. A failure prints the rule and the smallest pool and amounts that break it. Raise the bound for a slower, wider run.

## Able to fail

Each of these scratch changes to `backend/amm.py` makes the check fail. Use one to confirm the check still works after you edit it, then restore the file.

- `shares = min(` → `shares = max(` in `shares_for_deposit`: `DepositRedeemNoProfit`.
- `sat = state.sat * shares // state.shares` → `sat = -(-state.sat * shares // state.shares)`: `RedeemIsProRata`, `StateStaysValid`.
- `amount_out = effective * reserve_out // (reserve_in * BPS + effective)` → `amount_out = -(-amount_in * reserve_out // reserve_in)`: `SwapNeverLowersK`.

## Coverage

Synced with the code at commit `88468ef`. Move this forward only after you confirm that the script still calls the functions the service uses.

Covered: `quote_exact_in`, `shares_for_deposit`, `single_sided_deposit_quote` (SAT input), `redemption_amounts`, `PoolState.validate`. Not covered: pools or amounts above the bound, USD-input zaps, sequences of more than one operation, and the proportion tolerance in `PoolService.deposit`.
