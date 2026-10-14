---
title: Jo answers every open item in one message: a machine send line, ok, and one input row per prose block
status: building
workload: wl-mv66ylg1op3wg0
pr: 139
---
Workload `wl-mv66ylg1op3wg0` (production stakes, plan revision 4 at `~/agent-scratch/agent-system-2.0/wl-mv66ylg1op3wg0/PLAN.md`, approved by Jo). Jo, 2026-10-13 about 04:37Z (the brief): *"we never get anything done because I send things one at a time and Ilex always has more to say."* Jo's later words: `in-mv67564pwap534` (the TypeSafe judge sorts each open item as routine or needs-Jo; only routine items go in the `send:` line) and `in-mv6uf1b4z6jsao` (a numbered batch skips bad numbers and never refuses whole). The rules are amended in SPEC-2.0.md § B16 (*Amended 2026-10-13 — one-message answers*).

**What changed for Jo.**

- After each Ilex message the surface shows the *needs Jo* list, items only Jo can decide, each with a one-line reason. Below it comes one `send: <n> <word>, …` line holding Ilex's recommended answer to every item the judge sorted routine.
- Typing `ok`, the whole message, applies exactly the last `send:` line shown, and each answer is its own ledger row. `ok` is refused whole, applying nothing, only when something else was shown after that line.
- A numbered batch, typed or applied by `ok`, applies every valid answer and skips only stale or invalid numbers, naming each one (`#n skipped: <reason>`). One bad number never refuses the batch.
- A paste with plain-words blocks between its command lines writes one Jo input row per block, in the same transaction as the commands. Each block is echoed with its `in-…` id. Before this, the blocks got an echo and no row.
- The reply to a batch is the applied list and the new needs-Jo list, both shown by the surface, with no commentary on what Jo just answered.

**What changed for Ilex.**

- Ilex records a recommendation for every open item with `orchestrator_recommend` (`#n` or the row's id, one of its options, one line why). An advisory stop continuation names the rows still lacking one.
- Ilex never types a `send:` line. P-11 row 1 refuses a reply line starting `send:` on every turn.
- When an applied answer is to Ilex's own question, the surface writes a `surface-batch-turn` session entry and sends a hidden "act on these answers" message that starts a batch turn. On that turn row 1 allows at most one new **QUESTION** and refuses every other labeled block, all unlabeled prose, and any line naming an applied `q-…`/`en-…` id or `#n`.
- A paste with prose blocks takes a normal turn, scoped by the same entry. Session entries that cannot be read refuse the reply, naming why.
- Ilex's prose carries at most one ask, and it comes last (voice/VOICE.md, *Open ledger items are answered after the message*). Each pasted prose block's input id is spent as its echo line says.

**New ledger entry prefixes**, all `assumption` entries written by the surface:

- `recommend: <row-id> <word> — <reason>`, on the row's workload: Ilex's recommendation, written by `orchestrator_recommend`.
- `triage: <row-id> <choice> <confidence> <provider/model> key <sha256>`, on the row's workload: the judge's routine or needs-Jo verdict. The key hashes every judge input, so an unchanged row is not judged again.
- `send-line: <id> <pieces>`, on the standing workload: every `send:` line the surface renders.
- `send-applied: <id> <ok-input> <answer rows | none> skipped <numbers | none>`, on the standing workload: links an `ok` to the line it applied.
