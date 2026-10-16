## Panel synthesis: what you read and what you return

These rules hold in every panel mode and take precedence over the base text above wherever the two differ. `panel.ts check` enforces each one mechanically; a report that breaks one fails the slice.

**What you read.** `out/status.json` (each lab's `status`, `reason`, `model`, and the `findingIds` of a landed leg), the landed leg outputs `out/legs/<lab>.json` (every item carries its `id`, `<lab>-<n>`), this prompt, and only for quorum with a withheld draft `in/withheld/draft.md`. Nothing else: no other panel's files, no session files, no `agent://`, `history://`, `proc://`, `artifact://` or `local://` URI, no repo. The material you need beyond the leg outputs is in this prompt. A read outside that list is a breach and fails the synthesis. A missing or excluded leg's output does not exist for you; never reconstruct it.

**What you return.** Exactly one JSON object matching the synthesis schema, and nothing else:

- `legs`: all three labs, `status` and `model` exactly as `status.json` has them (`model` the empty string when it is null), `reason` copied likewise.
- `synth`: your own lab, and `builderLab: true` only when your dispatch said you are running on a builder lab of the workload.
- `findings`: one entry per finding in the report, ids `S1`, `S2`, … in report order. `supportIds` are the leg item ids that assert the finding; `refuteIds` the leg item ids that contradict it. `section` is the text of the `##` heading the finding sits under in the markdown.
- `dropped`: every landed item id that is in no finding, each with a non-empty `reason` (taste, out of lane, duplicate within its own leg, unreceipted, …).
- `markdown`: the full report.

**Accounting.** Every id in every landed leg's `findingIds` appears exactly once across all findings' `supportIds` and `refuteIds` and `dropped`: never twice, never in two findings, never both in a finding and in `dropped`, and no id that is not in a landed leg. Clustering two items of one leg into the same finding is allowed (both ids go in it); clustering is by defect, never by wording.

**Agreement count.** A finding's `n/3` is the number of distinct labs among its `supportIds` (the lab is the id's prefix before the last `-`), never more, never rounded up for severity, and never counting a missing leg.

**Disagreements.** A finding with both `supportIds` and `refuteIds` sits under this mode's disagreement heading (named in the mode rules above), never under any other section.

**Markdown shape.** The report is markdown with these fixed parts:

1. A `**Legs:**` line at the start of a line (not a list item), before any finding, naming every lab once, separated by ` | `, each as `<lab> <model> <status>` for a landed leg and `<lab> <model or "no model"> <status> (<reason>)` otherwise, e.g. `**Legs:** anthropic claude-x landed | openai gpt-y landed | kimi no model missing (cancelled)`. A two-leg report says so here; it is never presented as three.
2. Sections as `##` headings, each finding under exactly one of them. Each finding opens with a heading (`###`) or list-item (`- `) line whose first `S<n>` token is its id, followed later on that line by its agreement count, e.g. `### S1 · [HIGH] stale cache read · 2/3` or `- **GUESS(inference)** S4 · cold-read only · 1/3`. Put no other `n/3` on that line before the count, and name a finding's id on no other heading or list-item line before its own.
3. **Output-types labels.** Every statement block (a run of lines between blank lines that is not a heading or a fenced code block) opens with a bold contract label: `**CLAIM**`, `**CITE**`, `**GUESS(inference)**`, `**GUESS(pattern)**`, `**GUESS(recall)**`, `**GUESS**`, `**ACTION**`, `**PMDW**`, or `**QUESTION**`, alone on its line or leading the block's first line. A heading line directly above a block does not count as its first line. The `**Legs:**` line and summary lines are statements too: label them (`**CLAIM**` with the status.json receipt). A finding the panel's legs raised is a `**GUESS(inference)**` unless you checked it against the material in this prompt, then `**CLAIM**` with the receipt. A table needs a first column headed `Type`.

Never declare a winner where the base text says not to, never resolve a disagreement silently, and never drop an item without saying why.
