---
date: 2026-10-27T13:49-07:00
engineer: Ilex
session: wl-mv7gtie2w23da8
status: resolved
durable: false
supersedes:
workload: wl-mv7gtie2w23da8
---

# Jo (2026-10-14): "open a production workload: row 6 follows a literal cd. `cd /tmp && rm -rf pdq` was held as outside temp (en-mv70vl5v2e86bk, en-mv6wkajyj30nwg). Resolve relative rm operands against a literal cd in the same chain; unknown or variable cd stays reserved." Target: gates/src/rows/r06-reserved.ts. Its rm-outside-temp rule should resolve a relative rm operand against a literal `cd <path>` earlier in the same && / ; chain. A cd whose target is unknown or a variable (`cd "$X"`, `cd $(…)`, `cd -`, or a cd in a subshell or a separate chain) keeps the current reserved behaviour. Note: this message reached Ilex with no input id, so it has no input row.

done: Row 6 resolves a relative rm operand against a literal cd earlier in the same command chain, so `cd /tmp && rm -rf pdq` is treated as inside temp, while an rm after an unknown or variable cd stays reserved; covered by tests and merged on main.
done-because: (no receipt recorded)

Rendered from the ledger by Ilex (they/them) at workload close; stakes production, mode user-driven, opened 2026-10-14T02:02:56.474Z.

## What changed

- none

## Decisions made (and why)

- jo (surface): Jo: "open a production workload: row 6 follows a literal cd. `cd /tmp && rm -rf pdq` was held as outside temp (en-mv70vl5v2e86bk, en-mv6wkajyj30nwg). Resolve relative rm operands against a literal cd in the same chain; unknown or variable cd stays reserved." — reading: The row 6 literal-cd workload's brief, repeated. It's already open as wl-mv7gtie2w23da8 (production, user-driven), which until now had no input id. It resolves relative rm operands against a literal cd in the same chain; an unknown or variable cd stays reserved. Scope unchanged.
- jo (surface): withdraw wl-mv7gtie2w23da8
- orchestrator (surface): close receipt: withdrawn by Jo (in-mvr5r8wbk0xt3z): closed with no done-because: receipt

## Dead ends — don't retry these

- none

## Heads-up for whoever touches this next

- none
