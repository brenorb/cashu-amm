from __future__ import annotations

from uuid import uuid4

import httpx
import pytest

import backend.service as service_module
from backend.app import create_app
from backend.idempotency import OperationResultStore
from backend.journal import OperationJournal
from backend.service import Asset, OperationError, PoolService
from backend.tests.test_service import service


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "direction,token,expected",
    [("sat-usd", "sat-token", 4504), ("usd-sat", "usd-token", 90081)],
)
async def test_exact_floor_is_accepted_without_changing_rounding(
    direction, token, expected
):
    pool, sat, usd, _ = service()
    before = pool.state
    output = usd if direction == "sat-usd" else sat
    result = await pool.swap(direction, token, minimum_amount_out=expected)
    assert result.amount_out == expected
    assert output.sent == [expected]
    assert pool.state.sat * pool.state.usd >= before.sat * before.usd


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "direction,token,expected,asset",
    [
        ("sat-usd", "sat-token", 4504, Asset.SAT),
        ("usd-sat", "usd-token", 90081, Asset.USD),
    ],
)
async def test_one_unit_above_floor_refunds_input_and_keeps_pool(
    direction, token, expected, asset
):
    pool, sat, usd, _ = service()
    before = pool.state
    incoming, outgoing = (sat, usd) if asset == Asset.SAT else (usd, sat)
    with pytest.raises(OperationError) as rejected:
        await pool.swap(direction, token, minimum_amount_out=expected + 1)
    assert rejected.value.code == "slippage_exceeded"
    amount = incoming.received[token]
    assert rejected.value.refunds == {asset: f"cashuB-fake-{amount}"}
    assert rejected.value.refund_amounts == {asset: amount}
    assert incoming.sent == [amount]
    assert outgoing.sent == []
    assert pool.state == before


@pytest.mark.asyncio
async def test_floor_uses_net_received_amount_not_token_face_value():
    pool, sat, usd, _ = service()
    sat.received["sat-token"] = 201
    with pytest.raises(OperationError) as rejected:
        await pool.swap("sat-usd", "sat-token", minimum_amount_out=10)
    assert rejected.value.code == "slippage_exceeded"
    assert rejected.value.refund_amounts == {Asset.SAT: 201}
    assert sat.sent == [201]
    assert usd.sent == []


@pytest.mark.asyncio
async def test_stale_quote_does_not_receive_input(monkeypatch):
    pool, sat, usd, _ = service()

    async def forbidden(_token):
        pytest.fail("expired quote must not consume input")

    sat.receive = forbidden
    monkeypatch.setattr(service_module, "_now_ms", lambda: 1000)
    with pytest.raises(OperationError) as rejected:
        await pool.swap(
            "sat-usd", "sat-token", minimum_amount_out=1, quote_deadline_ms=1000
        )
    assert rejected.value.code == "quote_expired"
    assert rejected.value.refunds == {}
    assert rejected.value.input_received is False
    assert sat.sent == usd.sent == []


@pytest.mark.asyncio
async def test_quote_expiring_during_receive_refunds_net_input(monkeypatch):
    pool, sat, usd, _ = service()
    now = [1000]
    monkeypatch.setattr(service_module, "_now_ms", lambda: now[0])

    async def receive(_token):
        now[0] = 2000
        return 99997

    sat.receive = receive
    with pytest.raises(OperationError) as rejected:
        await pool.swap(
            "sat-usd", "sat-token", minimum_amount_out=1, quote_deadline_ms=2000
        )
    assert rejected.value.code == "quote_expired"
    assert rejected.value.refund_amounts == {Asset.SAT: 99997}
    assert sat.sent == [99997]
    assert usd.sent == []


