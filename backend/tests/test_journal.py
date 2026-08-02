from __future__ import annotations

from backend.journal import OperationJournal


def test_journal_is_durable_and_clears_only_on_completion(tmp_path) -> None:
    journal = OperationJournal(tmp_path / "pending")
    operation_id = journal.begin("swap", {"direction": "sat-usd"})
    journal.update(operation_id, stage="input_received", amount_in=100)

    reopened = OperationJournal(tmp_path / "pending")
    assert reopened.pending()[0]["stage"] == "input_received"
    assert reopened.pending()[0]["amount_in"] == 100

    reopened.complete(operation_id)
    assert reopened.pending() == []
