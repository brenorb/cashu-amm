from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from .service import CashuGateway, OperationError


def _unit_name(value: object) -> str:
    raw = getattr(value, "value", None)
    if not isinstance(raw, str):
        raw = getattr(value, "name", value)
    return raw.strip().lower() if isinstance(raw, str) else ""


@dataclass(slots=True)
class NutshellGateway(CashuGateway):
    """Cashu gateway backed by a persistent Nutshell ``Wallet``."""

    wallet: Any
    mint_url: str
    unit: str

    def __post_init__(self) -> None:
        self.mint_url = self.mint_url.rstrip("/")
        self.unit = self.unit.strip().lower()
        if not self.mint_url or not self.unit:
            raise ValueError("mint URL and unit are required")

    @classmethod
    async def open(
        cls, mint_url: str, db_path: str, name: str, unit: str
    ) -> NutshellGateway:
        from cashu.wallet.wallet import Wallet

        wallet = await Wallet.with_db(mint_url, db_path, name, unit=unit)
        await wallet.load_mint()
        await wallet.load_proofs(reload=True)
        return cls(wallet=wallet, mint_url=mint_url, unit=unit)

    async def receive(self, token: str) -> int:
        from cashu.wallet.helpers import deserialize_token_from_string, receive

        try:
            token_obj = deserialize_token_from_string(token)
            token_mint = str(getattr(token_obj, "mint", "")).rstrip("/")
            token_unit = _unit_name(getattr(token_obj, "unit", ""))
            if token_mint != self.mint_url or token_unit != self.unit:
                raise ValueError("Cashu token mint or unit does not match gateway")
            before = self._available_balance()
            await self.wallet.load_mint()
            await self.wallet.load_mint_keysets()
            await receive(self.wallet, token_obj)
            await self.wallet.load_proofs(reload=True)
            amount = self._available_balance() - before
            if amount <= 0:
                raise ValueError("Cashu receive produced no spendable balance")
            return amount
        except OperationError:
            raise
        except Exception as error:
            raise OperationError("cashu_receive_failed", str(error)) from error

    async def send(self, amount: int) -> str:
        send_proofs = []
        try:
            if type(amount) is not int or amount <= 0:
                raise ValueError("Cashu send amount must be positive")
            await self.wallet.load_mint()
            await self.wallet.load_proofs(reload=True)
            proofs = self.wallet.active_proofs(self.wallet.proofs)
            send_proofs, _ = await self.wallet.select_to_send(
                proofs,
                amount,
                set_reserved=True,
                include_fees=False,
            )
            if sum(proof.amount for proof in send_proofs) != amount:
                raise ValueError("Nutshell did not produce the exact output amount")
            return await self.wallet.serialize_proofs(send_proofs, include_dleq=True)
        except OperationError:
            raise
        except Exception as error:
            if send_proofs:
                await self.wallet.set_reserved_for_send(send_proofs, reserved=False)
                await self.wallet.load_proofs(reload=True)
            raise OperationError("cashu_send_failed", str(error)) from error

    async def cancel(self, token: str) -> None:
        """Release a token prepared by this wallet but not delivered to a user."""
        from cashu.wallet.helpers import deserialize_token_from_string

        try:
            token_obj = deserialize_token_from_string(token)
            token_mint = str(getattr(token_obj, "mint", "")).rstrip("/")
            token_unit = _unit_name(getattr(token_obj, "unit", ""))
            if token_mint != self.mint_url or token_unit != self.unit:
                raise ValueError("Cashu token mint or unit does not match gateway")
            await self.wallet.load_proofs(reload=True)
            secrets = {proof.secret for proof in token_obj.proofs}
            proofs = [proof for proof in self.wallet.proofs if proof.secret in secrets]
            if len(proofs) != len(secrets) or any(
                not proof.reserved for proof in proofs
            ):
                raise ValueError("Cashu token is not a pending send from this wallet")
            await self.wallet.set_reserved_for_send(proofs, reserved=False)
            await self.wallet.load_proofs(reload=True)
        except OperationError:
            raise
        except Exception as error:
            raise OperationError("cashu_cancel_failed", str(error)) from error

    async def burn(self, amount: int) -> None:
        """Consume LP proofs locally after a redemption is fully delivered.

        Cashu has no native ``burn`` primitive.  Invalidating the selected
        proofs in the operator wallet makes redeemed LP units unavailable for a
        later send while keeping this PoC's LP supply accounting explicit.
        """
        try:
            if type(amount) is not int or amount <= 0:
                raise ValueError("Cashu burn amount must be positive")
            await self.wallet.load_proofs(reload=True)
            proofs = self.wallet.active_proofs(self.wallet.proofs)
            burn_proofs, _ = await self.wallet.select_to_send(
                proofs,
                amount,
                set_reserved=True,
                include_fees=False,
            )
            if sum(proof.amount for proof in burn_proofs) != amount:
                raise ValueError("Nutshell did not select the exact LP amount to burn")
            await self.wallet.invalidate(burn_proofs)
        except OperationError:
            raise
        except Exception as error:
            raise OperationError("cashu_burn_failed", str(error)) from error

    async def issue(self, amount: int) -> str:
        """Issue LP from the private loopback Nutshell mint."""
        try:
            quote = await self.wallet.request_mint(amount, memo="Cashu AMM LP")
            for _ in range(50):
                current = await self.wallet.get_mint_quote(str(quote.quote))
                if current.paid:
                    break
                await asyncio.sleep(0.1)
            else:
                raise TimeoutError("LP mint quote was not paid by the local mint")
            proofs = await self.wallet.mint(amount, quote_id=str(quote.quote))
            return await self._serialize_new_proofs(proofs, amount)
        except OperationError:
            raise
        except Exception as error:
            raise OperationError("cashu_issue_failed", str(error)) from error

    async def mint_quote(self, amount: int) -> dict[str, object]:
        try:
            quote = await self.wallet.request_mint(amount)
            return {
                "quote_id": str(quote.quote),
                "request": str(quote.request),
                "amount": int(amount),
            }
        except Exception as error:
            raise OperationError("cashu_mint_quote_failed", str(error)) from error

    async def mint_paid(self, amount: int, quote_id: str) -> str:
        try:
            await self.wallet.load_proofs(reload=True)
            proofs = [
                proof
                for proof in self.wallet.proofs
                if getattr(proof, "mint_id", None) == quote_id
            ]
            if not proofs:
                proofs = await self.wallet.mint(amount, quote_id=quote_id)
            return await self._serialize_new_proofs(proofs, amount)
        except OperationError:
            raise
        except Exception as error:
            raise OperationError("cashu_mint_failed", str(error)) from error

    async def _serialize_new_proofs(self, proofs: list[Any], amount: int) -> str:
        if sum(proof.amount for proof in proofs) != amount:
            raise ValueError("Nutshell minted an unexpected amount")
        if not all(getattr(proof, "reserved", False) for proof in proofs):
            await self.wallet.set_reserved_for_send(proofs, reserved=True)
        try:
            return await self.wallet.serialize_proofs(proofs, include_dleq=True)
        except Exception:
            await self.wallet.set_reserved_for_send(proofs, reserved=False)
            await self.wallet.load_proofs(reload=True)
            raise

    def _available_balance(self) -> int:
        return sum(
            proof.amount
            for proof in self.wallet.active_proofs(self.wallet.proofs)
            if not getattr(proof, "reserved", False)
        )
