---
title: A released lane's omp ends, and a released lane never blocks a relaunch
status: open
workload: wl-mvidsu83epvpj4
pr: none
---
**Why:** after a lane released its workload, wrote `released-open:` or wrote `done-because:`, its omp rpc child often stayed alive. In omp 18.8.6 rpc mode `pi.shutdown()` only requests shutdown, and the process exits once background work drains, so an unsettled background job kept omp up. The runner (`surface/scripts/lane.ts`) then waited the full 15-minute settle window, and the starter refused every relaunch with `lane reserve: <wl> not launched: held: <lane> still running (omp pid N)` (exit 7). Reported in jo-issues #184 (https://github.com/thewolff/jo-issues/issues/184), jo-issues #47 (https://github.com/thewolff/jo-issues/issues/47) and agent-system-2.0 #283 (https://github.com/thewolff/agent-system-2.0/issues/283). Plan: `/Users/jowolff/agent-scratch/agent-system-2.0/wl-mvidsu83epvpj4/PLAN.md` rev 9.

**What changes**
- **Self-release is read from the holder history.** A lane released itself when its own newest holder change goes to none or jo and was written by that lane. A lease lapse, a takeover, or a release by the runner or the starter is not a self-release.
- **The runner decides at once.** After a self-release, the runner skips the settle wait and the continue and hold steps and decides the outcome: handed off, released, `open-work` for a `released-open:` marker, else completed. A `done-because:` receipt alone skips only the settle wait. Both are checked on the runner's own `prompt_result` and in the stop poll, so a release or receipt written by a woken turn is caught too.
- **The runner's renewal never re-claims.** It uses a new `Ledger.renewLease`, which extends the lease only while the lane is still the holder and writes no holder change, so a release cannot be undone between its snapshot and its renewal.
- **The runner ends omp.** stdin EOF first, SIGTERM after 10 s (`AGENT_SYSTEM_LANE_SHUTDOWN_GRACE_MS` for tests), SIGKILL 30 s after that, then `lane-exit:` is written. This is one path for every `end()` caller.
- **The starter admits past a self-released lane.** A self-released lane's live omp or runner pid no longer refuses a reservation, on the launch and the interactive path. The starter does not wait, so the surface's 30 s launch timeout is unaffected.
- **The spawning process ends the stale omp.** The runner (before its spawn) and `lane.ts interactive` (before its TUI) read the self-released lanes without a `lane-exit:` from the ledger and end their omps under one 60 s aggregate deadline. A signal goes only to a pid whose `ps -p <pid> -o stat=,lstart=` still matches the recorded start time. Every ps or kill failure is reported and never thrown, and the spawn proceeds regardless. A stop accepted during that cleanup, by signal or by ledger stop request, spawns no omp and writes `lane-exit: … outcome stop`.
- **Lanes that did not release themselves still refuse.** A lapsed lease, a crash mid-turn, a takeover, or an uninspected or unverified pid still gives `held: … still running`, as the wl-mvggzumu8zs5xc incident replay requires.
- **OS-independent.** Only `ps -p … -o stat=,lstart=`, `process.kill` and Bun child `kill` are used. Nothing reads or writes launchd.

**Not changed:** the end of by-hand interactive lanes themselves (omp runs in Jo's terminal), and why omp's own deferred shutdown does not fire while background work is pending (omp upstream).

**Cost:** a released lane's pending background job is killed rather than awaited. Its tools already refuse after release, so it could write nothing to the ledger. A spawn can wait up to 60 s when a stale omp ignores SIGTERM.
