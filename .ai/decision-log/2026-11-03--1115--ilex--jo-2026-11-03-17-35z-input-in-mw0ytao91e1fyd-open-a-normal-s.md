---
date: 2026-11-03T11:15-08:00
engineer: Ilex
session: wl-mw0ytmzi89d683
status: resolved
durable: false
supersedes:
workload: wl-mw0ytmzi89d683
---

# Jo (2026-11-03 ~17:35Z, input in-mw0ytao91e1fyd): open a normal-stakes as2 workload: revive PR #304 so a released lane's process ends at once (jo-issues #184, agent-system-2.0 #283).

Bug: today a lane that releases its hold keeps running until the session settles. surface/src/turn-end.ts:144 returns wait while the session is unsettled, so the holder check at :158 is never reached. The stop poll has no released-lane exit, so the process idles up to SETTLE_IDLE_MS (15 minutes, turn-end.ts:26) with its slot taken. 51 of 207 lanes in the last 7 days did this (report: /Users/jowolff/agent-scratch/agent-system-2.0/stuck-lane/DIAGNOSIS-2026-11-03.md).

The fix is written: PR #304 on branch wl/wl-mvidsu83epvpj4, commit fa5e5bee. It changes the wait line to also return when selfReleased or receipt is set, and ends the process on stdin EOF. It conflicts with main because #424 (permanent merge train) added the released-idle outcome in turnEnd and exitOutcome.

Work: rebase or merge #304's branch onto main. Keep #424's released-idle outcome. Make #304's wait change the first check. Keep its tests (lane-release-exit, turn-end, turn-idle) passing alongside #424's. Land through the train on a new PR that closes #304.

Done when: a lane that releases itself exits within 10 seconds in the lane-release-exit test, the full suite is green, and PR #304 is closed as superseded.

Overlap the plan settles: an open user-driven merge-train fix workload already names PR #304 (wl-mvpopz0o270hkw, head branch wl/wl-mvidsu…, no open slices). The plan says whether that workload closes into this one.

Verification: through lane_full_test and the runner.

Bring Jo the plan before code.

## How it fails
- The rebase drops #424's released-idle outcome. The train's post-park holder line regresses. Surfaces in #424's turn-end tests, which must stay and pass. Recovery: restore the outcome from main. Retry bound: the review rounds.
- The stdin-EOF ending races the runner's 5-second lease. Surfaces in the lane-live-lane test. Recovery: the plan says which side wins, and the test pins it. Retry bound: 2 fix attempts, then a question to Jo.
- The merge with main conflicts beyond turn-end.ts and exitOutcome. Surfaces in the merge. Recovery: resolve toward main's behavior and list each resolution in the plan. Retry bound: one question to Jo if a resolution changes behavior beyond #304's stated fix.

done: A rebased successor to PR #304 on current main makes a self-released lane exit within 10 seconds in the lane-release-exit test, keeps #424's released-idle outcome and its turn-end tests, passes the full suite through lane_full_test, lands through the merge train, and PR #304 is closed as superseded.
done-because: PR #443 (https://github.com/thewolff/agent-system-2.0/pull/443) is the successor to PR #304, merged with current main at e9cda192795baeb9ef8153f35e824891f04b2e35. In surface/test/lane-release-exit.test.ts case 1, a self-released lane's lane-exit: lands within the 10 s guard. #424's released-idle outcome and its turn-end tests are kept, and a released-idle self-released train case was added. The full suite is green at e9cda192 through lane_full_test: run tr-0mw11rsld06pquv, scope full (land-first off), 7989 passed, 0 failed, 135 skipped (/Users/jowolff/.agent-system-2/test-runs/tr-0mw11rsld06pquv/result.json). The cross-lab code review passed at round 2 on openai-codex/gpt-6.1-sol (/Users/jowolff/agent-scratch/agent-system-2.0/wl-mw0ytmzi89d683/CODE-REVIEW-r2.md). Its one minor finding is declined: "Timing-marker requirement remains unresolved". PR #304 is closed as superseded: `gh pr view 304 --json state` → CLOSED, with the comment "Superseded by #443". The overlapping merge-train fix workload for #304 (wl-mvpopz0o270hkw) is still open; its close was requested by msg-mw11rwykil2rdo. The landing is handed to the merge train; this lane does not claim it has landed.

