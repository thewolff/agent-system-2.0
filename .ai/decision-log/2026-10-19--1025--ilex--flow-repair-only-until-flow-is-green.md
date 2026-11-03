---
date: 2026-10-19T10:25-07:00
engineer: ilex
session: Jo's flow-repair ruling, written down by lane lane-mvfj0wfsz5vn5s-1 (workload wl-mvfj0wfsz5vn5s)
status: open
durable: true
---

# Flow-repair only until flow is green

## Jo's words (2026-10-19, 10:25 PDT, to Ilex)

Verbatim from the ledger input row in-mvfiyyv2kuha80 (2026-10-19T17:25:19.742Z), recorded as the
instruction row in-mvfiztvfi7ez28 on wl-mvbcjadqgblr7k:

> Ruling: flow-repair only until flow is green. From now on, open only workloads that fix flow: the started-work cap with a real queued state, relaunch of dead lanes with a retry counter, the close-check fixes (#223 and the merged-never-run case), the Plumb-to-Ilex channel, the monitoring/invariant timer (PR #70, wl-mv654hoqwpfhmo), and the merge-train auto-boarding. Every other new ask gets queued and you tell me "queued, position N". Workloads I already approved or that already have a lane keep running.
> The exit condition is the five daily flow signals in /Users/jowolff/agent-scratch/agent-system-2.0/stuck-analysis/ROOT-CAUSE.md section 5 (open workloads, quiet 24 h, dead and not relaunched, questions per day, provider-error messages per day), all green for three days in a row at the thresholds written there. Report the five numbers to me once a day at noon PDT. The gate lifts only on that measured condition, never because it's hard to meet. Write this ruling to the decision log and https://github.com/thewolff/jo-issues/issues/132.

## Decisions made (and why)

- Until flow is green, Ilex opens only workloads that fix flow:
  - the started-work cap, with a real queued state;
  - relaunch of dead lanes, with a retry counter;
  - the close-check fixes: #223 and the merged-never-run case;
  - the Plumb-to-Ilex channel;
  - the monitoring/invariant timer (PR #70, wl-mv654hoqwpfhmo);
  - merge-train auto-boarding.
- Every other new ask is queued, and Jo is told "queued, position N".
- Workloads Jo already approved, and workloads that already have a lane, keep running.
- Exit condition: the five daily flow signals in ROOT-CAUSE.md, heading "## 5. Early warning: five
  signals to watch daily" (open workloads, quiet 24 h, dead and not relaunched, questions per day,
  provider-error messages per day), all green three days in a row at the thresholds written there.
- Ilex reports the five numbers to Jo once a day at noon PDT.
- The gate lifts only on that measured condition, never because it is hard to meet.
- Context (not Jo's stated reason): ROOT-CAUSE.md (same directory as above)
  finds that as2 was designed for per-workload correctness and never for system flow (Root A), and
  that repairs to the system ride the same queue as the work they protect (Root G).

## Heads-up for whoever touches this next

- The ruling is also posted on https://github.com/thewolff/jo-issues/issues/132.
- This entry records the ruling only. Whether the gate is enforced by machinery or by Ilex's
  discipline is not decided here.
