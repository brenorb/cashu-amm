# Cashu AMM verification

Project-local skills under `.claude/skills` check the parts of the pool where a bug costs users money:

| Skill | What it checks | Tool | Scope |
| --- | --- | --- | --- |
| [verify-amm-custody](../../.claude/skills/verify-amm-custody/SKILL.md) | Every token the pool takes is in the pool, refunded, or on the recovery journal; a retried request gets the same tokens back | TLA+ / TLC | 58 states: one two-token deposit, any receive, issue, or refund failure, one lost response |
| [verify-amm-curve](../../.claude/skills/verify-amm-curve/SKILL.md) | Swaps never lower k; redemptions are pro rata; deposit or zap round trips never profit | Exhaustive run of `backend/amm.py` | 331,776 cases: every pool and amount up to 24 |

The custody model found two bugs, now fixed with regression tests:

1. **A partial refund closed the journal.** When a refused deposit returned the SAT token but failed to return the USD token, `_fail` completed the journal anyway. The pool then held USD that no record showed (commit 7c3e090).
2. **A lost refund response could not be replayed.** Only successful results were stored by `operation_id`, so a retry after a lost 409 tried to receive already-swapped proofs and lost the refund tokens (commit 88468ef).

## User flows

The charts were generated with pstack `/statechart` from the TLA+ models next to them. Regenerate one with `/statechart` on its `.tla` file and `view.mjs`, writing to a new folder.

### Trade SAT and USD

[TLA+ model](flows/trade/Trade.tla) · [TLC report](flows/trade/report.md)

```mermaid
---
title: "Trade SAT and USD"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: settled
    lg1: stopped
    lg2: working
  }
  class lg0 teal
  class lg1 orange
  class lg2 blue
  s0: Choose a token to trade
  s1: Trade in progress
  s2: Held, answer on its way
  s3: Refunded, answer on its way
  s4: Swapped, answer on its way
  s5: Token refused, nothing taken
  s6: Connection lost, trade ID kept
  s7: Held for operator recovery
  s8: Refund token in your wallet
  s9: Output token in your wallet
  [*] --> s0
  s0 --> s1: you press trade
  s1 --> s2: the output and the refund both fail
  s1 --> s3: the output fails and the pool refunds
  s1 --> s4: the pool swaps at the curve price
  s1 --> s5: the mint refuses the token
  s2 --> s6: the response is lost
  s2 --> s7: the page says the pool holds it
  s3 --> s6: the response is lost
  s3 --> s8: the page saves the refund token
  s4 --> s6: the response is lost
  s4 --> s9: the page saves the output token
  s6 --> s2: you press trade again
  s6 --> s3: you press trade again
  s6 --> s4: you press trade again
  class s0 blue
  class s1 blue
  class s2 blue
  class s3 blue
  class s4 blue
  class s5 orange
  class s6 blue
  class s7 orange
  class s8 teal
  class s9 teal
```

### Add SAT + USD liquidity

[TLA+ model](flows/add-liquidity/AddLiquidity.tla) · [TLC report](flows/add-liquidity/report.md)

```mermaid
---
title: "Add SAT + USD liquidity"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: settled
    lg1: stopped
    lg2: working
  }
  class lg0 teal
  class lg1 orange
  class lg2 blue
  s0: Choose SAT and USD tokens
  s1: Sending tokens
  s2: SAT received
  s3: SAT token refused, nothing taken
  s4: Both tokens received
  s5: Returning your tokens
  s6: LP token in your wallet
  s7: SAT token returned
  s8: Held for operator recovery
  s9: Both tokens returned
  s10: Part returned, rest held for recovery
  [*] --> s0
  s0 --> s1: you press add liquidity
  s1 --> s2: the pool receives the SAT token
  s1 --> s3: the mint refuses the SAT token
  s2 --> s4: the pool receives the USD token
  s2 --> s5: the mint refuses the USD token
  s4 --> s5: the amounts do not match the pool price
  s4 --> s6: the pool issues LP shares
  s5 --> s7: every refund succeeds
  s5 --> s8: a refund fails
  s5 --> s9: every refund succeeds
  s5 --> s10: a refund fails
  class s0 blue
  class s1 blue
  class s2 blue
  class s3 orange
  class s4 blue
  class s5 blue
  class s6 teal
  class s7 teal
  class s8 orange
  class s9 teal
  class s10 orange
```

The charts hide terminal stuttering and the `Replay` step, which stays in the same chart state. They leave out the LP redemption flow, browser reloads, and operator recovery after a pending journal.
