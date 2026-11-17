------------------------------- MODULE Trade -------------------------------
\* Trading SAT for USD (or back) in the browser: app.js trade form ->
\* postOperation -> POST /api/swap -> PoolService.swap. The response can be
\* lost once; the browser keeps the operation_id and the next click reuses it.
VARIABLES screen, pool, wallet, lost

vars == <<screen, pool, wallet, lost>>

\* pool: what the server did with the input ("untouched", "swapped",
\*       "refunded", "held" = in a pending journal for operator recovery)
\* wallet: what the browser holds ("input", "output", "refund")
Init ==
  /\ screen = "choose" /\ pool = "untouched" /\ wallet = "input" /\ lost = FALSE

YouSubmit ==
  /\ screen = "choose" /\ screen' = "sending"
  /\ UNCHANGED <<pool, wallet, lost>>

PoolSwaps ==
  /\ screen = "sending" /\ pool = "untouched"
  /\ pool' = "swapped" /\ screen' = "answered"
  /\ UNCHANGED <<wallet, lost>>

PoolRefunds ==
  /\ screen = "sending" /\ pool = "untouched"
  /\ pool' = "refunded" /\ screen' = "answered"
  /\ UNCHANGED <<wallet, lost>>

PoolHolds ==
  /\ screen = "sending" /\ pool = "untouched"
  /\ pool' = "held" /\ screen' = "answered"
  /\ UNCHANGED <<wallet, lost>>

RejectToken ==
  /\ screen = "sending" /\ pool = "untouched"
  /\ screen' = "rejected"
  /\ UNCHANGED <<pool, wallet, lost>>

\* A retry with the same operation_id gets the stored result back.
Replay ==
  /\ screen = "sending" /\ pool # "untouched"
  /\ screen' = "answered"
  /\ UNCHANGED <<pool, wallet, lost>>

ResponseLost ==
  /\ screen = "answered" /\ ~lost
  /\ screen' = "offline" /\ lost' = TRUE
  /\ UNCHANGED <<pool, wallet>>

YouRetry ==
  /\ screen = "offline" /\ screen' = "sending"
  /\ UNCHANGED <<pool, wallet, lost>>

ShowResult ==
  /\ screen = "answered"
  /\ wallet' = CASE pool = "swapped" -> "output"
                 [] pool = "refunded" -> "refund"
                 [] OTHER -> wallet
  /\ screen' = CASE pool = "swapped" -> "traded"
                 [] pool = "refunded" -> "refund"
                 [] OTHER -> "support"
  /\ UNCHANGED <<pool, lost>>

Done == screen \in {"traded", "refund", "support", "rejected"} /\ UNCHANGED vars

Next == YouSubmit \/ PoolSwaps \/ PoolRefunds \/ PoolHolds \/ RejectToken
        \/ Replay \/ ResponseLost \/ YouRetry \/ ShowResult \/ Done

Spec == Init /\ [][Next]_vars

\* When the trade screen settles, the wallet holds what the pool owes it.
YouKeepYourValue ==
  /\ screen = "traded" => wallet = "output"
  /\ screen = "refund" => wallet = "refund"
  /\ pool = "refunded" /\ screen \in {"traded", "rejected"} => FALSE
=============================================================================
