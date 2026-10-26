---
title: The test runner runs the files of a PR's full part in parallel
status: building
workload: wl-mvg2kzuvwngdmo
pr: 272
---
Workload `wl-mvg2kzuvwngdmo` (normal stakes, plan revision 4 at `~/agent-scratch/agent-system-2.0/wl-mvg2kzuvwngdmo/PLAN.md`, approved by Jo; measurements in `MEASURE.md` beside it).

**Measurement (2026-10-19).** The 26 finished runs held the lock for 500 minutes. The full pass took 412 of them (82 %), and it ran serially: one `bun test` process on a 14-core machine. 14 of those 26 runs waited over 30 minutes for the lock, the longest 150 minutes (`tr-0mvfrkc9ssiin1n`, PR #158). One file, `surface/test/lane-script.test.ts`, took about 30 % of each pass.

**What changed.**
- A new config key, `testRunner.fullWorkers`: an integer of 1 or more, default 1. `profile/config.yml` sets it to 6. The runner writes it into the run's `caps.json` and logs `full workers <n>` to `runner.log` before the full part.
- The PR's full part runs `bun test --parallel=<n>` when the value is over 1. The wrapper's argv does not change.
- `base-full` always runs serially. A test that fails only under `--parallel` then fails on the PR and passes on base, so the run is red, never red-main. The base cache holds only serial results.
- The split of `surface/test/lane-script.test.ts` (about 290 s, the floor of a parallel pass) is deferred by Jo's word (in-mvg5jvjprdc2dc) to `migration/items/test-runner-split-lane-script.md`.
- A new tool, `surface/scripts/test-run-waits.ts`, prints each run's wait, worker count, full duration and verdict for a day, and lists tests that failed for two or more PRs that day. With `--qualify` it is the gate for this workload's done line.
- The run lock, the queue and the one-run-at-a-time model are unchanged.

**Reversal.** Set `fullWorkers: 1` in `profile/config.yml`. The runner picks it up at the first run after the installed tree carries the change; a run in flight keeps the caps it wrote.

**Rejected.**
- Two run slots at once: the fence and the sweep assume one run per uid, so it needs a second account and per-slot lock code. It stays the fallback.
- Lanes run only the tests their change touches: it changes the done rule and the close check, and it misses spawn-based tests such as lane-script.

**Completion.** Merging is not the end. The workload stays open until a measured day qualifies under PLAN.md § 4: `test-run-waits.ts --day <day> --qualify --workers 6 --merge <merge sha> --repo <checkout>` exits 0. That needs a finished day with at least 10 activated, error-free PR full parts, every run terminal, no wait over 30 minutes and no suspect. A full-part error or a suspect on that day files the reversal first.

**Train return repair.** Publication uses the existing shared post-sweep deadline for retries on either database. The ledger's retry loop no longer nests inside the runs database's retry loop. Persistent contention writes a local error and releases the run lock; transient contention may still publish and settle atomically before the deadline. The full-suite time cap is unchanged.