Rendered from the ledger by Ilex (they/them) at workload close; stakes normal, mode autonomous, opened 2026-11-03T17:32:14.622Z.

## What changed

- sl-rx-plan: Plan: rebase PR #304's released-lane exit onto main keeping #424 released-idle; decide wl-mvpopz0o270hkw overlap — artifact: /Users/jowolff/agent-scratch/agent-system-2.0/wl-mw0ytmzi89d683/PLAN.md approved by auto-start after review pass /Users/jowolff/agent-scratch/agent-system-2.0/wl-mw0ytmzi89d683/PLAN-REVIEW-r2.md (openai-codex/gpt-6.1-sol, round dg-mw0zml3wd3e24654)
- sl-rx-merge: Merge origin/wl/wl-mvidsu83epvpj4 into the lane branch at current origin/main; resolve per PLAN.md table plus F1 (liveTrainLane []), F3 (terminalNow !train), F5 (ReserveRows literals) — artifact: commits e3ee6a9b (merge) + 1fef4aab (F1/F3/F5, migration item) on wl/wl-mw0ytmzi89d683; `bun test surface/test/turn-end.test.ts surface/test/turn-idle.test.ts surface/test/launch.test.ts surface/test/train-permanent.test.ts ledger/test/ledger.test.ts ledger/test/lane.test.ts gates/test/manifest-sync.test.ts` → 271 pass 0 fail; hand reported lane-release-exit 12/0 and lane-live-lane+lane-script 108/0 with surface/scripts/ps-shim on PATH
- sl-rx-tests: Tests per PLAN.md: 10 s exit guard, concurrent race case, case 2c and endStale timing conversions (fake clock), F8 cleanup, released-idle/train-receipt/peer-train cases — artifact: commits 2510bbf5 + 468a57e8; declared artifact `bun test surface/test/turn-end.test.ts surface/test/timing-lint.test.ts surface/test/turn-idle.test.ts surface/test/launch.test.ts surface/test/train-permanent.test.ts ledger/test/ledger.test.ts ledger/test/lane.test.ts gates/test/manifest-sync.test.ts` → 285 pass 0 fail (timing baseline unchanged); hand: lane-release-exit 13/0 (59.6 s, cases 1/2c/6c 3x more), lane-live-lane+lane-script 109/0, with ps shim
- sl-rx-review: Cross-lab findings-only review of origin/main...HEAD against PLAN.md — artifact: review round 2 passed, openai-codex/gpt-6.1-sol (group dg-mw11mj3237f95667), /Users/jowolff/agent-scratch/agent-system-2.0/wl-mw0ytmzi89d683/CODE-REVIEW-r2.md; round 1 /Users/jowolff/agent-scratch/agent-system-2.0/wl-mw0ytmzi89d683/CODE-REVIEW-r1.md. Remaining finding (minor, tests): "Timing-marker requirement remains unresolved" — declined: surface/src/timing-lint.ts reports an opt-out that covers no finding, and the fake-clock endStale cases have no finding to cover.
- sl-rx-fix1: Code review r1 fixes: cleanup identity-probes pids before SIGKILL; cases 6/7a/7b event-gated instead of racing the 5 s grace; runner-level train legacy-receipt idle case — artifact: commit 0bcff949 (surface/test/lane-release-exit.test.ts only); declared artifact → 285 pass 0 fail; hand: lane-release-exit with ps shim 14/0 (63 s), cases 2d/6/7a/7b 3x 4/0; 2d fails-before with terminalNow train=false (timed out waiting for idle check)
- sl-rx-pr: Merge origin/main if moved, run the declared artifact, push, open the PR superseding #304, set pr: in the migration item, close #304, ask the orchestrator to close wl-mvpopz0o270hkw, lane_full_test — artifact: PR #443 https://github.com/thewolff/agent-system-2.0/pull/443 open at e9cda192 (declared artifact 285/0 on that tree before push); full suite tr-0mw11rsld06pquv green at e9cda192 (7989 pass, 0 fail); `gh pr view 304 --json state` → CLOSED; orchestrator asked to close wl-mvpopz0o270hkw (msg-mw11rwykil2rdo), status still open
- sl-full-mw0ytmzi89d683-1: full suite outside the fence at PR #443 — artifact: test-run tr-0mw11rsld06pquv: green at e9cda192795baeb9ef8153f35e824891f04b2e35 on PR #443; full 7989/0/135; alone: none; /Users/jowolff/.agent-system-2/test-runs/tr-0mw11rsld06pquv

