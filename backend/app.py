from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from uuid import UUID

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .service import OperationError, PoolService


class DepositRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operation_id: UUID
    sat_token: str = Field(min_length=1)
    usd_token: str = Field(min_length=1)


class SwapRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operation_id: UUID
    direction: str = Field(min_length=1)
    token: str = Field(min_length=1)


class RedeemRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operation_id: UUID
    lp_token: str = Field(min_length=1)


class MintRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    asset: str = Field(min_length=1)
    amount: int = Field(gt=0)
    quote_id: str | None = None


def _snapshot(service: PoolService) -> dict[str, Any]:
    state = service.state
    return {
        "pool": {"sat": state.sat, "usd": state.usd, "shares": state.shares},
        "price_usd_per_btc": state.usd * 1_000_000 / state.sat if state.sat else 0,
        "k": state.sat * state.usd,
        "fee_bps": 100,
        "events": list(state.events),
        "initialized": state.shares > 0,
    }


def _error_response(error: OperationError) -> JSONResponse:
    return JSONResponse(
        status_code=409,
        content={
            "error": error.code,
            "code": error.code,
            "message": str(error),
            "refunds": {asset.value: token for asset, token in error.refunds.items()},
        },
    )


def create_app(service: PoolService | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if service is None:
            from .runtime import build_service_from_env

            app.state.pool_service = await build_service_from_env()
        else:
            app.state.pool_service = service
        yield

    app = FastAPI(title="Cashu AMM", version="0.2.0", lifespan=lifespan)
    origins = [
        origin.strip()
        for origin in os.environ.get(
            "CASHU_AMM_ALLOWED_ORIGINS",
            "http://localhost:4173,http://127.0.0.1:4173,http://localhost:8080,http://127.0.0.1:8080",
        ).split(",")
        if origin.strip()
    ]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type"],
    )
    if service is not None:
        app.state.pool_service = service

    def current(request: Request) -> PoolService:
        return request.app.state.pool_service

    @app.get("/health")
    async def health(request: Request) -> dict[str, str]:
        current(request)
        return {"status": "ok"}

    @app.get("/api/pool")
    async def pool(request: Request) -> dict[str, Any]:
        return _snapshot(current(request))

    @app.post("/api/liquidity/deposit")
    async def deposit(payload: DepositRequest, request: Request):
        try:
            result = await current(request).deposit(
                payload.sat_token,
                payload.usd_token,
                str(payload.operation_id),
            )
            return {
                "shares": result.shares,
                "lp_token": result.lp_token,
                "pool": _snapshot(current(request)),
            }
        except OperationError as error:
            return _error_response(error)

    @app.post("/api/swap")
    async def swap(payload: SwapRequest, request: Request):
        try:
            result = await current(request).swap(
                payload.direction, payload.token, str(payload.operation_id)
            )
            return {
                "amount_in": result.amount_in,
                "amount_out": result.amount_out,
                "output_token": result.output_token,
                "pool": _snapshot(current(request)),
            }
        except OperationError as error:
            return _error_response(error)

    @app.post("/api/liquidity/redeem")
    async def redeem(payload: RedeemRequest, request: Request):
        try:
            result = await current(request).redeem(
                payload.lp_token, str(payload.operation_id)
            )
            return {
                "amounts": {
                    asset.value: amount for asset, amount in result.amounts.items()
                },
                "tokens": {
                    asset.value: token for asset, token in result.tokens.items()
                },
                "pool": _snapshot(current(request)),
            }
        except OperationError as error:
            return _error_response(error)

    @app.post("/api/mint/quote")
    async def mint_quote(payload: MintRequest, request: Request):
        try:
            result = await current(request).mint_quote(payload.asset, payload.amount)
            return {
                "asset": result.asset.value,
                "amount": result.amount,
                "quote_id": result.quote_id,
                "request": result.request,
            }
        except OperationError as error:
            return _error_response(error)

    @app.post("/api/mint")
    async def mint(payload: MintRequest, request: Request):
        if not payload.quote_id:
            return JSONResponse(
                status_code=422,
                content={"error": "quote_id is required after payment"},
            )
        try:
            result = await current(request).mint_paid(
                payload.asset, payload.amount, payload.quote_id
            )
            return {
                "asset": result.asset.value,
                "amount": result.amount,
                "quote_id": result.quote_id,
                "token": result.token,
            }
        except OperationError as error:
            return _error_response(error)

    site = Path(__file__).resolve().parent.parent

    @app.get("/", include_in_schema=False)
    async def index() -> FileResponse:
        return FileResponse(
            site / "index.html", headers={"Cache-Control": "no-store"}
        )

    @app.get("/app.js", include_in_schema=False)
    async def app_javascript() -> FileResponse:
        return FileResponse(site / "app.js", headers={"Cache-Control": "no-store"})

    @app.get("/styles.css", include_in_schema=False)
    async def stylesheet() -> FileResponse:
        return FileResponse(
            site / "styles.css", headers={"Cache-Control": "no-store"}
        )

    @app.get("/mints.js", include_in_schema=False)
    async def mint_javascript() -> FileResponse:
        return FileResponse(
            site / "mints.js", headers={"Cache-Control": "no-store"}
        )

    return app
