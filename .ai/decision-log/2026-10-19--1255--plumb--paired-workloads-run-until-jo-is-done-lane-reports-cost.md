---
status: open
author: plumb
date: 2026-10-19
---

# A workload Jo is pairing in runs until Jo is done; the lane reports cost in the pane

## Decision

Jo, 2026-10-19 at about 12:55 PM PDT: "anything i am paired with should continue until i am fucking done with it, though i should be kept abreast, by the lane i am paired in, of the cost".

This amends point 2 of `2026-10-19--1125--plumb--escalation-policy-auto-start-normal-plans-and-stop-at-ceiling.md` ("At 100% of a workload ceiling, as2 stops and sends Jo a notice"):

- A workload Jo is pairing in never stops at its ceiling.
- The lane Jo is paired with reports running spend against the ceiling in the session, unprompted. Cost does not reach Jo as a surface question.
- The 100% stop still applies to every workload Jo is not in.

## Scope, and an assumption named

"Paired" today means a lane started by hand with `as2 lane <wl>`. as2 has no paired mode yet (jo-issues #139). That lane's system.md reads "This lane runs in Jo's terminal; Jo is present." Plumb's assumption: the rule covers by-hand lanes, plus paired mode once it exists. Whether every user-driven workload counts is left to the plan.

## Routing

- Implementation: the escalation policy workload wl-mvfkv7llkp7nk0, which builds the 11:25 ruling.
- Applied now to wl-mvfmkbgin0se0w (newdle profile feed, ceiling $150 / 18h): no stop until Jo is done. If the current machinery would stop it, Ilex extends it on this ruling.
- Ilex paste: `.tmp/paste-paired-no-ceiling-stop.txt`. Jo sends it, because there is no Plumb-to-Ilex channel.

## Unknown

Plumb did not check whether a lane can read its own spend. A by-hand lane's `orchestrator_ledger` refuses ("This session is not the orchestrator surface"). The paste makes "the lane receives its spend figure" a done-when.
