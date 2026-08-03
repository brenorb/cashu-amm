from __future__ import annotations

from dataclasses import dataclass, field

import pytest

from backend.journal import OperationJournal
from backend.idempotency import OperationResultStore
from backend.service import (
    Asset,
    CashuGateway,
    OperationError,
    PoolService,
    PoolState,
)


@dataclass
class FakeGateway(CashuGateway):
    received: dict[str, int] = field(default_factory=dict)
    sent: list[int] = field(default_factory=list)
    fail_receive: bool = False
    fail_send: bool = False
    issued: list[int] = field(default_factory=list)
    cancelled: list[str] = field(default_factory=list)
    fail_cancel: bool = False

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

    async def cancel(self, token: str) -> None:
        if self.fail_cancel:
            raise OperationError("cancel_failed", "gateway could not cancel token")
        self.cancelled.append(token)

    async def burn(self, amount: int) -> None:
        self.sent.append(-amount)

    async def issue(self, amount: int) -> str:
        self.issued.append(amount)
        return f"cashuB-fake-issued-{amount}"


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
    assert result.lp_token == "cashuB-fake-issued-22360"
    assert share.issued == [22_360]
    assert pool.state.sat == 1_100_000
    assert pool.state.usd == 55_000
    assert pool.state.shares == 245_966
    assert pool.state.events[-1]["type"] == "liquidity"
    assert sat.sent == []
    assert usd.sent == []


@pytest.mark.asyncio
async def test_deposit_refunds_first_asset_if_second_asset_fails() -> None:
    pool, _sat, usd, _ = service()
    usd.fail_receive = True

    with pytest.raises(OperationError, match="gateway refused token") as error:
        await pool.deposit("sat-token", "usd-token")

    assert error.value.refunds == {Asset.SAT: "cashuB-fake-100000"}
    assert pool.state == PoolState(sat=1_000_000, usd=50_000, shares=223_606)


@pytest.mark.asyncio
async def test_first_deposit_initializes_pool_and_issues_geometric_lp() -> None:
    sat = FakeGateway(received={"sat-seed": 1_000_000})
    usd = FakeGateway(received={"usd-seed": 50_000})
    share = FakeGateway()
    pool = PoolService(
        sat_gateway=sat,
        usd_gateway=usd,
        share_gateway=share,
        state=PoolState(sat=0, usd=0, shares=0),
    )

    result = await pool.deposit("sat-seed", "usd-seed")

    assert result.shares == 223_606
    assert share.issued == [223_606]
    assert pool.state == PoolState(
        sat=1_000_000,
        usd=50_000,
        shares=223_606,
        events=pool.state.events,
    )


@pytest.mark.asyncio
async def test_unbalanced_deposit_is_refunded_instead_of_donating_excess() -> None:
    pool, _sat, usd, share = service()
    usd.received["tiny-usd"] = 1

    with pytest.raises(OperationError, match="proportion") as error:
        await pool.deposit("sat-token", "tiny-usd")

    assert error.value.refunds == {
        Asset.SAT: "cashuB-fake-100000",
        Asset.USD: "cashuB-fake-1",
    }
    assert share.issued == []
    assert pool.state == PoolState(sat=1_000_000, usd=50_000, shares=223_606)


@pytest.mark.asyncio
async def test_small_cashu_fee_imbalance_is_accepted() -> None:
    pool, sat, usd, share = service()
    sat.received["fee-sat"] = 20_000
    usd.received["fee-usd"] = 999

    result = await pool.deposit("fee-sat", "fee-usd")

    assert result.shares > 0
    assert share.issued == [result.shares]


@pytest.mark.asyncio
async def test_swap_receives_input_and_sends_output_after_quote() -> None:
    pool, _sat, usd, _ = service()

    result = await pool.swap("sat-usd", "sat-token")

    assert result.amount_in == 100_000
    assert result.amount_out == 4_504
    assert result.output_token == "cashuB-fake-4504"
    assert usd.sent == [4_504]
    assert pool.state.sat == 1_100_000
    assert pool.state.usd == 45_496


@pytest.mark.asyncio
async def test_swap_refunds_input_when_output_token_cannot_be_created() -> None:
    pool, _sat, usd, _ = service()
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
async def test_redeem_refunds_lp_if_rounding_would_zero_an_asset() -> None:
    sat = FakeGateway()
    usd = FakeGateway()
    share = FakeGateway(received={"tiny-lp": 1})
    pool = PoolService(
        sat_gateway=sat,
        usd_gateway=usd,
        share_gateway=share,
        state=PoolState(sat=1_000_000, usd=1, shares=10),
    )

    with pytest.raises(OperationError, match="too small") as error:
        await pool.redeem("tiny-lp")

    assert error.value.refunds == {Asset.LP: "cashuB-fake-1"}
    assert sat.sent == []
    assert usd.sent == []


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
async def test_redeem_cancels_prepared_output_and_refunds_lp(tmp_path) -> None:
    pool, sat, usd, share, journal = journal_service(tmp_path)
    usd.fail_send = True

    with pytest.raises(OperationError, match="could not create token"):
        await pool.redeem("lp-token")

    assert sat.sent == [99_997]
    assert sat.cancelled == ["cashuB-fake-99997"]
    assert share.sent == [22_360]
    assert journal.pending() == []
    assert pool.state.shares == 223_606


@pytest.mark.asyncio
async def test_redeem_stays_pending_if_prepared_output_cannot_be_cancelled(
    tmp_path,
) -> None:
    pool, sat, usd, share, journal = journal_service(tmp_path)
    usd.fail_send = True
    sat.fail_cancel = True

    with pytest.raises(OperationError) as error:
        await pool.redeem("lp-token")

    assert error.value.refunds == {}
    assert share.sent == []
    assert len(journal.pending()) == 1


@pytest.mark.asyncio
async def test_rejected_input_does_not_poison_restart_journal(tmp_path) -> None:
    pool, _, _, _, journal = journal_service(tmp_path)

    with pytest.raises(OperationError, match="not available"):
        await pool.swap("sat-usd", "invalid-token")

    assert journal.pending() == []


@pytest.mark.asyncio
async def test_deposit_retry_returns_same_lp_without_mutating_pool_twice(
    tmp_path,
) -> None:
    pool, _sat, _usd, share = service()
    pool.results = OperationResultStore(tmp_path / "completed")
    operation_id = "123e4567-e89b-12d3-a456-426614174000"

    first = await pool.deposit("sat-token", "usd-token", operation_id)
    state_after_first = pool.state
    retry = await pool.deposit("sat-token", "usd-token", operation_id)

    assert retry == first
    assert pool.state == state_after_first
    assert share.issued == [22_360]


@pytest.mark.asyncio
async def test_operation_id_cannot_be_reused_with_different_payload(tmp_path) -> None:
    pool, sat, _usd, _share = service()
    pool.results = OperationResultStore(tmp_path / "completed")
    operation_id = "123e4567-e89b-12d3-a456-426614174000"
    await pool.swap("sat-usd", "sat-token", operation_id)
    sat.received["another-token"] = 10_000

    with pytest.raises(OperationError) as error:
        await pool.swap("sat-usd", "another-token", operation_id)

    assert error.value.code == "operation_id_conflict"
