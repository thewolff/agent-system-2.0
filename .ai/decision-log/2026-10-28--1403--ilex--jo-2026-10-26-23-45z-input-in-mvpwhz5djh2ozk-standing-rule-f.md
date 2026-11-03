---
date: 2026-10-28T14:03-07:00
engineer: Ilex
session: wl-mvpwinavd4sxds
status: resolved
durable: false
supersedes:
workload: wl-mvpwinavd4sxds
---

# Jo (2026-10-26 ~23:45Z, input in-mvpwhz5djh2ozk), standing rule, flow repair: never add a commit to a PR branch that has a green full test run or is on the merge train, unless the commit is the fix that PR needs. That includes decision-log entries. Cause today: the workload close (orchestrator_close_workload and the tick's automatic close) renders the decision-log entry and commits it on the lane branch wl/<id> and pushes it to the workload's PR. Intake cap PR #305 went green at aebe37a4, then decision-log commit cde03460 ("docs: decision-log entry 2026-10-26--1530--ilex…") moved its head, so the train had to queue a fresh full run that waited 49 minutes for the runner (requested 3:50 PM, started 4:39 PM PDT). Session-recovery PR #309 (green at 3edec08a) and Anthropic-default PR #314 (green at e491b7f3; .ai/decision-log/2026-10-26--1513--ilex--… now on the branch) had the same thing happen. Change: put decision-log entries on their own branch, batched, or in the ledger only (Jo named these three options; the plan picks one and says why) so no close ever moves a green or train-boarded PR's head; enforce it in machinery (the close path and any other writer that pushes to a PR branch), not prose. Related, held for later per jo-issues #213: folding the ~32 open decision-log PRs into one. Read jo-issues #213 (https://github.com/thewolff/jo-issues/issues/213) for order. Run on Anthropic or OpenAI, not Kimi. PR only.

