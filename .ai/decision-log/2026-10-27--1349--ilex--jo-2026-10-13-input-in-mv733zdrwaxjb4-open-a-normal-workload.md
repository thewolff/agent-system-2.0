---
date: 2026-10-27T13:49-07:00
engineer: Ilex
session: wl-mv734imdks3mdc
status: resolved
durable: false
supersedes:
workload: wl-mv734imdks3mdc
---

# Jo (2026-10-13, input in-mv733zdrwaxjb4): "Open a normal workload: in skills/, bump impeccable skill-v4.3.1 to 4.5.2, and add two trial skills, diagram-design (@657c71d, MIT) and taste-skill (@c924fad, MIT), each pinned in VENDOR.md with its LICENSE. Queue it after licences."

Notes (Ilex):
- **impeccable bump.** /Users/jowolff/code/agent-system-2.0/skills/VENDOR.md pins pmndrs/impeccable (https://github.com/pmndrs/impeccable.git) at `skill-v4.3.1`, cd12f866, Apache 2.0 (pack table line 12, row 20). The vendored copy is the `.pi/skills/impeccable/` variant, because OMP leaves `${CLAUDE_SKILL_DIR}` unexpanded. The `allowed-tools` frontmatter key was dropped. The engine pin note sits under the table (`skill-v4.3.1` → `engine-v0.1.5`).
  - Bump to the upstream tag for 4.5.2 (the plan confirms the exact tag name and commit from upstream). Re-apply the same owned edits, and update the engine pin note.
  - Add impeccable's LICENSE and NOTICE (Apache 2.0), which the licences workload wl-mv72a3eo35lyps would otherwise do. Coordinate so only one workload writes it.
- **Trial skills.** diagram-design at commit 657c71d and taste-skill at commit c924fad, both MIT. Jo gave commits but not upstream repos. The plan finds each repo and records the URL, full commit SHA and licence text fetched from upstream. If a repo can't be identified with certainty, that is a QUESTION to Jo, not a guess. Each gets a VENDOR.md pack row and file row, its LICENSE file in its skill dir, install/manifest.tsv rows, includeSkills if needed, and an updated fresh-machine-test skill count. "Trial" means the plan names how a trial skill is marked and how it gets dropped or kept later.
- **Skill-writing rule.** Any SKILL.md edit follows writing-for-agents. The skill-writing gate workload wl-mv72nurvlwba4g will enforce this later.
- **Coordinate.**
  - The licences workload wl-mv72a3eo35lyps (VENDOR.md columns, the licence check);
  - jo-deck wl-mv6zfcyl8s54w0 (adds row 23 and bumps the skill count);
  - DESIGN-2.0.md C6.1 row counts.
  Name shared files; merge order is green-first.
- Regression tests fail before the change where behaviour changes: manifest-sync and install tests, run on a separate unpacked copy. Full suite via lane_full_test. Merging stays Jo's (merge commit). Cross-lab review.
- **Lane budget.** Jo holds 4 running lanes (in-mv71ja9ygqgsu8). This workload opens user-driven and is queued right after vendored-skill licences (Jo).

done: skills/impeccable is vendored from the upstream 4.5.2 tag with its owned edits re-applied and its Apache 2.0 LICENSE, and skills/diagram-design (@657c71d) and skills/taste-skill (@c924fad) are vendored as marked trial skills, each with its MIT LICENSE; all three are pinned in VENDOR.md with repo URL, full commit and licence; manifest and install tests pass, fresh-machine-test shows the new skill count, and the full suite is green at the PR head.
done-because: (no receipt recorded)

Rendered from the ledger by Ilex (they/them) at workload close; stakes normal, mode user-driven, opened 2026-10-13T19:39:35.365Z.

## What changed

- none

## Decisions made (and why)

- jo (surface): Jo: "Open a normal workload: in skills/, bump impeccable skill-v4.3.1 to 4.5.2, and add two trial skills,
 diagram-design (@657c71d, MIT) and taste-skill (@c924fad, MIT), each pinned in VENDOR.md with its LICENSE. Queue
 it after licences." — reading: In skills/: - bump impeccable from skill-v4.3.1 to 4.5.2; - add two trial skills, diagram-design at commit 657c71d (MIT) and taste-skill at commit c924fad (MIT); - pin each one in VENDOR.md and ship its LICENSE. Relaunch queue under the 4-lane hold, superseding in-mv72re9o19vgu8: 1. cheaper routing wl-mv71x5rwdu7eo0 2. runner speed wl-mv615mkeaf1yio 3. clickable file links wl-mv720a2pph9d6o 4. the PR #101 fix wl-mv6t0dlejgzvuo 5. the paste-drop fix wl-mv65nllu5g181s 6. monitoring wl-mv654hoqwpfhmo 7. the skill-writing gate wl-mv72nurvlwba4g 8. jo-deck wl-mv6zfcyl8s54w0 9. vendored-skill licences wl-mv72a3eo35lyps 10. this skill bump wl-mv734imdks3mdc 11. the rest of the ceiling queue
- jo (surface): withdraw wl-mv734imdks3mdc
- orchestrator (surface): close receipt: withdrawn by Jo (in-mvr5r8wayy18kr): closed with no done-because: receipt
- assumption (orchestrator-surface): brief-judged: change-large confidence 1.00 judge typesafe/jev-1.13.0

## Dead ends — don't retry these

- none

## Heads-up for whoever touches this next

- none
