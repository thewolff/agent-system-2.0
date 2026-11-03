---
title: The test runner stops wasting its one slot on solo reruns after a timeout or a green
status: open
workload: wl-mvq4edh02r5z40
pr: 324
---
Workload `wl-mvq4edh02r5z40` (normal stakes, flow repair, plan revision 3 at `~/agent-scratch/agent-system-2.0/wl-mvq4edh02r5z40/PLAN.md`). Jo's instructions in-mvq5b1c565wbnk and in-mvq5hvhq6jd728 govern it.

**What changed.**
- A full part that times out (wrapper exit 124, or the outlive sweep fired on its call) ends the run. No solo and no base parts run after it; the sweep and the head re-check still do. The verdict is `error` naming the timeout, even when the partial report holds failures or its import was refused.
- After an all-pass full part, only changed test files with no executed case in the full part's junit run alone. A file with at least one non-skipped case is covered and gets no solo part.
- After a red full part, only the failing files that are not under `gates/test/` run alone. The rerun is a diagnostic: a file that passes alone never turns the verdict green and never removes its full-part failures. A plain red says `failing in the full part; passed alone: <files>`. Security-path failures are never rerun, on the PR or on base, and a run with one is never `red-main`.
- Base comparison is `base-solo` of those same failing files only. `base-full` is gone from the runner, the wrapper's call shapes, `test-exec` and the rendered `exec` wrapper; old `full` entries under base-cache are never read. `red-main` needs every part to have reported cleanly, every full failure reproduced alone, and each of those failing on base; any gap, broken part or base error stays `red`.
- Any other full-part error (not a timeout) keeps today's changed-file solos, minus a failing security test.

**Dropped from the brief.** Two items of the original brief did not ship, by Jo's instructions:
- A 3-minute silence kill. A passing test took 210 s without a test line (`lane-script.test.ts` T6 allows 240 000 ms), so a fixed silence limit would kill healthy runs. A part is killed only at its wall cap.
- A serial rerun of failed files that turns a parallel failure green, with a `flake:` note. The rerun is diagnostic only: it never changes a red to a green.

**Stuck capture.** Before a capped part's process group is killed, `test-exec` writes `<part>.stuck.log` (`full.stuck.log`, `solo-3.stuck.log`, `base-solo-1.stuck.log`) beside the part's log: the process tree, `sample` per bun process, `lsof` per process, and the last 200 log lines. It has its own hard deadline (`captureMs`, 20 s by default), never blocks the kill, never changes the exit (124) or the timeout message, and the runner imports it into the run directory (`~/.agent-system-2/test-runs/<run id>/`) after a timed-out part. Where `ps` is refused inside the fence (a sandbox refuses its setuid exec), the process tree falls back to `pgrep`.

**Rollout.** Live after merge, once the live checkout is fast-forwarded and the `as2test` refresh rebuilds `exec` and `test-exec.js` from origin/main. No sudo setup is needed. `profile/config.yml` is not in this PR: its comments that mention `base-full` and "each changed file alone" go stale and need a later config PR.
