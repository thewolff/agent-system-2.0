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
2. **Three involvement levels.** With Jo from the start. Escalate, where the agent asks when it hits a named criterion. Solo, where the agent proceeds, merges itself and Jo gets a notice. Jo rejected the name "reserved", and says "production stakes" misleads because most of Jo's work goes to production. The field's name is open.
3. **"Big fix" is replaced by checkable stand-ins.** The main one is the as2-machinery changed-path list. It replaces the branch-name rule in `surface/src/merge-train.ts` (`prStakes`) and the question-text-only `gates-stakes` ruling in `gates/src/rulings.ts`. #369 merged machinery changes without Jo because of that gap.
4. **A self-improving loop.** It has four parts: a Recorder, a Labeler, an Eval and an Improver. Jo's words: "never say it never makes improvements on its own. we'd probably want me approving the improvements based on the reports and etc for the first month to make sure it's working right. but at some point I'd like the agents to take this over too." In month one, Jo approves each change. After that, agents apply changes that score better on both numbers (unnecessary asks and missed asks), and Jo gets the report. The code checks for irreversible commands and the machinery path list stay outside what the improver can loosen.
5. **Approvals are made on recommendation.** Jo, 2026-10-28, morning PDT: "keep in mind I have SO many things to approve that I'm not reading them. I just ask you if it's a good idea and if you say so I send approve". So the labeler doesn't read an approve as Jo judging an ask, and every proposed improvement gets an independent cross-lab review before Plumb recommends it.
6. **Later, and only after this pilot passes month one:** the same harness becomes the pattern for other self-improving as2 features. Jo: "once we validate it, it should".

## Amendments

- **P-16** ("the system proposes and never applies") and **P-7b item 4** ("changes to the system's own rules or machinery" are Jo's) are amended **for this feature only, and only for the criteria-wording file** (spec § 6.5). That file holds the text of the enumerated judgment questions and nothing else: no levels, no routing, no thresholds, no path lists. Jo approves each change in month one, and agents apply changes after graduation.
- **Machine-checked exception.** After graduation, an improver PR merges without Jo only when all of these hold. The checks run from main's copy of the exception check and scorer, never the candidate's.
  - The improver is in the graduated state, and its authority is current: a passing blinded weekly audit within the last 8 days, and live comparison data available. A missing, overdue or failed audit suspends authority back to Jo-approves automatically (spec § 7.6).
  - The diff touches only the criteria-wording file.
  - It edits existing enumerated entries only, with none added, removed or renamed.
  - The trusted scorer rates it acceptable.
  - The cross-lab reviewer passes it.
- **Unchanged under P-16 and P-7b:** the policy file, the path lists, the command gate, the protection and exception checks, the eval and its gates, moving any ask type to solo, and how recommendations are made. These stay Jo's.
- **How the spec reads "better on both numbers" (item 4).** The unnecessary-ask rate falls, and the missed-ask rate does not rise, overall or on any protected criterion. "Not higher" rather than "lower" lets a change be accepted when missed asks are already at zero. This is the spec's reading, not a ruling of Jo's.

## Standing state

- **Production merges are paused until this is built** (Jo, 8:15 AM PDT, 2026-10-28). The spec proposes that the pause lifts when slices B1 (Recorder) and B2 (path lists and the merge checkpoint) are on main. Jo has not confirmed that reading.

## Open

1. The field's name. Recommended: `involvement`, with the values `with-jo` / `escalate` / `solo`.
2. The graduation gates from Jo-approves to agent-applied. The proposed thresholds are in the spec's § 7.5 (G1–G6, failing closed on missing data).
3. Held until slice B10: which hosted model the improver may send ledger text to. No local model runtime is installed. Recommended: Anthropic.

## Review

An independent OpenAI review ran three rounds, on commits `422bef49`, `99347881` and `c84907ae`. Each returned request-changes: ten findings in round 1, two blockers in round 2 and one in round 3. The spec's § 12 maps every finding to its resolution.

## Source

- Recon draft: `/Users/jowolff/agent-scratch/agent-system-2.0/stakes-criteria/DRAFT.md`.
- Escalation survey: `.tmp/escalation-research/REPORT.md`.
- Escalation policy: `2026-10-19--1125--plumb--escalation-policy-auto-start-normal-plans-and-stop-at-ceiling.md`.

## Status

Spec and ruling only. No code has been built.
