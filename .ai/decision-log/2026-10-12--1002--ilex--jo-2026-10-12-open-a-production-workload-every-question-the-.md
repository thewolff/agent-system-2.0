---
date: 2026-10-12T10:02-07:00
engineer: Ilex
session: wl-mv4nde7u06bc3k
status: resolved
durable: false
supersedes:
workload: wl-mv4nde7u06bc3k
---

# Jo (2026-10-12): "open a production workload: every QUESTION the orchestrator raises to Jo is written as a question row (give wl-orchestrator a standing slice for it), the invariant watcher counts them as stuck-question, and Jo's answer resolves the row; add a test that an orchestrator ask with no row fails. this is fucking crucial"
Context (Ilex, from this session; not verified against code): today the orchestrator's QUESTION to Jo exists only as text in a chat message. The gate tracks it as "your QUESTION to Jo about wl-… has no answer in the ledger" and works out which workloads it is about from the message text. Jo's replies are parsed only as `<word> <q-id>` against question rows that lanes raised. So an orchestrator ask has no q-id, no row and no needs-you line, and it is not counted when it goes stale. That happened tonight, 2026-10-12, about 02:00–02:45Z:
- Ilex's asks about the ledger-replay cleanup, the empty-slice fix and the Tinker M8 relaunch lived only in scrollback, while Jo answered other questions in between.
- The gate then refused opening this very workload: "your QUESTION to Jo about wl-mv0ntc3s9bz0g0, wl-mv18ttlamr98u8, wl-mv4n4rpnvz8h6o has no answer in the ledger".
- After Jo answered "relaunch", it still blocked on wl-mv4n4rpnvz8h6o, a workload only mentioned in the message's needs-you section, until Ilex wrote a no-change instruction row.
The wake-read entries land on wl-orchestrator (en-mv4mya1l5yc268), so that pseudo-workload exists in the ledger.
Requirements:
1. Every QUESTION block the orchestrator sends Jo writes a question row with options, on a standing slice of wl-orchestrator. The plan names the slice, how it is created and kept open, and how the q-id appears in the message so Jo can answer `<option> <q-id>`. The question row names which workload(s) it is about, explicitly rather than inferred from the message text.
2. The invariant watcher counts unanswered orchestrator question rows as stuck-question, the same as lane questions. The plan states the threshold.
3. Jo's answer resolves the row: word-first `<option> <q-id>`, or a bare option word when exactly one orchestrator question is open. The plan says how a reply with no q-id is matched, or that it isn't.
4. A test proves that an orchestrator message carrying a QUESTION block with no matching question row fails: refused at the message gate (P-11 row 1 or the row that owns it), not just warned. The test fails before the change.
5. Existing lane question rows, the one-QUESTION-per-message rule and the "QUESTION unanswered → words, not work" gate keep working. The plan says whether that gate now reads the row instead of the chat text, and fixes the over-matching described above if it does.
6. Add a MIGRATION.md item. Update SPEC-2.0.md and tiers/orchestrator.md where the orchestrator's ask is described.
Regression tests fail before the change; prove that on a separate unpacked copy, never by overwriting the worktree. Run the full suite via lane_full_test on the PR. Merging stays Jo's. This touches gates/ and the surface, so it is production stakes. Coordinate with the empty-slice fix wl-mv4n4rpnvz8h6o, which also edits gates/ (r07-wake-read); the plan states the merge order.

done: Every QUESTION the orchestrator sends Jo is a question row with options on a standing wl-orchestrator slice and names its workloads explicitly; the invariant watcher counts unanswered ones as stuck-question; Jo's answer resolves the row; a test shows an orchestrator QUESTION with no row is refused, and it fails before the change; existing lane-question behaviour still passes; MIGRATION.md, SPEC-2.0.md and tiers/orchestrator.md record it; the full suite is green at the PR head; the change is on a branch with a PR.
done-because: superseded by Plumb's plumb/orchestrator-questions, PR #55 MERGED (Jo, in-mv4ndn9igb0cu8 and in-mv4nev1offjmbk); this workload made no change.

Rendered from the ledger by Ilex (they/them) at workload close; stakes production, mode autonomous, opened 2026-10-12T02:43:03.354Z.

## What changed

- sl-ceiling-mv4nde7u06bc3k-1: Jo decides the ceiling overrun — artifact: answered stop in-mv4nepj2q3tnnk

## Decisions made (and why)

- jo (surface): Jo: ""do not open the orchestrator question-row workload — Plumb is building
 it by hand on plumb/orchestrator-questions; you'll get the PR." — reading: Jo does not want this workload. Plumb is building the orchestrator question-row change by hand on branch plumb/orchestrator-questions. It arrived after Ilex had opened it. The lane makes no plan, no code, no branch push and no hand dispatch, and releases at once. Ilex stops it with the ceiling and closes it as superseded.
- jo answered "stop" to q-mv4ndo0w4n4e80 (wl-mv4nde7u06bc3k has used $1.77 of its $1 ceiling (176 %) and 0 of 5 minutes (3 %), production stakes; 239807 tokens.
stop (the default): the lane keeps working and is stopped at the ceiling; nothing relaunches.
extend: the ceiling grows by one more block of this workload's own size and the lane goes on (a stopped lane relaunches); for an exact figure say `ceiling <usd> [<hours>] wl-mv4nde7u06bc3k` instead.
split: the lane is stopped at the ceiling like stop, and the remaining work is split into a new workload; nothing relaunches here.)
- jo (surface): Jo: "stop q-mv4ndo0w4n4e80" — reading: Stop the superseded question-row workload's ceiling question. Nothing relaunches. Ilex closes the workload as superseded by Plumb's plumb/orchestrator-questions branch.
- assumption (lane-mv4nde7u06bc3k-1): builder-lab: anthropic lane lane-mv4nde7u06bc3k-1 model anthropic/claude-opus-5-5
- assumption (repair-close-wl-mv4t8x1ma3j8qo): Repair (Jo's "repair", q-mv4t3dke3ke8e8), through wl-mv4t8x1ma3j8qo's repair.sh, run by Jo outside the fence: This workload is superseded by Plumb's plumb/orchestrator-questions, PR #55 merged (Jo, in-mv4ndn9igb0cu8 and in-mv4nev1offjmbk); it made no change. No slice to cancel. The repair claims the workload as repair-close-wl-mv4t8x1ma3j8qo (lease 60 s), writes the done-because: below and releases it, because a holder's done-because: is the only receipt the close accepts.

## Dead ends — don't retry these

- none

## Heads-up for whoever touches this next

- none
