---
date: 2026-10-21T14:52-07:00
engineer: Ilex
session: wl-mvidsu83epvpj4
status: resolved
durable: false
supersedes:
workload: wl-mvidsu83epvpj4
---

# Jo (2026-10-21 ~17:35Z, input in-mvidsh105ahv5s; jo-issues #184, https://github.com/thewolff/jo-issues/issues/184): "Open a normal workload in thewolff/agent-system-2.0, plan first, for https://github.com/thewolff/jo-issues/issues/184 (a flow fix: six lanes hung after release on Oct 20, two of them blocking the merge queue's own relaunch): after a lane writes released-open, done-because or its release, surface/scripts/lane.ts must end its omp rpc child (graceful shutdown, then SIGTERM after a short timeout) and write lane-exit, and the starter must treat a live pid whose lane has already released as stale instead of refusing every relaunch. Regression test: a lane that releases while its omp child stays alive still exits and the next launch proceeds. Linux: same pid logic, no launchd dependency. PR only, no merge." Context: Plumb logged the six cases on jo-issues #184 (pids 60182, 19638, 37874, 38063, 61422 and one earlier); the refusal text is "lane reserve: <wl> not launched: held: <lane> still running (omp pid N)" (starter exit 7).

done: An open, unmerged PR in thewolff/agent-system-2.0 linked to jo-issues #184 makes surface/scripts/lane.ts end its omp rpc child (graceful shutdown, then SIGTERM after a short timeout) and write lane-exit after released-open, done-because or release, makes the starter treat a live pid whose lane already released as stale, carries a regression test where a lane releases while its omp child stays alive and the next launch still proceeds, uses OS-independent pid logic with no launchd dependency, and is full-suite green at its head.
done-because: PR #304 (https://github.com/thewolff/agent-system-2.0/pull/304) is open and unmerged. Its body links jo-issues #184 and says Closes #283. Its head ff7765ed8078e244ab2e9bdb755ad3c39912de97 is green in the full suite: run tr-0mvimqigq24kcvq, 5907 passed, 0 failed, 124 skipped (/Users/jowolff/.agent-system-2/test-runs/tr-0mvimqigq24kcvq/result.json).

What the PR changes:
- surface/scripts/lane.ts now ends its omp rpc child once the lane has written released-open, done-because or its release. It closes stdin first, sends SIGTERM if omp is still running after SHUTDOWN_GRACE_MS (10 s), then SIGKILL, and then writes lane-exit:.
- liveLaneOf treats a lane that released itself as stale, so the starter no longer refuses with "held: … still running (omp pid N)".
- endStale / endStaleBeforeSpawn end such leftover omps before a new spawn. They re-probe before SIGKILL and respect the deadline.

The regression test is surface/test/lane-release-exit.test.ts (12 pass); its fails-before evidence is /Users/jowolff/agent-scratch/agent-system-2.0/wl-mvidsu83epvpj4/FAILS-BEFORE.txt. The pid logic uses only `ps -p <pid> -o stat=,lstart=` and process.kill, with no launchd. The cross-lab code review passed in round 3 (0 blocking, 0 major); its one minor was fixed in cee58219.

Two earlier red runs at the same head, tr-0mvili570kxpo6p and tr-0mvim4nbwo8jl9w, failed only on the pre-existing ledger locality df/mount flake (entry en-mvimqhubqgkrgg); that flake was reported to the orchestrator in msg-mvimqhubkzzo5c.

Rendered from the ledger by Ilex (they/them) at workload close; stakes normal, mode autonomous, opened 2026-10-21T17:23:54.243Z.

## What changed

