---
date: 2026-10-27T15:53-07:00
engineer: Ilex
session: wl-mvr94xusd8x17n
status: resolved
durable: false
supersedes:
workload: wl-mvr94xusd8x17n
---

# Jo (2026-10-27 ~22:20Z, input in-mvr942e8yl6y4b), standing ruling, enforced in code: a launcher-level "no new work" curb to save Anthropic plan usage for signature dataviz. Jo's words: "start no new work unless I explicitly tell you to. Open no new workloads, launch no queued ones, and relaunch no stalled or dead ones, on any lab, until I say so. Lanes already running finish the workload they hold, and the merge train keeps running. A lane that frees up stays empty with no question to me. This brings back my Anthropic-usage curb (in-mvqxe28wt05n28) without its free-lane amendment (in-mvqxrohijcrt34). Enforce it in the launcher, not by convention, and tell me in one line when it is on."
Requirements: (1) a durable curb state (ledger or profile) that Jo turns on and off by a surface word; while on, the launcher (/Users/jowolff/code/agent-system-2.0/surface/src/launch.ts and every path that reaches it: orchestrator_open_workload intake, orchestrator_launch_lane, the orchestrator tick's queued/stalled/dead relaunches, rank-launch) refuses to start a lane for any workload that holds no live lane now, with a one-line refusal naming the curb; (2) a lane already running on a workload keeps it to the end, including its own tick relaunch of that same lane session only if Jo's words allow it (default: a dead lane is not relaunched); (3) the merge train (wl-mvqxkrisivng1s, and the permanent-train workload if it lands) keeps its lane and is exempt; ASSUMPTION for Jo to flip at plan time: merge-train fix workloads the train opens count as the train and stay allowed, since the train cannot land anything without them; (4) a freed lane slot stays empty and no question is raised to Jo; (5) Jo gets exactly one line when the curb turns on and one when it turns off; (6) tests cover each refusal path, the running-lane and train exemptions, and the on/off notices. Until this lands, the orchestrator holds the curb by convention: no opens, launches or relaunches. This workload itself is the one Jo explicitly authorized.

done: A launcher-enforced no-new-work curb exists that Jo turns on and off by word, refuses every new open, queued launch and stalled or dead relaunch while on, exempts running lanes and the merge train, raises no question when a lane frees up, tells Jo in one line when it turns on, and is merged to main with a green full suite.
done-because: (no receipt recorded)

Rendered from the ledger by Ilex (they/them) at workload close; stakes normal, mode autonomous, opened 2026-10-27T22:23:16.324Z.

## What changed

- none

## Decisions made (and why)

- jo (surface): Jo: "standing ruling from me, to save Anthropic plan usage for signature dataviz: start no new work unless I explicitly tell you to. Open
no new workloads, launch no queued ones, and relaunch no stalled or dead ones, on any lab, until I say so. Lanes already running
finish the workload they hold, and the merge train keeps running. A lane that frees up stays empty with no question to me. This
brings back my Anthropic-usage curb (in-mvqxe28wt05n28) without its free-lane amendment (in-mvqxrohijcrt34). Enforce it in the
launcher, not by convention, and tell me in one line when it is on." — reading: Standing no-new-work curb, to save Anthropic plan usage for signature dataviz: until Jo says otherwise, open no new workloads, launch no queued ones, and relaunch no stalled or dead ones, on any lab. Running lanes finish the workload they hold, the merge train keeps running, and a freed lane stays empty with no question to Jo. This restores curb in-mvqxe28wt05n28 without amendment in-mvqxrohijcrt34. Enforce it in the launcher, in code, and tell Jo in one line when it is on. This workload builds that enforcement.
- jo (surface) on sl-curb-plan: cancel-slice sl-curb-plan
- jo (surface) on sl-curb-plan-b: cancel-slice sl-curb-plan-b
- jo (surface): withdraw wl-mvr94xusd8x17n
- orchestrator (surface): close receipt: withdrawn by Jo (in-mvra7kxsiqp0ua): closed with no done-because: receipt
- assumption (orchestrator-surface): brief-judged: change-large confidence 0.95 judge typesafe/jev-1.13.0
- assumption (classifier): pair-exposure: lane-mvr94xusd8x17n-1 on
- assumption (classifier): pair-signal: taste no 1 ambiguous no 0.82 judge typesafe/jev-1.13.0 tokens 1075 cost 0.00004515
- assumption (lane-mvr94xusd8x17n-1): builder-lab: anthropic lane lane-mvr94xusd8x17n-1 model anthropic/claude-opus-5-5
- assumption (lane-mvr94xusd8x17n-1, sl-curb-plan): hand-spawn: dt-mvr9cg6kaf8544c4 session /Users/jowolff/.agent-system-2/lanes/wl-mvr94xusd8x17n/sessions/2026-10-27T22-23-20-365Z_01a17f75-f92d-7000-b6ff-b83bc3b0b745 spawn sl-curb-plan review yes group dg-mvr9cg6k52758dea row openai-codex/gpt-6.1-sol
- assumption (lane-mvr94xusd8x17n-1, sl-curb-plan): hand-settled: dt-mvr9cg6kaf8544c4 routing rt-mvr9hjijw5ydof
- assumption (lane-mvr94xusd8x17n-1, sl-curb-plan): review-round: sl-curb-plan round 1 token dt-mvr9cg6kaf8544c4 group dg-mvr9cg6k52758dea verdict accepted blocking 1 counts {"counts":{"blocking":{"correctness":1},"major":{"correctness":1},"minor":{}},"titles":[{"severity":"blocking","kind":"correctness","title":"Unrestricted resume exemption can relaunch a dead or already-stalled workload"},{"severity":"major","kind":"correctness","title":"Launch-tool refusal bypasses the promised train exemption"}]}
- assumption (lane-mvr94xusd8x17n-1, sl-curb-plan): hand-spawn: dt-mvr9igkxbea236b4 session /Users/jowolff/.agent-system-2/lanes/wl-mvr94xusd8x17n/sessions/2026-10-27T22-23-20-365Z_01a17f75-f92d-7000-b6ff-b83bc3b0b745 spawn sl-curb-plan-2 review yes group dg-mvr9igkxda458ed3 row openai-codex/gpt-6.1-sol
- assumption (lane-mvr94xusd8x17n-1, sl-curb-plan): hand-settled: dt-mvr9igkxbea236b4 routing rt-mvr9jw9pzphm0f
- assumption (lane-mvr94xusd8x17n-1, sl-curb-plan): review-round: sl-curb-plan round 2 token dt-mvr9igkxbea236b4 group dg-mvr9igkxda458ed3 verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{},"minor":{}},"titles":[]}
- assumption (lane-mvr94xusd8x17n-1, sl-curb-plan): review-loop-end: sl-curb-plan reason pass
- assumption (classifier): pair-exposure: lane-mvr94xusd8x17n-2 on
- assumption (lane-mvr94xusd8x17n-2): builder-lab: anthropic lane lane-mvr94xusd8x17n-2 model anthropic/claude-opus-5-5
- assumption (lane-mvr94xusd8x17n-2): Reading of Jo's `cancel-slice sl-curb-plan` (in-mvr9o10qts2oeg, 22:38:06Z): Jo typed the cancel-slice word itself (instruction body `cancel-slice sl-curb-plan`; a plan-question `cancel` answer would have written `plan cancelled from the surface` instead, surface/src/input.ts "if (plan && word === \"cancel\")"), it carries no other words, and it relaunched this lane (launch-requested by jo). The plan is therefore not approved and plan-first still stands. GUESS(inference): Jo did not reject the curb itself (in-mvr953xawa166t stands, and the workload was not withdrawn). Action: cut a fresh plan slice sl-curb-plan-b, re-review PLAN.md rev 2 on another lab as that slice's review, and raise the plan question again, so Jo can approve, revise, or cancel; told to the orchestrator by lane_message.
- assumption (lane-mvr94xusd8x17n-2, sl-curb-plan-b): hand-spawn: dt-mvr9p62102aca4e7 session /Users/jowolff/.agent-system-2/lanes/wl-mvr94xusd8x17n/sessions/2026-10-27T22-23-20-365Z_01a17f75-f92d-7000-b6ff-b83bc3b0b745 spawn sl-curb-plan-b review yes group dg-mvr9p621d1cea092 row openai-codex/gpt-6.1-sol
- assumption (lane-mvr94xusd8x17n-2, sl-curb-plan-b): hand-settled: dt-mvr9p62102aca4e7 routing rt-mvr9qprk290r32
- assumption (lane-mvr94xusd8x17n-2, sl-curb-plan-b): review-round: sl-curb-plan-b round 1 token dt-mvr9p62102aca4e7 group dg-mvr9p621d1cea092 verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{},"minor":{}},"titles":[]}
- assumption (lane-mvr94xusd8x17n-2, sl-curb-plan-b): review-loop-end: sl-curb-plan-b reason pass
- assumption (classifier): pair-exposure: lane-mvr94xusd8x17n-3 on

