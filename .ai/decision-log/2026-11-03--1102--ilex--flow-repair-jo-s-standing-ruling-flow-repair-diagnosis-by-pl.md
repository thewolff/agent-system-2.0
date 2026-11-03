---
date: 2026-11-03T11:02-08:00
engineer: Ilex
session: wl-mw0zbp43e2vrg7
status: resolved
durable: false
supersedes:
workload: wl-mw0zbp43e2vrg7
---

# Flow repair (Jo's standing ruling flow-repair; diagnosis by Plumb, 2026-11-03 ~17:47Z): main's GitHub Actions Linux job "linux (ubuntu-latest)" is red on every main run since 2026-11-02 21:30Z.

Cause: `gh run view 41681113340 --log-failed` shows 7149 pass, 73 skip, 3 fail, all in gates/test/routine-gate.test.ts:
- :269 "the fence wraps an auto-applied gh read…"
- :283 "an auto-applied scratch rm runs under the confined profile"
- :564 "R32: an rm in the own worktree auto-applies…"
They assert the sandbox-exec wrapper string, which is macOS-only. fence.ts:99-101 probes sandbox-exec and fails closed on Linux, so no wrapper is produced. fence.test.ts and scratch-fence.test.ts are listed in profile/config.yml testRunner.macOnly; routine-gate.test.ts is not.

Change: guard those three tests on sandbox-exec availability, the way fence.test.ts does, so the rest of routine-gate.test.ts keeps running on Linux. Do not add the whole file to macOnly. Do not change gate code.

Done when: the Linux job is green on the PR, and the full suite is green through lane_full_test.

## How it fails
- The guard skips the tests on macOS too. Surfaces as the three tests not running in the Mac full suite. Recovery: key the guard on the same sandbox-exec probe fence.test.ts uses, and check the Mac run's executed count for those three tests. Retry bound: 2 attempts.
- Another macOS-only assertion surfaces in the Linux job after these three are guarded. Surfaces in the PR's Linux job. Recovery: guard it the same way if it asserts sandbox-exec output; otherwise report it to the orchestrator. Retry bound: one extra round, then a message.
- The Linux job stays red for an unrelated reason (runner image, Node 20 deprecation). Surfaces in the job log. Recovery: name it in the done-because and message the orchestrator. Retry bound: none.

done: The three sandbox-exec assertions in gates/test/routine-gate.test.ts are guarded on sandbox-exec availability like fence.test.ts, the GitHub Actions Linux job is green on the PR, and the full suite is green through lane_full_test.
done-because: The three sandbox-exec wrapper assertions in gates/test/routine-gate.test.ts are guarded with test.skipIf(!SANDBOX_EXEC), keyed on the fence's own load probe sandboxExecPath(process.env) (gates/src/fence.ts), the same availability check fence.ts fails closed on; R32 is split so its auto-applied worktree row and callMark assertions stay unguarded (cross-lab review round 1 minor, fixed). No gate code changed; testRunner.macOnly untouched. PR #440 (https://github.com/thewolff/agent-system-2.0/pull/440) head 46799afb: GitHub Actions linux (ubuntu-latest) success in run 41688074791. Full suite green through lane_full_test, tr-0mw103l0yv7khkt at 46799afb: 7948 passed, 0 failed, 135 skipped; its full.xml shows all four guarded/split routine-gate tests executed on the Mac with assertions (no skip). Cross-lab review sl-guard-review passed (round 2 at 46799afb: no findings). Outside the done line: the hosted macos (macos-latest) job of run 41688074791 failed one unrelated test, gates/test/printf-property.test.ts "printfOutput matches bash printf on every form it evaluates" (main's macOS job at 24dd0c90 passed it); reported to the orchestrator in msg-mw1023ej154jvq.

Rendered from the ledger by Ilex (they/them) at workload close; stakes normal, mode autonomous, opened 2026-11-03T17:46:17.187Z.

## What changed

- sl-guard-fix: Guard routine-gate.test.ts's three wrapper-string tests (:269, :283, :564) with test.skipIf on the fence's own sandboxExecPath probe — artifact: commit 5db96ccd on wl/wl-mw0zbp43e2vrg7, PR https://github.com/thewolff/agent-system-2.0/pull/440; `bun test gates/test/routine-gate.test.ts` → 23 pass, 3 skip (behaviour-under-sandbox-exec, nested sandbox), 0 fail; `-t` on the three guarded tests → 3 pass on macOS
- sl-guard-review: Cross-lab findings-only review of PR #440 (commit 5db96ccd) against the brief — artifact: Cross-lab review (openai row, strong tier). Round 1 at 5db96ccd: 0 blocking, 1 minor (R32 whole-test guard dropped row/mark coverage on Linux), fixed in 46799afb (sl-guard-split). Round 2 at 46799afb: no findings, review-findings {"findings":[]}; transcripts history://sl-guard-review, history://sl-guard-review-2
- sl-full-mw0zbp43e2vrg7-1: full suite outside the fence at PR #440 — artifact: test-run tr-0mw103l0yv7khkt: green at 46799afb3b3b5e477f820b69216a1bb05383ddf3 on PR #440; full 7948/0/135; alone: none; /Users/jowolff/.agent-system-2/test-runs/tr-0mw103l0yv7khkt
- sl-guard-split: Split R32 test: unguarded row-6 test for the auto-applied worktree row and callMark, guarded test for the fence wrapper only (review minor finding) — artifact: commit 46799afb pushed to PR #440; `bun test gates/test/routine-gate.test.ts` → 24 pass, 3 skip, 0 fail; with PATH lacking sandbox-exec (scratch nosx-bin + bun + /bin) → 21 pass, 6 skip, 0 fail, unguarded R32 row/mark test passes