- sl-plan-laneexit: Plan: cut slices for jo-issues #184 (lane.ts ends omp child after release + lane-exit; starter treats live pid of released lane as stale; regression test) — artifact: Jo approved q-mvif477quphq80 (in-mvifah4k6jueio); plan /Users/jowolff/agent-scratch/agent-system-2.0/wl-mvidsu83epvpj4/PLAN.md rev 9; review pass r9 openai-codex/gpt-6.1-sol /Users/jowolff/agent-scratch/agent-system-2.0/wl-mvidsu83epvpj4/PLAN-REVIEW-r9.md
- sl-docs-exit: Write migration/items/released-lane-exits.md (title, status, workload, pr front matter) — artifact: /Users/jowolff/code/agent-system-2.0-lanes/wl-mvidsu83epvpj4/migration/items/released-lane-exits.md committed in 523e361f; bun test surface/test/migration-items-repo.test.ts passed within the 370-pass 12-file run.
- sl-fix-exit: Implement PLAN.md D1-D5, D2b and the fake-omp fixture switches, with the tests the plan names, plus FAILS-BEFORE.txt — artifact: Commits fa5e5bee (fix) + 2983ac1f (merge origin/main) on wl/wl-mvidsu83epvpj4. PATH=surface/scripts/ps-shim bun test of 12 files (ledger, turn-end, lane-release-exit, lane-live-lane, lane-script, lane-model, turn-idle, migration-items-repo, lane-model-script, by-hand-context, launch, lane-run-guard) -> 370 pass 0 fail. Declared artifact `bun test surface/test/turn-end.test.ts ledger/test/ledger.test.ts` -> 89 pass 0 fail. FAILS-BEFORE: /Users/jowolff/agent-scratch/agent-system-2.0/wl-mvidsu83epvpj4/FAILS-BEFORE.txt (35 new tests fail on origin/main; 2c passes there by design).
- sl-review-exit: Cross-lab code review of the settled diff origin/main...wl/wl-mvidsu83epvpj4 against PLAN.md, findings only — artifact: Cross-lab code review round 3 (hand sl-review-exit-3, strong tier off the anthropic builder lab) on 535a109f: approve, 0 blocking, 0 major, 1 minor ("ReserveRows test fixture omits the new required holderChanges field"), fixed in cee58219 (surface/test/launch.test.ts, 79 pass). Rounds 1-2 majors (cached-identity SIGKILL; deadline bypass; no per-pid grace) fixed in 861cd9c0 and 535a109f with regressions that fail before (/Users/jowolff/agent-scratch/agent-system-2.0/wl-mvidsu83epvpj4/FAILS-BEFORE.txt).
- sl-fix-reuse: Fix review r1 major: endStale re-probes each pid before SIGKILL (no cached start-time match); regression test with a pid reused during another pid's slow probe — artifact: Commit 861cd9c0. PATH=surface/scripts/ps-shim bun test surface/test/lane-live-lane.test.ts -> 19 pass 0 fail; lane-release-exit + lane-script -> 79 pass 0 fail. New test "a pid reused while another pid's slow probe crosses the grace is not SIGKILLed" fails on the pre-fix tree (scratch reuse-check: 101 got SIGKILL), appended to /Users/jowolff/agent-scratch/agent-system-2.0/wl-mvidsu83epvpj4/FAILS-BEFORE.txt. Bare declared run failed only on the fence's ps EPERM (en-mvihxiaims76dc).
- sl-pr-exit: PR #304 open, full suite green at its head via lane_full_test; no merge — artifact: test-run tr-0mvimqigq24kcvq: green at ff7765ed8078e244ab2e9bdb755ad3c39912de97 on PR #304; full 5907/0/124; alone: ./ledger/test/ledger.test.ts 54/0, ./surface/test/lane-live-lane.test.ts 21/0, ./surface/test/lane-model.test.ts 17/0, ./surface/test/lane-release-exit.test.ts 12/0, ./surface/test/lane-script.test.ts 67/0, ./surface/test/launch.test.ts 79/0, ./surface/test/turn-end.test.ts 35/0, ./surface/test/turn-idle.test.ts 13/0; /Users/jowolff/.agent-system-2/test-runs/tr-0mvimqigq24kcvq
- sl-fix-deadline: Fix review r2 majors: endStale SIGKILL pass keeps the aggregate deadline (kill due one poll before it) and each pid gets its own grace after its SIGTERM; two regressions — artifact: Commit 535a109f pushed to PR #304. PATH=surface/scripts/ps-shim bun test surface/test/lane-live-lane.test.ts -> 21 pass 0 fail; lane-release-exit + lane-script -> 79 pass 0 fail. Two new tests fail on 861cd9c0 (882 ms vs <500; SIGKILL 52 ms after SIGTERM vs >=300), appended to /Users/jowolff/agent-scratch/agent-system-2.0/wl-mvidsu83epvpj4/FAILS-BEFORE.txt. Declared turn-end+ledger artifact 89 pass.

