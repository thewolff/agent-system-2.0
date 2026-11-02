---
title: The test runner stops a positively stuck test worker within about 45 seconds
status: open
workload: wl-mvq8x4pkjmx69s
pr: 338
---
Workload `wl-mvq8x4pkjmx69s` (normal stakes, plan revision 5 at `~/agent-scratch/agent-system-2.0/wl-mvq8x4pkjmx69s/PLAN.md`; flow repair, jo-issues #213). It depends on the runner-waste PR (#324): the wall-cap timeout fact, the solo plan and the cap capture stay as they are, and this adds a second, separate stop reason beside them.

**What it detects.** A `bun test` worker spinning on one CPU inside `Bun.spawnSync`, with the child of that call dead but never reaped, so the call never returns and the run holds the lock until the wall cap. It is a positive identification, never a quiet period. Three facts must hold on every tick for 5 s (`persistMs`), and a break in any of them resets the count:
- The worker's marker file is flock-held. The executor adds its own `--preload` to every part; it wraps `Bun.spawnSync` and holds an exclusive `flock` on `<pid>` in a per-part marker directory for exactly the length of the call. The kernel drops the lock when the call returns, the fd closes or the worker dies, so a marker cannot outlive its call.
- The worker is hot: its CPU delta is at least 80 % of the wall delta since the previous tick.
- The same zombie child sits under the worker: state zombie, parent the worker, born within 250 ms after the marker's start time, and its command equal to the marker's command.

A healthy `Bun.spawnSync` reaps its child and returns, a call blocked on a live child or a pipe has no zombie or is not hot, and a long synchronous computation is not inside `spawnSync`, so none of them matches. Logs, output timing and other workers are never inputs, and observation spawns nothing (sysctl, `proc_pid_rusage` and `flock` reads through `bun:ffi`; `surface/src/stuck-detect.ts`). One tick is 1 s. The detector is macOS only; elsewhere it logs `stuck-detector-off` and the wall cap stays the only stop.

**It ships in shadow.** `testRunner.stuckStop` defaults to `shadow`. A match logs `stuck-signature`, then `stuck-would-stop`, takes one bounded signature capture into `<part>.signature.log` (3 s) and lets the part run on to the cap, unchanged. Nothing is stopped, and nothing about a run's verdict changes. The preload and the detector run in both modes, because shadow needs the marker.

**Switching it on.** After the field report (below) shows no false positives, add one line under `testRunner:` in `profile/config.yml`:

```yaml
testRunner:
  stuckStop: enforce
```

This PR does not edit that file. The runner writes the value into the run's `caps.json` and logs `stuck detector <mode>` at the start of each run; a run in flight keeps the caps it wrote, and the installed executor needs the refresh after merge to carry the detector. In `enforce`, a match writes `stuck-stop`, kills every process group that holds an owned process (the leader, the workers and their descendants, matched by pid and start time), verifies them gone, and exits 125 with a `stuck:` reason. The run ends as an error with that reason: never green, never red-main, no solo or base parts; failures from any junit already imported stay in the result, and the security-red rule reads them as before. The runner's backstop abandons a wrapper call 16.5 s after a `stuck-signature` if the executor stalls: after a stop line the part is stuck (`executor did not finish the stop`), otherwise the run ends as an error `executor stalled during stuck detection; worker <pid> was a candidate, not confirmed`, never a stuck-worker verdict.

**Reversal.** Remove the `stuckStop` line (or set `shadow`). The runner picks it up at the first run after the change; a run in flight keeps its caps. A value other than `shadow` or `enforce` is refused when the profile is parsed.

**Reading the field report.** The report is a markdown read of the runner's logs and results; it writes nothing and spawns nothing.

```
bun surface/scripts/stuck-report.ts --since YYYY-MM-DD [--until YYYY-MM-DD] [--root <runs root>]
```

The default root is `~/.agent-system-2/test-runs`. It keeps three things apart: candidates (a signature that appeared), decisions (`would-stop` in shadow, `stop` in enforce) and outcomes. A signature that cleared before 5 s is `cleared-before-match`: not a decision and not a false positive. Per decision the outcome is:
- `recovered` (the signature cleared after the decision) or `part-ended` (the part ended on its own after it): both are **false positives**, a hang the detector would have killed that was not one. One false positive is a reason not to enforce.
- `capped`: the wall cap fired later, so the hang was real and unrecovered; the report shows the minutes from the decision to the cap, which is what enforcing would have saved. It reads `unassessed` until someone reads the signature capture.
- `stopped`: enforce stopped the part.

Post-signature slot time is how long the lock stayed held after the first signature (lock released minus first signature), plus, when a run was waiting, how long until the next run took the lock; the report gives the worst and the p95 over decisions. Under shadow it is the cost of the hang as it ran, so it says what enforcing would save only in the `capped` rows; under enforce it is the measured recovery time and the figure to compare with 45 s. Wall-cap timeouts with no decision, `executor-stalled` errors, `containment-failed` runs, `admission-refused` runs, runs with the detector off and Bun versions are counts of their own, each with its denominator, never decisions. An interval with no decision says `no hang observed: no latency evidence`: no false positives were seen, and nothing was learned about speed either. The first production report is due one week after merge; the soak before merge is `FIELD-REPORT-<date>.md` beside the plan.

**Budget.** About 45 s is claimed for the contained path only, counted from the first signature to the next queued run taking the lock; the sum of the bounds is 39.6 s: signature visible 1 s, persistence 5 s, capture 3 s, teardown verified 3.5 s, runner poll 1 s, the one bounded sweep 12 s (about 10 s observed), head re-check and result write 12 s, containment check 0.1 s, queue poll 2 s. Two other paths are outside it:
- **Stalled executor** (enforce): the backstop abandons the call at signature + 16.5 s, then the same sweep, finalization and poll: at most 42.5 s, and the verdict is `executor stalled` (stuck, if a stop line came first).
- **Containment failed**: if an `_as2test` process is still alive after the sweep, the runner retries a bounded sweep and a spawn-free check every 5 s for up to 60 s after the stuck fact. If it never clears, the reason gains `containment failed: <pids>`, `stuck-containment-failed` is logged and counted, and the lock is released anyway. The next run's admission gate, which every run passes before its first part, retries for 30 s, then ends `admission refused: live _as2test processes <pids>` without running a part, and the refusal shows in its status. No part ever runs beside a survivor of an earlier run.

**Residuals.**
- The preload wraps `Bun.spawnSync` in every part, also in shadow: one flock, a small write and an unlock per call. It publishes a call only when every input the call reads is plain data, checked per option and read through property descriptors only: `cmd` a dense real array of strings; `env` a primitive or a plain object of primitive data; `stdio` a primitive or a dense array of primitives; any other option, `stdin`, `stdout` and `stderr` included, a primitive; and `Object.prototype` carrying no accessor but its own `__proto__`. So a held marker means the native call is running and no test getter or proxy trap runs inside it. Any other call runs unpublished: a missed detection, never a false one. That includes a call given `process.env` itself (bun gives it native accessors) and a call carrying bytes, such as a Buffer `stdin` or node's `spawnSync`/`execSync` with `input` (bun looks up `Symbol.asyncIterator` on a byte container, which can run a getter). A test that replaces `Bun.spawnSync` itself, or a `spawnSync` before the preload runs, is not covered, and the wall cap remains. A test that holds a marker lock itself can only stop its own run, as an `error`. The detector's own momentary shared lock can make one call run unpublished, counted by the report as a cap timeout with no decision.
- The lock release retries a non-blocking delete every 50 ms until the row is gone or until a waiter could take it as stale (its last heartbeat + 60 s), so the slot frees within about 50 ms of `runs.db` freeing. Only `runs.db` held by another writer up to that horizon keeps the slot past the 45 s budget; that release is logged as `the lock was not released`, the runner exits 3, and the field report counts it as `lock release failed`.
- `persistMs` of 5 s rests on the marker lock for positive identification; the pre-merge soak and production shadow data are what check it.
- Hangs outside `Bun.spawnSync` (no marker) and a nested subprocess hang while the worker sleeps are not detected.
- The real lost-reap is not reproduced deterministically. The tests build the observable state by hand (marker held, worker hot, child unreaped) and prove the wiring; only production shadow data proves the real case.
- Darwin only, as above.

**Rejected.**
- Stopping on a quiet log or on a long run: it kills slow legitimate tests, which is why the time since the last output is never an input.
- Polling with `ps` or `spawnSync` from the detector: it would add the hazard it watches for.
- Enforce as the default: the first signal has to come from shadow data, and Jo's configuration decides.

**Completion.** Merging is not the end. The item stays open until the first production field report, one week after merge, has been read and Jo has either added `stuckStop: enforce` or left it in shadow.
