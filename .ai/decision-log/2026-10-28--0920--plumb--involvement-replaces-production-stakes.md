---
status: open
author: plumb
date: 2026-10-28
durable: true
---

# Involvement replaces production stakes

## Decision

Jo, 2026-10-28, morning PDT, approved this outcome: as2's "production stakes" is replaced by a spec for how much Jo is involved in a workload. The spec covers three things: what decides the level, the machinery that enforces it, and a loop that improves the criteria. The spec is `DESIGN-involvement.md`. Its scratch copy is at `/Users/jowolff/agent-scratch/agent-system-2.0/involvement/SPEC.md`.

1. **The scope is whole workloads, not only who merges a PR.** Six checkpoints run across a workload: it opens, the plan is written, each slice during work, before an irreversible command, at merge, and at deploy or after merge. Each checkpoint has a code check that can't be talked past, a recorded agent judgment, or both.
2. **Three involvement levels:** `with-operator`, where the operator (Jo today) is in from the start; `escalate`, where the agent asks when it hits a named criterion; and `solo`, where the agent proceeds, merges itself and Jo gets a notice. Jo rejected the name "reserved", and says "production stakes" misleads because most of Jo's work goes to production. **The field is `operatorInvolvement`, ledger column `operator_involvement`.** Jo decided the name on 2026-10-28; `date` read 09:51 PDT when it was recorded. Jo's words: "how about operator involvement?", then "i like it - with-operator". The reason: as2 is public and runs wherever OMP runs, so the schema doesn't hard-code Jo's name. Also considered: `involvement` with `with-jo`, `oversight`, and `autonomy`.
3. **"Big fix" is replaced by checkable stand-ins.** The main one is the as2-machinery changed-path list. It replaces the branch-name rule in `surface/src/merge-train.ts` (`prStakes`) and the question-text-only `gates-stakes` ruling in `gates/src/rulings.ts`. #369 merged machinery changes without Jo because of that gap.
4. **A self-improving loop.** It has four parts: a Recorder, a Labeler, an Eval and an Improver. Jo's words: "never say it never makes improvements on its own. we'd probably want me approving the improvements based on the reports and etc for the first month to make sure it's working right. but at some point I'd like the agents to take this over too." In month one, Jo approves each change. After Jo flips the switch (item 7), agents apply changes that score better on both numbers (unnecessary asks and missed asks), and Jo gets the report. The code checks for irreversible commands and the machinery path list stay outside what the improver can loosen.
5. **Approvals are made on recommendation.** Jo, 2026-10-28, morning PDT: "keep in mind I have SO many things to approve that I'm not reading them. I just ask you if it's a good idea and if you say so I send approve". So the labeler doesn't read an approve as Jo judging an ask, and every proposed improvement gets an independent cross-lab review before Plumb recommends it.
6. **Later, and only after this pilot passes month one:** the same harness becomes the pattern for other self-improving as2 features. Jo: "once we validate it, it should".
7. **Graduation is Jo's switch.** Jo decided this on 2026-10-28; `date` read 10:08 PDT when the decision was recorded. Jo's words: "i think the weekly criteria runs without me after i say it does, and we use ther checks as written as guidance. but *I* am the one who flips the switch".
   - The improver moves from Jo-approves to agents-apply only on Jo's word, recorded in the ledger as an `instructions` row. Nothing graduates automatically.
   - The gates G1–G6 (spec § 7.5) stay as written, but they are guidance. Every weekly report computes each one and shows pass, fail or `insufficient data`, with the reason for each fail. The report never permits or blocks graduation on its own.
   - If Jo flips the switch while a gate is failing, the switch record lists the gates failing at that moment.
   - **A failure after the switch notifies Jo loudly and waits for Jo's call.** Jo was asked "if the weekly criteria-rewriter fails a check after you've turned it loose, should it drop back automatically… or should a failure only notify you and wait for your call?". Jo's words: "notify and wait for my call", then "but notify me LOUDLY". Jo decided this on 2026-10-28; `date` read 10:58 PDT when the decision was recorded.
     - An overdue or failed weekly audit, missing live data, a missed ask on a protected criterion, or the tripwire each send Jo one immediate needs-you notice naming the failure and its evidence.
     - The notice goes through as2's existing alert channels (spec § 7.6): a `NOW (guard)` needs-you question that goes out on fire, an issue on `thewolff/jo-issues` mentioning `@thewolff`, a macOS notification with sound, and the train's send ladder re-sending at 4 h and 8 h with a LOUD line. Spec slice B11 builds what is missing today: the ladder only runs for the merge train, there is no sound at raise, nothing sorts NOW lines to the top, and nothing repeats after 8 h.
     - The rewriter keeps its current authority until Jo rules. Nothing drops back, and nothing is reverted, on its own.
     - Jo's call is `keep`, `suspend` (back to Jo approving each change) or `revert` (suspend, and revert the last change). It is recorded in the ledger as an `instructions` row, like the switch.
     - Putting the tripwire's revert among Jo's options, rather than making it automatic, is the spec's reading of "wait for my call".

## Amendments

- **P-16** ("the system proposes and never applies") and **P-7b item 4** ("changes to the system's own rules or machinery" are Jo's) are amended **for this feature only, and only for the criteria-wording file** (spec § 6.5). That file holds the text of the enumerated judgment questions and nothing else: no levels, no routing, no thresholds, no path lists. Jo approves each change in month one, and agents apply changes after Jo flips the switch (item 7).
- **Machine-checked exception.** After Jo flips the switch, an improver PR merges without Jo only when all of these hold. The checks run from main's copy of the exception check and scorer, never the candidate's.
  - Jo's switch instruction stands in main's ledger, and no later Jo call has suspended it. An open failure notice does not remove authority; only Jo's recorded call does (spec § 7.6).
  - The diff touches only the criteria-wording file.
  - It edits existing enumerated entries only, with none added, removed or renamed.
  - The trusted scorer rates it acceptable.
  - The cross-lab reviewer passes it.
- **Unchanged under P-16 and P-7b:** the policy file, the path lists, the command gate, the protection and exception checks, the eval and its gates, moving any ask type to solo, and how recommendations are made. These stay Jo's.
- **How the spec reads "better on both numbers" (item 4).** The unnecessary-ask rate falls, and the missed-ask rate does not rise, overall or on any protected criterion. "Not higher" rather than "lower" lets a change be accepted when missed asks are already at zero. This is the spec's reading, not a ruling of Jo's.

## Standing state

- **Production merges are paused until this is built** (Jo, 2026-10-28, morning PDT). The spec proposes that the pause lifts when slices B1 (Recorder) and B2 (path lists and the merge checkpoint) are on main. Jo has not confirmed that reading.

## Open

1. Held until slice B10: which hosted model the improver may send ledger text to. No local model runtime is installed. Recommended: Anthropic.

## Review

An independent OpenAI review ran three rounds, on commits `422bef49`, `99347881` and `c84907ae`. Each returned request-changes: ten findings in round 1, two blockers in round 2 and one in round 3. The spec's § 12 maps every finding to its resolution.

## Source

- Recon draft: `/Users/jowolff/agent-scratch/agent-system-2.0/stakes-criteria/DRAFT.md`.
- Escalation survey: `.tmp/escalation-research/REPORT.md`.
- Escalation policy: `2026-10-19--1125--plumb--escalation-policy-auto-start-normal-plans-and-stop-at-ceiling.md`.

## Status

Spec and ruling only. No code has been built.