## Decisions made (and why)

- jo answered "approve" to q-mvif477quphq80 (/Users/jowolff/agent-scratch/agent-system-2.0/wl-mvidsu83epvpj4/PLAN.md
- sl-fix-exit: release/receipt ends the runner at once; EOF, SIGTERM 10s, SIGKILL; holder-only renewal; starter admits self-released; runner ends stale omp
- sl-docs-exit: migration/items/released-lane-exits.md
- sl-review-exit: cross-lab code review of the settled diff against PLAN.md, findings only
- sl-pr-exit: merge origin/main, declared artifact green, push, open PR (jo-issues#184, closes #283), lane_full_test green at head; no merge
prompt-only: R10: new tests fail on the pre-change tree; one scratch run against origin/main, no gate re-runs an old tree
prompt-only: R13: cross-lab review passes before done-because; the lane sequences it, no tool checks it
prompt-only: R14: PR stays open, unmerged, links jo-issues #184; lane conduct, the merge train lands it later
tradeoff: a released lane's pending background job is killed, not awaited; its lane tools already refuse after release
tradeoff: a new runner may wait up to 60 s ending a stale omp before its spawn; the starter and the surface's 30 s timeout never wait
tradeoff: a lane that did not release itself (lease lapse, crash) still refuses relaunch while its omp lives, as today
review: pass r9, openai-codex/gpt-6.1-sol, /Users/jowolff/agent-scratch/agent-system-2.0/wl-mvidsu83epvpj4/PLAN-REVIEW-r9.md)
- assumption (classifier): pair-exposure: lane-mvidsu83epvpj4-1 on
- assumption (classifier): pair-signal: taste no 1 ambiguous no 0.98 judge typesafe/jev-1.13.0 tokens 866 cost 0.000036372
- assumption (lane-mvidsu83epvpj4-1): builder-lab: anthropic lane lane-mvidsu83epvpj4-1 model anthropic/claude-opus-5-5
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): hand-spawn: dt-mvidza6a8df3a361 session /Users/jowolff/.agent-system-2/lanes/wl-mvidsu83epvpj4/sessions/2026-10-21T17-23-57-662Z_01a15f7d-ba5e-7000-85f4-c9e4c20cd7ea spawn sl-plan-laneexit review yes group dg-mvidza6a47025137 row openai-codex/gpt-6.1-sol,moonshot/kimi-k2.7-code
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): hand-settled: dt-mvidza6a8df3a361 routing rt-mvie6pdmg951c0
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): review-round: sl-plan-laneexit round 1 token dt-mvidza6a8df3a361 group dg-mvidza6a47025137 verdict accepted blocking 1 counts {"counts":{"blocking":{"tests":1},"major":{"correctness":3,"design":1},"minor":{"docs":1}},"titles":[{"severity":"blocking","kind":"tests","title":"The regression script cannot both release and remain unsettled/alive"},{"severity":"major","kind":"correctness","title":"A receipt written by a woken turn has no new prompt_result trigger"},{"severity":"major","kind":"correctness","title":"Newest lane-started can move past an already committed self-release"},{"severity":"major","kind":"design","title":"The stale-child cleanup has no aggregate pre-claim bound"},{"severity":"major","kind":"correctness","title":"Shared admission changes the interactive path without specifying its cleanup"},{"severity":"minor","kind":"docs","title":"The requirement map overstates its review enforcer and omits PR delivery constraints"}]}
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): hand-spawn: dt-mvie91z5e496e0ee session /Users/jowolff/.agent-system-2/lanes/wl-mvidsu83epvpj4/sessions/2026-10-21T17-23-57-662Z_01a15f7d-ba5e-7000-85f4-c9e4c20cd7ea spawn sl-plan-laneexit-2 review yes group dg-mvie91z5aec5570a row openai-codex/gpt-6.1-sol,moonshot/kimi-k2.7-code
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): hand-settled: dt-mvie91z5e496e0ee routing rt-mvieda2go4ly4g
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): review-round: sl-plan-laneexit round 2 token dt-mvie91z5e496e0ee group dg-mvie91z5aec5570a verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{"correctness":1,"tests":1},"minor":{}},"titles":[{"severity":"major","kind":"correctness","title":"The stale-cleanup deadline exceeds the surface caller’s starter timeout"},{"severity":"major","kind":"tests","title":"Neither receipt-only runner trigger has an independent regression case"}]}
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): review-loop-end: sl-plan-laneexit reason pass
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): hand-spawn: dt-mvief2u31b9d6e1f session /Users/jowolff/.agent-system-2/lanes/wl-mvidsu83epvpj4/sessions/2026-10-21T17-23-57-662Z_01a15f7d-ba5e-7000-85f4-c9e4c20cd7ea spawn sl-plan-laneexit-3 review yes group dg-mvief2u3e261094c row openai-codex/gpt-6.1-sol,moonshot/kimi-k2.7-code
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): hand-settled: dt-mvief2u31b9d6e1f routing rt-mvieiwkhsj65fk
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): review-round: sl-plan-laneexit round 1 token dt-mvief2u31b9d6e1f group dg-mvief2u3e261094c verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{"correctness":1,"tests":1},"minor":{}},"titles":[{"severity":"major","kind":"correctness","title":"The new pre-spawn wait opens a stop-before-child race"},{"severity":"major","kind":"tests","title":"Case 6 does not independently establish that the starter returns before stale cleanup completes"}]}
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): review-loop-end: sl-plan-laneexit reason pass
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): hand-spawn: dt-mviejtpfb33d9aad session /Users/jowolff/.agent-system-2/lanes/wl-mvidsu83epvpj4/sessions/2026-10-21T17-23-57-662Z_01a15f7d-ba5e-7000-85f4-c9e4c20cd7ea spawn sl-plan-laneexit-4 review yes group dg-mviejtpff77eb638 row openai-codex/gpt-6.1-sol,moonshot/kimi-k2.7-code
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): hand-settled: dt-mviejtpfb33d9aad routing rt-mviemc4b1brfuo
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): review-round: sl-plan-laneexit round 1 token dt-mviejtpfb33d9aad group dg-mviejtpff77eb638 verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{"correctness":1},"minor":{}},"titles":[{"severity":"major","kind":"correctness","title":"Pre-spawn cancellation has no path to accept a ledger stop"}]}
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): review-loop-end: sl-plan-laneexit reason pass
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): hand-spawn: dt-mvien2h1260ec603 session /Users/jowolff/.agent-system-2/lanes/wl-mvidsu83epvpj4/sessions/2026-10-21T17-23-57-662Z_01a15f7d-ba5e-7000-85f4-c9e4c20cd7ea spawn sl-plan-laneexit-5 review yes group dg-mvien2h147b2e4a7 row openai-codex/gpt-6.1-sol,moonshot/kimi-k2.7-code
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): hand-settled: dt-mvien2h1260ec603 routing rt-mviepyro097pxc
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): review-round: sl-plan-laneexit round 1 token dt-mvien2h1260ec603 group dg-mvien2h147b2e4a7 verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{"tests":1},"minor":{}},"titles":[{"severity":"major","kind":"tests","title":"Case 7b can pass through the stop command’s fallback without exercising pre-spawn cancellation"}]}
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): review-loop-end: sl-plan-laneexit reason pass
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): hand-spawn: dt-mvieqp8bf3467e90 session /Users/jowolff/.agent-system-2/lanes/wl-mvidsu83epvpj4/sessions/2026-10-21T17-23-57-662Z_01a15f7d-ba5e-7000-85f4-c9e4c20cd7ea spawn sl-plan-laneexit-6 review yes group dg-mvieqp8bbfdbc560 row openai-codex/gpt-6.1-sol,moonshot/kimi-k2.7-code
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): hand-settled: dt-mvieqp8bf3467e90 routing rt-mviesmj1gbyj28
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): review-round: sl-plan-laneexit round 1 token dt-mvieqp8bf3467e90 group dg-mvieqp8bbfdbc560 verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{"tests":1},"minor":{}},"titles":[{"severity":"major","kind":"tests","title":"No planned test catches omission of stale cleanup from the interactive spawn path"}]}
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): review-loop-end: sl-plan-laneexit reason pass
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): hand-spawn: dt-mviet2rq1f7ca682 session /Users/jowolff/.agent-system-2/lanes/wl-mvidsu83epvpj4/sessions/2026-10-21T17-23-57-662Z_01a15f7d-ba5e-7000-85f4-c9e4c20cd7ea spawn sl-plan-laneexit-7 review yes group dg-mviet2rq68e41ab3 row openai-codex/gpt-6.1-sol,moonshot/kimi-k2.7-code
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): hand-settled: dt-mviet2rq1f7ca682 routing rt-mvievqtxp9ixog
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): review-round: sl-plan-laneexit round 1 token dt-mviet2rq1f7ca682 group dg-mviet2rq68e41ab3 verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{"correctness":1},"minor":{}},"titles":[{"severity":"major","kind":"correctness","title":"A runner renewal can erase self-release before either new terminal trigger observes it"}]}
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): review-loop-end: sl-plan-laneexit reason pass
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): hand-spawn: dt-mviewon238640bca session /Users/jowolff/.agent-system-2/lanes/wl-mvidsu83epvpj4/sessions/2026-10-21T17-23-57-662Z_01a15f7d-ba5e-7000-85f4-c9e4c20cd7ea spawn sl-plan-laneexit-8 review yes group dg-mviewon2e7dbd558 row openai-codex/gpt-6.1-sol,moonshot/kimi-k2.7-code
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): hand-settled: dt-mviewon238640bca routing rt-mviezo7og5ttkw
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): review-round: sl-plan-laneexit round 1 token dt-mviewon238640bca group dg-mviewon2e7dbd558 verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{"tests":2},"minor":{}},"titles":[{"severity":"major","kind":"tests","title":"Receipt-bearing release cases mask the runner’s self-release trigger"},{"severity":"major","kind":"tests","title":"The renewal regression test exercises the new method, not the runner’s use of it"}]}
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): review-loop-end: sl-plan-laneexit reason pass
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): hand-spawn: dt-mvif0jy6dd5672f1 session /Users/jowolff/.agent-system-2/lanes/wl-mvidsu83epvpj4/sessions/2026-10-21T17-23-57-662Z_01a15f7d-ba5e-7000-85f4-c9e4c20cd7ea spawn sl-plan-laneexit-9 review yes group dg-mvif0jy60c54af1b row openai-codex/gpt-6.1-sol,moonshot/kimi-k2.7-code
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): hand-settled: dt-mvif0jy6dd5672f1 routing rt-mvif3k5t97v0n4
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): review-round: sl-plan-laneexit round 1 token dt-mvif0jy6dd5672f1 group dg-mvif0jy60c54af1b verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{},"minor":{}},"titles":[]}
- assumption (lane-mvidsu83epvpj4-1, sl-plan-laneexit): review-loop-end: sl-plan-laneexit reason pass
- assumption (classifier): pair-exposure: lane-mvidsu83epvpj4-2 on
- assumption (lane-mvidsu83epvpj4-2): builder-lab: anthropic lane lane-mvidsu83epvpj4-2 model anthropic/claude-opus-5-5
- assumption (lane-mvidsu83epvpj4-2, sl-fix-exit): hand-spawn: dt-mvifbcyd37f9c9c8 session /Users/jowolff/.agent-system-2/lanes/wl-mvidsu83epvpj4/sessions/2026-10-21T17-23-57-662Z_01a15f7d-ba5e-7000-85f4-c9e4c20cd7ea spawn sl-fix-exit review no group dg-mvifbcyd876feee1 row anthropic/claude-opus-5-5
- assumption (lane-mvidsu83epvpj4-2, sl-docs-exit): hand-spawn: dt-mvifbcydaf3260bf session /Users/jowolff/.agent-system-2/lanes/wl-mvidsu83epvpj4/sessions/2026-10-21T17-23-57-662Z_01a15f7d-ba5e-7000-85f4-c9e4c20cd7ea spawn sl-docs-exit review no group dg-mvifbcydea3cb8f8 row anthropic/claude-sonnet-5-5
- assumption (lane-mvidsu83epvpj4-2, sl-docs-exit): hand-settled: dt-mvifbcydaf3260bf routing rt-mvifbsf3xj4sg0
- assumption (lane-mvidsu83epvpj4-2, sl-fix-exit): hand-settled: dt-mvifbcyd37f9c9c8 routing rt-mvih75x8d2chz4
- assumption (lane-mvidsu83epvpj4-2, sl-fix-exit): artifact-command: bun test surface/test/turn-end.test.ts ledger/test/ledger.test.ts
- assumption (lane-mvidsu83epvpj4-2, sl-review-exit): hand-spawn: dt-mvihjdc40a94d20e session /Users/jowolff/.agent-system-2/lanes/wl-mvidsu83epvpj4/sessions/2026-10-21T17-23-57-662Z_01a15f7d-ba5e-7000-85f4-c9e4c20cd7ea spawn sl-review-exit review yes group dg-mvihjdc48e1d5d7b row openai-codex/gpt-6.1-sol,moonshot/kimi-k2.7-code
- assumption (lane-mvidsu83epvpj4-2, sl-review-exit): hand-settled: dt-mvihjdc40a94d20e routing rt-mvihlz6300lc00
- assumption (lane-mvidsu83epvpj4-2, sl-review-exit): review-round: sl-review-exit round 1 token dt-mvihjdc40a94d20e group dg-mvihjdc48e1d5d7b verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{"correctness":1},"minor":{}},"titles":[{"severity":"major","kind":"correctness","title":"Stale-omp SIGKILL escalation uses a cached start-time match and can signal a reused pid"}]}
- assumption (lane-mvidsu83epvpj4-2, sl-review-exit): review-loop-end: sl-review-exit reason pass
- assumption (lane-mvidsu83epvpj4-2, sl-fix-reuse): artifact-command: bun test surface/test/lane-live-lane.test.ts
- assumption (lane-mvidsu83epvpj4-2, sl-fix-reuse): The declared artifact `bun test surface/test/lane-live-lane.test.ts` failed 3 of 19 only because this lane's fence denies spawning /bin/ps (EPERM posix_spawn 'ps' at surface/test/lane-live-lane.test.ts:241), not on the change. The same file with the repo's ps shim on PATH (`PATH="$PWD/surface/scripts/ps-shim:$PATH" bun test surface/test/lane-live-lane.test.ts`) passed 19/19 at 861cd9c0's tree; the full suite on the runner (outside the fence) is the real proof.
- assumption (lane-mvidsu83epvpj4-2, sl-review-exit): hand-spawn: dt-mvihxx5iae51bd68 session /Users/jowolff/.agent-system-2/lanes/wl-mvidsu83epvpj4/sessions/2026-10-21T17-23-57-662Z_01a15f7d-ba5e-7000-85f4-c9e4c20cd7ea spawn sl-review-exit-2 review yes group dg-mvihxx5i06c5175a row openai-codex/gpt-6.1-sol,moonshot/kimi-k2.7-code
- assumption (lane-mvidsu83epvpj4-2, sl-review-exit): hand-settled: dt-mvihxx5iae51bd68 routing rt-mvii21u2knncw0
- assumption (lane-mvidsu83epvpj4-2, sl-review-exit): review-round: sl-review-exit round 1 token dt-mvihxx5iae51bd68 group dg-mvihxx5i06c5175a verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{"correctness":2},"minor":{}},"titles":[{"severity":"major","kind":"correctness","title":"Fresh escalation probes disable the aggregate cleanup deadline"},{"severity":"major","kind":"correctness","title":"Recovered probes can cause immediate SIGKILL after the first SIGTERM"}]}
- assumption (lane-mvidsu83epvpj4-2, sl-review-exit): review-loop-end: sl-review-exit reason pass
- assumption (lane-mvidsu83epvpj4-2, sl-review-exit): hand-spawn: dt-mviiclvqd8a46392 session /Users/jowolff/.agent-system-2/lanes/wl-mvidsu83epvpj4/sessions/2026-10-21T17-23-57-662Z_01a15f7d-ba5e-7000-85f4-c9e4c20cd7ea spawn sl-review-exit-3 review yes group dg-mviiclvq8781437d row openai-codex/gpt-6.1-sol,moonshot/kimi-k2.7-code
- assumption (lane-mvidsu83epvpj4-2, sl-review-exit): hand-settled: dt-mviiclvqd8a46392 routing rt-mviifxmd32z668
- assumption (lane-mvidsu83epvpj4-2, sl-review-exit): review-round: sl-review-exit round 1 token dt-mviiclvqd8a46392 group dg-mviiclvq8781437d verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{},"minor":{"tests":1}},"titles":[{"severity":"minor","kind":"tests","title":"ReserveRows test fixture omits the new required holderChanges field"}]}
- assumption (lane-mvidsu83epvpj4-2, sl-review-exit): review-loop-end: sl-review-exit reason pass
- assumption (lane-mvidsu83epvpj4-2, sl-pr-exit): Run tr-0mvili570kxpo6p (ff7765ed) red on 1 of 5907: classifier/test/crosslab.test.ts "both pinned spawns refused: one park; one member still running: no park" failed opening its ledger: "ledger path ... is not on a local filesystem (unknown:no mount entry for /System/Volumes/Data)". That string comes from mountLocality in /Users/jowolff/code/agent-system-2.0-lanes/wl-mvidsu83epvpj4/ledger/src/locality.ts:245-247, where the /sbin/mount output had no line for a mount point that df had just reported. The PR diff touches neither locality.ts nor crosslab. All 5906 other tests passed, including every other test that opens a temp ledger on the same volume, and the run's own baseCompare marks it as not failing on base. GUESS(inference): a transient /sbin/mount spawn result under suite load, unrelated to this PR. Decision: re-run the full suite at the same head with no code change.
- assumption (lane-mvidsu83epvpj4-2, sl-pr-exit): Run tr-0mvim4nbwo8jl9w (ff7765ed) was red on 2 of 5907 tests: surface/test/input.test.ts waive-pr and surface/test/lane-headroom-script.test.ts. Both fail in the same way, with ledger mountLocality returning "unknown:df failed". The previous run, tr-0mvili570kxpo6p, failed one different test for the same reason ("no mount entry"). Neither test file is in the PR diff, and all eight changed test files pass when run alone. CLAIM: the same locality error appears in runs that are not this PR's: /Users/jowolff/.agent-system-2/test-runs/tr-0mv5ijtllvchime/result.json:90, tr-0mv5shm15wj21po/result.json:105, tr-0mv9459gcn6kn9u/result.json:78, tr-0mvh3m334nn56t4/result.json:349 and tr-0mvidej0daw3f07/result.json:308. So it is a pre-existing runner flake: ledger/src/locality.ts spawns df and /sbin/mount for each ledger open. Decision: re-run at the same head, and tell the orchestrator the flake exists.

