---
title: The train tick backs off a train whose every PR is held, one live lane per workload, no launch request at the ceiling
status: building
workload: wl-mvgn310dpi5gcg
pr: 287
---
**Built on branch `wl/wl-mvgn310dpi5gcg`, PR #287.** Workload `wl-mvgn310dpi5gcg` (normal stakes, Jo's `open` on q-mvgmb2cbphqubk, plan at `~/agent-scratch/agent-system-2.0/wl-mvgn310dpi5gcg/PLAN.md`). On 2026-10-20 the daily self-heal report train `wl-mvggzumu8zs5xc`, whose only PR #244 was held by owner `wl-mvbcjageg7o2yo`'s conflict task, ran lanes 1 to 15 between about 09:20Z and 12:06Z. From 11:30Z on it ran one about every 5 minutes, sometimes three at once. It spent about $28 with nothing landed, and started one more lane after the ceiling had stopped it.

**What was wrong.**
- The tick recorded a head's wake (`train-head-woken:`) only when its own launcher call exited 0. That night every call was refused `cap`. The drain or the surface served the request a minute later. So the head stayed at zero wakes, the untested-head retry was due on every pass, and `trainRetries`' backoff never applied.
- The launch predicate checks only the holder lease. After `lane_release` the holder is cleared, but the runner keeps running for up to SETTLE_IDLE_MS before `lane-exit:`. A new reservation started a second lane beside the live one.
- The tick never read the ceiling.

**What changed.**
- `request()` in `surface/scripts/train-tick.ts` returns `{ code, wrote, requestId }`. Step 4 records one `train-head-woken:` per request the tick made for a head (it wrote the request, or its launcher served a pending one), whichever starter serves it, and never a second wake for the same request. The backoff (`trainRetries`, `surface/src/merge-train.ts`: 15, 30, 60 min … up to 4 h after each lane's exit) now applies.
- `request()` first checks `ceilingStopped` (`surface/src/ceiling.ts`): the maximum of each half over the workload's `spend:` rows against `effectiveCeiling`. At 100 % it writes no `launch-requested:`, calls no launcher and records no wake, for train wakes and owner deliveries alike. It logs one line only. Jo's `extend` or `ceiling <usd>` lifts it on the next pass.
- `reserve()` in `surface/scripts/lane.ts` runs the live-lane check (`liveLaneOf`) inside `reserveLane`'s write transaction, for both the autonomous and the interactive starter. An earlier lane with a `lane-started:` after its newest `lane-exit:` whose runner or omp is alive, or which ps cannot verify, refuses `held: <laneId> still running (…)` (exit 7) and writes no row. The request stays queued, and the old runner's exit drains it.
- Both spawn sites (the runner's `startAsOwner` body and `cmdInteractive`) spawn omp only while the workload is still held by their lane id (`spawnIfReserved`, `stillReserved`). A reservation taken by another starter after this one's pre-claim lapsed spawns nothing and records `launch-failed:` (stage `reserve`, exit 7).
- Regression tests replay the night's shape: `surface/test/train-tick.test.ts` ("the relaunch loop, replaying wl-mvggzumu8zs5xc") and `surface/test/lane-live-lane.test.ts`.

**Not fixed here (filed).** thewolff/agent-system-2.0 #282 (each train lane resumes one growing session), #283 (the 15-minute settle wait after a release), #284 (an owner's task settles failed by the 2 h rule while its lane is live), #285 (train lanes write the `train-error: pr <n>` pass-over inside longer notes).

**Rollback.** Revert the PR. The tick returns to waking on every pass when its own launch is refused, and a released lane's live runner no longer blocks a new one.
