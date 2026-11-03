---
title: A decision-log-only commit never costs a full test rerun on the merge train
status: building
workload: wl-mvpwkpqobyp20w
pr: 320
---
Workload `wl-mvpwkpqobyp20w` (normal stakes, plan revision 4 at `~/agent-scratch/agent-system-2.0/wl-mvpwkpqobyp20w/PLAN.md`). Built on branch `wl/wl-mvpwkpqobyp20w`, PR #320.

**Evidence.** PR #305 was green at `aebe37a4`. Then `close-entry.ts` committed one decision-log entry, `cde03460`, on the PR branch. That commit has one parent and touches one file under `.ai/decision-log/`. The train did not accept the green at the new head. It needed a fresh full run, and the runner made it wait 49 minutes, from 3:50 PM to 4:39 PM PDT on 2026-10-26. PR #309 had the same shape: green at `3edec08a`, decision-log commit `c6e3430f`. The saved GitHub answers for #305 are the fixture `surface/test/fixtures/train-carry-305/`.

**Cause.** One rule already says when a green survives a decision-log-only commit: `decisionLogFault` / `decisionLogOnly` in `surface/src/test-run.ts`. Only the close path used it. Task settle waited for a green at the exact head. Boarding in `surface/scripts/train-tick.ts` used its own inline commit walk, which never checked parent counts, so a merge commit touching only the decision log boarded. The runner had no way to answer for a head past its green, and main's strict ruleset requires the `as2/full-suite` status on the head. Only the test runner posts that status.

**What changes.** There is still one rule. Every caller passes a `CompareResult` to `decisionLogFault`.

- **One GitHub compare builder.** `ghCompare(repo, from, to, ghJson)` in `surface/src/merge-train.ts` builds the `CompareResult` from GitHub: status, commit count, each commit's parent count and files (all pages; a rename counts both paths). It returns `{ ok: false, reason }` when GitHub cannot answer completely. It decides nothing. `from === to` is `identical` with no gh call.
- **Settle.** A train task settles `fixed` on a green at S when the PR head passes `decisionLogFault(compare(S, head))`. The evidence reads `run <id> green at <S>, head <head> decision-log only`. A missing compare faults, so nothing carries without evidence. `carryPairs` lets the tick fetch the compares before its ledger write, so no gh call holds the ledger lock.
- **Boarding.** `liveHalf` drops its inline commit walk. A head past the green G boards only when `decisionLogFault(ghCompare(G, head))` is null. Behaviour change: a merge commit after the green no longer boards.
- **Landing, in the test runner.** For a merge train's `lane_full_test` at a head that is decision-log-only past the PR's authoritative green, the starter in `surface/scripts/test-runner.ts` carries the green. The authority is the last `test-requested:` for the PR in ledger order across the train, the head-branch workload and its fix workloads. A newer red, error, stale or pending request blocks the carry. The starter writes a `test-run:` green at the head whose reason is `carried from <R> at <S> (decision-log only)`, with the counts of the carried run, and spawns no suite. After the commit it posts `as2/full-suite` success on the head and prints its usual line plus ` carried <R>`. A failed post is logged and the verdict stands. Anything else falls through to today's run. Non-train requests are untouched.
- **Train brief.** `trainBrief` gains two sentences, and step 7d gains a status-repair step. A head ahead of its green only by decision-log commits is tested by calling `lane_full_test`. When the starter's line ends ` carried <R>`, the slice is already green at that head. When the first merge is refused, the train goes back to step a. If a. passes on the same head, the train adds the next `-full-<r+1>` slice and calls `lane_full_test` once, so the starter re-posts the status from the identical green. A moved head or main routes to steps 2 or 3 as before. The second refused merge is `train-error: pr <n> merge-refused`, as today.

**Not changed.** The close path's own git builder and `closeFreshness`. Non-train `lane_full_test` requests. `close-entry.ts` still commits decision-log entries on PR branches.

**Tests.** New and extended tests in `surface/test/train-return.test.ts`, `surface/test/train-tick.test.ts` and `surface/test/test-runner.test.ts`, built on the #305 fixture. They cover a carry, a non-decision-log path, a merge commit, a newer non-green, reversed completion order, a source change mid-carry, a failed status post and its repair, and no gh call inside the carry transaction.