## Dead ends — don't retry these

- sl-curb-plan cancelled: Plan the launcher-enforced no-new-work curb: slice cut, requirements with enforcers, cross-lab plan review
- sl-curb-plan-b cancelled: Plan the no-new-work curb again after Jo cancelled sl-curb-plan: PLAN.md rev 2, cross-lab review, plan question
- q-mvr9k6z9xsje2i withdrawn (then cancel): cancel-slice (instruction in-mvr9o10qts2oeg) — the question was: /Users/jowolff/agent-scratch/agent-system-2.0/wl-mvr94xusd8x17n/PLAN.md
- sl-curb-core: curb on/off word + SURFACE_BY curb: entry; verdictOf refuses non-train launches; open and launch_lane tools refuse; tests
- sl-curb-docs: USER-GUIDE.md word row and launch sentence; tiers/orchestrator.md curb line
- sl-curb-smoke: live-ledger backup snapshot in scratch, curb on: trains unchanged, launchable workloads curbed, held stay held
- sl-curb-review: cross-lab code review of the settled diff against PLAN.md, findings only
- sl-curb-pr: merge origin/main, declared artifact, push, PR, lane_full_test green at its head
prompt-only: R12: USER-GUIDE.md and tiers/orchestrator.md prose; wording is judged by the cross-lab review, no test reads its meaning
tradeoff: a lane that parks on a question is not running: your answer is recorded, and it resumes only after `curb off`
tradeoff: train fix workloads count as the train; due rows and by-hand `as2 lane` stay allowed (neither starts an autonomous lane)
tradeoff: no per-workload allow word: to start one workload you say `curb off`, then `curb on`; the tick may fill free slots between
review: pass, openai-codex/gpt-6.1-sol, /Users/jowolff/agent-scratch/agent-system-2.0/wl-mvr94xusd8x17n/PLAN-REVIEW-r2.md
- q-mvr9qxbwwg56fm withdrawn (then cancel): cancel-slice (instruction in-mvra61qdr9fsn2) — the question was: /Users/jowolff/agent-scratch/agent-system-2.0/wl-mvr94xusd8x17n/PLAN.md
- sl-curb-core: curb on/off word + SURFACE_BY curb: entry; verdictOf refuses non-train launches; open and launch_lane tools refuse; tests
- sl-curb-docs: USER-GUIDE.md word row and launch sentence; tiers/orchestrator.md curb line
- sl-curb-smoke: live-ledger backup snapshot in scratch, curb on: trains unchanged, launchable workloads curbed, held stay held
- sl-curb-review: cross-lab code review of the settled diff against PLAN.md, findings only
- sl-curb-pr: merge origin/main, declared artifact, push, PR, lane_full_test green at its head
prompt-only: R12: USER-GUIDE.md and tiers/orchestrator.md prose; wording is judged by the cross-lab review, no test reads its meaning
tradeoff: a lane that parks on a question is not running: your answer is recorded, and it resumes only after `curb off`
tradeoff: train fix workloads count as the train; due rows and by-hand `as2 lane` stay allowed (neither starts an autonomous lane)
tradeoff: no per-workload allow word: to start one workload you say `curb off`, then `curb on`; the tick may fill free slots between
review: pass, openai-codex/gpt-6.1-sol, /Users/jowolff/agent-scratch/agent-system-2.0/wl-mvr94xusd8x17n/PLAN-REVIEW-r3.md

## Heads-up for whoever touches this next

- message msg-mvr9p9en150jq2 [held] not acted on: Jo's `cancel-slice sl-curb-plan` (in-mvr9o10qts2oeg) cancelled the no-new-work curb's plan slice and withdrew its plan question, with no other words, and relaunched this lane. I read it as: the plan is not approved yet, and the curb ruling (in-mvr953xawa166t) still stands. I am re-raising the same plan (PLAN.md rev 2) on a fresh plan slice, sl-curb-plan-b, after one more cross-lab review. On that question Jo can answer approve, revise (with what to change), or cancel to stop. To end the whole workload instead, the word is `withdraw wl-mvr94xusd8x17n`.
