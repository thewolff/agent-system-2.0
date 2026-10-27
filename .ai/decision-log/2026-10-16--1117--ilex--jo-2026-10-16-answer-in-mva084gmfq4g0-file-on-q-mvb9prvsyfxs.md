---
date: 2026-10-16T11:17-07:00
engineer: Ilex
session: wl-mvba0qibcx61vk
status: resolved
durable: false
supersedes:
workload: wl-mvba0qibcx61vk
---

# Jo (2026-10-16, answer in-mva084gmfq4g0: `file` on q-mvb9prvsyfxszk): file the as2 defects Ilex has been tracking as GitHub issues in agent-system-2.0 (thewolff/agent-system-2.0), one issue per defect, each with the evidence below plus whatever the lane confirms from the ledger (/Users/jowolff/.agent-system-2/ledger.db) or the code. Before filing, search existing open and closed issues and MIGRATION.md on origin/main; for a defect already filed, comment the new evidence on that issue instead of opening a duplicate. Report back the issue URL for each defect. No code changes.

Defects:
1. Same-lab review approval: a headroom-skip row between the same-lab rule and the review spawn is not counted by `sameLabTokens` (lane-tools.ts), so a granted same-lab review still cannot approve a plan. Seen on the PR #218 conflict fix wl-mvaqnihc2r85c0 (entries 19407 rule, 19408 headroom-skip, 19409 spawn).
2. Held timers reset by Jev rank runs: as2-rank `priority-signal` rows count as activity, so about 60 workloads all show "held, no activity since 2026-10-15T21:13:31Z", the same rank-run stamp.
3. `cancel` and `accept` answers do not settle the slice they answer (the PR #153 sync slice on wl-mv8wzytml878b4 stayed open after Jo's `cancel`).
4. Held drafts echoed as Jo's input and applied: q-mv99ichikqgd1c received a false `merged`.
5. The close check counts merged sibling PRs from a shared branch: the #221 merge train wl-mva2bas9070hkw cannot close because it picks up the merged #156.
6. Flaky as2test T5 from a shared /private/tmp. Also seen today: classifier/test/crosslab.test.ts T3e failed once in tr-0mvb8405ob3o9o9 (waits on a single setImmediate flush, crosslab.test.ts:1555/:1749) and passed alone.
7. Close-check `git fetch origin timed out: no output` repeats on every tick (bindfix wl-mv5qdfvv82ivwg).
8. An open orchestrator question blocks unrelated work: with q-mvb8w6mhki5ts0 open, orchestrator_open_workload for Jo's new pair-offer ask was refused twice with "a reply that does not answer it gets words, not work".
9. Mode inferred from a topic word: the pair-offer workload wl-mvb9mw00ycfjeo opened user-driven, "mode inferred user-driven: you said \"pair\"", though pairing was the subject, not a request.
10. Two P-11 row 1 rules conflict for reserved actions: a choice must be a final QUESTION block, and a QUESTION block must name a q-row Ilex raised, but a reserved action (`approve en-…`) has no q-row.
11. A stakes change does not apply to a running plan the way the brief implied: `normal` on wl-mvb8tyw5u1ut4w only lowered the review round limit; the lane recorded "plan slice and cross-lab plan review stay as running". File only if the lane confirms this contradicts SPEC-2.0.md; otherwise note it as working as designed.
12. The orchestrator cannot write any durable note (a write to /Users/jowolff/agent-scratch/... was refused: "the orchestrator opens workloads; a lane does this"), so a list Ilex keeps lives only in its session summary.

done: Every defect in the brief has a GitHub issue URL in agent-system-2.0 (new, or an existing issue with the evidence added as a comment), reported back to the orchestrator, with no code changed.
done-because: Each of the 12 defects in the brief now has a new GitHub issue in thewolff/agent-system-2.0: 1→#228, 2→#227, 3→#226, 4→#225, 5→#223, 6→#229 and #230 (two unrelated causes), 7→#224, 8→#232, 9→#233, 10→#234, 11→#231, 12→#235. I searched the 57 existing issues and MIGRATION.md on origin/main 9f3f0e1 first; none of the defects had an issue, so there was no existing issue to comment on. Each issue carries the evidence confirmed from the ledger and code. The URLs went to the orchestrator in msg-mvbah9h1c4nta8. No code was changed, no branch was pushed, and no PR was opened.

Rendered from the ledger by Ilex (they/them) at workload close; stakes normal, mode autonomous, opened 2026-10-16T18:03:40.979Z.

## What changed

- sl-dedupe: Search open+closed GitHub issues in thewolff/agent-system-2.0 and MIGRATION.md / migration/items on origin/main for each of the 12 defects; map each to an existing issue or 'new' — artifact: /Users/jowolff/agent-scratch/agent-system-2.0/scratch/wl-mvba0qibcx61vk/DEDUPE.md — gh issue list --state all --limit 500 on thewolff/agent-system-2.0 → 57 issues (55 workload mirrors, #215 smoke, #124 test), keyword search per defect found no defect report: all 12 new on GitHub. MIGRATION.md/migration/items candidates listed per defect; final same/related verdicts ride the per-defect drafts.
- sl-ev-review: Confirm defects 1 (sameLabTokens skips headroom-skip) and 11 (stakes change vs running plan, check SPEC-2.0.md) from ledger+code; draft issue bodies — artifact: drafts/d01.md, d11.md in /Users/jowolff/agent-scratch/agent-system-2.0/scratch/wl-mvba0qibcx61vk/. d01 confirmed: entries rowids 19407/19408/19409 on wl-mvaqnihc2r85c0 (rule, headroom-skip, spawn), sameLabTokens next-entry check surface/extensions/lane-tools.ts:174-176, recordSpawn order classifier/extension.ts:2218-2221; also hit wl-mvb8tyw5u1ut4w. d11: reported plan continuation is as designed (§ B6 amended 2026-10-02); Jo's normal never applied (workloads.stakes still production, ceiling 19468) contradicts § A1.2/§ B4. Filed #228, #231.
- sl-ev-answers: Confirm defects 2 (priority-signal rows reset held timers), 3 (cancel/accept answers do not settle slice), 4 (held drafts echoed as Jo input) from ledger+code; draft issue bodies — artifact: drafts/d02.md, d03.md, d04.md in /Users/jowolff/agent-scratch/agent-system-2.0/scratch/wl-mvba0qibcx61vk/; all three confirmed: d02 61 priority-signal rows at 2026-10-15T21:13:31Z, last_activity_at = max(provenance.at) ledger/schema.sql:614; d03 q-mv9qugxmopxpfk cancel → provenance seq 388440 sl-pr153-sync paused->open, trigger questions_resolution_settles_slice; d04 in-mv99it11jzwb9c applied from row 1 held-reply continuation (Ilex session line 6897/6899). Filed (see sl-file).
- sl-ev-close: Confirm defects 5 (close check counts merged sibling PRs from shared branch) and 7 (close-check git fetch timeout repeats each tick) from ledger+code; draft issue bodies — artifact: drafts/d05.md and drafts/d07.md in /Users/jowolff/agent-scratch/agent-system-2.0/scratch/wl-mvba0qibcx61vk/; d05 confirmed (close-entry.ts gatherCloseSet lists all PRs on push-dest branch wl/wl-mv8s8srodefytc; #156/#220 greens live on wl-mv8s8srodefytc); d07 partly confirmed (9 timeout lines for wl-mv5qdfvv82ivwg 2026-10-15T18:13Z..10-16T17:42Z, not every tick; dedupe keeps last text only, wake.ts refusedClose). Filed as #223.
- sl-ev-flaky: Confirm defect 6 (as2test T5 flaky from shared /private/tmp; crosslab.test.ts T3e single setImmediate flush) from runner results+code; draft issue body — artifact: drafts/d06.md, d06b.md in /Users/jowolff/agent-scratch/agent-system-2.0/scratch/wl-mvba0qibcx61vk/. T5 confirmed: surface/test/as2test.test.ts:875/:965/:993 watch shared /private/tmp, REFRESH_BUILD_PARENT surface/src/as2test.ts:529, failure in tr-0mv97egonmuel93. T3e partly: failure at crosslab.test.ts:1750 in tr-0mvb8405ob3o9o9 confirmed, setImmediate cause does not fit the failing line; not reproduced in 16+8 parallel runs. Filed #229, #230.
- sl-ev-surface: Confirm defects 8 (open orchestrator question blocks unrelated open_workload), 9 (mode inferred from topic word pair), 10 (row 1 QUESTION rules conflict for reserved approve), 12 (orchestrator cannot write durable note) from ledger+gates code; draft issue bodies — artifact: drafts/d08.md, d09.md, d10.md, d12.md in /Users/jowolff/agent-scratch/agent-system-2.0/scratch/wl-mvba0qibcx61vk/. All confirmed from Ilex session 2026-10-12T20-29-05-405Z_01a131cd….jsonl (lines 7634/7641, 7657, 7619/7661, 7671/7673) and code: r15-orchestrator-role.ts:100,:290-302 (d08, same as MIGRATION item 84 still present); surface/src/stakes.ts:30,:54-58 (d09); r01-turn-shape.ts:178,:285-297 + r15:200-216 (d10); r15:79,:257-268 (d12, missing feature). Filed #232, #233, #234, #235.
- sl-file: File one GitHub issue per defect from the checked drafts (gh issue create), record URLs, report them to the orchestrator — artifact: 13 issues filed with literal gh issue create, each verified by gh issue view / gh issue list: #223-#235 in thewolff/agent-system-2.0 (defect 6 split into #229/#230). Table in /Users/jowolff/agent-scratch/agent-system-2.0/scratch/wl-mvba0qibcx61vk/URLS.md; URLs sent to the orchestrator as msg-mvbah9h1c4nta8.

## Decisions made (and why)

- assumption (orchestrator-surface): brief-judged: change-large confidence 0.37 judge typesafe/jev-1.13.0
- assumption (classifier): pair-exposure: lane-mvba0qibcx61vk-1 on
- assumption (classifier): pair-signal: taste no 1 ambiguous no 0.8 judge typesafe/jev-1.13.0 tokens 1428 cost 0.000059976
- assumption (lane-mvba0qibcx61vk-1): builder-lab: anthropic lane lane-mvba0qibcx61vk-1 model anthropic/claude-opus-5-5
- assumption (lane-mvba0qibcx61vk-1, sl-ev-review): hand-spawn: dt-mvba6b9fdc1e0fbf session /Users/jowolff/.agent-system-2/lanes/wl-mvba0qibcx61vk/sessions/2026-10-16T18-03-44-481Z_01a145e2-59e1-7000-8708-628fd6d23ad3 spawn sl-ev-review review no group dg-mvba6b9f6aef92df row anthropic/claude-opus-5-5
- assumption (lane-mvba0qibcx61vk-1, sl-ev-answers): hand-spawn: dt-mvba6b9f74bee0b3 session /Users/jowolff/.agent-system-2/lanes/wl-mvba0qibcx61vk/sessions/2026-10-16T18-03-44-481Z_01a145e2-59e1-7000-8708-628fd6d23ad3 spawn sl-ev-answers review no group dg-mvba6b9facf00e76 row anthropic/claude-opus-5-5
- assumption (lane-mvba0qibcx61vk-1, sl-ev-close): hand-spawn: dt-mvba6b9f4b359fe9 session /Users/jowolff/.agent-system-2/lanes/wl-mvba0qibcx61vk/sessions/2026-10-16T18-03-44-481Z_01a145e2-59e1-7000-8708-628fd6d23ad3 spawn sl-ev-close review no group dg-mvba6b9fcea0694d row anthropic/claude-opus-5-5
- assumption (lane-mvba0qibcx61vk-1, sl-ev-flaky): hand-spawn: dt-mvba6b9f3d49f0a3 session /Users/jowolff/.agent-system-2/lanes/wl-mvba0qibcx61vk/sessions/2026-10-16T18-03-44-481Z_01a145e2-59e1-7000-8708-628fd6d23ad3 spawn sl-ev-flaky review no group dg-mvba6b9f929f7753 row anthropic/claude-opus-5-5
- assumption (lane-mvba0qibcx61vk-1, sl-ev-surface): hand-spawn: dt-mvba6b9fb1883926 session /Users/jowolff/.agent-system-2/lanes/wl-mvba0qibcx61vk/sessions/2026-10-16T18-03-44-481Z_01a145e2-59e1-7000-8708-628fd6d23ad3 spawn sl-ev-surface review no group dg-mvba6b9fbe87dd0c row anthropic/claude-opus-5-5
- assumption (lane-mvba0qibcx61vk-1, sl-ev-close): hand-settled: dt-mvba6b9f4b359fe9 routing rt-mvbabzekp74lq8
- assumption (lane-mvba0qibcx61vk-1, sl-ev-answers): hand-settled: dt-mvba6b9f74bee0b3 routing rt-mvbad4l0uqs3k0
- assumption (lane-mvba0qibcx61vk-1, sl-ev-review): hand-settled: dt-mvba6b9fdc1e0fbf routing rt-mvbaei43x7kkjk
- assumption (lane-mvba0qibcx61vk-1, sl-ev-flaky): hand-settled: dt-mvba6b9f3d49f0a3 routing rt-mvbaennrd7ug3k
- assumption (lane-mvba0qibcx61vk-1, sl-ev-review): Decision on defect 11: file it. The brief said file only if it contradicts SPEC-2.0.md. The hand found the reported symptom (plan slice and cross-lab plan review keep running after `normal`) is as designed under § B6 "Amended 2026-10-02 — plan-first by default"; but Jo's "normal pls" (in-mvb9mivtm01udc, answering q-mvb8w6mhki5ts0) was never applied: workloads.stakes for wl-mvb8tyw5u1ut4w is still production, no `stakes:` instruction, ceiling entry 19468 still "source stakes production". That contradicts § A1.2 (one-word override) and § B4 (stakes flip re-sizes ceiling and round limit), so the issue is filed under that title, with the as-designed part stated in its body. Defect 6 is filed as two issues (as2test T5 shared /private/tmp; crosslab T3e) because the hand showed unrelated causes.
- assumption (lane-mvba0qibcx61vk-1, sl-ev-surface): hand-settled: dt-mvba6b9fb1883926 routing rt-mvbaf0npmg9khs

## Dead ends — don't retry these

- none

## Heads-up for whoever touches this next

- message msg-mvbah9h1c4nta8 [held] not acted on: All 12 defects are filed as new issues in thewolff/agent-system-2.0. None was filed before: the 57 existing issues are workload mirrors plus 2 test issues. No code was changed.
1 same-lab plan approval broken by headroom-skip: https://github.com/thewolff/agent-system-2.0/issues/228 (also hit wl-mvb8tyw5u1ut4w)
2 rank runs reset the held clock: https://github.com/thewolff/agent-system-2.0/issues/227
3 cancel/accept answers don't settle the slice: https://github.com/thewolff/agent-system-2.0/issues/226
4 a held draft was applied as Jo's input: https://github.com/thewolff/agent-system-2.0/issues/225
5 close check counts sibling merged PRs: https://github.com/thewolff/agent-system-2.0/issues/223
6 flaky tests, filed as two issues because the causes are unrelated: T5 shared /private/tmp https://github.com/thewolff/agent-system-2.0/issues/229 and T3e https://github.com/thewolff/agent-system-2.0/issues/230 (the setImmediate cause doesn't match the line that failed)
7 close-check fetch timeouts: https://github.com/thewolff/agent-system-2.0/issues/224 (9 in 24 h, not on every tick; each one makes the real refusal be told again)
8 an open question blocks an unrelated open: https://github.com/thewolff/agent-system-2.0/issues/232 (same as MIGRATION.md item 84, still present)
9 mode inferred from a topic word: https://github.com/thewolff/agent-system-2.0/issues/233
10 row 1 vs row 15 for reserved approvals: https://github.com/thewolff/agent-system-2.0/issues/234
11 https://github.com/thewolff/agent-system-2.0/issues/231. The part you reported is as designed: under SPEC § B6 (amended 2026-10-02) the plan still runs after a stakes change. The real defect is that Jo's "normal pls" was never applied. wl-mvb8tyw5u1ut4w is still production in the ledger, with the $150/720 ceiling and the 5-round limit. Its lane recorded "round limit 3", but that is wrong.
12 the orchestrator can't keep a note: https://github.com/thewolff/agent-system-2.0/issues/235 (missing feature, labelled enhancement)
- reserved request en-mvbag307liyakg: gh api with a word not known until it runs, which could be a status or check-run endpoint or a method that writes one (the merge gate's as2/full-suite is the test runner's alone): gh api repos/thewolff/agent-system-2.0/issues?state=open&per_page=20&sort=created --jq '.[] | select(.number>=223) | "\(.number) \(.title[0:70])"' (P-11 row 6 refused tool call toolu_01KzRz5KKtKJTYD8aPs747i1) — withdrawn by lane-mvba0qibcx61vk-1: verified issues with literal gh issue view instead
- reserved request en-mvbag64gd30b9c: gh with a subcommand or target not known until it runs: for n in 231 232 233 234 235; do gh issue view $n -R thewolff/agent-system-2.0 --json number,title,state --jq '"\(.number) \(.state) \(.title[0:80])"'; done (P-11 row 6 refused tool call toolu_01DUtFpPHaayHm3YtDg8kzWk) — withdrawn by lane-mvba0qibcx61vk-1: verified issues with literal gh issue view instead
