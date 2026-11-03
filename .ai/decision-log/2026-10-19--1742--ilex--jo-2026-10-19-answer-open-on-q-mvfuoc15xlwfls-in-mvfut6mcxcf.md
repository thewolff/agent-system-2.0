---
date: 2026-10-19T17:42-07:00
engineer: Ilex
session: wl-mvfutg9edknu2o
status: resolved
durable: false
supersedes:
workload: wl-mvfutg9edknu2o
---

# Jo (2026-10-19, answer `open` on q-mvfuoc15xlwfls, in-mvfut6mcxcf3ls), flow fix under the flow-repair ruling in-mvfiztvfi7ez28: make the full-suite test runner serve waiting runs oldest first.

Problem: the runner lock in surface/scripts/test-runner.ts acquire() (around lines 610-640) is taken by whichever queued run polls first after release; every queued run polls every 2 s (AGENT_SYSTEM_TEST_RUNNER_POLL_MS) and INSERT OR REPLACEs the one-row lock table in ~/.agent-system-2/test-runs/runs.db once the holder is gone or stale. There is no order. Observed 2026-10-19: PR #158's run tr-0mvfrkc9ssiin1n (requested ~21:2xZ) and PR #257's run tr-0mvfrs8f6q8i6vq (requested 21:32Z) were passed over for 75+ minutes by later runs tr-0mvftcytmj9ir1h (#264) and tr-0mvfsoz4zpgvr95 (#246). Lane reports: msg-mvftk96yh3o4jk, msg-mvfuekpqr1siyo. queueMaxMin is 1440 in profile/config.yml, so starved runs wait up to a day.

Change: waiting runs take the lock in request order (oldest test-requested first), while keeping the existing stale-holder takeover, the startup lease, queued-too-long, superseded/stale-sha handling and the one-run-per-workload reservation. A waiter whose request is dead (no heartbeat/stale, or settled) must not block the queue. Regression test that fails before the change (e.g. three queued runs, release, the oldest acquires). Migration item if the runs.db schema changes. Full suite via lane_full_test on a pushed PR. Do not disturb the live run tr-0mvfsoz4zpgvr95 or other live runs while working; test against a scratch runs root.

done: A regression test shows queued full-suite runs acquire the runner lock oldest-request first (and a dead waiter does not block the queue), it failed before the change, and the full suite is green at the head of a pushed PR in agent-system-2.0.
done-because: PR #266 (https://github.com/thewolff/agent-system-2.0/pull/266) is green at its head 59ea958: test run tr-0mvfwafntpl6hgm, 5458 pass, 0 fail, 94 skipped, en-mvfyjmxowc3lkw. In surface/test/test-runner.test.ts, "the lock queue" T1 shows queued runs acquire the runner lock in oldest-request order, including on a stale-holder takeover. T2 and T2b show dead waiters are pruned and never block the queue, while live ones do block. T3 shows a waiter pruned while suspended rejoins in its old place. T4 in test-run.test.ts unit-tests the helpers. T1 failed on the base 251e354 sources in scratch on its ordering assertion: C acquired while the older A was stopped (sl-fifo-change artifact). The plan passed cross-lab review at r3 and Jo approved it (q-mvfvaxizbkiiv4). Cross-lab code review: pass, no findings. Migration item migration/items/test-runner-fifo-queue.md. Jo integrates; the lane does not merge.

Rendered from the ledger by Ilex (they/them) at workload close; stakes normal, mode autonomous, opened 2026-10-19T22:56:57.746Z.

## What changed

