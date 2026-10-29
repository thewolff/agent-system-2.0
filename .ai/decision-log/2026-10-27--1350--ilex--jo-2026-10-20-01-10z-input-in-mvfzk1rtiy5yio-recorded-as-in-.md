---
date: 2026-10-27T13:50-07:00
engineer: Ilex
session: wl-mvfzkm6jrv1xxc
status: resolved
durable: false
supersedes:
workload: wl-mvfzkm6jrv1xxc
---

# Jo (2026-10-20 ~01:10Z, input in-mvfzk1rtiy5yio, recorded as in-mvfzk9ersv7k00 on wl-mvb9mw00ycfjeo): split the PLAN-3 work out of the pair-handoff workload into its own normal workload that waits on PR #261 (the Jo-only boundary, observe-and-tune wl-mv654hoqwpfhmo).

The work (Jo's original ask, in-mvfwiux65zlybk on wl-mvb9mw00ycfjeo): (1) in a by-hand lane (AGENT_SYSTEM_BY_HAND=1) the harness, never the model, reads each line Jo types at that lane's prompt through the surface's interpreter (surface/src/input.ts interpret/apply) and applies it, as author jo, when it is an answer word for a question on that lane's own workload. Every other line stays a normal chat turn. The model has no path to write a Jo-authored answer. (2) A bare word with no id answers when exactly one question is open on that workload. With two or more open it is refused, and the open ids are listed. (3) The surface also accepts `<q-id> <word>` as the same answer as `<word> <q-id>`.

Decided already: channel `direct`, written by the as2 lane launcher (Jo's `direct` on q-mvfy61hw6zzd34, in-mvfyawutp1log0). Loud forgery detection (wl-mvfxw3c4zqfzls, in-mvfyd6bwf7y800) counts that writer as a Jo channel. #261's triggers and tests have to accept that row (forgery audit gap G6: /Users/jowolff/agent-scratch/agent-system-2.0/scratch/wl-mv654hoqwpfhmo/auth-forgery/AUDIT.md).

Start from the existing draft: /Users/jowolff/agent-scratch/agent-system-2.0/wl-mvb9mw00ycfjeo/PLAN-3.md and its review PLAN-3-REVIEW-r1.md (same-lab, by Jo's `same-lab` on q-mvfwk4bwlax0xs). Copy them into this workload's scratch and revise from there. Wait on #261: no change slice is built until #261 has merged, or until its head is final and the plan names how this PR stacks on it. The plan says which. The plan comes to Jo for approval.

Done when (Jo's words): a test types `review` into a by-hand lane with one open question, and the question shows answered by jo (channel direct, writer the as2 lane launcher); the same text produced by the model answers nothing; `q-… review` at the surface answers the question. The full suite is green via lane_full_test at the head of a pushed PR. Jo merges.

done: A test shows Jo's word typed in a by-hand lane with one open question answers it as author jo on channel direct from the as2 lane launcher, the same text produced by the model answers nothing, `q-… <word>` at the surface answers the question, the change fits PR #261's boundary, and the full suite is green at the head of a pushed PR in agent-system-2.0.
done-because: (no receipt recorded)

Rendered from the ledger by Ilex (they/them) at workload close; stakes normal, mode autonomous, opened 2026-10-20T01:10:03.595Z.

## What changed

- sl-plan-typed: Plan: revise PLAN-3 (by-hand lane typed answers as author jo, channel direct; bare-word answer; q-id word order) against PR #261's boundary, cross-lab review, raise plan question — artifact: Jo approved q-mvg0m8vvztbjeo (in-mvg1qinl724b9c) on /Users/jowolff/agent-scratch/agent-system-2.0/scratch/wl-mvfzkm6jrv1xxc/PLAN.md rev 9; cross-lab reviews r2-r7 (openai-codex/gpt-6.1-sol) in the same directory; final round r7 left 1 minor ("35-second lost-connection fallback omits a successful lane-starter withdrawal, including a typed plan cancel"), fixed in rev 9.

## Decisions made (and why)

- jo answered "approve" to q-mvg0m8vvztbjeo (/Users/jowolff/agent-scratch/agent-system-2.0/scratch/wl-mvfzkm6jrv1xxc/PLAN.md
- sl-ta-interpret: input.ts interpretLane, lane origin in apply, bare word answers only with one open question, `<q-id> <word>`; tests
- sl-ta-boundary: joAuthority accepts lane-starter/direct answers; 4 answer readers (extend, round extend, waive, train) onto it; tests
- sl-ta-relay: launcher's keyed loopback relay writes Jo's answer on its own handle; lane input hook, deadlines, notices; tests
- sl-ta-session: real bin/as2 lane in a pty: typed `review` answers as jo/direct/lane-starter; model text answers nothing
- sl-ta-docs: USER-GUIDE, DESIGN-lane-launcher, ledger/SCHEMA.md, migration/items/by-hand-typed-answers.md
- sl-ta-review: cross-lab code review of the settled diff, findings only
- sl-ta-pr: merge origin/main, push, open PR, lane_full_test green at head; the merge train lands it
prompt-only: R19: wait for #258 and #261 to merge, then merge main in, no stack; other workloads' merge order, no gate reads it
prompt-only: R20: reaches by-hand lanes only after main is installed and lanes restart; deployment timing is Jo's
tradeoff: waits for #261 to merge rather than stacking: its G1-G3 commits are unpushed, so its head is not final; may idle a while
tradeoff: lost relay connection can end "outcome unknown"; you check the surface render; the ledger trigger prevents a double answer
tradeoff: a typed answer is refused while row 11 holds unrecorded words; you send any message first, then the answer
review: revise (1 minor fixed in rev 9), openai-codex/gpt-6.1-sol, /Users/jowolff/agent-scratch/agent-system-2.0/scratch/wl-mvfzkm6jrv1xxc/PLAN-REVIEW-r7.md)
- jo (surface): withdraw wl-mvfzkm6jrv1xxc
- orchestrator (surface): close receipt: withdrawn by Jo (in-mvr5r8we1rzt31): closed with no done-because: receipt
- assumption (orchestrator-surface): brief-judged: change-large confidence 0.95 judge typesafe/jev-1.13.0
- assumption (classifier): pair-exposure: lane-mvfzkm6jrv1xxc-1 on
- assumption (classifier): pair-signal: taste no 1 ambiguous no 0.88 judge typesafe/jev-1.13.0 tokens 1222 cost 0.000051324
- assumption (lane-mvfzkm6jrv1xxc-1): builder-lab: anthropic lane lane-mvfzkm6jrv1xxc-1 model anthropic/claude-opus-5-5
- assumption (lane-mvfzkm6jrv1xxc-1, sl-plan-typed): hand-spawn: dt-mvfzsb62396b7ce3 session /Users/jowolff/.agent-system-2/lanes/wl-mvfzkm6jrv1xxc/sessions/2026-10-20T01-10-07-116Z_01a156db-ca0c-7000-9a4a-464565507826 spawn sl-plan-typed review yes group dg-mvfzsb62011278b5 row openai-codex/gpt-6.1-sol
- assumption (lane-mvfzkm6jrv1xxc-1, sl-plan-typed): hand-settled: dt-mvfzsb62396b7ce3 routing rt-mvfzy2wmttrqio
- assumption (lane-mvfzkm6jrv1xxc-1, sl-plan-typed): review-round: sl-plan-typed round 1 token dt-mvfzsb62396b7ce3 group dg-mvfzsb62011278b5 verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{"correctness":2,"design":1},"minor":{}},"titles":[{"severity":"major","kind":"correctness","title":"Detection F2(c) flags marked lane-starter typed answers; predicate and R2 must agree, not only R7"},{"severity":"major","kind":"correctness","title":"Synchronous held-row retry and late-created notAfter invalidate D9's hook bound and final timeout outcome"},{"severity":"major","kind":"design","title":"Installer-based session artifacts precede the sole manifest-owner slice"}]}
- assumption (lane-mvfzkm6jrv1xxc-1, sl-plan-typed): review-loop-end: sl-plan-typed reason pass
- assumption (lane-mvfzkm6jrv1xxc-1, sl-plan-typed): hand-spawn: dt-mvg01x2o6cd608da session /Users/jowolff/.agent-system-2/lanes/wl-mvfzkm6jrv1xxc/sessions/2026-10-20T01-10-07-116Z_01a156db-ca0c-7000-9a4a-464565507826 spawn sl-plan-typed-2 review yes group dg-mvg01x2o86f1b824 row openai-codex/gpt-6.1-sol
- assumption (lane-mvfzkm6jrv1xxc-1, sl-plan-typed): hand-settled: dt-mvg01x2o6cd608da routing rt-mvg05f2q35hnuo
- assumption (lane-mvfzkm6jrv1xxc-1, sl-plan-typed): review-round: sl-plan-typed round 1 token dt-mvg01x2o6cd608da group dg-mvg01x2o86f1b824 verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{"correctness":1},"minor":{}},"titles":[{"severity":"major","kind":"correctness","title":"D9 permits a late commit after a definitive not-applied notice, contradicting R12's final-outcome and no-late-write guarantees"}]}
- assumption (lane-mvfzkm6jrv1xxc-1, sl-plan-typed): review-loop-end: sl-plan-typed reason pass
- assumption (lane-mvfzkm6jrv1xxc-1, sl-plan-typed): hand-spawn: dt-mvg06tfme741b138 session /Users/jowolff/.agent-system-2/lanes/wl-mvfzkm6jrv1xxc/sessions/2026-10-20T01-10-07-116Z_01a156db-ca0c-7000-9a4a-464565507826 spawn sl-plan-typed-3 review yes group dg-mvg06tfm2d9d514f row openai-codex/gpt-6.1-sol
- assumption (lane-mvfzkm6jrv1xxc-1, sl-plan-typed): hand-settled: dt-mvg06tfme741b138 routing rt-mvg09o2t77b75s
- assumption (lane-mvfzkm6jrv1xxc-1, sl-plan-typed): review-round: sl-plan-typed round 1 token dt-mvg06tfme741b138 group dg-mvg06tfm2d9d514f verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{"correctness":1},"minor":{}},"titles":[{"severity":"major","kind":"correctness","title":"Lost-connection fallback can end with an inconclusive 35-second read despite R12 promising a final outcome"}]}
- assumption (lane-mvfzkm6jrv1xxc-1, sl-plan-typed): review-loop-end: sl-plan-typed reason pass
- assumption (lane-mvfzkm6jrv1xxc-1, sl-plan-typed): hand-spawn: dt-mvg0aydpec66c08d session /Users/jowolff/.agent-system-2/lanes/wl-mvfzkm6jrv1xxc/sessions/2026-10-20T01-10-07-116Z_01a156db-ca0c-7000-9a4a-464565507826 spawn sl-plan-typed-4 review yes group dg-mvg0aydp0ce3f51c row openai-codex/gpt-6.1-sol
- assumption (lane-mvfzkm6jrv1xxc-1, sl-plan-typed): hand-settled: dt-mvg0aydpec66c08d routing rt-mvg0d4vmk970n4
- assumption (lane-mvfzkm6jrv1xxc-1, sl-plan-typed): review-round: sl-plan-typed round 1 token dt-mvg0aydpec66c08d group dg-mvg0aydp0ce3f51c verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{"correctness":1},"minor":{}},"titles":[{"severity":"major","kind":"correctness","title":"Lost-connection recovery and T1 promise an already-answered surface refusal, but the specified surface parser passes that retry as prose"}]}
- assumption (lane-mvfzkm6jrv1xxc-1, sl-plan-typed): review-loop-end: sl-plan-typed reason pass
- assumption (lane-mvfzkm6jrv1xxc-1, sl-plan-typed): hand-spawn: dt-mvg0eozv27f435bc session /Users/jowolff/.agent-system-2/lanes/wl-mvfzkm6jrv1xxc/sessions/2026-10-20T01-10-07-116Z_01a156db-ca0c-7000-9a4a-464565507826 spawn sl-plan-typed-5 review yes group dg-mvg0eozv43587988 row openai-codex/gpt-6.1-sol
- assumption (lane-mvfzkm6jrv1xxc-1, sl-plan-typed): hand-settled: dt-mvg0eozv27f435bc routing rt-mvg0ibfl57s934
- assumption (lane-mvfzkm6jrv1xxc-1, sl-plan-typed): review-round: sl-plan-typed round 1 token dt-mvg0eozv27f435bc group dg-mvg0eozv43587988 verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{},"minor":{"correctness":1}},"titles":[{"severity":"minor","kind":"correctness","title":"Lost-connection fallback says the question was still open for any non-lane-starter result, including an observed surface answer or withdrawal"}]}
- assumption (lane-mvfzkm6jrv1xxc-1, sl-plan-typed): review-loop-end: sl-plan-typed reason pass
- assumption (lane-mvfzkm6jrv1xxc-1, sl-plan-typed): hand-spawn: dt-mvg0j0nsf97a26d9 session /Users/jowolff/.agent-system-2/lanes/wl-mvfzkm6jrv1xxc/sessions/2026-10-20T01-10-07-116Z_01a156db-ca0c-7000-9a4a-464565507826 spawn sl-plan-typed-6 review yes group dg-mvg0j0nsb934259a row openai-codex/gpt-6.1-sol
- assumption (lane-mvfzkm6jrv1xxc-1, sl-plan-typed): hand-settled: dt-mvg0j0nsf97a26d9 routing rt-mvg0lgg8l158n4
- assumption (lane-mvfzkm6jrv1xxc-1, sl-plan-typed): review-round: sl-plan-typed round 1 token dt-mvg0j0nsf97a26d9 group dg-mvg0j0nsb934259a verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{},"minor":{"correctness":1}},"titles":[{"severity":"minor","kind":"correctness","title":"35-second lost-connection fallback omits a successful lane-starter withdrawal, including a typed plan cancel"}]}
- assumption (lane-mvfzkm6jrv1xxc-1, sl-plan-typed): review-loop-end: sl-plan-typed reason pass
- assumption (lane-mvfzkm6jrv1xxc-1, sl-plan-typed): Plan rev 9 raised to Jo as q-mvg0m8vvztbjeo. Six review rounds ran on openai-codex/gpt-6.1-sol: r2 found 3 major, r3, r4 and r5 found 1 major each, r6 and r7 found 1 minor each. All are resolved in the plan. The r7 minor fix (fallback covers a lane-starter withdrawal) was not re-reviewed. Wait rule chosen: merge, not stack. No change slice until #258 and #261 are both merged; #261's G1-G3 commits are unpushed, so its head is not final. Detection plan wl-mvfxw3c4zqfzls rev 4 already matches the lane-starter row; msg about the mismatch was superseded by the follow-up message.
- assumption (classifier): pair-exposure: lane-mvfzkm6jrv1xxc-2 on
- assumption (lane-mvfzkm6jrv1xxc-2): builder-lab: anthropic lane lane-mvfzkm6jrv1xxc-2 model anthropic/claude-opus-5-5
- assumption (lane-mvfzkm6jrv1xxc-2): waiting (R19): no change slice is cut. At 2026-10-20 both prerequisites are still OPEN: PR #258 at head 6ca1655 and PR #261 at head 0b874c6 (gh pr view, mergedAt null); origin/main is at 3d58005. The lane releases now. Relaunch it once both have merged; it will then merge origin/main into wl/wl-mvfzkm6jrv1xxc once, check ledger/src/authority.ts against the plan, and cut sl-ta-interpret and sl-ta-boundary.

