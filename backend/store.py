from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from .amm import PoolState


STATE_VERSION = 1


class JsonPoolStore:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)

    def load(self) -> PoolState | None:
        if not self.path.exists():
            return None
        raw = json.loads(self.path.read_text())
        if raw.get("version") != STATE_VERSION:
            raise ValueError("unsupported pool state version")
        state = PoolState(
            sat=int(raw["sat"]),
            usd=int(raw["usd"]),
            shares=int(raw["shares"]),
            events=tuple(raw.get("events", ())),
        )
        state.validate()
        return state

    def save(self, state: PoolState) -> None:
        state.validate()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload: dict[str, Any] = {
            "version": STATE_VERSION,
            "sat": state.sat,
            "usd": state.usd,
            "shares": state.shares,
            "events": list(state.events),
        }
        fd, temp_path = tempfile.mkstemp(prefix="pool-", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w") as handle:
                json.dump(payload, handle, sort_keys=True)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_path, self.path)
        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
