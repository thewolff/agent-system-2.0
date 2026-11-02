---
status: open
author: plumb
date: 2026-10-19
---

# By-hand pairing lanes get their brief and the paired-coding plugin, on the pair-handoff workload

## Decision

Jo, 2026-10-19 at about 12:15 PM PDT: "ADD BOTH". Both fixes go to the workload "make pair offers visible and fix the pair handoff" (wl-mvb9mw00ycfjeo) as a second PR, after PR #243 lands:

1. `as2 lane <wl>` delivers the first prompt into the session. Today it writes `prompt.md` (`surface/scripts/lane.ts:1753-1756`) but `interactiveArgv` (`surface/src/launch.ts:1252-1255`) passes only `system.md`.
2. paired-coding (jo-wolff-plugins 1.3.2) is vendored under `plugins/paired-coding/`. Today the as2 profile's `includeSkills` does not list it and its `extensions/` does not load the adapter, so the `pair_*` tools never register.

## Found by

Jo's pairing lane on wl-mvfmkbgin0se0w (lane-mvfmkbgin0se0w-1). It could not read its brief (`orchestrator_ledger` refused: "This session is not the orchestrator surface"), and it could not find the pairing skill. Session file: `~/.agent-system-2/lanes/wl-mvfmkbgin0se0w/sessions/2026-10-19T19-07-35-474Z_01a1558f-e2b2-7000-a4b4-7a969efc3495.jsonl`.

## Delivery

The amendment is written as a paste for Ilex: `.tmp/paste-pair-handoff-add-both.txt`. Jo sends it, because there is still no direct Plumb-to-Ilex channel (`2026-10-14--1650--plumb--plumb-routes-actionable-work-through-as2.md`, "Depends on"). Not yet sent at writing.

## Heads-up

- Plumb's recommendation rested on "its lane is already live". Checked afterwards: the workload's only open slice is the full-suite run for PR #243, and it has used $40.30 of its $50 ceiling (q-mvfiw81828bhxc). The paste puts the new work after #243 and warns that the 100% stop is coming.
- Correction to an earlier Plumb reply the same day: the plugin-drift banner covers OMP's default profile only. as2's profile does not load the machine's skills or plugins (`docs/getting-started.md:63`).
