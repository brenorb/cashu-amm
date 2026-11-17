------------------------------- MODULE Custody -------------------------------
\* One two-token liquidity deposit (PoolService.deposit in backend/service.py)
\* with a client that may lose the HTTP response once and retry with the same
\* operation_id (postOperation in app.js). Steps map to the code:
\*   ReceiveSat / ReceiveUsd   -> self._receive(...) on each gateway
\*   UsdFails                  -> second _receive raises
\*   Issue / IssueFails        -> share_gateway.issue(shares)
\*   Refund(a) / RefundFails(a)-> self._refund(gateway, asset, amount)
\*   Close                     -> self._fail(...) or persist + _store_result
\*                                + _complete; the HTTP response is produced
\*   Deliver / Lose            -> the response reaches the browser or not
\*   Retry                     -> the browser posts again with the same ID
\* Broken = TRUE is the code before the fix: _fail completed the journal when
\* any refund succeeded, and only successful results were stored by ID.
EXTENDS FiniteSets

CONSTANT Broken

Assets == {"sat", "usd"}

VARIABLES pc, received, refunded, failedRefund, inState, journal, cache,
          response, client, attempt

vars == <<pc, received, refunded, failedRefund, inState, journal, cache,
          response, client, attempt>>

Init ==
  /\ pc = "start"
  /\ received = {}
  /\ refunded = {}
  /\ failedRefund = {}
  /\ inState = FALSE
  /\ journal = "none"
  /\ cache = "none"
  /\ response = "none"
  /\ client = "waiting"
  /\ attempt = 1

Unchanged(vs) == UNCHANGED vs

ReceiveSat ==
  /\ pc = "start" /\ attempt = 1
  /\ received' = {"sat"} /\ journal' = "pending" /\ pc' = "sat"
  /\ UNCHANGED <<refunded, failedRefund, inState, cache, response, client, attempt>>

ReceiveUsd ==
  /\ pc = "sat"
  /\ received' = Assets /\ pc' = "both"
  /\ UNCHANGED <<refunded, failedRefund, inState, journal, cache, response, client, attempt>>

UsdFails ==
  /\ pc = "sat" /\ pc' = "refunding"
  /\ UNCHANGED <<received, refunded, failedRefund, inState, journal, cache, response, client, attempt>>

Issue ==
  /\ pc = "both" /\ pc' = "issued"
  /\ UNCHANGED <<received, refunded, failedRefund, inState, journal, cache, response, client, attempt>>

IssueFails ==
  /\ pc = "both" /\ pc' = "refunding"
  /\ UNCHANGED <<received, refunded, failedRefund, inState, journal, cache, response, client, attempt>>

Pending == received \ (refunded \cup failedRefund)

Refund(a) ==
  /\ pc = "refunding" /\ a \in Pending
  /\ refunded' = refunded \cup {a}
  /\ UNCHANGED <<pc, received, failedRefund, inState, journal, cache, response, client, attempt>>

RefundFails(a) ==
  /\ pc = "refunding" /\ a \in Pending
  /\ failedRefund' = failedRefund \cup {a}
  /\ UNCHANGED <<pc, received, refunded, inState, journal, cache, response, client, attempt>>

\* _fail: the old code completed the journal whenever refunds was non-empty.
CloseFailure ==
  /\ pc = "refunding" /\ Pending = {}
  /\ journal' = IF (IF Broken THEN refunded # {} ELSE failedRefund = {})
                THEN "complete" ELSE "pending"
  /\ cache' = IF Broken \/ refunded = {} THEN cache ELSE "refunds"
  /\ response' = "refunds" /\ pc' = "closed"
  /\ UNCHANGED <<received, refunded, failedRefund, inState, client, attempt>>

CloseSuccess ==
  /\ pc = "issued"
  /\ inState' = TRUE /\ journal' = "complete" /\ cache' = "lp"
  /\ response' = "lp" /\ pc' = "closed"
  /\ UNCHANGED <<received, refunded, failedRefund, client, attempt>>

\* A retry with the same ID: a cached result is returned as is; otherwise the
\* tokens were already swapped by the mint, so _receive rejects them.
Replay ==
  /\ pc = "start" /\ attempt = 2
  /\ response' = IF cache = "none" THEN "spent" ELSE cache
  /\ pc' = "closed"
  /\ UNCHANGED <<received, refunded, failedRefund, inState, journal, cache, client, attempt>>

Deliver ==
  /\ pc = "closed" /\ client = "waiting"
  /\ client' = response
  /\ UNCHANGED <<pc, received, refunded, failedRefund, inState, journal, cache, response, attempt>>

Lose ==
  /\ pc = "closed" /\ client = "waiting" /\ attempt = 1
  /\ client' = "lost"
  /\ UNCHANGED <<pc, received, refunded, failedRefund, inState, journal, cache, response, attempt>>

Retry ==
  /\ client = "lost"
  /\ client' = "waiting" /\ attempt' = 2 /\ pc' = "start" /\ response' = "none"
  /\ UNCHANGED <<received, refunded, failedRefund, inState, journal, cache>>

Done == client \notin {"waiting", "lost"} /\ UNCHANGED vars

Next ==
  \/ ReceiveSat \/ ReceiveUsd \/ UsdFails \/ Issue \/ IssueFails
  \/ \E a \in Assets : Refund(a) \/ RefundFails(a)
  \/ CloseFailure \/ CloseSuccess \/ Replay \/ Deliver \/ Lose \/ Retry \/ Done

Spec == Init /\ [][Next]_vars

\* Every token the pool took is in the pool state, back with its owner, or in
\* a pending journal record that blocks restart until an operator recovers it.
NoOrphanedFunds ==
  pc = "closed" =>
    \A a \in received : inState \/ a \in refunded \/ journal = "pending"

\* When the browser stops, it holds what the pool owes it: the LP token, or
\* every refund token the pool created.
ClientGetsWhatItIsOwed ==
  client \notin {"waiting", "lost"} =>
    /\ inState => client = "lp"
    /\ refunded # {} => client = "refunds"
=============================================================================