## Decisions made (and why)

- assumption (orchestrator-surface): brief-judged: change-small confidence 0.94 judge typesafe/jev-1.13.0
- assumption (classifier): pair-exposure: lane-mw0zbp43e2vrg7-1 on
- assumption (classifier): pair-signal: taste no 1 ambiguous no 0.98 judge typesafe/jev-1.13.0 tokens 1056 cost 0.000044352
- assumption (lane-mw0zbp43e2vrg7-1): builder-lab: anthropic lane lane-mw0zbp43e2vrg7-1 model anthropic/claude-opus-5-5
- assumption (lane-mw0zbp43e2vrg7-1, sl-guard-fix): artifact-command: bun test gates/test/routine-gate.test.ts
- assumption (lane-mw0zbp43e2vrg7-1): how-it-fails: n/a, read-only review of a small test diff (dispatch brief sl-guard-review)
- assumption (lane-mw0zbp43e2vrg7-1, sl-guard-review): hand-spawn: dt-mw0zdy8y14db5b53 session /Users/jowolff/.agent-system-2/lanes/wl-mw0zbp43e2vrg7/sessions/2026-11-03T17-46-23-300Z_01a1a284-eec4-7000-9510-345d1fac7d29 spawn sl-guard-review review yes group dg-mw0zdy8yf311e822 row openai-codex/gpt-6.1-sol
- assumption (lane-mw0zbp43e2vrg7-1, sl-guard-review): hand-settled: dt-mw0zdy8y14db5b53 routing rt-mw0zfuunzctg4r
- assumption (lane-mw0zbp43e2vrg7-1, sl-guard-review): review-round: sl-guard-review round 1 token dt-mw0zdy8y14db5b53 group dg-mw0zdy8yf311e822 verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{},"minor":{"tests":1}},"titles":[{"severity":"minor","kind":"tests","title":"Whole-test R32 guard removes otherwise-uncovered worktree ledger-row and callMark integration assertions on Linux"}]}
- assumption (lane-mw0zbp43e2vrg7-1, sl-guard-review): review-loop-end: sl-guard-review reason pass
- assumption (lane-mw0zbp43e2vrg7-1, sl-guard-split): artifact-command: bun test gates/test/routine-gate.test.ts
- assumption (lane-mw0zbp43e2vrg7-1): how-it-fails: n/a, read-only review of a small test diff (dispatch brief sl-guard-review)
- assumption (lane-mw0zbp43e2vrg7-1, sl-guard-review): hand-spawn: dt-mw0zh61w1ecff55a session /Users/jowolff/.agent-system-2/lanes/wl-mw0zbp43e2vrg7/sessions/2026-11-03T17-46-23-300Z_01a1a284-eec4-7000-9510-345d1fac7d29 spawn sl-guard-review-2 review yes group dg-mw0zh61wed26fe8c row openai-codex/gpt-6.1-sol
- assumption (lane-mw0zbp43e2vrg7-1, sl-guard-review): hand-settled: dt-mw0zh61w1ecff55a routing rt-mw0zi6f5qne4kb
- assumption (lane-mw0zbp43e2vrg7-1, sl-guard-review): review-round: sl-guard-review round 1 token dt-mw0zh61w1ecff55a group dg-mw0zh61wed26fe8c verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{},"minor":{}},"titles":[]}
- assumption (lane-mw0zbp43e2vrg7-1, sl-guard-review): review-loop-end: sl-guard-review reason pass
- assumption (lane-mw0zbp43e2vrg7-1): PR #440 hosted CI at head 46799afb (run 41688074791): linux (ubuntu-latest) success; macos (macos-latest) failure on one unrelated test, gates/test/printf-property.test.ts "printfOutput matches bash printf on every form it evaluates" (755 pass, 1 fail). The PR changes only gates/test/routine-gate.test.ts; main's macOS job at 24dd0c90 (run 41686941599) passed, so this reads as a runner-side variance in the bash printf comparison, not caused here. Not in this workload's done line; reported to the orchestrator.

## Dead ends — don't retry these

- none

## Heads-up for whoever touches this next

- message msg-mw1023ej154jvq [held] not acted on: Linux-job repair (wl-mw0zbp43e2vrg7), PR #440 at 46799afb: GitHub Actions linux (ubuntu-latest) is green (run 41688074791). The macOS hosted job on the same run failed on one test outside this change: gates/test/printf-property.test.ts "printfOutput matches bash printf on every form it evaluates" (755 pass, 1 fail; the log-failed output carries no mismatch detail). Main's macOS job at 24dd0c90 (run 41686941599) passed it, and this PR touches only gates/test/routine-gate.test.ts. Next: none from this lane; it may need its own look if it recurs. Full suite on the runner is pending.
