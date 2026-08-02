from __future__ import annotations

from types import SimpleNamespace

import pytest

from backend.nutshell import NutshellGateway
from backend.service import OperationError


class FakeWallet:
    def __init__(self) -> None:
        self.proofs = []

    async def load_mint(self) -> None: ...

    async def load_mint_keysets(self) -> None: ...

    async def load_proofs(self, reload: bool = False) -> None: ...

    def active_proofs(self, proofs):
        return proofs


@pytest.mark.asyncio
async def test_receive_rejects_token_from_another_mint(monkeypatch) -> None:
    wallet = FakeWallet()
    gateway = NutshellGateway(wallet, "https://sat.example", "sat")
    token = SimpleNamespace(mint="https://other.example", unit="sat")
    monkeypatch.setattr("cashu.wallet.helpers.deserialize_token_from_string", lambda _: token)

    with pytest.raises(OperationError, match="mint or unit"):
        await gateway.receive("cashuB-token")


@pytest.mark.asyncio
async def test_receive_returns_new_spendable_balance(monkeypatch) -> None:
    wallet = FakeWallet()
    gateway = NutshellGateway(wallet, "https://sat.example/", "sat")
    token = SimpleNamespace(mint="https://sat.example", unit="sat")
    monkeypatch.setattr("cashu.wallet.helpers.deserialize_token_from_string", lambda _: token)

    async def fake_receive(target, token_obj):
        target.proofs.append(SimpleNamespace(amount=42, reserved=False))

    monkeypatch.setattr("cashu.wallet.helpers.receive", fake_receive)
    assert await gateway.receive("cashuB-token") == 42
