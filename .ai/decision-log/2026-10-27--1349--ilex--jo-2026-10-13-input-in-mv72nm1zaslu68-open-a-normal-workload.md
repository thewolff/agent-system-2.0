---
date: 2026-10-27T13:49-07:00
engineer: Ilex
session: wl-mv72nurvlwba4g
status: resolved
durable: false
supersedes:
workload: wl-mv72nurvlwba4g
---

# Jo (2026-10-13, input in-mv72nm1zaslu68): "open a normal workload: any hand or lane that writes or edits a SKILL.md gets the writing-for-agents skill loaded automatically, in code, not by prompt. It is on the allow list but was read only twice; a skill draft today skipped it and came out 2,910 words."

Notes (Ilex):
- **Trigger.** Any write or edit tool call by a hand or a lane whose target path ends in SKILL.md, in any repo, including skills/<name>/SKILL.md and the ~/.agents and ~/.claude skill dirs. A bash command that writes a SKILL.md, through a redirect, tee, cp or mv, counts too where the gates can resolve it. The plan states the line.
- **Mechanism (code, not prompt).** Before the first such write lands, the session has skills/writing-for-agents/SKILL.md in context. Two ways to get there:
  - a gate row that refuses the first SKILL.md write until the skill has been read this session, with a refusal naming `skill://writing-for-agents`;
  - the gate or extension injecting the skill text into the session.
  The plan picks one and says why. A prompt line alone does not count. The injected or required content is the vendored copy in the repo, never a remembered summary.
- **Where.** Hands spawned by lanes (every tier) and lane sessions themselves. The orchestrator never writes a SKILL.md.
- **Proof.** Regression tests fail before the change, proven on a separate unpacked copy: a hand that writes a SKILL.md without reading the skill is refused or gets the skill injected, and a hand that already read it is not refused. Smoke: a real lane hand drafting a SKILL.md shows the skill read before the write.
- **Coordinate.**
  - The monitoring workload wl-mv654hoqwpfhmo tracks skill read rates (REPORT row 13).
  - The vendored-skill licences workload wl-mv72a3eo35lyps edits skills/.
  - jo-deck wl-mv6zfcyl8s54w0 vendors skills/jo-deck/SKILL.md.
  Name shared files.
- MIGRATION item. Full suite via lane_full_test. Merging stays Jo's (merge commit, green-first). Cross-lab review.
- **Lane budget.** Jo holds 4 running lanes (in-mv71ja9ygqgsu8). This workload opens user-driven, so no lane starts. It waits in the relaunch queue (in-mv72fqdij3fjls) unless Jo places it.

done: Any hand or lane that writes or edits a SKILL.md has the writing-for-agents skill loaded before the write lands, enforced in code (a gate row or an injection) rather than prompt text; regression tests fail before the change; a real lane hand drafting a SKILL.md shows it; a MIGRATION item records it; and the full suite is green at the PR head.
done-because: (no receipt recorded)

Rendered from the ledger by Ilex (they/them) at workload close; stakes normal, mode user-driven, opened 2026-10-13T19:26:37.963Z.

## What changed

- none

## Decisions made (and why)

- jo (surface): Jo: "open a normal workload: any hand or lane that writes or edits a SKILL.md gets the writing-for-agents skill loaded
 automatically, in code, not by prompt. It is on the allow list but was read only twice; a skill draft today
 skipped it and came out 2,910 words." — reading: Any hand or lane that writes or edits a SKILL.md gets the writing-for-agents skill loaded automatically, enforced in code (a gate row or an injection) and not by prompt text. Reason: the skill is on the allow list but has been read only twice, and a skill draft today skipped it and came out at 2,910 words. Opened user-driven under the 4-lane hold (in-mv71ja9ygqgsu8). Its place in the relaunch queue is not set yet.
- jo (surface): Jo: "skill gate before jo-deck" — reading: Relaunch queue under the 4-lane hold, superseding in-mv72fqdij3fjls: 1. cheaper routing wl-mv71x5rwdu7eo0 2. clickable file links wl-mv720a2pph9d6o 3. the PR #101 fix wl-mv6t0dlejgzvuo 4. the paste-drop fix wl-mv65nllu5g181s 5. runner speed wl-mv615mkeaf1yio 6. monitoring wl-mv654hoqwpfhmo 7. the skill-writing gate wl-mv72nurvlwba4g 8. jo-deck wl-mv6zfcyl8s54w0 9. vendored-skill licences wl-mv72a3eo35lyps 10. the rest of the ceiling queue
- jo (surface): withdraw wl-mv72nurvlwba4g
- orchestrator (surface): close receipt: withdrawn by Jo (in-mvr5r8w9q3kbb4): closed with no done-because: receipt
- assumption (orchestrator-surface): brief-judged: change-large confidence 0.60 judge typesafe/jev-1.13.0

## Dead ends — don't retry these

- none

## Heads-up for whoever touches this next

- none