## Decisions made (and why)

- jo flipped mode to autonomous
- jo answered "retry" to q-mw0z2hiq42smkc (The plan review for the PR #304 revival cannot start: the classifier refused both dispatches of the review hand with "every judge candidate failed: typesafe/jev-latest rejected the account recently". The plan is written at /Users/jowolff/agent-scratch/agent-system-2.0/wl-mw0ytmzi89d683/PLAN.md (merge #304's branch into main, 9 files of additive conflicts resolved toward main plus #304, a 10 s exit bound pinned in lane-release-exit, the overlapping #304 fix workload closed into this one). retry (recommended): answer once the classifier's judge account works again, and the lane re-dispatches the same review. cancel: stop this workload's plan.)
- assumption (classifier): pair-exposure: lane-mw0ytmzi89d683-1 on
- assumption (classifier): pair-signal-failed: attempt 1 error tokens unknown cost unknown
- assumption (lane-mw0ytmzi89d683-1): builder-lab: anthropic lane lane-mw0ytmzi89d683-1 model anthropic/claude-opus-5-5
- assumption (classifier): pair-signal-failed: attempt 2 error tokens unknown cost unknown
- assumption (classifier): pair-signal-failed: attempt 3 error tokens unknown cost unknown
- assumption (classifier): pair-exposure: lane-mw0ytmzi89d683-2 on
- assumption (lane-mw0ytmzi89d683-2): builder-lab: anthropic lane lane-mw0ytmzi89d683-2 model anthropic/claude-opus-5-5
- assumption (lane-mw0ytmzi89d683-2, sl-rx-plan): hand-spawn: dt-mw0z9f97f16cff94 session /Users/jowolff/.agent-system-2/lanes/wl-mw0ytmzi89d683/sessions/2026-11-03T17-33-57-285Z_01a1a279-8ca4-7000-badc-1fd1dd35c07f spawn sl-rx-plan review yes group dg-mw0z9f9706ec025f row openai-codex/gpt-6.1-sol
- assumption (lane-mw0ytmzi89d683-2, sl-rx-plan): hand-settled: dt-mw0z9f97f16cff94 routing rt-mw0ziggfa8u392
- assumption (lane-mw0ytmzi89d683-2, sl-rx-plan): review-round: sl-rx-plan round 1 token dt-mw0z9f97f16cff94 group dg-mw0z9f9706ec025f verdict accepted blocking 4 counts {"counts":{"blocking":{"correctness":1,"tests":1,"design":1,"fault-tolerance":1},"major":{"correctness":1,"tests":2,"design":1},"minor":{"docs":1}},"titles":[{"severity":"blocking","kind":"correctness","title":"The conflict-resolution plan misses liveTrainLane's second production call to liveLaneOf"},{"severity":"blocking","kind":"tests","title":"The timing plan violates the standing rule and imports new timing-lint offenders"},{"severity":"major","kind":"correctness","title":"Keeping !train only in decideTurn leaves the new terminalNow receipt trigger inconsistent"},{"severity":"major","kind":"tests","title":"The named cases do not exercise concurrent own-runner and next-spawner cleanup"},{"severity":"major","kind":"tests","title":"R7 points at the wrong cap-exemption test and misses new required ReserveRows fixtures"},{"severity":"major","kind":"design","title":"R11 and R12 confuse mutation authority with inability to observe completion"},{"severity":"blocking","kind":"design","title":"The completion sequence stops before the workload's required train landing"},{"severity":"blocking","kind":"fault-tolerance","title":"Imported release-exit test cleanup silently ignores signal failures and erases failure evidence"},{"severity":"minor","kind":"docs","title":"R6 promises a ladder for every runner end despite deliberate hard-kill exceptions"}]}
- assumption (lane-mw0ytmzi89d683-2, sl-rx-plan): hand-spawn: dt-mw0zml3w5d20e941 session /Users/jowolff/.agent-system-2/lanes/wl-mw0ytmzi89d683/sessions/2026-11-03T17-33-57-285Z_01a1a279-8ca4-7000-badc-1fd1dd35c07f spawn sl-rx-plan-2 review yes group dg-mw0zml3wd3e24654 row openai-codex/gpt-6.1-sol
- assumption (lane-mw0ytmzi89d683-2, sl-rx-plan): hand-settled: dt-mw0zml3w5d20e941 routing rt-mw0zq0nld4t1an
- assumption (lane-mw0ytmzi89d683-2, sl-rx-plan): review-round: sl-rx-plan round 2 token dt-mw0zml3w5d20e941 group dg-mw0zml3wd3e24654 verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{"design":1},"minor":{}},"titles":[{"severity":"major","kind":"design","title":"R16 still substitutes message delivery for overlapping-workload closure"}]}
- assumption (lane-mw0ytmzi89d683-2, sl-rx-plan): review-loop-end: sl-rx-plan reason pass
- assumption (lane-mw0ytmzi89d683-2, sl-rx-plan): Plan review round 2 passed (openai-codex/gpt-6.1-sol, /Users/jowolff/agent-scratch/agent-system-2.0/wl-mw0ytmzi89d683/PLAN-REVIEW-r2.md) with one major left: R16 used the message id as closure evidence. Folded in after the review, as the reviewer suggested: R16 now reads "asked to close, observed status in done-because", the lane reads wl-mvpopz0o270hkw's status read-only before release, and a How-it-fails row covers the orchestrator not acting. No other plan text changed. Decision on the 10 s bound (round-1 F2): a failure-only 10 s exitOf deadline in lane-release-exit case 1, no measured duration; the reviewer judged it consistent with the timing rule.
- assumption (lane-mw0ytmzi89d683-2, sl-rx-merge): artifact-command: bun test surface/test/turn-end.test.ts surface/test/turn-idle.test.ts surface/test/launch.test.ts surface/test/train-permanent.test.ts ledger/test/ledger.test.ts ledger/test/lane.test.ts gates/test/manifest-sync.test.ts
- assumption (lane-mw0ytmzi89d683-2, sl-rx-merge): hand-spawn: dt-mw0zreyx33e39ea4 session /Users/jowolff/.agent-system-2/lanes/wl-mw0ytmzi89d683/sessions/2026-11-03T17-33-57-285Z_01a1a279-8ca4-7000-badc-1fd1dd35c07f spawn sl-rx-merge review no group dg-mw0zreyxfc4f08f2 row anthropic/claude-opus-5-5
- assumption (lane-mw0ytmzi89d683-2, sl-rx-merge): hand-settled: dt-mw0zreyx33e39ea4 routing rt-mw10e9a7216lkh
- assumption (lane-mw0ytmzi89d683-2, sl-rx-tests): artifact-command: bun test surface/test/turn-end.test.ts surface/test/timing-lint.test.ts surface/test/turn-idle.test.ts surface/test/launch.test.ts surface/test/train-permanent.test.ts ledger/test/ledger.test.ts ledger/test/lane.test.ts gates/test/manifest-sync.test.ts
- assumption (lane-mw0ytmzi89d683-2, sl-rx-tests): hand-spawn: dt-mw10f7l9e2421f8d session /Users/jowolff/.agent-system-2/lanes/wl-mw0ytmzi89d683/sessions/2026-11-03T17-33-57-285Z_01a1a279-8ca4-7000-badc-1fd1dd35c07f spawn sl-rx-tests review no group dg-mw10f7l9c2af4a83 row anthropic/claude-opus-5-5
- assumption (lane-mw0ytmzi89d683-2, sl-rx-tests): hand-settled: dt-mw10f7l9e2421f8d routing rt-mw110yk3pl4bmt
- assumption (lane-mw0ytmzi89d683-2, sl-rx-review): hand-spawn: dt-mw111nop9d805a16 session /Users/jowolff/.agent-system-2/lanes/wl-mw0ytmzi89d683/sessions/2026-11-03T17-33-57-285Z_01a1a279-8ca4-7000-badc-1fd1dd35c07f spawn sl-rx-review review yes group dg-mw111nop619f6728 row openai-codex/gpt-6.1-sol
- assumption (lane-mw0ytmzi89d683-2, sl-rx-review): hand-settled: dt-mw111nop9d805a16 routing rt-mw116ymud3llso
- assumption (lane-mw0ytmzi89d683-2, sl-rx-review): review-round: sl-rx-review round 1 token dt-mw111nop9d805a16 group dg-mw111nop619f6728 verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{"correctness":1,"tests":1},"minor":{"tests":2}},"titles":[{"severity":"major","kind":"correctness","title":"Cleanup can SIGKILL a reused pid"},{"severity":"major","kind":"tests","title":"Cases 6 and 7 still race a real five-second escalation"},{"severity":"minor","kind":"tests","title":"The train-receipt test does not exercise the polling regression"},{"severity":"minor","kind":"tests","title":"Fake-clock timing tests omit the required markers"}]}
- assumption (lane-mw0ytmzi89d683-2, sl-rx-review): review-loop-end: sl-rx-review reason pass
- assumption (lane-mw0ytmzi89d683-2, sl-rx-review): Code review round 1 (sl-rx-review, /Users/jowolff/agent-scratch/agent-system-2.0/wl-mw0ytmzi89d683/CODE-REVIEW-r1.md) passed with 2 major, 2 minor. Fixing in sl-rx-fix1: major "Cleanup can SIGKILL a reused pid", major "Cases 6 and 7 still race a real five-second escalation", minor "The train-receipt test does not exercise the polling regression". Not taking minor "Fake-clock timing tests omit the required markers": surface/src/timing-lint.ts's header makes an opt-out that covers no finding a reported problem, and the fake-clock cases have no finding to cover, so the markers would fail timing-lint.
- assumption (lane-mw0ytmzi89d683-2, sl-rx-fix1): artifact-command: bun test surface/test/turn-end.test.ts surface/test/timing-lint.test.ts surface/test/turn-idle.test.ts surface/test/launch.test.ts surface/test/train-permanent.test.ts ledger/test/ledger.test.ts ledger/test/lane.test.ts gates/test/manifest-sync.test.ts
- assumption (lane-mw0ytmzi89d683-2, sl-rx-fix1): hand-spawn: dt-mw1184gf41f9a420 session /Users/jowolff/.agent-system-2/lanes/wl-mw0ytmzi89d683/sessions/2026-11-03T17-33-57-285Z_01a1a279-8ca4-7000-badc-1fd1dd35c07f spawn sl-rx-fix1 review no group dg-mw1184gfe010614e row anthropic/claude-opus-5-5
- assumption (lane-mw0ytmzi89d683-2, sl-rx-fix1): hand-settled: dt-mw1184gf41f9a420 routing rt-mw11lwee5w6qvs
- assumption (lane-mw0ytmzi89d683-2, sl-rx-review): hand-spawn: dt-mw11mj314f7360c1 session /Users/jowolff/.agent-system-2/lanes/wl-mw0ytmzi89d683/sessions/2026-11-03T17-33-57-285Z_01a1a279-8ca4-7000-badc-1fd1dd35c07f spawn sl-rx-review-2 review yes group dg-mw11mj3237f95667 row openai-codex/gpt-6.1-sol
- assumption (lane-mw0ytmzi89d683-2, sl-rx-review): hand-settled: dt-mw11mj314f7360c1 routing rt-mw11q7klnaky42
- assumption (lane-mw0ytmzi89d683-2, sl-rx-review): review-round: sl-rx-review round 1 token dt-mw11mj314f7360c1 group dg-mw11mj3237f95667 verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{},"minor":{"tests":1}},"titles":[{"severity":"minor","kind":"tests","title":"Timing-marker requirement remains unresolved"}]}
- assumption (lane-mw0ytmzi89d683-2, sl-rx-review): review-loop-end: sl-rx-review reason pass
- assumption (lane-mw0ytmzi89d683-2, sl-rx-pr): artifact-command: bun test surface/test/turn-end.test.ts surface/test/timing-lint.test.ts surface/test/turn-idle.test.ts surface/test/launch.test.ts surface/test/train-permanent.test.ts ledger/test/ledger.test.ts ledger/test/lane.test.ts gates/test/manifest-sync.test.ts