- sl-plan-runner-fifo: Plan the oldest-first runner lock: slice cut, requirements with enforcers, cross-lab plan review, plan question to Jo — artifact: Jo approved q-mvfvaxizbkiiv4 (in-mvfvmll9ufqtq8); plan /Users/jowolff/agent-scratch/agent-system-2.0/wl-mvfutg9edknu2o/PLAN.md rev 3, review pass r3 openai-codex/gpt-6.1-sol PLAN-REVIEW-r3.md
- sl-fifo-change: Implement PLAN.md D1-D7 (runs.db queue, oldest-first acquire, dead-waiter pruning, migration item) with tests T1-T4 and the fails-before proof — artifact: commit 3019eda on wl/wl-mvfutg9edknu2o. `bun test surface/test/test-runner.test.ts -t "the lock queue"` → 4 pass 0 fail (lane run). Hand: both files 129 pass 0 fail; test-runner.test.ts 57/0 twice more. Fails-before on base 251e354 sources in $AS2_SCRATCH/failsbefore: T1 0 pass 1 fail at the ordering assertion (C acquired, displaced tr-otherholder, while A stopped).
- sl-fifo-codereview: Cross-lab code review of 251e354..3019eda against PLAN.md rev 3; findings only — artifact: cross-lab review (strong hand) of 251e354..3019eda: verdict pass, review-findings {"findings":[]}; agent://sl-fifo-codereview
- sl-fifo-pushpr: Merge origin/main, run the declared artifact on the final tree, push wl/wl-mvfutg9edknu2o, open the PR — artifact: https://github.com/thewolff/agent-system-2.0/pull/266 head 59ea958 (origin/main merged at 05fd226); `bun test surface/test/test-run.test.ts` → 72 pass 0 fail on that tree; `bun test surface/test/test-runner.test.ts -t "the lock queue"` → 4 pass 0 fail after the merge
- sl-full-mvfutg9edknu2o-1: full suite outside the fence at PR #266 — artifact: test-run tr-0mvfwafntpl6hgm: green at 59ea9581444e9807dfbbf038f5024328fc82f202 on PR #266; full 5458/0/94; alone: ./surface/test/test-run.test.ts 72/0, ./surface/test/test-runner.test.ts 57/0; /Users/jowolff/.agent-system-2/test-runs/tr-0mvfwafntpl6hgm

## Decisions made (and why)

