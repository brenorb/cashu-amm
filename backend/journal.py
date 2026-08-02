from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4


class OperationJournal:
    """Small durable operation journal for the single-process PoC.

    A record is written before any Cashu proof is accepted.  It is removed only
    after the economic snapshot and all compensating outputs have been safely
    persisted.  A leftover record therefore tells the operator that a crash
    happened in the middle of a custody operation.
    """

    def __init__(self, directory: str | Path) -> None:
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)

    def begin(self, operation: str, payload: dict[str, Any]) -> str:
        operation_id = str(uuid4())
        self._write(
            operation_id,
            {
                "id": operation_id,
                "operation": operation,
                "stage": "started",
                "payload": payload,
                "created_at": datetime.now(UTC).isoformat(),
            },
        )
        return operation_id

    def update(self, operation_id: str, **fields: Any) -> None:
        current = self.read(operation_id)
        if current is None:
            raise KeyError(operation_id)
        current.update(fields)
        current["updated_at"] = datetime.now(UTC).isoformat()
        self._write(operation_id, current)

    def complete(self, operation_id: str, *, result: str = "committed") -> None:
        path = self._path(operation_id)
        if not path.exists():
            return
        record = self.read(operation_id) or {}
        record.update(
            {
                "stage": result,
                "completed_at": datetime.now(UTC).isoformat(),
            }
        )
        self._write(operation_id, record)
        path.unlink(missing_ok=True)

    def read(self, operation_id: str) -> dict[str, Any] | None:
        path = self._path(operation_id)
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def pending(self) -> list[dict[str, Any]]:
        return [
            json.loads(path.read_text(encoding="utf-8"))
            for path in sorted(self.directory.glob("*.json"))
        ]

    def _path(self, operation_id: str) -> Path:
        return self.directory / f"{operation_id}.json"

    def _write(self, operation_id: str, record: dict[str, Any]) -> None:
        target = self._path(operation_id)
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(record, indent=2, sort_keys=True), encoding="utf-8")
        with temporary.open("rb") as handle:
            os.fsync(handle.fileno())
        os.replace(temporary, target)
