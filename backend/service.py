from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Protocol
from uuid import uuid4

from .amm import (
    BPS,
    FEE_BPS,
    PoolState,
    quote_exact_in,
    redemption_amounts,
    shares_for_deposit,
    single_sided_deposit_quote,
)
from .idempotency import OperationResultStore
from .journal import OperationJournal

PROPORTION_TOLERANCE_BPS = 100
SWAP_QUOTE_LIFETIME_MS = 30_000


def _now_ms() -> int:
    return time.time_ns() // 1_000_000


class Asset(StrEnum):
    SAT = "sat"
    USD = "usd"
    LP = "lp"


class CashuGateway(Protocol):
    async def receive(self, token: str) -> int: ...

    async def send(self, amount: int) -> str: ...

    async def cancel(self, token: str) -> None: ...

    async def burn(self, amount: int) -> None: ...

    async def issue(self, amount: int) -> str: ...

    async def mint_quote(self, amount: int) -> dict[str, object]: ...

    async def mint_paid(self, amount: int, quote_id: str) -> str: ...


class OperationError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        refunds: dict[Asset, str] | None = None,
        refund_amounts: dict[Asset, int] | None = None,
        input_received: bool | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.refunds = refunds or {}
        self.refund_amounts = refund_amounts or {}
        self.input_received = input_received


@dataclass(frozen=True)
class DepositResult:
    shares: int
    lp_token: str


@dataclass(frozen=True)
class SingleDepositQuote:
    asset: Asset
    amount: int
    shares: int
    swapped: int
    counter_amount: int


@dataclass(frozen=True)
class SingleDepositResult(SingleDepositQuote):
    lp_token: str


