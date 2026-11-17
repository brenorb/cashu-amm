---------------------------- MODULE AddLiquidity ----------------------------
\* Adding SAT + USD liquidity in the browser: app.js liquidity form ->
\* POST /api/liquidity/deposit -> PoolService.deposit. Each refund can fail on
\* its own; a token the pool cannot return stays in a pending journal.
VARIABLES screen, took, back, journal, lp

vars == <<screen, took, back, journal, lp>>

Assets == {"sat", "usd"}

Init ==
  /\ screen = "choose" /\ took = {} /\ back = {} /\ journal = FALSE /\ lp = FALSE

YouAdd ==
  /\ screen = "choose" /\ screen' = "receiving"
  /\ UNCHANGED <<took, back, journal, lp>>

PoolTakesSat ==
  /\ screen = "receiving" /\ took = {}
  /\ took' = {"sat"} /\ journal' = TRUE
  /\ UNCHANGED <<screen, back, lp>>

PoolTakesUsd ==
  /\ screen = "receiving" /\ took = {"sat"}
  /\ took' = Assets /\ screen' = "checking"
  /\ UNCHANGED <<back, journal, lp>>

SatRefused ==
  /\ screen = "receiving" /\ took = {}
  /\ screen' = "refused"
  /\ UNCHANGED <<took, back, journal, lp>>

UsdRefused ==
  /\ screen = "receiving" /\ took = {"sat"}
  /\ screen' = "refunding"
  /\ UNCHANGED <<took, back, journal, lp>>

PoolIssuesLp ==
  /\ screen = "checking"
  /\ lp' = TRUE /\ journal' = FALSE /\ screen' = "added"
  /\ UNCHANGED <<took, back>>

WrongProportion ==
  /\ screen = "checking" /\ screen' = "refunding"
  /\ UNCHANGED <<took, back, journal, lp>>

RefundsMade ==
  /\ screen = "refunding"
  /\ back' = took /\ journal' = FALSE /\ screen' = "refunded"
  /\ UNCHANGED <<took, lp>>

\* _fail keeps the journal when any owed refund is missing.
SomeRefundFails ==
  /\ screen = "refunding"
  /\ \E kept \in SUBSET took :
       /\ kept # {}
       /\ back' = took \ kept
  /\ screen' = "held"
  /\ UNCHANGED <<took, journal, lp>>

Done == screen \in {"added", "refunded", "held", "refused"} /\ UNCHANGED vars

Next == YouAdd \/ PoolTakesSat \/ PoolTakesUsd \/ SatRefused \/ UsdRefused
        \/ PoolIssuesLp \/ WrongProportion \/ RefundsMade \/ SomeRefundFails \/ Done

Spec == Init /\ [][Next]_vars

\* Each token the pool took is in the pool (as LP), back with you, or on the
\* operator's recovery list.
NothingDisappears ==
  screen \in {"added", "refunded", "held", "refused"} =>
    \A a \in took : lp \/ a \in back \/ journal
=============================================================================
