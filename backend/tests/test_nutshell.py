from __future__ import annotations

from types import SimpleNamespace

import pytest

from backend.nutshell import NutshellGateway
from backend.service import OperationError


class FakeWallet:
    def __init__(self) -> None:
        self.proofs = []
        self.mint_calls = []

    async def load_mint(self) -> None: ...

    async def load_mint_keysets(self) -> None: ...

    async def load_proofs(self, reload: bool = False) -> None: ...

    def active_proofs(self, proofs):
        return proofs

    async def request_mint(self, amount, memo=None):
        return SimpleNamespace(quote=f"lp-{amount}")

    async def get_mint_quote(self, quote_id):
        return SimpleNamespace(paid=True)

    async def mint(self, amount, quote_id, split=None):
        self.mint_calls.append((amount, quote_id, split))
        proofs = [
            SimpleNamespace(
                amount=amount,
                reserved=False,
                mint_id=quote_id,
                secret=f"secret-{quote_id}",
            )
        ]
        self.proofs.extend(proofs)
        return proofs

    async def select_to_send(self, proofs, amount, **kwargs):
        selected = [next(proof for proof in proofs if proof.amount == amount)]
        if kwargs.get("set_reserved"):
            for proof in selected:
                proof.reserved = True
        return selected, 0

    async def set_reserved_for_send(self, proofs, reserved):
        for proof in proofs:
            proof.reserved = reserved

    async def serialize_proofs(self, proofs, include_dleq=False):
        return f"cashuB-lp-{sum(proof.amount for proof in proofs)}"


@pytest.mark.asyncio
async def test_receive_rejects_token_from_another_mint(monkeypatch) -> None:
    wallet = FakeWallet()
    gateway = NutshellGateway(wallet, "https://sat.example", "sat")
    token = SimpleNamespace(mint="https://other.example", unit="sat")
    monkeypatch.setattr(
        "cashu.wallet.helpers.deserialize_token_from_string", lambda _: token
    )

    with pytest.raises(OperationError, match="mint or unit"):
        await gateway.receive("cashuB-token")


@pytest.mark.asyncio
async def test_receive_returns_new_spendable_balance(monkeypatch) -> None:
    wallet = FakeWallet()
    gateway = NutshellGateway(wallet, "https://sat.example/", "sat")
    token = SimpleNamespace(mint="https://sat.example", unit="sat")
    monkeypatch.setattr(
        "cashu.wallet.helpers.deserialize_token_from_string", lambda _: token
    )

    async def fake_receive(target, token_obj):
        target.proofs.append(SimpleNamespace(amount=42, reserved=False))

    monkeypatch.setattr("cashu.wallet.helpers.receive", fake_receive)
    assert await gateway.receive("cashuB-token") == 42


@pytest.mark.asyncio
async def test_issue_uses_nutshell_mint_and_not_preseeded_inventory() -> None:
    wallet = FakeWallet()
    gateway = NutshellGateway(wallet, "http://127.0.0.1:3338", "sat")

    token = await gateway.issue(22_360)

    assert token == "cashuB-lp-22360"
    assert wallet.mint_calls == [(22_360, "lp-22360", None)]


@pytest.mark.asyncio
async def test_mint_paid_can_return_the_same_issued_quote_again() -> None:
    wallet = FakeWallet()
    gateway = NutshellGateway(wallet, "https://testnut.example", "sat")

    first = await gateway.mint_paid(1_000, "quote-1")
    second = await gateway.mint_paid(1_000, "quote-1")

    assert first == second == "cashuB-lp-1000"
    assert wallet.mint_calls == [(1_000, "quote-1", None)]