## Dead ends — don't retry these

- none

## Heads-up for whoever touches this next

- message msg-mvfzrzhlridm9s [delivered] not acted on: Cross-workload mismatch on the by-hand typed answer's writer stamp. This plan (/Users/jowolff/agent-scratch/agent-system-2.0/scratch/wl-mvfzkm6jrv1xxc/PLAN.md D7) stamps lane-typed answer rows created_by `lane-starter` (the as2 lane launcher's writer id) and adds a joAuthority clause for them, following the option Jo chose on q-mvfy61hw6zzd34 ("told apart from row 11's direct instructions … by its writer id, the as2 lane launcher"). The loud-forgery-detection plan rev 3 (wl-mvfxw3c4zqfzls, /Users/jowolff/agent-scratch/agent-system-2.0/wl-mvfxw3c4zqfzls/PLAN.md D1 and R7) assumes those rows carry the `orchestrator-surface` stamp plus its launcher provenance mark, with joAuthority unchanged. Its check is stamp-agnostic on the launcher's handle, so only its R7 text and the joAuthority clause disagree. Please relay to the wl-mvfxw3c4zqfzls lane, or to Jo if a ruling is needed. This plan also cedes G4 (moving readers onto joAuthority) to that workload, apart from the four answer readers a lane-typed answer must reach.
- message msg-mvg01klwg36kg0 [delivered] not acted on: Update to msg-mvfzrzhlridm9s: the stamp mismatch is already resolved on the detection side. wl-mvfxw3c4zqfzls's plan is now rev 4, "aligned to PLAN-3 rev 2's lane-typed row (lane-starter, joAuthority widened there)", with a process-wide declareJoChannel that marks the launcher's relay. This plan's rev 4 (/Users/jowolff/agent-scratch/agent-system-2.0/scratch/wl-mvfzkm6jrv1xxc/PLAN.md D7) states the same contract. Nothing needs relaying.
- message msg-mvg1r0539t1u68 [delivered] not acted on: wl-mvfzkm6jrv1xxc: Jo approved the plan (q-mvg0m8vvztbjeo), and sl-plan-typed is closed. Under the approved start condition (R19), no change slice is cut while PR #258 (head 6ca1655) and PR #261 (head 0b874c6) are still open; both were open just now. This lane is releasing. Please relaunch the workload once both have merged on main; nothing is needed from Jo before then.
