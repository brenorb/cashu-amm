from __future__ import annotations

import httpx
import pytest

from backend.app import create_app
from backend.tests.test_service import service


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
            json={"sat_token": "sat-token", "usd_token": "usd-token"},
        )

    assert response.status_code == 200
    assert response.json()["shares"] == 22_360
    assert response.json()["lp_token"] == "cashuB-fake-22360"


@pytest.mark.asyncio
async def test_invalid_request_is_rejected_without_mutating_pool() -> None:
    pool, _, _, _ = service()
    app = create_app(pool)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/api/swap", json={"direction": "eur-gbp", "token": "sat-token"}
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
