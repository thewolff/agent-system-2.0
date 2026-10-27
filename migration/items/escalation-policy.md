---
title: Escalation policy phase 1 — standing rulings decide questions, normal plans that pass cross-lab review start on their own, and the ceiling stops and sends a notice instead of asking
status: open
workload: wl-mvfkv7llkp7nk0
pr: 267
---
Jo's words, 2026-10-19: *"yes to auto-start, stop at 100%"*, deciding decisions 1 and 2 of the escalation-policy draft (`~/agent-scratch/agent-system-2.0/escalation-policy/DRAFT.md`), plus the paired-workload amendment in-mvfo7nphl9xn28. Decision log: `.ai/decision-log/2026-10-19--1125--plumb--escalation-policy-auto-start-normal-plans-and-stop-at-ceiling.md`. Plan: `/Users/jowolff/agent-scratch/agent-system-2.0/wl-mvfkv7llkp7nk0/PLAN.md` (rev 5, approved). Before this change Jo was asked questions that a ruling of Jo's had already answered, every normal-stakes plan waited for Jo's `approve` even after a clean cross-lab pass, and the ceiling raised a stop / extend / split question at 80 % and again at 100 %.

What changed:
- **Notices** (`surface/src/notice.ts`). A notice is something Jo is told and does not answer. It is a `notice:` message to the orchestrator written by trusted tool code (`sendNotice`), never a question row. Needs-you shows it last as `notice on <workload> (nothing to answer): …`, with no `#n`, until it has been delivered once. It is not counted among the answer lines, and `pending` does not list it. The two ceiling notices are on fire for the batch; the others wait for the window. `lane_message` refuses a body opening with `notice:`; an entry body opening with it is inert, because every notice reader reads messages, never entries.
- **Standing rulings** (`gates/src/rulings.ts`). `askJo` is the one production path to `Ledger.raiseQuestion`. It works out the question's kind from its options, plus the new `subject` parameter (`lane-model` / `review-model`) when every option is a `provider/model` id, and checks `STANDING_RULINGS`: `kimi-out`, `flow-repair`, `merges`, `models`, `gates-stakes`, and `train-signoff`, added later by `migration/items/train-signoff-ruling.md` (SPEC-2.0.md § B4, *Amended 2026-10-20*). When a ruling covers the question, no question row is written and the asker records `ruling-applied: <ruling> kind <k> slice <sl> answer <a>`. The lane and orchestrator question tools then return the ruling and what to do in place of a question id. Jo's surface word `end-ruling <id>` ends one ruling at once. The invariant report (`surface/scripts/invariants.ts`) lists `ruling-miss` for any question raised since the ledger's first `ruling-applied:` entry (the check's activation; before it, nothing is listed) that an active ruling would have decided.
- **Auto-start** (`planAutoStartRound`, `surface/extensions/lane-tools.ts`). On a normal-stakes plan-first workload, the lane's plan question is not raised when all of these hold: the latest review round on the plan slice passed wholly on labs other than the builders', with no same-lab token, no `accept` at a round limit and no review after it; the body has the plan shape; the workload was never halted; and `flow-repair` is not active. Instead, the writer `escalation` records `plan: approved auto <round>`, a form no lane can write, and Jo gets a notice carrying the plan. Auto-start never opens a workload or launches a lane. Production plans still go to Jo.
- **Veto window** (`prStakes`, `surface/src/merge-train.ts`). The merge train holds an auto-started workload's PRs (`hold: … until <time|jo>`, `train-hold:` entry) until 4 h after Jo's first plain-words surface message after the notice was delivered; a command word does not start the clock. With no such message the hold lasts until Jo writes one. The train tick wakes the train once when a hold ends (`hold-expired`). Jo's surface word `halt <wl>` writes `plan: halted`, asks a live holder to stop and holds the PRs with no end. From then on the workload is unapproved and plan-first again, and auto-start never fires on it.
- **Ceiling** (`surface/scripts/lane.ts`, `surface/src/ceiling.ts`). The ceiling question is gone: `CEILING_OPTIONS`, `ceilingQuestionBody`, `raiseCeilingQuestion`, `settleCeiling` and the ceiling pair-offer site were removed. At 80 % the runner sends one notice per ceiling value and keeps working. At 100 % it stops the lane (`lane-stop: … accepted ceiling`) and sends one stop notice per value. Nothing extends on its own at any stakes. The new surface word `extend <wl>` raises the ceiling by one block of the workload's own size. `ceiling <usd> [<hours>] [<wl>]` now relaunches a lane the ceiling stopped, as `extend` does, through one shared helper (`raiseCeiling`, `surface/src/input.ts`). The runner reads the ceiling in force and accepts a ceiling stop in one ledger transaction (`meterPoll`), so a raise that lands first lets the lane go on and a raise after it relaunches the lane.
- **Paired lanes** (`surface/extensions/lane.ts`). A by-hand lane (`as2 lane <wl>`) is never stopped at the ceiling and puts nothing about it on needs-you. At every turn start it gets a context line, `spend: $X of $Y ceiling (Z %), N min; paired: not stopped at the ceiling`. Jo gets one pane line each time the dollar spend crosses another 25 % of the original ceiling, past 100 % too.
- Docs: `USER-GUIDE.md` (sections 1–4 and 6), `DESIGN-workload-ceiling.md` (§ 2, amended), `SPEC-2.0.md` (dated amendments in § B3, § B6 and § B11), `tiers/lane.md` and `tiers/orchestrator.md`.

