from __future__ import annotations

import os
from pathlib import Path

from .amm import PoolState
from .idempotency import OperationResultStore
from .journal import OperationJournal
from .nutshell import NutshellGateway
from .service import PoolService
from .store import JsonPoolStore


def _mint_url(name: str, default: str) -> str:
    return os.environ.get(name, default).strip().rstrip("/")


async def build_service_from_env() -> PoolService:
    data_dir = Path(os.environ.get("CASHU_AMM_DATA_DIR", "./data"))
    sat_mint = _mint_url("CASHU_AMM_SAT_MINT_URL", "https://testnut.cashu.space")
    usd_mint = _mint_url("CASHU_AMM_USD_MINT_URL", "https://testnut.cashu.space")
    lp_mint = _mint_url("CASHU_AMM_LP_MINT_URL", "http://127.0.0.1:3338")
    lp_unit = os.environ.get("CASHU_AMM_LP_UNIT", "sat")
    if lp_mint in {sat_mint, usd_mint}:
        raise RuntimeError("LP mint must be private and distinct from the asset mint")

    sat = await NutshellGateway.open(sat_mint, str(data_dir), "pool-sat", "sat")
    usd = await NutshellGateway.open(usd_mint, str(data_dir), "pool-usd", "usd")
    lp = await NutshellGateway.open(lp_mint, str(data_dir), "pool-lp", lp_unit)
    store = JsonPoolStore(data_dir / "pool-state.json")
    journal = OperationJournal(data_dir / "pending-operations")
    results = OperationResultStore(data_dir / "completed-operations")
    pending = journal.pending()
    if pending:
        ids = ", ".join(str(item.get("id", "unknown")) for item in pending)
        raise RuntimeError(f"pending Cashu operations require operator recovery: {ids}")
    state = store.load()
    if state is None:
        state = PoolState(sat=0, usd=0, shares=0)
        store.save(state)

    return PoolService(
        sat_gateway=sat,
        usd_gateway=usd,
        share_gateway=lp,
        state=state,
        persist=store.save,
        journal=journal,
        results=results,
    )
