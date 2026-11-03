---
title: The merge train always has a live lane, outside the lane cap
status: building
workload: wl-mvpsrr4tr0p1xc
pr: none
---
## Why

Two incidents on 2026-10-26 (spec: jo-issues #212, https://github.com/thewolff/jo-issues/issues/212).

- The train lane exited `parked` at 21:36:47Z. Jo's `launch-requested: by jo` at 21:53:56Z was refused `cap`, because the train lane counted against the lane cap like any other lane. The train started again at 22:06:12Z, only when a slot freed.
- That morning, lanes -63 to -68 each wrote `launch-failed: … readiness: never ready in 3m` and `lane-exit: … outcome never-ready`, one per 5-minute tick. The train still had work (`#304 not yet worked; #308 not yet worked`) after every exit, so the tick launched again. Nothing bounded the failures.

## Rules

**D1. The train lane is outside the cap.** A workload is cap-exempt when it is an open merge train (a valid `train:` or `train-board:` member). Its lane is not counted in the live-lane count, in any launch path or rank mode, and it does not wait for a slot. `launchable` takes `capExempt` and skips only the `cap` refusal; every other rule is unchanged. A fix workload a train opens (`train-fix:`) is an ordinary workload and counts.

**D2. The tick launches the train at once when it has work.** Work is a PR on the train, a settled task, a merged dependency, a retry, an expired hold, an answer to the tick's own alert, or now an answer to a question the train lane raised. An answer is consumed when a launch that carried it reaches `lane-ready:`. A launch that never gets ready consumes nothing, so the answer still wakes the train. A never-ready exit swallows no work. A PR counts as worked once the train's own lane has written on its slice or ended its pass by its word (released with open slices, `parked`, `released`, `completed`). A crash does not count.

**D3. Never two train lanes at once.** The same workload is held by its lease. Across trains, a second train is refused `held: train lane <laneId> live on <wl>`, checked at reservation and again at spawn, both inside a ledger write. The check is global, not per repository.

**D4. Failed launches are bounded.** After 3 consecutive failed launches of the train lane (`TRAIN_LAUNCH_LIMIT`), no path starts another: `reserve` refuses with `not-launchable: train launch limit` (exit 10). A launch counts as failed when it never reached `lane-ready:` and has a `launch-failed:`, a `never-ready` exit, a later attempt, or a lapsed lease with no record. A by-hand session (`as2 lane <wl>`, `cause interactive`) has no runner readiness step, so it never counts and ends the run of failures as a ready lane does; since `migration/items/permanent-merge-train.md` a train refuses by-hand sessions outright (reason `train-autonomous`). The tick then raises one `now` (incident) question per run of failures on the train's first open PR slice, with the options `relaunch` / `stop`. It also files the jo-issues alert. `relaunch`, Jo's `launch-requested:` and a new `train:` binding reset the count. `stop` leaves the train stopped until one of those.

**D5. Relaunch on work only.** An idle train gets no launch request and no lane, whether the cap is empty or full. The train lane still exits when parked on its own question and releases when nothing is runnable.

## Launch limit and the NOW question

The limit is 3, the same number as PR #308's `RETRY_LIMIT`. The counter is a separate one, because #308 is unmerged and keeps merge trains out of its relaunch. The question reaches Jo as a `NOW (incident)` line, on fire at the first poll.

## Out of scope

- Jo's `launch-requested:` on an ordinary workload still waits for the cap.
- jo-issues #210 (`train <N>` joining the open train) and the train's stable title.
- PR #308's dead-lane relaunch for ordinary workloads.
- A lane that reaches `lane-ready:` and then crashes again and again. D4 counts only launches that never got ready.
- One train lane at a time globally, not per repository. There is one served repository today.

Docs: `USER-GUIDE.md` (the merge-train lane and the lane cap) and `DESIGN-lane-launcher.md` (the predicate's `capExempt`).