## Dead ends — don't retry these

- none

## Heads-up for whoever touches this next

- message msg-mvihxd13uuhe68 [held] not acted on: artifact-failed: `bun test surface/test/lane-live-lane.test.ts` exited 1 (tool call toolu_01FfLUmUmrujWXrhdm9Q8gzV)
- message msg-mvimqhubkzzo5c [held] not acted on: **CLAIM**
The full-suite runner has a recurring flake that is not part of this PR. A test now and then fails with "ledger path … is not on a local filesystem (unknown:df failed | unknown:no mount entry for /System/Volumes/Data)". That error comes from mountLocality in /Users/jowolff/code/agent-system-2.0-lanes/wl-mvidsu83epvpj4/ledger/src/locality.ts:240-247, which spawns df and /sbin/mount every time a ledger is opened.

It has turned PR #304 red twice:
- tr-0mvili570kxpo6p: 1 failure
- tr-0mvim4nbwo8jl9w: 2 failures

It has also hit other workloads:
- tr-0mv5ijtllvchime
- tr-0mv5shm15wj21po
- tr-0mv9459gcn6kn9u
- tr-0mvh3m334nn56t4
- tr-0mvidej0daw3f07

**ACTION**
I'm re-running PR #304 at the same head, ff7765ed.

**GUESS(inference)**
It's worth its own jo-issues ticket: cache the locality result, or skip the check when the run is on the test runner.
