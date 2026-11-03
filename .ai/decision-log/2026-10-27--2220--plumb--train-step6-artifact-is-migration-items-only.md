---
status: resolved
author: plumb
date: 2026-10-27
---

# The merge train's step 6 local artifact is migration-items only

## Decision

Step 6 of the merge train brief (`surface/src/merge-train.ts`, `trainBrief`) declares the slice artifact as a bare `bun test surface/test/migration-items.test.ts`. It no longer runs the PR's changed test files.

## Why

jo-issues #240 (https://github.com/thewolff/jo-issues/issues/240), part 1. The train lane runs step 6 inside its sandbox-exec fence, and the fence denies setuid `/bin/ps`. Every lane-script, lane-model-script and as2test test then waits out the 30 s lane-exit `until` (surface/test helpers.ts:368), so step 6 timed out at 900 s or 1800 s and failed the train attempt. `lane_full_test` runs the full suite outside the fence, where `ps` works, and already covers the PR's changed test files.

## Interim instruction

Jo's instruction on the train, in-mvrnklogjnm4pn: "until merge-train.ts step 6 is fixed, the local artifact is `bun test surface/test/migration-items.test.ts` only, for every PR; changed test files are covered by lane_full_test outside the fence." Once this change merges and the live checkout is updated, that interim instruction can be retired.

## Not in scope

The fence itself, `lane_full_test`, and the lane tests' `ps` usage (jo-issues #240 part 2).
