---
date: 2026-10-27T13:48-07:00
engineer: Ilex
session: wl-mv72a3eo35lyps
status: resolved
durable: false
supersedes:
workload: wl-mv72a3eo35lyps
---

# Jo (2026-10-13, input in-mv729n7ypokkcg): "open a normal workload: as2 is public and ships vendored skills, but only humanizer and execute-plan carry a LICENSE. Add each pack's licence and NOTICE, trace where the three skills copied from Jo's dirs came from, and add a check that refuses a vendored skill dir with no licence."

Notes (Ilex):
- **Current state (read 2026-10-13).** /Users/jowolff/code/agent-system-2.0/skills/ has 22 skill dirs plus VENDOR.md. Only skills/humanizer/LICENSE and skills/execute-plan/LICENSE exist. VENDOR.md is the provenance table to start from. Some dirs are as2's own (for example seo-audit, cross-model-review, possibly ctx). The plan sorts each dir into vendored-from-a-pack, copied-from-Jo's-dirs, or as2-authored, with a receipt for each.
- **Licences.** Each upstream pack's licence goes in the repo with the exact upstream text, fetched and cited by URL and commit. A NOTICE carries attribution wherever the licence requires one, or Apache-style NOTICE text where upstream ships one. Where a pack has no licence at all, or its licence forbids redistribution, that is a QUESTION to Jo: drop the skill, ask the author, or keep it private. Never invent or assume a licence.
- **The three skills copied from Jo's dirs.** Trace each one to its true origin: upstream repo, author, licence, and the commit or date copied. The plan names the three (VENDOR.md and git history first). If one is Jo's own work, record that, and Jo picks the licence (QUESTION).
- **The check (machinery).** A test or install-time check refuses any vendored skill dir that has no licence file, or no licence entry in VENDOR.md. As2-authored skills are covered by the repo licence and marked as such, so the check tells them apart by a VENDOR.md column rather than by guessing. It runs in the full suite and in fresh-machine-test. It fails before the change, proven on a separate unpacked copy.
- **Coordinate.**
  - jo-deck wl-mv6zfcyl8s54w0 vendors skills/jo-deck (row 23) and needs its licence too.
  - Private data wl-mv6zl15365nf9c moves content out of the public tree.
  Name shared files (VENDOR.md, DESIGN-2.0.md C6.1, install/manifest.tsv).
- MIGRATION item. Full suite via lane_full_test. Merging stays Jo's (merge commit, green-first). Cross-lab review.
- **Lane budget.** Jo holds 4 running lanes (in-mv71ja9ygqgsu8). This workload opens user-driven, so no lane starts. It waits in the relaunch queue unless Jo moves it up with `autonomous wl-…`.

done: Every vendored skill dir in the public as2 repo carries its upstream pack's licence (exact text, cited by URL and commit) and any required NOTICE; the three skills copied from Jo's dirs have a traced, recorded origin in VENDOR.md; a check in the full suite and fresh-machine-test refuses a vendored skill dir with no licence and fails before the change; any skill whose licence is missing or forbids redistribution is raised to Jo; and the full suite is green at the PR head.
done-because: (no receipt recorded)

Rendered from the ledger by Ilex (they/them) at workload close; stakes normal, mode user-driven, opened 2026-10-13T19:15:55.968Z.

## What changed

- none

## Decisions made (and why)

- jo (surface): Jo: "open a normal workload: as2 is public and ships vendored skills, but only humanizer and execute-plan carry a LICENSE. Add each pack's licence and NOTICE, trace where the three skills copied from Jo's dirs came from, and add a check that refuses a vendored skill dir with no licence." — reading: Skill licences. as2 is public and ships vendored skills, but only skills/humanizer and skills/execute-plan carry a LICENSE. Add each upstream pack's licence and NOTICE, trace the origin of the three skills copied from Jo's own dirs, and add a check that refuses a vendored skill dir with no licence. Opened user-driven under the 4-lane hold (in-mv71ja9ygqgsu8).
- jo (surface): Jo: "new relaunch order: 1 cheaper routing, 2 clickable links, 3 PR #101 fix, 4 paste-drop fix (wl-mv65nllu5g181s), 5
 runner speed, 6 monitoring, 7 jo-deck, 8 licences, then the rest of the ceiling queue. Licences last: only Graham
 knows the repo exists." — reading: Relaunch queue under the 4-lane hold (in-mv71ja9ygqgsu8), superseding in-mv72cbnrtmml1c: 1. cheaper routing wl-mv71x5rwdu7eo0 2. clickable file links wl-mv720a2pph9d6o 3. the PR #101 fix wl-mv6t0dlejgzvuo 4. the paste-drop fix wl-mv65nllu5g181s (its ceiling question q-mv6wdvfe1ikv0g needs extend) 5. runner speed wl-mv615mkeaf1yio 6. monitoring wl-mv654hoqwpfhmo 7. jo-deck wl-mv6zfcyl8s54w0 8. vendored-skill licences wl-mv72a3eo35lyps 9. then the rest of the ceiling queue Licences go last because the public-repo exposure is low: per Jo, only Graham knows the repo exists.
- jo (surface): withdraw wl-mv72a3eo35lyps
- orchestrator (surface): close receipt: withdrawn by Jo (in-mvr5r8w9kxfaon): closed with no done-because: receipt
- assumption (orchestrator-surface): brief-judged: change-large confidence 0.97 judge typesafe/jev-1.13.0

## Dead ends — don't retry these

- none

## Heads-up for whoever touches this next

- none