done: A PR on thewolff/agent-system-2.0 makes the workload close (manual and tick) and every other machinery writer stop committing to a PR branch that has a green full run or is on the merge train (except the PR's own fix), with decision-log entries going to their own branch, a batch, or the ledger only, and a test showing a close of a workload whose PR is green leaves that PR's head unchanged.
done-because: (no receipt recorded)

Rendered from the ledger by Ilex (they/them) at workload close; stakes normal, mode autonomous, opened 2026-10-26T23:42:14.647Z.

## What changed

- sl-ceiling-mvpwinavd4sxds-1: Jo decides the ceiling overrun — artifact: answered extend in-mvpxh5nbm6yuio

## Decisions made (and why)

- jo (surface): Jo: "standing rule from me, flow repair: never add a commit to a PR branch that has a green full test run or is on the merge train, unless the commit is the fix that PR needs. That includes decision-log entries. Today the intake cap PR #305 went green at aebe37a4, then a decision-log commit (cde03460, "docs: decision-log entry 2026-10-26--1530--ilex…") moved its head, so the train had to queue a fresh full run that waited 49 minutes for the test runner (requested 3:50 PM, started 4:39 PM). The session-recovery PR #309 had the same thing happen. Put decision-log entries on their own branch, batched, or in the ledger only. Tell me where this rule now lives in code or in your brief, and whether any other green PR carries a decision-log commit that hasn't been tested yet." — reading: Standing rule, flow repair: no commit lands on a PR branch that has a green full run or is on the merge train unless it is that PR's own fix, decision-log entries included; decision-log entries go on their own branch, batched, or in the ledger only. This workload builds that into the close machinery.
- jo (surface): Jo: "withdraw wl-mvpwinavd4sxds: superseded by wl-mvpwkpqobyp20w. With the train accepting decision-log-only commits on top of a green, the close step can keep committing entries on wl/<id> at no cost, so no change to the close is needed. Keep "never add a commit to a green or on-train PR branch except the fix it needs" as a standing instruction in your brief only, until wl-mvpwkpqobyp20w merges." — reading: drop: withdraw the close-path decision-log workload (wl-mvpwinavd4sxds); the train-tolerance workload (wl-mvpwkpqobyp20w) supersedes it and the close keeps committing entries on wl/<id>; the rule "never add a commit to a green or on-train PR branch except the fix it needs" stays a standing instruction in Ilex's brief only until wl-mvpwkpqobyp20w merges. (answers q-mvpwm6wozbfym8)
- jo answered "extend" to q-mvpxcj44384l4w (wl-mvpwinavd4sxds has used $0.31 of its $0.01 ceiling (3078 %) and 0 of 1 minutes (16 %), normal stakes; 60771 tokens.
stop (the default): the lane keeps working and is stopped at the ceiling; nothing relaunches.
extend: the ceiling grows by one more block of this workload's own size and the lane goes on (a stopped lane relaunches); for an exact figure say `ceiling <usd> [<hours>] wl-mvpwinavd4sxds` instead.
split: the lane is stopped at the ceiling like stop, and the remaining work is split into a new workload; nothing relaunches here.)
- jo (surface): withdraw wl-mvpwinavd4sxds
- orchestrator (surface): close receipt: withdrawn by Jo (in-mvslqnrhted06r): closed with no done-because: receipt
- assumption (orchestrator-surface): brief-judged: judge confidence 0.41 judge typesafe/jev-1.13.0
- assumption (classifier): pair-exposure: lane-mvpwinavd4sxds-1 on
- assumption (classifier): pair-signal: taste no 1 ambiguous yes 0.36 judge typesafe/jev-1.13.0 tokens 993 cost 0.000041706
- assumption (lane-mvpwinavd4sxds-1): builder-lab: anthropic lane lane-mvpwinavd4sxds-1 model anthropic/claude-opus-5-5
- assumption (classifier): pair-exposure: lane-mvpwinavd4sxds-2 on
- assumption (lane-mvpwinavd4sxds-2): builder-lab: anthropic lane lane-mvpwinavd4sxds-2 model anthropic/claude-opus-5-5
- assumption (lane-mvpwinavd4sxds-2): Decision: no slices cut, no code changed. Jo's withdrawal in-mvpwmguba4xlog (answer "drop" to q-mvpwm6wozbfym8: superseded by the train-tolerance workload wl-mvpwkpqobyp20w, close keeps committing entries on wl/<id>) still stands. The later in-mvpxh5nbm6yuio "extend" answers only the ceiling question q-mvpxcj44384l4w (lane -1 hit the $0.01 ceiling the orchestrator set at withdrawal, ledger entries 2026-10-26T23:45:25Z and 2026-10-27T00:05:28Z); it changes budget, not the drop decision, so it does not reopen the close-path change. Lane releases without a done-because because the done: line is withdrawn, not met; the orchestrator closes or withdraws the row.

## Dead ends — don't retry these

- sl-ceiling-mvpwinavd4sxds-2 cancelled: Jo decides the ceiling overrun
- q-mvpynj0tqwms5c withdrawn (then cancel): finished under the ceiling — the question was: wl-mvpwinavd4sxds has used $0.80 of its $1 ceiling (80 %) and 1 of 30 minutes (3 %), normal stakes; 1107596 tokens.
stop (the default): the lane keeps working and is stopped at the ceiling; nothing relaunches.
extend: the ceiling grows by one more block of this workload's own size and the lane goes on (a stopped lane relaunches); for an exact figure say `ceiling <usd> [<hours>] wl-mvpwinavd4sxds` instead.
split: the lane is stopped at the ceiling like stop, and the remaining work is split into a new workload; nothing relaunches here.

## Heads-up for whoever touches this next

- message msg-mvpynhhqw9nvgg [delivered] not acted on: Close-path decision-log workload (wl-mvpwinavd4sxds): I did no work and am releasing. Jo withdrew it (in-mvpwmguba4xlog, "drop" on q-mvpwm6wozbfym8, superseded by the train-tolerance workload wl-mvpwkpqobyp20w). Jo's later "extend" (in-mvpxh5nbm6yuio) answered only the ceiling question q-mvpxcj44384l4w, which fired because the orchestrator lowered the ceiling to $0.01 at withdrawal; it relaunched this lane but does not reverse the drop. No branch push, no PR. The row is still open: please close/withdraw it so the tick stops relaunching lanes on it. If Jo did mean "extend" as "build it after all", relaunch with that instruction recorded on the workload.
