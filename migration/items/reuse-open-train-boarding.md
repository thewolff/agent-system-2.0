---
title: Auto-boarding reuses the repository's open main train instead of creating a replacement
status: building
workload: wl-mvh33rgh9gisqo
pr: 302
---

## Problem and scope

For [jo-issues #174](https://github.com/thewolff/jo-issues/issues/174), Jo narrowed this workload to the smallest `boardLanding` fix. Previously, a train opened before auto-boarding cutover, at half its dollar/wall ceiling, or with a standing completion receipt could cause auto-boarding to create another open train.

This is a code-fix shipping record, not a ledger schema migration. There is no PR #72 dependency, schema change, live fold, external merge queue or runtime cutover.

## Behavior

`boardLanding` in `surface/src/merge-train.ts` now selects the repository's newest open train inside its existing `ledger.write` transaction. The train procedure still targets `main`:

- An active open train takes the ready PR regardless of train creation date or spend; ordered membership is retained.
- Jo's stop or an effective standing `done-because:` leaves the PR pending without a board or another workload. After actual closure, a successor may open. Pending candidates remain subject to the existing 14-day scan window.
- A new train opens only when no matching open train exists. Existing worked-PR and already-boarded refusals remain.
- Full-ceiling launch enforcement is unchanged. Boarding does not authorize a launch beyond that ceiling.

This prevents second-train creation only through `boardLanding`. It does not enforce SQL uniqueness, change `applyTrain` or repair existing duplicates. Fold, snapshot migration and reader cutover are separately tracked in [agent-system-2.0 #300](https://github.com/thewolff/agent-system-2.0/issues/300).

## Verification and platforms

`surface/test/train-board.test.ts` covers ready-PR reuse on an existing Jo train, pre-cutover and exact half/full dollar/wall states, held/effectively-done pending behavior, close-before-successor, newest selection among historical duplicates, repo identity across checkouts and unchanged membership/workload counts. Obsolete expectations that required replacement trains were removed.

An isolated real-Ledger smoke exercised `landingReady` and `boardLanding`, inspected IDs, ordered members and workload rows, and observed reuse, pending refusals and successor-after-close. No live ledger was opened. Changed logic is OS-independent TypeScript using existing APIs; runtime proof ran on macOS, not Linux.

## Rollback

Revert this PR's code, tests and documentation. No schema/data restore is required; already-boarded PRs remain on their trains.
