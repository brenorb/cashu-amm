from __future__ import annotations

import httpx
import pytest

from backend.amm import PoolState
from backend.app import create_app
from backend.idempotency import OperationResultStore
from backend.service import PoolService
from backend.tests.test_service import FakeGateway, service


@pytest.mark.asyncio
async def test_pool_endpoint_exposes_server_authoritative_state() -> None:
    pool, _, _, _ = service()
    app = create_app(pool)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/api/pool")

    assert response.status_code == 200
    assert response.json()["pool"] == {
        "sat": 1_000_000,
        "usd": 50_000,
        "shares": 223_606,
    }


@pytest.mark.asyncio
async def test_deposit_endpoint_returns_cashu_outputs() -> None:
    pool, _, _, _ = service()
    app = create_app(pool)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/api/liquidity/deposit",
            json={
                "operation_id": "123e4567-e89b-12d3-a456-426614174000",
                "sat_token": "sat-token",
                "usd_token": "usd-token",
            },
        )

    assert response.status_code == 200
    assert response.json()["shares"] == 22_360
    assert response.json()["lp_token"] == "cashuB-fake-issued-22360"


@pytest.mark.asyncio
async def test_invalid_request_is_rejected_without_mutating_pool() -> None:
    pool, _, _, _ = service()
    app = create_app(pool)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/api/swap",
            json={
                "operation_id": "123e4567-e89b-12d3-a456-426614174000",
                "direction": "eur-gbp",
                "token": "sat-token",
            },
        )

    assert response.status_code == 409
    assert response.json()["code"] == "invalid_direction"
    assert pool.state.sat == 1_000_000


@pytest.mark.asyncio
async def test_mint_quote_endpoint_returns_invoice_request() -> None:
    pool, _, _, _ = service()
    app = create_app(pool)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/api/mint/quote", json={"asset": "sat", "amount": 10_000}
        )

    assert response.status_code == 200
    assert response.json()["request"] == "lnbc-10000"


@pytest.mark.asyncio
async def test_api_allows_static_frontend_origin() -> None:
    pool, _, _, _ = service()
    app = create_app(pool)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get(
            "/api/pool", headers={"Origin": "http://localhost:4173"}
        )

    assert response.headers["access-control-allow-origin"] == "http://localhost:4173"


@pytest.mark.asyncio
async def test_same_server_serves_the_website() -> None:
    pool, _, _, _ = service()
    app = create_app(pool)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/")

    assert response.status_code == 200
    assert "Cashu AMM" in response.text
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.asyncio
async def test_frontend_assets_are_not_cached() -> None:
    pool, _, _, _ = service()
    app = create_app(pool)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        responses = [
            await client.get(path)
            for path in ("/app.js", "/styles.css", "/mints.js")
        ]

    assert all(response.status_code == 200 for response in responses)
    assert all(
        response.headers["cache-control"] == "no-store" for response in responses
    )


@pytest.mark.asyncio
async def test_empty_pool_snapshot_is_valid_before_first_deposit() -> None:
    gateway = FakeGateway()
    pool = PoolService(
        sat_gateway=gateway,
        usd_gateway=gateway,
        share_gateway=gateway,
        state=PoolState(sat=0, usd=0, shares=0),
    )
    app = create_app(pool)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/api/pool")

    assert response.status_code == 200
    assert response.json()["initialized"] is False
    assert response.json()["price_usd_per_btc"] == 0


@pytest.mark.asyncio
async def test_api_retry_returns_same_token_and_pool_state(tmp_path) -> None:
    pool, _, _, share = service()
    pool.results = OperationResultStore(tmp_path / "completed")
    app = create_app(pool)
    payload = {
        "operation_id": "123e4567-e89b-12d3-a456-426614174000",
        "sat_token": "sat-token",
        "usd_token": "usd-token",
    }

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        first = await client.post("/api/liquidity/deposit", json=payload)
        retry = await client.post("/api/liquidity/deposit", json=payload)

    assert retry.status_code == 200
    assert retry.json()["lp_token"] == first.json()["lp_token"]
    assert retry.json()["pool"] == first.json()["pool"]
    assert share.issued == [22_360]


@pytest.mark.asyncio
async def test_mutation_requires_operation_id() -> None:
    pool, _, _, _ = service()
    app = create_app(pool)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/api/swap", json={"direction": "sat-usd", "token": "sat-token"}
        )

    assert response.status_code == 422
