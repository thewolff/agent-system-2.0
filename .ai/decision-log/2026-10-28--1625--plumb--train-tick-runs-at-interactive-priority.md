---
status: resolved
author: plumb
date: 2026-10-28
supersedes: .ai/decision-log/2026-10-28--0150--plumb--train-tick-runs-at-standard-priority.md
---

# The merge train's tick runs at Interactive priority

## Decision

`install/com.agent-system-2.train-tick.plist` sets `ProcessType` to `Interactive` instead of `Standard`. A template pin in `ledger/test/install.test.ts` fails if the template says anything else, so a reinstall cannot bring back a clamp. Jo approved the change on 2026-10-28 at about 16:2x PDT.

This supersedes the 01:50 entry (`2026-10-28--0150--plumb--train-tick-runs-at-standard-priority.md`), which moved the tick from `Background` to `Standard`. `install/com.agent-system-2.chaos.plist` is not changed here and stays on `Standard`. The pure maintenance jobs stay on `Background`.

## Why

jo-issues #213. The tick launches merge-train lanes, those lanes request full-suite test runs, and the runner, its sudo part and every bun test worker inherit the tick's launchd scheduling clamp. The 01:50 entry removed the `Background` clamp (priority 4). `Standard` still applies the utility clamp, priority 20.

The evidence:

- TrainLoadLoop (`$HOME/agent-scratch/agent-system-2.0/train-load-loop/REPORT.md`): full parts were green on 4 of 6 runs at base priority 31 and on 5 of 26 at base priority 20, the `Standard` clamp. Priority is the biggest measured lever, not the only one: at base 31 there was still one red (as2test stuck-detector tests) and one 20-minute timeout.
- Commit 15d796f1: `classifier/test/snapshot-settle.test.ts` T10c timed out 6 of 6 under `taskpolicy -c utility` and passed 6 of 6 at the default priority 31, under the same 12 busy loops and 2 spawn loops.
- launchd.plist(5): `Interactive` jobs run with no resource limits.

## Live state

The live plist at `$HOME/Library/LaunchAgents/com.agent-system-2.train-tick.plist` still says `Standard` when this entry is written. Nothing changes on the machine until the template is reinstalled and launchd reloads the job. `plutil -extract ProcessType raw $HOME/Library/LaunchAgents/com.agent-system-2.train-tick.plist` shows the live value.

## Revert

Set the template's `ProcessType` back to `Standard`, change the pin in `ledger/test/install.test.ts` to match, reinstall the live plist and reload the job.
