---
name: verify-amm-custody
description: Check that the Cashu AMM never loses track of a user's token when a deposit, swap, or redemption fails or its response is lost. Use when changing PoolService operations, _fail, _refund, _cached, _store_result, OperationJournal, OperationResultStore, or postOperation in app.js.
---

# Verify AMM custody

**Property.** Every token the pool takes ends up in the pool state, back with its owner as a refund token, or in a pending journal record. A browser that retries a lost request with the same `operation_id` receives the same LP, output, or refund tokens as the original answer.

**Harm if broken.** The pool keeps user funds that no record shows. Or a refund token exists only in a response that was lost, and the user can never claim it.

## Run

```sh
export TLA2TOOLS=/absolute/path/to/tla2tools.jar   # TLC 1.7.4 release
export JAVA=/path/to/java                          # Java 11 or later
bash scripts/verification/check-model.sh .claude/skills/verify-amm-custody/model/Custody.tla
bash scripts/verification/check-model.sh .claude/skills/verify-amm-custody/model/Custody.tla --mutant
uv run pytest backend/tests/test_service.py -k "refund"
```

The first run must print `No error has been found` (58 distinct states). The `--mutant` run sets `Broken = TRUE`, which replays the code before commits 7c3e090 and 88468ef. It must report `NoOrphanedFunds` violated. With only `ClientGetsWhatItIsOwed` in a copy of the config, it must report that rule violated too. Read every TLC result with the pstack `/statechart` skill, which tells each violation as its shortest path.

## Coverage

Synced with the code at commit `88468ef`. Move this forward only after you confirm that the model still describes the code at the new commit.

| Model step | Code |
| --- | --- |
| `ReceiveSat`, `ReceiveUsd`, `UsdFails` | `PoolService.deposit` → `_receive`, `OperationJournal.begin` (`backend/service.py`, `backend/journal.py`) |
| `Issue`, `IssueFails` | `share_gateway.issue`, the proportion check in `deposit` |
| `Refund`, `RefundFails` | `PoolService._refund` |
| `CloseFailure` | `PoolService._fail(owed=...)`, `PoolService._failure` → `_store_result` |
| `CloseSuccess` | `_persist`, `_store_result`, `_complete` |
| `Replay` | `PoolService._cached` → `OperationResultStore.load` (`backend/idempotency.py`) |
| `Lose`, `Retry` | `postOperation` in `app.js` keeps the operation ID after a network error |

`deposit_single`, `swap`, and `redeem` take one asset, a subset of the two-asset deposit, and use the same `_fail`, `_failure`, and `_cached`. The regression tests are `test_partial_refund_keeps_journal_pending` and `test_retry_after_lost_refund_response_returns_same_refund`.

## When the check fails

- A failing TLC run on the fixed config after a code change is a real bug until you show the model is wrong. Replay the path as a test in `backend/tests/test_service.py` with `FakeGateway` (set `fail_send`, `fail_receive`, or delete a token from `received` to model a spent proof).
- If you change the order of steps on purpose, change the model's actions to match, rerun both configs, and keep the mutant failing.

## Not covered

Two operations at once (the asyncio lock serializes them in one process), a crash between steps (restart refuses to run with any pending journal), redemption output cancellation in detail, the LP mint, and a browser reload, which drops the in-memory `pendingOperations` map and with it the operation ID.
