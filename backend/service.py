from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Protocol
from uuid import uuid4

from .amm import PoolState, quote_exact_in, redemption_amounts, shares_for_deposit
from .journal import OperationJournal


class Asset(StrEnum):
    SAT = "sat"
    USD = "usd"
    LP = "lp"


class CashuGateway(Protocol):
    async def receive(self, token: str) -> int: ...

    async def send(self, amount: int) -> str: ...

    async def burn(self, amount: int) -> None: ...

    async def mint_quote(self, amount: int) -> dict[str, object]: ...

    async def mint_paid(self, amount: int, quote_id: str) -> str: ...


class OperationError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        refunds: dict[Asset, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.refunds = refunds or {}


@dataclass(frozen=True)
class DepositResult:
    shares: int
    lp_token: str


@dataclass(frozen=True)
class SwapResult:
    amount_in: int
    amount_out: int
    output_token: str


@dataclass(frozen=True)
class RedeemResult:
    amounts: dict[Asset, int]
    tokens: dict[Asset, str]


@dataclass(frozen=True)
class MintResult:
    asset: Asset
    amount: int
    quote_id: str
    request: str
    token: str | None = None


class PoolService:
    def __init__(
        self,
        *,
        sat_gateway: CashuGateway,
        usd_gateway: CashuGateway,
        share_gateway: CashuGateway,
        state: PoolState,
        persist: object | None = None,
        journal: OperationJournal | None = None,
    ) -> None:
        state.validate()
        self.sat_gateway = sat_gateway
        self.usd_gateway = usd_gateway
        self.share_gateway = share_gateway
        self.state = state
        self.persist = persist
        self.journal = journal
        self._lock = asyncio.Lock()

    async def deposit(self, sat_token: str, usd_token: str) -> DepositResult:
        async with self._lock:
            operation_id = self._begin("deposit", {})
            sat_amount = await self._receive(self.sat_gateway, sat_token)
            self._update(operation_id, stage="sat_received", sat_amount=sat_amount)
            try:
                usd_amount = await self._receive(self.usd_gateway, usd_token)
                self._update(operation_id, stage="both_received", usd_amount=usd_amount)
            except Exception as error:
                refunds = await self._refund(self.sat_gateway, Asset.SAT, sat_amount)
                self._fail(operation_id, error, refunds)
                raise OperationError("deposit_usd_failed", str(error), refunds=refunds) from error

            try:
                shares = shares_for_deposit(self.state, sat_amount, usd_amount)
                lp_token = await self.share_gateway.send(shares)
                self._update(operation_id, stage="lp_sent", shares=shares)
            except Exception as error:
                refunds = {}
                refunds.update(await self._refund(self.sat_gateway, Asset.SAT, sat_amount))
                refunds.update(await self._refund(self.usd_gateway, Asset.USD, usd_amount))
                self._fail(operation_id, error, refunds)
                raise OperationError("deposit_share_failed", str(error), refunds=refunds) from error

            self.state = PoolState(
                sat=self.state.sat + sat_amount,
                usd=self.state.usd + usd_amount,
                shares=self.state.shares + shares,
                events=self._event("liquidity", f"{shares} LP emitted"),
            )
            await self._persist()
            self._complete(operation_id)
            return DepositResult(shares=shares, lp_token=lp_token)

    async def swap(self, direction: str, token: str) -> SwapResult:
        async with self._lock:
            if direction not in {"sat-usd", "usd-sat"}:
                raise OperationError("invalid_direction", "invalid swap direction")
            input_asset, output_asset = (
                (Asset.SAT, Asset.USD) if direction == "sat-usd" else (Asset.USD, Asset.SAT)
            )
            input_gateway = self._gateway(input_asset)
            output_gateway = self._gateway(output_asset)
            operation_id = self._begin("swap", {"direction": direction})
            amount_in = await self._receive(input_gateway, token)
            self._update(operation_id, stage="input_received", amount_in=amount_in)
            reserve_in, reserve_out = self._reserves(input_asset, output_asset)
            try:
                amount_out, next_in, next_out = quote_exact_in(reserve_in, reserve_out, amount_in)
                output_token = await output_gateway.send(amount_out)
                self._update(operation_id, stage="output_sent", amount_out=amount_out)
            except Exception as error:
                refunds = await self._refund(input_gateway, input_asset, amount_in)
                self._fail(operation_id, error, refunds)
                raise OperationError("swap_output_failed", str(error), refunds=refunds) from error

            self.state = self._replace_reserves(input_asset, output_asset, next_in, next_out)
            self.state = PoolState(
                sat=self.state.sat,
                usd=self.state.usd,
                shares=self.state.shares,
                events=self._event("swap", f"{amount_in} {input_asset} -> {amount_out} {output_asset}"),
            )
            await self._persist()
            self._complete(operation_id)
            return SwapResult(amount_in=amount_in, amount_out=amount_out, output_token=output_token)

    async def redeem(self, lp_token: str) -> RedeemResult:
        async with self._lock:
            operation_id = self._begin("redeem", {})
            shares = await self._receive(self.share_gateway, lp_token)
            self._update(operation_id, stage="lp_received", shares=shares)
            sat_token: str | None = None
            try:
                sat_amount, usd_amount = redemption_amounts(self.state, shares)
                sat_token = await self.sat_gateway.send(sat_amount)
                self._update(operation_id, stage="sat_sent", sat_amount=sat_amount)
                usd_token = await self.usd_gateway.send(usd_amount)
                self._update(operation_id, stage="both_outputs_sent", usd_amount=usd_amount)
                await self.share_gateway.burn(shares)
                self._update(operation_id, stage="lp_burned")
            except Exception as error:
                refunds = await self._refund(self.share_gateway, Asset.LP, shares)
                self._fail(operation_id, error, refunds, keep_pending=True if sat_token is not None else False)
                raise OperationError("redeem_output_failed", str(error), refunds=refunds) from error

            self.state = PoolState(
                sat=self.state.sat - sat_amount,
                usd=self.state.usd - usd_amount,
                shares=self.state.shares - shares,
                events=self._event("redeem", f"{shares} LP redeemed"),
            )
            await self._persist()
            self._complete(operation_id)
            return RedeemResult(
                amounts={Asset.SAT: sat_amount, Asset.USD: usd_amount},
                tokens={Asset.SAT: sat_token, Asset.USD: usd_token},
            )

    async def mint_quote(self, asset: str, amount: int) -> MintResult:
        try:
            selected = Asset(asset)
        except ValueError as error:
            raise OperationError("invalid_asset", "invalid mint asset") from error
        if selected is Asset.LP or type(amount) is not int or amount <= 0:
            raise OperationError("invalid_mint_request", "invalid mint amount")
        async with self._lock:
            gateway = self._gateway(selected)
            try:
                quote = await gateway.mint_quote(amount)
                return MintResult(asset=selected, amount=amount, quote_id=str(quote["quote_id"]), request=str(quote["request"]))
            except OperationError:
                raise
            except Exception as error:
                raise OperationError("mint_quote_failed", str(error)) from error

    async def mint_paid(self, asset: str, amount: int, quote_id: str) -> MintResult:
        try:
            selected = Asset(asset)
        except ValueError as error:
            raise OperationError("invalid_asset", "invalid mint asset") from error
        if selected is Asset.LP or type(amount) is not int or amount <= 0 or not quote_id:
            raise OperationError("invalid_mint_request", "invalid mint request")
        async with self._lock:
            gateway = self._gateway(selected)
            try:
                token = await gateway.mint_paid(amount, quote_id)
                return MintResult(asset=selected, amount=amount, quote_id=quote_id, request="", token=token)
            except OperationError:
                raise
            except Exception as error:
                raise OperationError("mint_failed", str(error)) from error

    def _gateway(self, asset: Asset) -> CashuGateway:
        return {
            Asset.SAT: self.sat_gateway,
            Asset.USD: self.usd_gateway,
            Asset.LP: self.share_gateway,
        }[asset]

    def _reserves(self, input_asset: Asset, output_asset: Asset) -> tuple[int, int]:
        values = {Asset.SAT: self.state.sat, Asset.USD: self.state.usd}
        return values[input_asset], values[output_asset]

    def _replace_reserves(
        self,
        input_asset: Asset,
        output_asset: Asset,
        next_in: int,
        next_out: int,
    ) -> PoolState:
        values = {Asset.SAT: self.state.sat, Asset.USD: self.state.usd}
        values[input_asset] = next_in
        values[output_asset] = next_out
        return PoolState(
            sat=values[Asset.SAT],
            usd=values[Asset.USD],
            shares=self.state.shares,
            events=self.state.events,
        )

    def _event(self, event_type: str, description: str) -> tuple[dict[str, object], ...]:
        event = {
            "id": str(uuid4()),
            "time": datetime.now(UTC).isoformat(),
            "type": event_type,
            "description": description,
        }
        return (*self.state.events, event)[-100:]

    async def _persist(self) -> None:
        if self.persist is not None:
            result = self.persist(self.state)
            if hasattr(result, "__await__"):
                await result

    def _begin(self, operation: str, payload: dict[str, object]) -> str | None:
        if self.journal is None:
            return None
        return self.journal.begin(operation, payload)

    def _update(self, operation_id: str | None, **fields: object) -> None:
        if operation_id is not None and self.journal is not None:
            self.journal.update(operation_id, **fields)

    def _complete(self, operation_id: str | None) -> None:
        if operation_id is not None and self.journal is not None:
            self.journal.complete(operation_id)

    def _fail(
        self,
        operation_id: str | None,
        error: Exception,
        refunds: dict[Asset, str],
        *,
        keep_pending: bool = False,
    ) -> None:
        if operation_id is None or self.journal is None:
            return
        self.journal.update(
            operation_id,
            stage="failed",
            error=str(error),
            refunds={asset.value: token for asset, token in refunds.items()},
        )
        if refunds and not keep_pending:
            self.journal.complete(operation_id, result="failed_refunded")

    @staticmethod
    async def _receive(gateway: CashuGateway, token: str) -> int:
        try:
            amount = await gateway.receive(token)
        except OperationError:
            raise
        except Exception as error:
            raise OperationError("receive_failed", str(error)) from error
        if type(amount) is not int or amount <= 0:
            raise OperationError("receive_failed", "gateway returned an invalid amount")
        return amount

    @staticmethod
    async def _refund(
        gateway: CashuGateway,
        asset: Asset,
        amount: int,
    ) -> dict[Asset, str]:
        try:
            return {asset: await gateway.send(amount)}
        except Exception:
            return {}
