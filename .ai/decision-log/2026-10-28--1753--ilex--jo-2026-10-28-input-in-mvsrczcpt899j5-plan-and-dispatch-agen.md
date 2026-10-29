---
date: 2026-10-28T17:53-07:00
engineer: Ilex
session: wl-mvsrdd2v3xnswl
status: resolved
durable: false
supersedes:
workload: wl-mvsrdd2v3xnswl
---

# Jo (2026-10-28, input in-mvsrczcpt899j5): plan and dispatch agent-system-2.0 issue #399 (https://github.com/thewolff/agent-system-2.0/issues/399) as flow repair (jo-issues #213). ledger/test/install.test.ts:654, the --daily-report test, fails on clean main d7f57c84: `herdr plugin link` at install/install.sh:651 exits 1 because the unix socket path under the test's temporary HOME exceeds sun_path ("local socket name length exceeds capacity of sun_path of sockaddr_un"). That keeps main's after-merge full suite red even after #397 lands. Fix options in the issue: a short per-test HOME (unique mkdtemp under /tmp or a short symlink) or an installer-made short socket directory independent of HOME. Hard requirements: a real herdr link failure must still fail the install (no silent fallback; keep the `|| fail` check); unique temp dir per test (parallel workers); cleanup in afterEach/finally, leaving the dir only on failure; no change to the socket location of existing real installs without a migration. Acceptance: the test passes on main and in a long-$TMPDIR fixture, and a forced herdr link failure still fails the install. Plan first. Normal train flow: open a PR and board it on the merge train. Any change to install/install.sh comes to Jo for review before merge. Explicit exception to Jo's no-new-work curb (in-mvr942e8yl6y4b).

done: A PR fixing issue #399 is on the merge train with a green full suite, ledger/test/install.test.ts --daily-report passes on main and under a long-$TMPDIR fixture, a forced herdr link failure still fails the install, and any install/install.sh change has been put to Jo before merge.
done-because: PR #406 (https://github.com/thewolff/agent-system-2.0/pull/406, "Fixes #399", head 7bf09e5e) is green in the full suite (tr-0mvssr410vvdzht: 6832 pass / 0 fail / 132 skip, en-mvstwpxchetvex) and its cross-lab review passed (sl-399-review, openai-codex/gpt-6.1-sol, no findings), so it is ready for the merge train. The --daily-report test passes at that head (`bun test ledger/test/install.test.ts ledger/test/file-links-install.test.ts` → 81/0) and under a long-$TMPDIR fixture (`-t daily-report` → 4/0). A forced herdr link failure still fails the install: file-links-install.test.ts "a failed herdr registration…" → exit 1, no "install complete", inside that 81/0 run. install/install.sh is unchanged (`git diff --name-only origin/main...HEAD` = ledger/test/install.test.ts only), so there was no installer change to put to Jo; Jo approved the plan that says so (q-mvsrt1t979jp5y). On main itself the test passes once the train lands #406.

Rendered from the ledger by Ilex (they/them) at workload close; stakes normal, mode autonomous, opened 2026-10-28T23:41:28.567Z.

## What changed

