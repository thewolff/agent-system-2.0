---
title: Remove the overlap-fixture scheduling race from the stuck-worker runner tests
status: open
workload: wl-mvr4jkxniw1g77
pr: 343
---

The runner integration test `enforce: overlapping signatures A and B, A cleared, then a stalled exec: B's deadline still fires` now emits both signatures and A's clear in one shell `printf`, with one timestamp. Its previous one-second sleep and separate whole-second `date` calls could let A's two-second backstop expire before the fixture delivered the clear.

The exact worker-21 error and log assertions remain. Production detector code, deadlines, configuration and enforcement do not change. Existing pure `StuckWatch` tests retain coverage of distinct signature timestamps and earliest-deadline ordering.

Verification: the focused overlapping-signatures integration case passed (1 pass, 0 fail), and the pure backstop cases passed (6 pass, 0 fail). A scratch-only delayed-delivery smoke fed the shell-emitted batch after 2.2 seconds and observed A cleared with B still carrying its original timestamp-derived deadline. Full-suite verification at the pushed PR head remains the merge-train task's final outcome check.

This fixes only attempt two's overlap-fixture race. It does not claim to fix the earlier `as2test.test.ts` teardown timeout. Reversal: revert the fixture batching change; no production setting or migration is required.
