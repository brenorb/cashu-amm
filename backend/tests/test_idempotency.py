from __future__ import annotations

import pytest

from backend.idempotency import OperationResultStore


def test_result_store_round_trips_token_with_private_permissions(tmp_path) -> None:
    store = OperationResultStore(tmp_path / "completed")
    operation_id = "123e4567-e89b-12d3-a456-426614174000"
    payload = {"token": "cashuB-input"}
    result = {"output_token": "cashuB-output", "amount_out": 42}

    store.save(operation_id, "swap", payload, result)

    assert store.load(operation_id, "swap", payload) == result
    mode = (tmp_path / "completed" / f"{operation_id}.json").stat().st_mode
    assert mode & 0o777 == 0o600


def test_result_store_rejects_id_reuse_for_different_request(tmp_path) -> None:
    store = OperationResultStore(tmp_path / "completed")
    operation_id = "123e4567-e89b-12d3-a456-426614174000"
    store.save(operation_id, "swap", {"token": "first"}, {"amount_out": 1})

    with pytest.raises(ValueError, match="another request"):
        store.load(operation_id, "swap", {"token": "second"})
