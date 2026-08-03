from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any


class OperationResultStore:
    """Durable response cache keyed by a client-provided operation ID."""

    def __init__(self, directory: str | Path) -> None:
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)

    @staticmethod
    def fingerprint(payload: dict[str, Any]) -> str:
        encoded = json.dumps(
            payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True
        ).encode()
        return hashlib.sha256(encoded).hexdigest()

    def load(
        self,
        operation_id: str,
        operation: str,
        payload: dict[str, Any],
    ) -> dict[str, Any] | None:
        path = self._path(operation_id)
        if not path.exists():
            return None
        record = json.loads(path.read_text(encoding="utf-8"))
        if (
            record.get("operation") != operation
            or record.get("fingerprint") != self.fingerprint(payload)
        ):
            raise ValueError("operation_id was already used for another request")
        result = record.get("result")
        if not isinstance(result, dict):
            raise ValueError("stored operation result is invalid")
        return result

    def save(
        self,
        operation_id: str,
        operation: str,
        payload: dict[str, Any],
        result: dict[str, Any],
    ) -> None:
        existing = self.load(operation_id, operation, payload)
        if existing is not None:
            if existing != result:
                raise ValueError("operation_id has a different stored result")
            return
        record = {
            "version": 1,
            "operation": operation,
            "fingerprint": self.fingerprint(payload),
            "result": result,
        }
        fd, temporary = tempfile.mkstemp(
            prefix=f"{operation_id}-", suffix=".tmp", dir=self.directory
        )
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(record, handle, sort_keys=True)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self._path(operation_id))
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def _path(self, operation_id: str) -> Path:
        invalid = any(
            character not in "0123456789abcdef-" for character in operation_id
        )
        if not operation_id or invalid:
            raise ValueError("operation_id must be a lowercase UUID")
        return self.directory / f"{operation_id}.json"
