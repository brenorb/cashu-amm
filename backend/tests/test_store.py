from __future__ import annotations

import pytest

from backend.amm import PoolState
from backend.store import JsonPoolStore


def test_pool_store_round_trips_versioned_state(tmp_path) -> None:
    store = JsonPoolStore(tmp_path / "pool.json")
    state = PoolState(
        sat=1_000_000,
        usd=50_000,
        shares=223_606,
        events=({"type": "seed"},),
    )

    store.save(state)

    assert store.load() == state


def test_pool_store_rejects_unknown_versions(tmp_path) -> None:
    path = tmp_path / "pool.json"
    path.write_text('{"version": 2}')

    with pytest.raises(ValueError, match="version"):
        JsonPoolStore(path).load()
