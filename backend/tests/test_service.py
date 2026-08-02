from __future__ import annotations

from dataclasses import dataclass, field

import pytest

from backend.service import (
    Asset,
    CashuGateway,
    OperationError,
    PoolService,
    PoolState,
)
from backend.journal import OperationJournal


@dataclass
class FakeGateway(CashuGateway):
    received: dict[str, int] = field(default_factory=dict)
    sent: list[int] = field(default_factory=list)
    fail_receive: bool = False
    fail_send: bool = False

    async def mint_quote(self, amount: int) -> dict[str, object]:
        return {"quote_id": f"quote-{amount}", "request": f"lnbc-{amount}"}

    async def mint_paid(self, amount: int, quote_id: str) -> str:
        return f"cashuB-fake-minted-{amount}-{quote_id}"

    async def receive(self, token: str) -> int:
        if self.fail_receive:
            raise OperationError("receive_failed", "gateway refused token")
        if token not in self.received:
            raise OperationError("unknown_token", "token is not available")
        return self.received[token]

    async def send(self, amount: int) -> str:
        if self.fail_send:
            raise OperationError("send_failed", "gateway could not create token")
        self.sent.append(amount)
        return f"cashuB-fake-{amount}"

    async def burn(self, amount: int) -> None:
        self.sent.append(-amount)


def service() -> tuple[PoolService, FakeGateway, FakeGateway, FakeGateway]:
    sat = FakeGateway(received={"sat-token": 100_000})
    usd = FakeGateway(received={"usd-token": 5_000})
    share = FakeGateway()
    pool = PoolService(
        sat_gateway=sat,
        usd_gateway=usd,
        share_gateway=share,
        state=PoolState(sat=1_000_000, usd=50_000, shares=223_606),
    )
    return pool, sat, usd, share


def journal_service(tmp_path):
    sat = FakeGateway()
    usd = FakeGateway()
    share = FakeGateway(received={"lp-token": 22_360})
    journal = OperationJournal(tmp_path / "pending")
    pool = PoolService(
        sat_gateway=sat,
        usd_gateway=usd,
        share_gateway=share,
        state=PoolState(sat=1_000_000, usd=50_000, shares=223_606),
        journal=journal,
    )
    return pool, sat, usd, share, journal


@pytest.mark.asyncio
async def test_deposit_receives_real_asset_tokens_and_returns_lp_token() -> None:
    pool, sat, usd, share = service()

    result = await pool.deposit("sat-token", "usd-token")

    assert result.shares == 22_360
    assert result.lp_token == "cashuB-fake-22360"
    assert share.sent == [22_360]
    assert pool.state.sat == 1_100_000
    assert pool.state.usd == 55_000
    assert pool.state.shares == 245_966
    assert pool.state.events[-1]["type"] == "liquidity"
    assert sat.sent == []
    assert usd.sent == []


@pytest.mark.asyncio
async def test_deposit_refunds_first_asset_if_second_asset_fails() -> None:
    pool, sat, usd, _ = service()
    usd.fail_receive = True

    with pytest.raises(OperationError, match="gateway refused token") as error:
        await pool.deposit("sat-token", "usd-token")

    assert error.value.refunds == {Asset.SAT: "cashuB-fake-100000"}
    assert pool.state == PoolState(sat=1_000_000, usd=50_000, shares=223_606)


@pytest.mark.asyncio
async def test_swap_receives_input_and_sends_output_after_quote() -> None:
    pool, sat, usd, _ = service()

    result = await pool.swap("sat-usd", "sat-token")

    assert result.amount_in == 100_000
    assert result.amount_out == 4_504
    assert result.output_token == "cashuB-fake-4504"
    assert usd.sent == [4_504]
    assert pool.state.sat == 1_100_000
    assert pool.state.usd == 45_496


@pytest.mark.asyncio
async def test_swap_refunds_input_when_output_token_cannot_be_created() -> None:
    pool, sat, usd, _ = service()
    usd.fail_send = True

    with pytest.raises(OperationError) as error:
        await pool.swap("sat-usd", "sat-token")

    assert error.value.refunds == {Asset.SAT: "cashuB-fake-100000"}
    assert pool.state == PoolState(sat=1_000_000, usd=50_000, shares=223_606)


@pytest.mark.asyncio
async def test_redeem_receives_lp_and_sends_both_underlying_assets() -> None:
    pool, sat, usd, share = service()
    share.received["lp-token"] = 22_360

    result = await pool.redeem("lp-token")

    assert result.amounts == {Asset.SAT: 99_997, Asset.USD: 4_999}
    assert result.tokens == {
        Asset.SAT: "cashuB-fake-99997",
        Asset.USD: "cashuB-fake-4999",
    }
    assert sat.sent == [99_997]
    assert usd.sent == [4_999]
    assert share.sent == [-22_360]
    assert pool.state.sat == 900_003
    assert pool.state.usd == 45_001
    assert pool.state.shares == 201_246
    assert pool.state.events[-1]["type"] == "redeem"


@pytest.mark.asyncio
async def test_invalid_direction_does_not_touch_gateways_or_state() -> None:
    pool, sat, usd, _ = service()

    with pytest.raises(OperationError, match="direction"):
        await pool.swap("eur-gbp", "sat-token")

    assert sat.sent == []
    assert usd.sent == []
    assert pool.state == PoolState(sat=1_000_000, usd=50_000, shares=223_606)


@pytest.mark.asyncio
async def test_mint_quote_and_paid_quote_return_real_token_boundary() -> None:
    pool, _, _, _ = service()

    quote = await pool.mint_quote("sat", 10_000)
    token = await pool.mint_paid("sat", 10_000, quote.quote_id)

    assert quote.quote_id == "quote-10000"
    assert quote.request == "lnbc-10000"
    assert token.token == "cashuB-fake-minted-10000-quote-10000"


@pytest.mark.asyncio
async def test_redeem_keeps_journal_pending_if_one_output_was_already_sent(tmp_path) -> None:
    pool, sat, usd, share, journal = journal_service(tmp_path)
    usd.fail_send = True

    with pytest.raises(OperationError, match="could not create token"):
        await pool.redeem("lp-token")

    assert sat.sent == [99_997]
    assert share.sent == [22_360]
    assert len(journal.pending()) == 1
    assert pool.state.shares == 223_606