@pytest.mark.asyncio
@pytest.mark.parametrize("accepted", [True, False])
async def test_durable_retry_after_expiry_returns_same_output_or_refund(
    tmp_path, monkeypatch, accepted
):
    pool, sat, usd, share = service()
    pool.results = OperationResultStore(tmp_path / "completed")
    pool.journal = OperationJournal(tmp_path / "pending")
    now = [1000]
    monkeypatch.setattr(service_module, "_now_ms", lambda: now[0])
    calls = []

    async def receive(token):
        calls.append(token)
        assert len(calls) == 1, "spent input must never be received again"
        return 100000

    sat.receive = receive
    operation_id = str(uuid4())
    options = {
        "minimum_amount_out": 4504 if accepted else 4505,
        "quote_deadline_ms": 2000,
    }
    if accepted:
        first = await pool.swap("sat-usd", "sat-token", operation_id, **options)
    else:
        with pytest.raises(OperationError) as first_error:
            await pool.swap("sat-usd", "sat-token", operation_id, **options)
    assert pool.journal.pending() == []
    restarted = PoolService(
        sat_gateway=sat,
        usd_gateway=usd,
        share_gateway=share,
        state=pool.state,
        results=OperationResultStore(tmp_path / "completed"),
    )
    now[0] = 3000
    if accepted:
        retry = await restarted.swap("sat-usd", "sat-token", operation_id, **options)
        assert retry == first
        assert usd.sent == [4504]
        assert sat.sent == []
    else:
        with pytest.raises(OperationError) as retry_error:
            await restarted.swap("sat-usd", "sat-token", operation_id, **options)
        assert retry_error.value.code == first_error.value.code
        assert retry_error.value.refunds == first_error.value.refunds
        assert retry_error.value.refund_amounts == first_error.value.refund_amounts
        assert sat.sent == [100000]
        assert usd.sent == []
    assert calls == ["sat-token"]
    for altered in [
        {**options, "minimum_amount_out": 4506},
        {**options, "quote_deadline_ms": 4000},
    ]:
        with pytest.raises(OperationError, match="another request") as conflict:
            await restarted.swap("sat-usd", "sat-token", operation_id, **altered)
        assert conflict.value.code == "operation_id_conflict"


@pytest.mark.asyncio
async def test_failed_refund_stays_pending_and_retry_does_not_receive_again(tmp_path):
    pool, sat, usd, _ = service()
    pool.results = OperationResultStore(tmp_path / "completed")
    pool.journal = OperationJournal(tmp_path / "pending")
    sat.fail_send = True
    calls = []

    async def receive(token):
        calls.append(token)
        return 100000

    sat.receive = receive
    operation_id = str(uuid4())
    for _ in range(2):
        with pytest.raises(OperationError) as rejected:
            await pool.swap(
                "sat-usd", "sat-token", operation_id, minimum_amount_out=4505
            )
        assert rejected.value.refunds == rejected.value.refund_amounts == {}
    assert calls == ["sat-token"]
    assert pool.journal.pending()[0]["stage"] == "failed"
    with pytest.raises(OperationError) as blocked:
        await pool.swap("sat-usd", "sat-token", str(uuid4()), minimum_amount_out=1)
    assert blocked.value.code == "pool_recovery_required"
    assert calls == ["sat-token"]
    assert usd.sent == []


@pytest.mark.asyncio
async def test_cache_write_failure_retains_compensating_token_in_journal(tmp_path):
    pool, _, _, _ = service()
    pool.results = OperationResultStore(tmp_path / "completed")
    pool.journal = OperationJournal(tmp_path / "pending")

    def broken_save(*_args):
        raise OSError("fixture disk failure")

    pool.results.save = broken_save
    with pytest.raises(OSError, match="fixture disk failure"):
        await pool.swap("sat-usd", "sat-token", str(uuid4()), minimum_amount_out=4505)
    assert pool.journal.pending()[0]["refunds"] == {"sat": "cashuB-fake-100000"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "direction,amount,expected,impact",
    [("sat-usd", 100000, 4504, 901), ("usd-sat", 5000, 90081, 900)],
)
async def test_quote_is_read_only_and_returns_floor_impact_deadline(
    monkeypatch, direction, amount, expected, impact
):
    pool, sat, usd, _ = service()
    before = pool.state
    monkeypatch.setattr(service_module, "_now_ms", lambda: 123000)
    app = create_app(pool)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/api/swap/quote", json={"direction": direction, "amount": amount}
        )
    assert response.status_code == 200
    assert response.json() == {
        "amount_in": amount,
        "amount_out": expected,
        "price_impact_bps": impact,
        "quote_deadline_ms": 153000,
        "fee_bps": 100,
    }
    assert pool.state == before
    assert sat.sent == usd.sent == []