- sl-399-plan: Plan the fix for #399: short per-test HOME vs installer socket dir, requirements, How it fails, slice cut — artifact: /Users/jowolff/agent-scratch/agent-system-2.0/wl-mvsrdd2v3xnswl/PLAN.md approved by Jo (q-mvsrt1t979jp5y, in-mvssmmvpm7xxq9); review pass openai-codex/gpt-6.1-sol /Users/jowolff/agent-scratch/agent-system-2.0/wl-mvsrdd2v3xnswl/PLAN-REVIEW-r3.md
- sl-399-fix: install.test.ts: daily-report run on herdr-free PATH, assert herdr not reached, completion-counted fixture-root cleanup kept on failure — artifact: commit 7bf09e5e on wl/wl-mvsrdd2v3xnswl (PR https://github.com/thewolff/agent-system-2.0/pull/406, only ledger/test/install.test.ts changed); `bun test ledger/test/install.test.ts ledger/test/file-links-install.test.ts` → 81 pass / 0 fail; long-TMPDIR `-t daily-report` → 4/0; failure retention proven by hand sl-399-fix (sync, reject, timeout kept root)
- sl-399-review: Cross-lab findings-only review of the settled sl-399-fix diff against PLAN.md — artifact: review pass, no findings, openai-codex/gpt-6.1-sol (builder labs anthropic: lane and sl-399-fix hand); reviewer ran `bun test ledger/test/install.test.ts` at 7bf09e5e → 39 pass / 0 fail; transcript /Users/jowolff/.agent-system-2/lanes/wl-mvsrdd2v3xnswl/sessions/2026-10-28T23-41-35-800Z_01a184e3-fab8-7000-bcce-4aca622843c5/sl-399-review.jsonl
- sl-full-mvsrdd2v3xnswl-1: full suite outside the fence at PR #406 — artifact: test-run tr-0mvssr410vvdzht: green at 7bf09e5eccf56d5e14486c954543d4ca763c33b0 on PR #406; full 6832/0/132; alone: none; /Users/jowolff/.agent-system-2/test-runs/tr-0mvssr410vvdzht

## Decisions made (and why)

- jo (surface): Jo: "Plan and dispatch as2 #399 as flow repair. The install.test.ts --daily-report test fails on clean main d7f57c84: herdr plugin link exits 1 because the unix socket path under the test's temp HOME is longer than sun_path. That keeps main's after-merge full suite red even after #397 lands. The fix must keep a real herdr link failure failing the install. Normal train flow; any change to install.sh comes to me before merge." — reading: Plan first, then fix issue #399 (install.test.ts --daily-report fails on main because herdr's socket path under the test's temp HOME exceeds sun_path) in normal merge-train flow; a real herdr link failure must still fail the install; any change to install/install.sh goes to Jo for review before merge; explicit exception to the no-new-work curb.
- jo (surface): Jo: "approve q-mvsrt1t979jp5" — reading: Jo approves the issue #399 plan (q-mvsrt1t979jp5y), typed with the id's last character missing, so the surface did not register it as the answer; the formal answer still needs `approve q-mvsrt1t979jp5y`.
- jo answered "approve" to q-mvsrt1t979jp5y (/Users/jowolff/agent-scratch/agent-system-2.0/wl-mvsrdd2v3xnswl/PLAN.md
- sl-399-fix: install.test.ts only: daily-report run gets herdr-free PATH, asserts herdr not reached; fixture root removed after a clean run, kept on failure
- sl-399-review: cross-lab findings-only review of the settled diff against PLAN.md
- sl-399-full: PR "Fixes #399", lane_full_test green at its head; merge train lands it
prompt-only: R2: long-$TMPDIR pass is a one-time proof run in sl-399-fix; no permanent test sets TMPDIR
prompt-only: R5: install/install.sh stays unchanged; lane checks the PR file list, no gate reads it
prompt-only: R6: real installs keep their herdr socket location; follows from R5, installer untouched
tradeoff: root cause is the test leaking the dev PATH (real herdr ran); fixed in the test, so install.sh is untouched and nothing needs your pre-merge review
tradeoff: cleanup is afterAll, not afterEach: the fix adds no temp dir and the per-file root is shared by every test; kept when any test body fails or times out
review: pass, openai-codex/gpt-6.1-sol, /Users/jowolff/agent-scratch/agent-system-2.0/wl-mvsrdd2v3xnswl/PLAN-REVIEW-r3.md)
- assumption (classifier): pair-exposure: lane-mvsrdd2v3xnswl-1 on
- assumption (classifier): pair-signal: taste no 1 ambiguous no 0.92 judge typesafe/jev-1.13.0 tokens 899 cost 0.000037758
- assumption (lane-mvsrdd2v3xnswl-1): builder-lab: anthropic lane lane-mvsrdd2v3xnswl-1 model anthropic/claude-opus-5-5
- assumption (lane-mvsrdd2v3xnswl-1, sl-399-plan): hand-spawn: dt-mvsri2ul58a77928 session /Users/jowolff/.agent-system-2/lanes/wl-mvsrdd2v3xnswl/sessions/2026-10-28T23-41-35-800Z_01a184e3-fab8-7000-bcce-4aca622843c5 spawn sl-399-plan review yes group dg-mvsri2ul47e583f1 row openai-codex/gpt-6.1-sol
- assumption (lane-mvsrdd2v3xnswl-1, sl-399-plan): hand-settled: dt-mvsri2ul58a77928 routing rt-mvsrjz2727h6o6
- assumption (lane-mvsrdd2v3xnswl-1, sl-399-plan): review-round: sl-399-plan round 1 token dt-mvsri2ul58a77928 group dg-mvsri2ul47e583f1 verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{"correctness":1},"minor":{}},"titles":[{"severity":"major","kind":"correctness","title":"Existing temp-root allocation does not satisfy the cleanup requirement"}]}
- assumption (lane-mvsrdd2v3xnswl-1, sl-399-plan): review-loop-end: sl-399-plan reason pass
- assumption (lane-mvsrdd2v3xnswl-1, sl-399-plan): hand-spawn: dt-mvsrmnjj82164e18 session /Users/jowolff/.agent-system-2/lanes/wl-mvsrdd2v3xnswl/sessions/2026-10-28T23-41-35-800Z_01a184e3-fab8-7000-bcce-4aca622843c5 spawn sl-399-plan-2 review yes group dg-mvsrmnjj8c8647a3 row openai-codex/gpt-6.1-sol
- assumption (lane-mvsrdd2v3xnswl-1, sl-399-plan): hand-settled: dt-mvsrmnjj82164e18 routing rt-mvsrpw5o3b17nx
- assumption (lane-mvsrdd2v3xnswl-1, sl-399-plan): review-round: sl-399-plan round 1 token dt-mvsrmnjj82164e18 group dg-mvsrmnjj8c8647a3 verdict accepted blocking 1 counts {"counts":{"blocking":{"correctness":1},"major":{"design":1},"minor":{}},"titles":[{"severity":"blocking","kind":"correctness","title":"Runner timeouts bypass the failure flag and permit evidence deletion"},{"severity":"major","kind":"design","title":"The plan substitutes afterAll for the required afterEach/finally cleanup"}]}
- assumption (lane-mvsrdd2v3xnswl-1, sl-399-plan): hand-spawn: dt-mvsrrbj35d2dff22 session /Users/jowolff/.agent-system-2/lanes/wl-mvsrdd2v3xnswl/sessions/2026-10-28T23-41-35-800Z_01a184e3-fab8-7000-bcce-4aca622843c5 spawn sl-399-plan-3 review yes group dg-mvsrrbj3db5de818 row openai-codex/gpt-6.1-sol
- assumption (lane-mvsrdd2v3xnswl-1, sl-399-plan): hand-settled: dt-mvsrrbj35d2dff22 routing rt-mvsrsp7zsd74hl
- assumption (lane-mvsrdd2v3xnswl-1, sl-399-plan): review-round: sl-399-plan round 2 token dt-mvsrrbj35d2dff22 group dg-mvsrrbj3db5de818 verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{},"minor":{}},"titles":[]}
- assumption (lane-mvsrdd2v3xnswl-1, sl-399-plan): review-loop-end: sl-399-plan reason pass
- assumption (lane-mvsrdd2v3xnswl-1, sl-399-plan): Plan at /Users/jowolff/agent-scratch/agent-system-2.0/wl-mvsrdd2v3xnswl/PLAN.md, awaiting Jo on q-mvsrt1t979jp5y (flow repair, so no auto-start). Root cause reproduced on d7f57c84: the --daily-report test (ledger/test/install.test.ts:661) passes the developer PATH to install.sh, so the real /opt/homebrew/bin/herdr ran and its socket path under the temp HOME overflowed sun_path; every other installer run in that file uses the herdr-free installPath. Fix is test-only; install/install.sh unchanged. Probe ($AS2_SCRATCH/probe): full file 39/0, long-TMPDIR daily-report 4/0, file-links-install.test.ts 42/0 incl. forced herdr exit 7 → install exit 1. Plan review: r1 revise (cleanup missing), r2 revise (timeout bypass, afterEach scope), r3 pass on openai-codex/gpt-6.1-sol; verdicts PLAN-REVIEW-r1..r3.md in the plan dir. Next on approve: add sl-399-fix, sl-399-review; dispatch sl-399-fix.
- assumption (classifier): pair-exposure: lane-mvsrdd2v3xnswl-2 on
- assumption (lane-mvsrdd2v3xnswl-2): builder-lab: anthropic lane lane-mvsrdd2v3xnswl-2 model anthropic/claude-opus-5-5
- assumption (lane-mvsrdd2v3xnswl-2, sl-399-fix): hand-spawn: dt-mvssneoe91544b14 session /Users/jowolff/.agent-system-2/lanes/wl-mvsrdd2v3xnswl/sessions/2026-10-28T23-41-35-800Z_01a184e3-fab8-7000-bcce-4aca622843c5 spawn sl-399-fix review no group dg-mvssneoe594b2443 row anthropic/claude-sonnet-5-5
- assumption (lane-mvsrdd2v3xnswl-2, sl-399-fix): hand-settled: dt-mvssneoe91544b14 routing rt-mvssphealdiovv
- assumption (lane-mvsrdd2v3xnswl-2, sl-399-fix): artifact-command: bun test ledger/test/install.test.ts ledger/test/file-links-install.test.ts
- assumption (lane-mvsrdd2v3xnswl-2, sl-399-review): hand-spawn: dt-mvssr2nw7bdd0a2f session /Users/jowolff/.agent-system-2/lanes/wl-mvsrdd2v3xnswl/sessions/2026-10-28T23-41-35-800Z_01a184e3-fab8-7000-bcce-4aca622843c5 spawn sl-399-review review yes group dg-mvssr2nwe6ab13ad row openai-codex/gpt-6.1-sol
- assumption (lane-mvsrdd2v3xnswl-2, sl-399-review): hand-settled: dt-mvssr2nw7bdd0a2f routing rt-mvsstr3fcvdvt3
- assumption (lane-mvsrdd2v3xnswl-2, sl-399-review): review-round: sl-399-review round 1 token dt-mvssr2nw7bdd0a2f group dg-mvssr2nwe6ab13ad verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{},"minor":{}},"titles":[]}
- assumption (lane-mvsrdd2v3xnswl-2, sl-399-review): review-loop-end: sl-399-review reason pass

## Dead ends — don't retry these

- none

## Heads-up for whoever touches this next

- none
