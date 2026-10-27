---
date: 2026-10-27T13:50-07:00
engineer: Ilex
session: wl-mv9odjq5r13e9s
status: resolved
durable: false
supersedes:
workload: wl-mv9odjq5r13e9s
---

# Jo (2026-10-15, answer in-mv9od937f70hz4: `followup` on q-mv98x34mg4n400, the runner workload wl-mv615mkeaf1yio's question): runner-fix PR #129 ships plain first-come-first-served after rebasing onto Plumb's runner-hang fix PR #218, and a separate workload adds rank order to the test runner's queue. Earlier ruling (in-mv92rsb78t4em8, in-mv92tevflvr75s): the runner queue serves on-fire first, reading rank from surface/src/rank.ts, which is now on main (PR #153, 333b01c).

Scope: the test runner's queue orders waiting runs by rank: Jo's pins ("X first") first, then on-fire, then first come first served. A run is dropped only when superseded (in-mv9340e04pgbnk). A running run is never killed to let a higher-ranked one through. Tonight Plumb killed PR #129's run to let #153 through, and Jo called that a mistake. Builds on PR #129 and PR #218 once they land; coordinate with the runner workload, which owns both.

done: The test runner's queue starts waiting runs in rank order (Jo's pins, then on-fire, then first come first served, read from surface/src/rank.ts), never kills a running run for rank, and drops a run only when superseded; shown by tests, with the full suite green at the PR head on a pushed PR.
done-because: (no receipt recorded)

Rendered from the ledger by Ilex (they/them) at workload close; stakes normal, mode user-driven, opened 2026-10-15T15:10:00.989Z.

## What changed

- none

## Decisions made (and why)

- jo (surface): withdraw wl-mv9odjq5r13e9s
- orchestrator (surface): close receipt: withdrawn by Jo (in-mvr5r8wd1h2dbi): closed with no done-because: receipt
- assumption (orchestrator-surface): brief-judged: judge confidence 0.85 judge typesafe/jev-1.13.0

## Dead ends — don't retry these

- none

## Heads-up for whoever touches this next

- none