- jo answered "approve" to q-mvfvaxizbkiiv4 (/Users/jowolff/agent-scratch/agent-system-2.0/wl-mvfutg9edknu2o/PLAN.md
- sl-fifo-change: runs.db queue table; acquire registers, prunes dead waiters, yields to older live ones; tests T1-T4; fails-before on base
- sl-fifo-review: cross-lab code review of the diff against PLAN.md, findings only
- sl-fifo-pr: merge origin/main, artifact green, push, PR, lane_full_test green at head; Jo merges
prompt-only: R5: T1 fails on base code: a one-time scratch run recorded in the slice artifact, no permanent code re-runs it
prompt-only: R7: live runs and the live runs root untouched: a working discipline; tests use world() scratch roots
tradeoff: runners already on old code at deploy ignore the queue until they end; FIFO is exact once all waiters run new code
tradeoff: each attempt reads other waiters' heartbeat files and ledger rows inside the runs.db transaction
tradeoff: strict FIFO: a stale-sha or superseded request still waits its turn, then ends within seconds
review: pass r3 no findings, openai-codex/gpt-6.1-sol, /Users/jowolff/agent-scratch/agent-system-2.0/wl-mvfutg9edknu2o/PLAN-REVIEW-r3.md)
- assumption (orchestrator-surface): brief-judged: change-small confidence 0.40 judge typesafe/jev-1.13.0
- assumption (classifier): pair-exposure: lane-mvfutg9edknu2o-1 on
- assumption (classifier): pair-signal: taste no 1 ambiguous no 0.98 judge typesafe/jev-1.13.0 tokens 1033 cost 0.000043386
- assumption (lane-mvfutg9edknu2o-1): builder-lab: anthropic lane lane-mvfutg9edknu2o-1 model anthropic/claude-opus-5-5
- assumption (lane-mvfutg9edknu2o-1, sl-plan-runner-fifo): hand-spawn: dt-mvfuwrjb1c70f09c session /Users/jowolff/.agent-system-2/lanes/wl-mvfutg9edknu2o/sessions/2026-10-19T22-57-00-617Z_01a15661-ecc9-7000-bae1-43a62a42e31f spawn sl-plan-runner-fifo review yes group dg-mvfuwrjbb319cac2 row openai-codex/gpt-6.1-sol
- assumption (lane-mvfutg9edknu2o-1, sl-plan-runner-fifo): hand-settled: dt-mvfuwrjb1c70f09c routing rt-mvfv1iifqln7r4
- assumption (lane-mvfutg9edknu2o-1, sl-plan-runner-fifo): review-round: sl-plan-runner-fifo round 1 token dt-mvfuwrjb1c70f09c group dg-mvfuwrjbb319cac2 verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{"correctness":1,"tests":3},"minor":{}},"titles":[{"severity":"major","kind":"correctness","title":"A pruned waiter never restores its queue membership when it resumes"},{"severity":"major","kind":"tests","title":"Pre-loop registration bypasses the contention signal existing lock tests await"},{"severity":"major","kind":"tests","title":"T1 and T2 rely on a polling-time gap rather than a deterministic fails-before barrier"},{"severity":"major","kind":"tests","title":"T2 can omit real dead queue rows and T2/T3 do not cover every R2 liveness branch"}]}
- assumption (lane-mvfutg9edknu2o-1, sl-plan-runner-fifo): review-loop-end: sl-plan-runner-fifo reason pass
- assumption (lane-mvfutg9edknu2o-1, sl-plan-runner-fifo): hand-spawn: dt-mvfv3tf1c380dd8e session /Users/jowolff/.agent-system-2/lanes/wl-mvfutg9edknu2o/sessions/2026-10-19T22-57-00-617Z_01a15661-ecc9-7000-bae1-43a62a42e31f spawn sl-plan-runner-fifo-2 review yes group dg-mvfv3tf1c46f4c9a row openai-codex/gpt-6.1-sol
- assumption (lane-mvfutg9edknu2o-1, sl-plan-runner-fifo): hand-settled: dt-mvfv3tf1c380dd8e routing rt-mvfv64dehcsxs0
- assumption (lane-mvfutg9edknu2o-1, sl-plan-runner-fifo): review-round: sl-plan-runner-fifo round 1 token dt-mvfv3tf1c380dd8e group dg-mvfv3tf1c46f4c9a verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{"tests":1},"minor":{"tests":1}},"titles":[{"severity":"major","kind":"tests","title":"SIGSTOP can freeze A inside its acquiring transaction; the barrier lacks freshness bounds and failure-safe cleanup"},{"severity":"minor","kind":"tests","title":"Round-one live adapter counterparts remain covered only by pure-helper unit tests"}]}
- assumption (lane-mvfutg9edknu2o-1, sl-plan-runner-fifo): review-loop-end: sl-plan-runner-fifo reason pass
- assumption (lane-mvfutg9edknu2o-1, sl-plan-runner-fifo): hand-spawn: dt-mvfv7i2iabe35b0e session /Users/jowolff/.agent-system-2/lanes/wl-mvfutg9edknu2o/sessions/2026-10-19T22-57-00-617Z_01a15661-ecc9-7000-bae1-43a62a42e31f spawn sl-plan-runner-fifo-3 review yes group dg-mvfv7i2i245c741e row openai-codex/gpt-6.1-sol
- assumption (lane-mvfutg9edknu2o-1, sl-plan-runner-fifo): hand-settled: dt-mvfv7i2iabe35b0e routing rt-mvfvantsza0l4w
- assumption (lane-mvfutg9edknu2o-1, sl-plan-runner-fifo): review-round: sl-plan-runner-fifo round 1 token dt-mvfv7i2iabe35b0e group dg-mvfv7i2i245c741e verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{},"minor":{}},"titles":[]}
- assumption (lane-mvfutg9edknu2o-1, sl-plan-runner-fifo): review-loop-end: sl-plan-runner-fifo reason pass
- assumption (lane-mvfutg9edknu2o-1, sl-fifo-change): hand-spawn: dt-mvfvnibx2daa9938 session /Users/jowolff/.agent-system-2/lanes/wl-mvfutg9edknu2o/sessions/2026-10-19T22-57-00-617Z_01a15661-ecc9-7000-bae1-43a62a42e31f spawn sl-fifo-change review no group dg-mvfvnibx60b528ed row anthropic/claude-opus-5-5
- assumption (lane-mvfutg9edknu2o-1, sl-fifo-change): hand-settled: dt-mvfvnibx2daa9938 routing rt-mvfw5w7jigaeio
- assumption (lane-mvfutg9edknu2o-1, sl-fifo-change): artifact-command: bun test surface/test/test-runner.test.ts -t "the lock queue"
- assumption (lane-mvfutg9edknu2o-1, sl-fifo-codereview): headroom-skip: anthropic/claude-opus-5-5 token dt-mvfw6sk896c83e5e anthropic 5h 0.93 used > 0.80
- assumption (lane-mvfutg9edknu2o-1, sl-fifo-codereview): hand-spawn: dt-mvfw6sk896c83e5e session /Users/jowolff/.agent-system-2/lanes/wl-mvfutg9edknu2o/sessions/2026-10-19T22-57-00-617Z_01a15661-ecc9-7000-bae1-43a62a42e31f spawn sl-fifo-codereview review yes group dg-mvfw6sk88f0b1153 row openai-codex/gpt-6.1-sol
- assumption (lane-mvfutg9edknu2o-1, sl-fifo-codereview): hand-settled: dt-mvfw6sk896c83e5e routing rt-mvfw8ihct6q70g
- assumption (lane-mvfutg9edknu2o-1, sl-fifo-codereview): review-round: sl-fifo-codereview round 1 token dt-mvfw6sk896c83e5e group dg-mvfw6sk88f0b1153 verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{},"minor":{}},"titles":[]}
- assumption (lane-mvfutg9edknu2o-1, sl-fifo-codereview): review-loop-end: sl-fifo-codereview reason pass
- assumption (lane-mvfutg9edknu2o-1, sl-fifo-pushpr): artifact-command: bun test surface/test/test-runner.test.ts -t "the lock queue"
- assumption (lane-mvfutg9edknu2o-1, sl-fifo-pushpr): artifact-command: bun test surface/test/test-run.test.ts

