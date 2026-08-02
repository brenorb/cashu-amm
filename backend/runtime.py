from __future__ import annotations

import math
import os
from pathlib import Path

from .amm import PoolState
from .journal import OperationJournal
from .nutshell import NutshellGateway
from .service import PoolService
from .store import JsonPoolStore


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"missing required environment variable {name}")
    return value


async def build_service_from_env() -> PoolService:
    data_dir = Path(os.environ.get("CASHU_AMM_DATA_DIR", "./data"))
    sat_mint = _required("CASHU_AMM_SAT_MINT_URL")
    usd_mint = _required("CASHU_AMM_USD_MINT_URL")
    lp_mint = _required("CASHU_AMM_LP_MINT_URL")
    lp_unit = os.environ.get("CASHU_AMM_LP_UNIT", "sat")

    sat = await NutshellGateway.open(sat_mint, str(data_dir), "pool-sat", "sat")
    usd = await NutshellGateway.open(usd_mint, str(data_dir), "pool-usd", "usd")
    lp = await NutshellGateway.open(lp_mint, str(data_dir), "pool-lp", lp_unit)
    store = JsonPoolStore(data_dir / "pool-state.json")
    journal = OperationJournal(data_dir / "pending-operations")
    pending = journal.pending()
    if pending:
        ids = ", ".join(str(item.get("id", "unknown")) for item in pending)
        raise RuntimeError(f"pending Cashu operations require operator recovery: {ids}")
    state = store.load()
    if state is None:
        seed_sat = _required("CASHU_AMM_SEED_SAT_TOKEN")
        seed_usd = _required("CASHU_AMM_SEED_USD_TOKEN")
        seed_lp = _required("CASHU_AMM_SEED_LP_TOKEN")
        reserve_sat = await sat.receive(seed_sat)
        reserve_usd = await usd.receive(seed_usd)
        shares = await lp.receive(seed_lp)
        expected = math.isqrt(reserve_sat * reserve_usd)
        if shares != expected:
            raise RuntimeError(f"LP seed {shares} does not match geometric supply {expected}")
        state = PoolState(sat=reserve_sat, usd=reserve_usd, shares=shares)
        store.save(state)

    return PoolService(
        sat_gateway=sat,
        usd_gateway=usd,
        share_gateway=lp,
        state=state,
        persist=store.save,
        journal=journal,
    )