@dataclass(frozen=True)
class SwapQuote:
    amount_in: int
    amount_out: int
    price_impact_bps: int
    quote_deadline_ms: int


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
        results: OperationResultStore | None = None,
    ) -> None:
        state.validate()
        self.sat_gateway = sat_gateway
        self.usd_gateway = usd_gateway
        self.share_gateway = share_gateway
        self.state = state
        self.persist = persist
        self.journal = journal
        self.results = results
        self._lock = asyncio.Lock()

    async def deposit(
        self,
        sat_token: str,
        usd_token: str,
        operation_id: str | None = None,
    ) -> DepositResult:
        async with self._lock:
            request = {"sat_token": sat_token, "usd_token": usd_token}
            cached = self._cached(operation_id, "deposit", request)
            if cached is not None:
                return DepositResult(
                    shares=int(cached["shares"]), lp_token=str(cached["lp_token"])
                )
            journal_id = self._begin("deposit", {"client_operation_id": operation_id})
            try:
                sat_amount = await self._receive(self.sat_gateway, sat_token)
            except Exception:
                self._reject(journal_id)
                raise
            self._update(journal_id, stage="sat_received", sat_amount=sat_amount)
            try:
                usd_amount = await self._receive(self.usd_gateway, usd_token)
                self._update(journal_id, stage="both_received", usd_amount=usd_amount)
            except Exception as error:
                refunds = await self._refund(self.sat_gateway, Asset.SAT, sat_amount)
                self._fail(journal_id, error, refunds)
                raise OperationError(
                    "deposit_usd_failed", str(error), refunds=refunds
                ) from error

            try:
                if self.state.shares:
                    sat_side = sat_amount * self.state.usd
                    usd_side = usd_amount * self.state.sat
                    imbalance = abs(sat_side - usd_side)
                    if (
                        imbalance * 10_000
                        > max(sat_side, usd_side) * PROPORTION_TOLERANCE_BPS
                    ):
                        raise ValueError(
                            "deposit must match the current pool proportion"
                        )
                shares = shares_for_deposit(self.state, sat_amount, usd_amount)
                lp_token = await self.share_gateway.issue(shares)
                self._update(journal_id, stage="lp_sent", shares=shares)
            except Exception as error:
                refunds = {}
                refunds.update(
                    await self._refund(self.sat_gateway, Asset.SAT, sat_amount)
                )
                refunds.update(
                    await self._refund(self.usd_gateway, Asset.USD, usd_amount)
                )
                self._fail(journal_id, error, refunds)
                raise OperationError(
                    "deposit_share_failed", str(error), refunds=refunds
                ) from error

            self.state = PoolState(
                sat=self.state.sat + sat_amount,
                usd=self.state.usd + usd_amount,
                shares=self.state.shares + shares,
                events=self._event("liquidity", f"{shares} LP emitted"),
            )
            await self._persist()
            result = DepositResult(shares=shares, lp_token=lp_token)
            self._store_result(
                operation_id,
                "deposit",
                request,
                {"shares": result.shares, "lp_token": result.lp_token},
            )
            self._complete(journal_id)
            return result

    async def quote_single_deposit(self, asset: str, amount: int) -> SingleDepositQuote:
        try:
            selected = Asset(asset)
        except ValueError as error:
            raise OperationError(
                "invalid_asset", "invalid single-sided input asset"
            ) from error
        if selected is Asset.LP or type(amount) is not int or amount <= 0:
            raise OperationError(
                "invalid_deposit_request", "invalid single-sided deposit"
            )
        async with self._lock:
            try:
                shares, swapped, counter_amount = single_sided_deposit_quote(
                    self.state, selected.value, amount
                )
            except ValueError as error:
                raise OperationError(
                    "single_deposit_unavailable", str(error)
                ) from error
            return SingleDepositQuote(
                asset=selected,
                amount=amount,
                shares=shares,
                swapped=swapped,
                counter_amount=counter_amount,
            )

    async def deposit_single(
        self, asset: str, token: str, operation_id: str | None = None
    ) -> SingleDepositResult:
        async with self._lock:
            try:
                selected = Asset(asset)
            except ValueError as error:
                raise OperationError(
                    "invalid_asset", "invalid single-sided input asset"
                ) from error
            if selected is Asset.LP:
                raise OperationError(
                    "invalid_asset", "LP cannot be deposited as a single-sided asset"
                )
            request = {"asset": selected.value, "token": token}
            cached = self._cached(operation_id, "deposit_single", request)
            if cached is not None:
                return SingleDepositResult(
                    asset=selected,
                    amount=int(cached["amount"]),
                    shares=int(cached["shares"]),
                    swapped=int(cached["swapped"]),
                    counter_amount=int(cached["counter_amount"]),
                    lp_token=str(cached["lp_token"]),
                )
            journal_id = self._begin(
                "deposit_single",
                {"asset": selected.value, "client_operation_id": operation_id},
            )
            gateway = self._gateway(selected)
            try:
                amount = await self._receive(gateway, token)
            except Exception:
                self._reject(journal_id)
                raise
            self._update(journal_id, stage="input_received", amount=amount)
            try:
                shares, swapped, counter_amount = single_sided_deposit_quote(
                    self.state, selected.value, amount
                )
                lp_token = await self.share_gateway.issue(shares)
                self._update(
                    journal_id,
                    stage="lp_sent",
                    shares=shares,
                    swapped=swapped,
                    counter_amount=counter_amount,
                )
            except Exception as error:
                refunds = await self._refund(gateway, selected, amount)
                self._fail(journal_id, error, refunds)
                raise OperationError(
                    "single_deposit_failed", str(error), refunds=refunds
                ) from error

            next_sat = (
                self.state.sat + amount if selected is Asset.SAT else self.state.sat
            )
            next_usd = (
                self.state.usd + amount if selected is Asset.USD else self.state.usd
            )
            self.state = PoolState(
                sat=next_sat,
                usd=next_usd,
                shares=self.state.shares + shares,
                events=self._event(
                    "liquidity",
                    f"{shares} LP emitted from {amount} "
                    f"{selected.value} single-sided deposit",
                ),
            )
            await self._persist()
            result = SingleDepositResult(
                asset=selected,
                amount=amount,
                shares=shares,
                swapped=swapped,
                counter_amount=counter_amount,
                lp_token=lp_token,
            )
            self._store_result(
                operation_id,
                "deposit_single",
                request,
                {
                    "asset": selected.value,
                    "amount": amount,
                    "shares": shares,
                    "swapped": swapped,
                    "counter_amount": counter_amount,
                    "lp_token": lp_token,
                },
            )
            self._complete(journal_id)
            return result

    async def quote_swap(self, direction: str, amount: int) -> SwapQuote:
        if direction not in {"sat-usd", "usd-sat"}:
            raise OperationError("invalid_direction", "invalid swap direction")
        if type(amount) is not int or amount <= 0:
            raise OperationError(
                "invalid_amount", "input amount must be a positive integer"
            )
        async with self._lock:
            reserve_in, reserve_out = (
                (self.state.sat, self.state.usd)
                if direction == "sat-usd"
                else (self.state.usd, self.state.sat)
            )
            try:
                amount_out, _, _ = quote_exact_in(reserve_in, reserve_out, amount)
            except ValueError as error:
                raise OperationError("swap_quote_unavailable", str(error)) from error
            # Relative to the fee-adjusted spot output: curvature and integer
            # rounding are included; the separately displayed AMM fee is excluded.
            spot_numerator = amount * (BPS - FEE_BPS) * reserve_out
            impact = (spot_numerator - amount_out * reserve_in * BPS) * BPS
            return SwapQuote(
                amount_in=amount,
                amount_out=amount_out,
                price_impact_bps=impact // spot_numerator,
                quote_deadline_ms=_now_ms() + SWAP_QUOTE_LIFETIME_MS,
            )

    async def swap(
        self,
        direction: str,
        token: str,
        operation_id: str | None = None,
        *,
        minimum_amount_out: int = 0,
        quote_deadline_ms: int | None = None,
    ) -> SwapResult:
        async with self._lock:
            if direction not in {"sat-usd", "usd-sat"}:
                raise OperationError("invalid_direction", "invalid swap direction")
            if type(minimum_amount_out) is not int or minimum_amount_out < 0:
                raise OperationError(
                    "invalid_minimum", "minimum output must be a non-negative integer"
                )
            if quote_deadline_ms is not None and (
                type(quote_deadline_ms) is not int or quote_deadline_ms < 0
            ):
                raise OperationError(
                    "invalid_deadline", "quote deadline must be Unix milliseconds"
                )
            request: dict[str, object] = {"direction": direction, "token": token}
            # Zero with no deadline preserves the identity of legacy completed
            # requests. Protected swaps include both constraints in their identity.
            if minimum_amount_out:
                request["minimum_amount_out"] = minimum_amount_out
            if quote_deadline_ms is not None:
                request["quote_deadline_ms"] = quote_deadline_ms
            cached = self._cached(operation_id, "swap", request)
            if cached is not None:
                if cached.get("failed"):
                    raise OperationError(
                        str(cached["code"]),
                        str(cached["message"]),
                        input_received=True,
                        refunds={
                            Asset(asset): str(value)
                            for asset, value in cached["refunds"].items()
                        },
                        refund_amounts={
                            Asset(asset): int(value)
                            for asset, value in cached["refund_amounts"].items()
                        },
                    )
                return SwapResult(
                    amount_in=int(cached["amount_in"]),
                    amount_out=int(cached["amount_out"]),
                    output_token=str(cached["output_token"]),
                )
            # A completed/refunded retry is replayed above even after its deadline.
            if quote_deadline_ms is not None and _now_ms() >= quote_deadline_ms:
                raise OperationError(
                    "quote_expired",
                    "quote expired; input token was not received",
                    input_received=False,
                )
            input_asset, output_asset = (
                (Asset.SAT, Asset.USD)
                if direction == "sat-usd"
                else (Asset.USD, Asset.SAT)
            )
            input_gateway = self._gateway(input_asset)
            output_gateway = self._gateway(output_asset)
            journal_id = self._begin(
                "swap",
                {
                    "direction": direction,
                    "client_operation_id": operation_id,
                    "minimum_amount_out": minimum_amount_out,
                    "quote_deadline_ms": quote_deadline_ms,
                },
            )
            try:
                amount_in = await self._receive(input_gateway, token)
            except Exception:
                self._reject(journal_id)
                raise
            self._update(journal_id, stage="input_received", amount_in=amount_in)
            reserve_in, reserve_out = self._reserves(input_asset, output_asset)
            try:
                if quote_deadline_ms is not None and _now_ms() >= quote_deadline_ms:
                    raise OperationError(
                        "quote_expired", "quote expired while receiving input"
                    )
                amount_out, next_in, next_out = quote_exact_in(
                    reserve_in, reserve_out, amount_in
                )
                if amount_out < minimum_amount_out:
                    raise OperationError(
                        "slippage_exceeded",
                        f"output {amount_out} is below minimum {minimum_amount_out}",
                    )
                output_token = await output_gateway.send(amount_out)
                self._update(
                    journal_id,
                    stage="output_sent",
                    amount_out=amount_out,
                    output_token=output_token,
                )
            except Exception as error:
                refunds = await self._refund(input_gateway, input_asset, amount_in)
                failed = OperationError(
                    error.code
                    if isinstance(error, OperationError)
                    and error.code in {"slippage_exceeded", "quote_expired"}
                    else "swap_output_failed",
                    str(error),
                    refunds=refunds,
                    refund_amounts={input_asset: amount_in} if refunds else {},
                    input_received=True,
                )
                # Persist compensating tokens before the response cache and do
                # not clear the recovery journal until the cache has been saved.
                self._fail(journal_id, failed, refunds, keep_pending=True)
                self._store_result(
                    operation_id,
                    "swap",
                    request,
                    {
                        "failed": True,
                        "code": failed.code,
                        "message": str(failed),
                        "refunds": {
                            asset.value: value for asset, value in refunds.items()
                        },
                        "refund_amounts": {
                            asset.value: value
                            for asset, value in failed.refund_amounts.items()
                        },
                    },
                )
                if refunds:
                    self._complete(journal_id, result="failed_refunded")
                raise failed from error

            self.state = self._replace_reserves(
                input_asset, output_asset, next_in, next_out
            )
            self.state = PoolState(
                sat=self.state.sat,
                usd=self.state.usd,
                shares=self.state.shares,
                events=self._event(
                    "swap", f"{amount_in} {input_asset} -> {amount_out} {output_asset}"
                ),
            )
            await self._persist()
            result = SwapResult(
                amount_in=amount_in, amount_out=amount_out, output_token=output_token
            )
            self._store_result(
                operation_id,
                "swap",
                request,
                {
                    "amount_in": result.amount_in,
                    "amount_out": result.amount_out,
                    "output_token": result.output_token,
                },
            )
            self._complete(journal_id)
            return result

    async def redeem(
        self, lp_token: str, operation_id: str | None = None
    ) -> RedeemResult:
        async with self._lock:
            request = {"lp_token": lp_token}
            cached = self._cached(operation_id, "redeem", request)
            if cached is not None:
                return RedeemResult(
                    amounts={
                        Asset.SAT: int(cached["amounts"][Asset.SAT.value]),
                        Asset.USD: int(cached["amounts"][Asset.USD.value]),
                    },
                    tokens={
                        Asset.SAT: str(cached["tokens"][Asset.SAT.value]),
                        Asset.USD: str(cached["tokens"][Asset.USD.value]),
                    },
                )
            journal_id = self._begin("redeem", {"client_operation_id": operation_id})
            try:
                shares = await self._receive(self.share_gateway, lp_token)
            except Exception:
                self._reject(journal_id)
                raise
            self._update(journal_id, stage="lp_received", shares=shares)
            sat_token: str | None = None
            usd_token: str | None = None
            try:
                sat_amount, usd_amount = redemption_amounts(self.state, shares)
                sat_token = await self.sat_gateway.send(sat_amount)
                self._update(
                    journal_id,
                    stage="sat_prepared",
                    sat_amount=sat_amount,
                    sat_token=sat_token,
                )
                usd_token = await self.usd_gateway.send(usd_amount)
                self._update(
                    journal_id,
                    stage="both_outputs_prepared",
                    usd_amount=usd_amount,
                    usd_token=usd_token,
                )
                await self.share_gateway.burn(shares)
                self._update(journal_id, stage="lp_burned")
            except Exception as error:
                outputs_cancelled = await self._cancel_redeem_outputs(
                    sat_token=sat_token,
                    usd_token=usd_token,
                )
                refunds = (
                    await self._refund(self.share_gateway, Asset.LP, shares)
                    if outputs_cancelled
                    else {}
                )
                self._fail(
                    journal_id,
                    error,
                    refunds,
                    keep_pending=not outputs_cancelled,
                )
                raise OperationError(
                    "redeem_output_failed", str(error), refunds=refunds
                ) from error

            self.state = PoolState(
                sat=self.state.sat - sat_amount,
                usd=self.state.usd - usd_amount,
                shares=self.state.shares - shares,
                events=self._event("redeem", f"{shares} LP redeemed"),
            )
            await self._persist()
            result = RedeemResult(
                amounts={Asset.SAT: sat_amount, Asset.USD: usd_amount},
                tokens={Asset.SAT: sat_token, Asset.USD: usd_token},
            )
            self._store_result(
                operation_id,
                "redeem",
                request,
                {
                    "amounts": {
                        Asset.SAT.value: sat_amount,
                        Asset.USD.value: usd_amount,
                    },
                    "tokens": {
                        Asset.SAT.value: sat_token,
                        Asset.USD.value: usd_token,
                    },
                },
            )
            self._complete(journal_id)
            return result

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
                return MintResult(
                    asset=selected,
                    amount=amount,
                    quote_id=str(quote["quote_id"]),
                    request=str(quote["request"]),
                )
            except OperationError:
                raise
            except Exception as error:
                raise OperationError("mint_quote_failed", str(error)) from error

    async def mint_paid(self, asset: str, amount: int, quote_id: str) -> MintResult:
        try:
            selected = Asset(asset)
        except ValueError as error:
            raise OperationError("invalid_asset", "invalid mint asset") from error
        if (
            selected is Asset.LP
            or type(amount) is not int
            or amount <= 0
            or not quote_id
        ):
            raise OperationError("invalid_mint_request", "invalid mint request")
        async with self._lock:
            gateway = self._gateway(selected)
            try:
                token = await gateway.mint_paid(amount, quote_id)
                return MintResult(
                    asset=selected,
                    amount=amount,
                    quote_id=quote_id,
                    request="",
                    token=token,
                )
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

    def _event(
        self, event_type: str, description: str
    ) -> tuple[dict[str, object], ...]:
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

    def _cached(
        self,
        operation_id: str | None,
        operation: str,
        payload: dict[str, object],
    ) -> dict[str, object] | None:
        if operation_id is None or self.results is None:
            return None
        try:
            return self.results.load(operation_id, operation, payload)
        except ValueError as error:
            raise OperationError("operation_id_conflict", str(error)) from error

    def _store_result(
        self,
        operation_id: str | None,
        operation: str,
        payload: dict[str, object],
        result: dict[str, object],
    ) -> None:
        if operation_id is None or self.results is None:
            return
        try:
            self.results.save(operation_id, operation, payload, result)
        except ValueError as error:
            raise OperationError("operation_id_conflict", str(error)) from error

    def _begin(self, operation: str, payload: dict[str, object]) -> str | None:
        if self.journal is None:
            return None
        if self.journal.pending():
            raise OperationError(
                "pool_recovery_required",
                "unfinished custody operation requires operator recovery",
            )
        return self.journal.begin(operation, payload)

    def _update(self, operation_id: str | None, **fields: object) -> None:
        if operation_id is not None and self.journal is not None:
            self.journal.update(operation_id, **fields)

    def _complete(self, operation_id: str | None, *, result: str = "committed") -> None:
        if operation_id is not None and self.journal is not None:
            self.journal.complete(operation_id, result=result)

    def _reject(self, operation_id: str | None) -> None:
        if operation_id is not None and self.journal is not None:
            self.journal.complete(operation_id, result="rejected")

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

    async def _cancel_redeem_outputs(
        self,
        *,
        sat_token: str | None,
        usd_token: str | None,
    ) -> bool:
        try:
            if usd_token is not None:
                await self.usd_gateway.cancel(usd_token)
            if sat_token is not None:
                await self.sat_gateway.cancel(sat_token)
            return True
        except Exception:
            return False
