---
status: resolved
author: plumb
date: 2026-10-28
---

# The merge train's tick runs at Standard priority

## Decision

`install/com.agent-system-2.train-tick.plist` sets `ProcessType` to `Standard` instead of `Background`. `install/com.agent-system-2.chaos.plist` gets the same change, because the nightly chaos run also starts omp sessions and lanes under timeouts (`surface/scripts/chaos.ts`: `omp -p` runs, the `omp --mode rpc` start, and the scratch ledger's `lane-started:` processes). The pure maintenance jobs (daily-report, ledger-backup, phoenix, scratch-sweep) stay on `Background`.

## Why

jo-issues #213 (https://github.com/thewolff/jo-issues/issues/213#issuecomment-6464528667). launchd's `Background` process type makes darwin throttle the job and everything it launches: priority 4 instead of 31, about 10x slower. The tick launches merge-train lanes, and those lanes request full-suite test runs, so the full runs hit their 20-minute cap.

The debugger evidence: 8 of 8 slow-mode timeouts came from lanes the train launched, and 0 of about 40 came from other lanes. Same-tree controls: 1d071e8f timed out from a train lane and went green in 442 s from a tick lane; 7012bc53 timed out and then went green in 477 s.

## Live state

The live plist at `$HOME/Library/LaunchAgents/com.agent-system-2.train-tick.plist` was switched to `Standard` by hand before this change. This change makes the repo template agree, so a reinstall with the train-tick flag no longer restores the throttle. The live chaos plist is unchanged until it is reinstalled.