## Dead ends — don't retry these

- none

## Heads-up for whoever touches this next

- message msg-mw0z2hif6zspy3 [delivered] not acted on: Blocker: the plan review for the PR #304 revival (wl-mw0ytmzi89d683) cannot be dispatched. Two dispatches of hand sl-rx-plan (tier deep), about 60 s apart, were both refused by the classifier: "agent-system-2 classifier could not route this dispatch: judgment: every judge candidate failed: typesafe/jev-latest rejected the account recently". The plan is written (/Users/jowolff/agent-scratch/agent-system-2.0/wl-mw0ytmzi89d683/PLAN.md); nothing in the repo changed. Next step known: the classifier's judge account (typesafe/jev-latest) needs restoring; then the lane re-dispatches the same review.
- message msg-mw0zqm4jyozgrd [delivered] not acted on: notice: plan started without your approve on wl-mw0ytmzi89d683 (cross-lab review passed); it will not merge until 4 h after your next message here; `halt wl-mw0ytmzi89d683` stops it; `ask-all` stops all auto-starts
/Users/jowolff/agent-scratch/agent-system-2.0/wl-mw0ytmzi89d683/PLAN.md
- sl-rx-merge: merge #304's branch into main; resolve 9 files; liveTrainLane keeps cross-train exclusivity; train receipt rule in terminalNow
- sl-rx-tests: 10 s exit guard; race case; event/fake-clock rewrites of #304's sleeps; cleanup errors kept; released-idle and train cases
- sl-rx-review: cross-lab findings-only review of origin/main...HEAD against the plan
- sl-rx-pr: push, open PR superseding #304, close #304, ask orchestrator to close the #304 fix workload, lane_full_test, done-because
prompt-only: R15: PR #304 closed naming the successor; a one-time live GitHub action, receipted by gh pr view, no repo test reaches it
prompt-only: R16: the #304 fix workload asked to close into this one; another workload's close is an orchestrator write
tradeoff: merge, not rebase: keeps #304's reviewed commits; history carries one merge commit
tradeoff: the 10 s bound is a failure-only wait on the real exit, not a measured duration, so the timing rule holds
tradeoff: a self-released peer train's lingering omp still blocks other trains until its own runner ends it
review: pass, openai-codex/gpt-6.1-sol, /Users/jowolff/agent-scratch/agent-system-2.0/wl-mw0ytmzi89d683/PLAN-REVIEW-r2.md
- message msg-mw11rwykil2rdo [held] not acted on: Please close the merge-train fix workload for PR #304 (wl-mvpopz0o270hkw) as superseded by this workload (wl-mw0ytmzi89d683). The same fix was merged with current main as PR #443 (https://github.com/thewolff/agent-system-2.0/pull/443). PR #304 is closed: `gh pr view 304 --json state` → CLOSED, with the comment "Superseded by #443". This lane has not touched that workload's ledger or branch. Per the approved plan (/Users/jowolff/agent-scratch/agent-system-2.0/wl-mw0ytmzi89d683/PLAN.md, R16), this lane will put that workload's observed status into done-because.
