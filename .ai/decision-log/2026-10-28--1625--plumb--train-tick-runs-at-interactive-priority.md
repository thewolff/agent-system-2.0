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

The live plist at `$HOME/Library/LaunchAgents/com.agent-system-2.train-tick.plist` still says `Standard` when this entry is written. It was installed from `/Users/jowolff/code/agent-system-2.0`: its program argument names that checkout's `surface/scripts/train-tick.ts`, not the verified control root. Nothing changes on the machine until that checkout has the merged commit and `bash install/install.sh --train-tick` re-renders the plist and reloads the job. Plumb hands this step to Jo as a helper script, as with the 01:50 change's `reload-train-tick.zsh`.

## Checking that it took

A plist file that says `Interactive` does not prove the job is loaded. `load_job` in `install/install.sh` boots the old job out, moves the new file into place, and only then runs `launchctl bootstrap`. If bootstrap fails after that, the file says `Interactive` and no tick job is loaded. A nonzero exit from the installer means activation failed, whatever the file says. Three checks follow it:

1. **Loaded.** `launchctl print gui/$(id -u)/com.agent-system-2.train-tick` exits 0, and the on-disk path it prints is `$HOME/Library/LaunchAgents/com.agent-system-2.train-tick.plist`. Exit 113 means the label is not loaded (the comment above `load_job`). Only then does `plutil -extract ProcessType raw $HOME/Library/LaunchAgents/com.agent-system-2.train-tick.plist` printing `Interactive` describe the job launchd is running.
2. **It fires.** `StartInterval` is 300 s and the plist sets no `RunAtLoad`, so the first run starts within 5 minutes of bootstrap. Within 10 minutes of the reload (two intervals, one spare for an interval launchd skips while the job is still running or the machine sleeps), `launchctl print` shows a last exit status of 0 and `$HOME/agent-scratch/agent-system-2.0/train-tick/launchd.log` has no new error line. A tick with nothing to do writes nothing to that log, so the absence of a new line is not a failure on its own. A new error line or a nonzero exit is. If there is still no exit after 10 minutes, stop waiting and tell Plumb. The train does not board or settle anything while the tick is down.
3. **Recovery if bootstrap failed** (installer exit nonzero, or check 1 exits 113): run `plutil -lint $HOME/Library/LaunchAgents/com.agent-system-2.train-tick.plist`, then `launchctl bootstrap gui/$(id -u) $HOME/Library/LaunchAgents/com.agent-system-2.train-tick.plist`. If that errors, do not retry it in a loop. Run check 1 once, because launchd refuses to bootstrap a label that is already loaded. If the job is still not loaded, rerun `bash install/install.sh --train-tick` from the checkout and send Plumb its output and the launchd log. The tick stays down until then.

## What a reload does not change

Reloading does not retune processes that are already running. Lanes, runners and suites that the old tick tree started keep the clamp they started with until they exit (TrainLoadLoop report, "Recommendation: one change"). A rollback works the same way: going back to `Standard` only clamps tick trees started after the rollback. When judging whether `Interactive` helped, count only full-suite runs whose lane started after the reload.

Bootout has one more edge. launchd.plist(5), under `AbandonProcessGroup`, says that when a job dies, launchd kills the processes left in its process group unless that key is true. This template does not set it. Descendants still in the tick's process group at reload can be killed, and lanes that run in their own process group survive with their old clamp. Reload between ticks, when `train-tick.ts` itself is not running.

## Limits this does not address

- `Interactive` lifts CPU and I/O limits only. It sets no memory bound. Swap was 17.8 of 18.4 GiB at 22:08Z (TrainLoadLoop report), and unthrottled suites can drive swap I/O harder.
- Green runs without the throttle do not prove the timing tests are robust. A test that passes only with the CPU to itself is still fragile. #384 (timing-only-when-under-test rule) and #397 (as2test stuck test on the detector's CPU clock) address those tests.

## Revert

Set the template's `ProcessType` back to `Standard`, change the pin in `ledger/test/install.test.ts` to match, reinstall the live plist with `bash install/install.sh --train-tick`, and run the three checks above. The rollback clamps only tick trees started after it; a suite already running unclamped keeps running that way until it finishes or is stopped.
