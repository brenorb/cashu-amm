#!/usr/bin/env python3
"""Exercise the real local container without printing bearer tokens."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from uuid import uuid4

BASE_URL = "http://127.0.0.1:8090"


def request(path: str, payload: dict[str, object] | None = None) -> dict[str, object]:
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST" if payload is not None else "GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        body = error.read().decode(errors="replace")
        raise RuntimeError(f"{path} returned HTTP {error.code}: {body}") from error


def mint(asset: str, amount: int) -> str:
    quote = request("/api/mint/quote", {"asset": asset, "amount": amount})
    payload = {"asset": asset, "amount": amount, "quote_id": quote["quote_id"]}
    for _ in range(20):
        try:
            result = request("/api/mint", payload)
            token = str(result["token"])
            retry = request("/api/mint", payload)
            if retry["token"] != token:
                raise RuntimeError("mint retry did not return the same bearer token")
            return token
        except RuntimeError as error:
            if "not paid" not in str(error).lower():
                raise
            time.sleep(0.25)
    raise RuntimeError(f"{asset} test token was not mintable after 5 seconds")


def main() -> None:
    initial = request("/api/pool")
    if initial["initialized"]:
        raise RuntimeError("smoke test requires an empty pool data volume")

    sat_liquidity = mint("sat", 20_001)
    usd_liquidity = mint("usd", 1_001)
    deposit_payload = {
        "operation_id": str(uuid4()),
        "sat_token": sat_liquidity,
        "usd_token": usd_liquidity,
    }
    deposit = request("/api/liquidity/deposit", deposit_payload)
    after_deposit = request("/api/pool")
    deposit_retry = request("/api/liquidity/deposit", deposit_payload)
    assert deposit_retry["lp_token"] == deposit["lp_token"]
    assert request("/api/pool")["pool"] == after_deposit["pool"]

    sat_trade = mint("sat", 501)
    sat_swap_payload = {
        "operation_id": str(uuid4()),
        "direction": "sat-usd",
        "token": sat_trade,
    }
    sat_to_usd = request("/api/swap", sat_swap_payload)
    after_sat_swap = request("/api/pool")
    sat_to_usd_retry = request("/api/swap", sat_swap_payload)
    assert sat_to_usd_retry["output_token"] == sat_to_usd["output_token"]
    assert request("/api/pool")["pool"] == after_sat_swap["pool"]

    usd_trade = mint("usd", 51)
    usd_swap_payload = {
        "operation_id": str(uuid4()),
        "direction": "usd-sat",
        "token": usd_trade,
    }
    usd_to_sat = request("/api/swap", usd_swap_payload)
    after_usd_swap = request("/api/pool")
    usd_to_sat_retry = request("/api/swap", usd_swap_payload)
    assert usd_to_sat_retry["output_token"] == usd_to_sat["output_token"]
    assert request("/api/pool")["pool"] == after_usd_swap["pool"]

    redeem_payload = {
        "operation_id": str(uuid4()),
        "lp_token": str(deposit["lp_token"]),
    }
    redeem = request("/api/liquidity/redeem", redeem_payload)
    final = request("/api/pool")
    redeem_retry = request("/api/liquidity/redeem", redeem_payload)
    assert redeem_retry["tokens"] == redeem["tokens"]
    assert request("/api/pool")["pool"] == final["pool"]
    assert final["pool"] == {"sat": 0, "usd": 0, "shares": 0}

    print(
        json.dumps(
            {
                "deposit_lp": deposit["shares"],
                "sat_to_usd": sat_to_usd["amount_out"],
                "usd_to_sat": usd_to_sat["amount_out"],
                "redeemed": redeem["amounts"],
                "final_pool": final["pool"],
                "idempotent_retries": 4,
                "result": "ok",
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