@pytest.mark.asyncio
async def test_api_refunded_retry_is_identical(tmp_path):
    pool, sat, usd, _ = service()
    pool.results = OperationResultStore(tmp_path / "completed")
    app = create_app(pool)
    payload = {
        "direction": "sat-usd",
        "token": "sat-token",
        "minimum_amount_out": 4505,
        "operation_id": str(uuid4()),
    }
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        first = await client.post("/api/swap", json=payload)
        retry = await client.post("/api/swap", json=payload)
    assert first.status_code == retry.status_code == 409
    assert retry.json() == first.json()
    assert first.json()["code"] == "slippage_exceeded"
    assert first.json()["refund_amounts"] == {"sat": 100000}
    assert first.json()["input_received"] is True
    assert sat.sent == [100000]
    assert usd.sent == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field,value",
    [
        ("minimum_amount_out", None),
        ("minimum_amount_out", True),
        ("minimum_amount_out", -1),
        ("minimum_amount_out", 1.5),
        ("minimum_amount_out", "100"),
        ("quote_deadline_ms", True),
        ("quote_deadline_ms", -1),
        ("quote_deadline_ms", 1.5),
    ],
)
async def test_invalid_constraints_are_rejected_before_receiving(field, value):
    pool, sat, _, _ = service()

    async def forbidden(_token):
        pytest.fail("invalid constraints must not consume input")

    sat.receive = forbidden
    payload = {
        "direction": "sat-usd",
        "token": "sat-token",
        "minimum_amount_out": 1,
        "operation_id": str(uuid4()),
    }
    if value is None:
        payload.pop(field)
    else:
        payload[field] = value
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=create_app(pool)), base_url="http://test"
    ) as client:
        response = await client.post("/api/swap", json=payload)
    assert response.status_code == 422


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "direction,token,amount,minimum",
    [("sat-usd", "sat-token", 100000, 4459), ("usd-sat", "usd-token", 5000, 89181)],
)
async def test_pool_change_after_preview_breaches_minimum_and_refunds(
    direction, token, amount, minimum
):
    pool, sat, usd, _ = service()
    quote = await pool.quote_swap(direction, amount)
    assert quote.amount_out >= minimum
    incoming, outgoing = (sat, usd) if direction == "sat-usd" else (usd, sat)
    incoming.received["other-trade"] = amount
    await pool.swap(direction, "other-trade")
    before = pool.state
    previous_outputs = list(outgoing.sent)
    with pytest.raises(OperationError) as rejected:
        await pool.swap(direction, token, minimum_amount_out=minimum)
    assert rejected.value.code == "slippage_exceeded"
    assert incoming.sent == [amount]
    assert outgoing.sent == previous_outputs
    assert pool.state == before


@pytest.mark.asyncio
async def test_legacy_unprotected_completed_response_can_still_be_recovered(tmp_path):
    pool, sat, _, _ = service()
    pool.results = OperationResultStore(tmp_path / "completed")
    operation_id = str(uuid4())
    pool.results.save(
        operation_id,
        "swap",
        {"direction": "sat-usd", "token": "sat-token"},
        {
            "amount_in": 100000,
            "amount_out": 4504,
            "output_token": "cashuB-previous-output",
        },
    )

    async def forbidden(_token):
        pytest.fail("legacy completed input must not be received again")

    sat.receive = forbidden
    result = await pool.swap("sat-usd", "sat-token", operation_id, minimum_amount_out=0)
    assert result.output_token == "cashuB-previous-output"


@pytest.mark.asyncio
async def test_api_expiry_reports_original_input_unspent(monkeypatch):
    pool, sat, _, _ = service()
    monkeypatch.setattr(service_module, "_now_ms", lambda: 1000)

    async def forbidden(_token):
        pytest.fail("expired input must remain unspent")

    sat.receive = forbidden
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=create_app(pool)), base_url="http://test"
    ) as client:
        response = await client.post(
            "/api/swap",
            json={
                "direction": "sat-usd",
                "token": "sat-token",
                "minimum_amount_out": 1,
                "quote_deadline_ms": 1000,
                "operation_id": str(uuid4()),
            },
        )
    assert response.status_code == 409
    assert response.json()["input_received"] is False
    assert response.json()["refunds"] == {}