## Dead ends — don't retry these

- none

## Heads-up for whoever touches this next

- message msg-mvfw9bstxf7bb4 [held] not acted on: artifact-failed: P-11 row 8 refused push 1 in a row on this slice (tool call toolu_012HGk8WVQg4gpzedVoJ212z): P-11 row 8 refused this push: no passing test record on this workload is for the pushed tree e271f9cd4f27 ('wl/wl-mvfutg9edknu2o'); the workload has 3 test records for /Users/jowolff/code/agent-system-2.0-lanes/wl-mvfutg9edknu2o, none from a bare test-runner command (the newest: `bun test surface/test/test-runner.test.ts -t "the lock queue"`). Bring origin/main in (`git fetch origin && git merge origin/main`, or a rebase that rewrites nothing already pushed), then run the slice's declared test artifact (slice_artifact) on that tree with nothing left uncommitted. The artifact must be a bare test-runner command (no pipe, `cd`, `||`, `;` or redirection), and it must finish in the foreground: OMP backgrounds a bash call after its auto-background threshold (60 s by default) and a backgrounded run records nothing, so split a long suite into several declared artifacts. If bringing origin/main in would rewrite commits already on the remote, stop and report; that force-push is § A4 reserved. Then push in its own command. Command: git push -u origin wl/wl-mvfutg9edknu2o
- message msg-mvfw9bt3eib1ts [held] not acted on: artifact-failed: P-11 row 8 refused push 2 in a row on this slice (tool call toolu_01LUjnVCkBwzbFWUktYGwzxj): P-11 row 8 refused this push: no passing test record on this workload is for the pushed tree e271f9cd4f27 ('wl/wl-mvfutg9edknu2o'); the workload has 3 test records for /Users/jowolff/code/agent-system-2.0-lanes/wl-mvfutg9edknu2o, none from a bare test-runner command (the newest: `bun test surface/test/test-runner.test.ts -t "the lock queue"`). Bring origin/main in (`git fetch origin && git merge origin/main`, or a rebase that rewrites nothing already pushed), then run the slice's declared test artifact (slice_artifact) on that tree with nothing left uncommitted. The artifact must be a bare test-runner command (no pipe, `cd`, `||`, `;` or redirection), and it must finish in the foreground: OMP backgrounds a bash call after its auto-background threshold (60 s by default) and a backgrounded run records nothing, so split a long suite into several declared artifacts. If bringing origin/main in would rewrite commits already on the remote, stop and report; that force-push is § A4 reserved. Then push in its own command. Command: git push -u origin wl/wl-mvfutg9edknu2o
- message msg-mvfw9g8r1mhnnk [held] not acted on: artifact-passed: `bun test surface/test/test-run.test.ts` exited 0 (tool call toolu_018jr3NqpfTjF2bTVM2s4FNo)
- message msg-mvfw9kmrddg6f4 [held] not acted on: artifact-passed: push let through by P-11 row 8 succeeded (tool call toolu_01FrnPfqyWNXmVtyeTdhKcc7)
- message msg-mvfykamh4jvbpc [held] not acted on: PR #266 is green at 59ea958 and ready for Jo to merge (tr-0mvfwafntpl6hgm: 5458 pass, 0 fail). It makes queued full-suite runs take the runner lock oldest request first, and dead waiters no longer block the queue. The regression test T1 failed on the old code: the youngest waiter took the lock while the oldest was paused. Plan and code both passed cross-lab review. One deploy note: runners already running when this merges still use the old code and ignore the queue until they finish. The order is exact from then on, once the installed runner is refreshed. This lane does not merge.
