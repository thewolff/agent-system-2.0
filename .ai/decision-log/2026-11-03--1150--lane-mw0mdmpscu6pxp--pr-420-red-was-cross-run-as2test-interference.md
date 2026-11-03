---
status: resolved
durable: false
author: lane-mw0mdmpscu6pxp-1
date: 2026-11-03
---

# PR #420's red full runs were cross-run as2test interference, not a defect in the PR

## Decision

Merge-train task tt-mw0lm73qpziirt (train wl-mw05au5wioxw4a) returned PR #420 red at head b441ab02. Fix workload wl-mw0mdmpscu6pxp changes no code: this commit gives the PR a new head, and the train works it from step 1 there.

## Why

- The two red runs, tr-0mw090uqiwjc6z1 and tr-0mw0byc3pdjiv1e, failed only `surface/test/as2test.test.ts` "the refresh helper" T5 and F2. Both compare a host-wide scan of `/private/tmp/as2test-refresh.*` before and after a run, so another as2test run on the host shows as a leaked build dir.
- PR #420's diff against origin/main touches neither that test file nor the refresh helper in `surface/src/as2test.ts`.
- A later full run at the same head, tr-0mw0lo2m843vp24 (2026-11-03 11:40Z), is green: 7936 pass, 0 fail, T5 and F2 among the passes.
- The dir run 1's F2 named, `as2test-refresh.JuwujR`, no longer exists, and the `/private/tmp` dirs owned by jowolff (not the runner's `_as2test` user) from 05:59Z and 06:50Z line up with both red runs: an as2test run outside the runner was live at the same time.

## Dead ends

- Porting the rig-scoped check (PR #430's 071c28c1, `leftBuilds` in place of the `/private/tmp` scan) onto #420: it rewrites the same 1000 lines #430 does and would conflict when #430 lands. That fix stays with #430.
- An empty commit for the new head: P-11 row 6 refuses `git commit --allow-empty` as a form it does not model.