Not changed: the review round limit and its `extend` / `accept` / `stop` question, merge-train questions, production plan approval, reserved actions, and the classifier's own Kimi-out handling in `classifier/src/lab.ts` (the `kimi-out` ruling mirrors it for questions only).

**What an installed system needs.** Everything is code that the surface, the lanes and the train tick load from the main checkout, plus two tier files the install copies into the profile. After Jo merges:
1. Fast-forward the main checkout (item 91).
2. Re-run `bash install/install.sh`, so the profile's `agents/lane.md` and `agents/orchestrator.md` carry the new text. The manifest now has rows for `gates/src/rulings.ts`, `gates/test/rulings.test.ts` and `surface/src/notice.ts`.
3. Restart `as2`, so the surface loads the new words (`extend`, `halt`, `end-ruling`), the notice lines and the question tool's ruling check.
4. Relaunch every running lane. A lane that is not relaunched still runs the old meter, which raises the ceiling question at 80 % and 100 %; it still raises questions a ruling would decide, and it never auto-starts a plan.

The train tick needs no reinstall: it runs `surface/scripts/train-tick.ts` from the checkout on each pass. No schema change and no ledger rewrite. `notice:`, `ruling-applied:`, `plan: approved auto`, `plan: halted` and `train-hold:` rows are new and inert under the old code. A ceiling question left open from before the deploy is not settled by anything new: answer it with `cancel-slice sl-ceiling-…` (withdraws it and cancels its slice) or `withdraw q-…` (withdraws it and replans the slice).

**Reversal.** Revert the PR on main, fast-forward, re-run the install, restart `as2` and relaunch the lanes. Rows already written stay in the ledger. The old reader drops a `plan: approved` from any writer but the surface (`validWriter`, `surface/src/launch.ts`), so a workload auto-started before the revert reads as plan-first and unapproved again: its lane may add no change slice until Jo approves its next plan question. A ceiling over 80 % may raise the old ceiling question at the lane's next poll.

## PR 267 train repair

The runner's readiness has two phases, both counted from the child spawn and not before
repository/profile preparation: startup, from the spawn to OMP's `ready` frame, bounded by the
reservation's lease expiry (`workloads.holder_lease_until`), and claim, from the `ready` frame
for `READY_MS`, cut at that expiry. A stall exits as `never-ready (startup)` or
`never-ready (claim)`; a missing or unreadable expiry is refused before any OMP spawns, never
defaulted. Preparation may block on git before OMP exists;
it must not consume the child's readiness allowance. Ceiling thresholds and the pre-prompt
ceiling check are unchanged. `surface/test/lane-model-script.test.ts`, under
`T5c: lane-ready: only just before the first prompt`, covers delayed preparation followed by
a delayed model reply and retains the at-ceiling relaunch's no-readiness/no-prompt checks.

The classifier's six-round review-loop reset scenario in `classifier/test/crosslab.test.ts`
uses the existing fingerprint injection to isolate loop accounting from repeated git scans.
It retains every round and behavioral assertion; the read-only review and fingerprint tests
still exercise real git. Neither repair increases a test or readiness timeout.

The merge with main retains the one-live-lane reservation and spawn guards alongside the
notice-only ceiling meter and the unmetered paired path. Train head-wake accounting remains
unchanged: a wake counts when the tick writes the request or its launcher succeeds, deduplicated
per request. Hold-expiry wakes count whenever a new or already-pending launch request exists,
even when the launcher remains capped; the drain can serve that request without waking the same
hold again. A ceiling refusal writes no request, calls no launcher and leaves an expired hold
due until Jo raises the ceiling. `surface/test/train-tick.test.ts`, under
`retries of a released train and fork PRs`, covers capped expiry/drain for requests newly written
at expiry and already pending before expiry, plus the ceiling-refusal/raise interaction. The standing rulings,
auto-start veto window and paired-workload ceiling exception are unchanged.

The merge with PR 258 keeps the canonical call/result adapters and paired-spend imports.
The by-hand first prompt is composed once in `byHandPromptFor`: paired ceiling/spend context
followed by `## Workload state now`, written once before spawning OMP and passed through its
native `@file` argument on fresh and resumed sessions. A second `promptFor` write would erase
the workload-state suffix. `surface/test/by-hand-context.test.ts`, under
`by-hand lane: the first prompt reaches the session`, seeds $1.25 of earlier spend against a
$1 ceiling and checks both contexts in the actual initial session message on fresh launches
and same-model resumes, with no ceiling stop, added question or ceiling notice. The autonomous
RPC path, unmetered paired policy and test timeouts are unchanged.

The PR 267 merge with main keeps main's auto-boarding semantics: a ready PR reuses the
newest open train regardless of age or half-ceiling, remains pending when Jo-held or done,
and creates a train only when none exists. The import resolution retains the escalation
hold/task dependencies and drops the obsolete `meter` import. In the by-hand prompt test,
EOF may record the expected lane death while an open slice remains, so the incidental
empty-deaths assertion is removed; no lane-stop, ceiling-stop, prompt, spend, or state
regression checks are removed or changed.

