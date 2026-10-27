---
date: 2026-10-27T13:50-07:00
engineer: Ilex
session: wl-mvpp9tk091patc
status: resolved
durable: false
supersedes:
workload: wl-mvpp9tk091patc
---

# Jo (2026-10-26 ~20:15Z, input in-mvpp9ji418muio), approved by Jo now even though it is not flow repair: vendor Addy Osmani's Clarity writing skill (https://github.com/addyosmani/clarity, MIT) into as2 and add it to as2's skill allowlist. Pin tag v0.2.1 = commit e27ceeff60368cf6966b4ea00a5b9b36418ee9a0, copied once and owned from then on, the same way humanizer is (skills/VENDOR.md row 2). Copy SKILL.md, LICENSE, references/{edit,interview,longform,medium,review}.md and scripts/{prose_stats,strip_markdown}.py into skills/clarity/. Leave out commands/, evals/, samples/, site/, README.md and scripts/validate_package.py. Add `- clarity` to includeSkills in profile/config.yml (the allowlist), add the 9 manifest rows in install/manifest.tsv, add the VENDOR.md pack row and row #23, and update the skill counts in install/fresh-machine-test.sh, DESIGN-2.0.md § C6.1 and docs/configuration.md:29 (already stale). Do not use `npx skills add`: it runs an unpinned CLI and sends telemetry; fetch the pinned commit's files directly (e.g. git clone + checkout e27ceeff… or raw URLs at that sha) and verify the sha. Plumb's file-and-line plan and comparables report: /Users/jowolff/code/agent-system-2.0/.tmp/clarity-comparables-2026-10-26.md, section "as2 vendoring steps". Context from Ilex: the main checkout's profile/config.yml testRunner values were restored to fullCapMin 20 / fullWorkers 6 by Plumb; work only on the workload branch. Run on Anthropic or OpenAI, not Kimi (Moonshot account suspended until 2026-10-30). PR only, no merge.

done: An open, unmerged PR on thewolff/agent-system-2.0 vendors Clarity v0.2.1 (commit e27ceeff60368cf6966b4ea00a5b9b36418ee9a0) into skills/clarity/ with exactly the nine named files, adds clarity to includeSkills in profile/config.yml, the 9 rows in install/manifest.tsv and the VENDOR.md pack row and row #23, updates the skill counts in install/fresh-machine-test.sh, DESIGN-2.0.md § C6.1 and docs/configuration.md, and install/install.sh passes while install/fresh-machine-test.sh discovers 26 skills with no warnings.
done-because: (no receipt recorded)

Rendered from the ledger by Ilex (they/them) at workload close; stakes normal, mode user-driven, opened 2026-10-26T20:19:25.536Z.

## What changed

- none

## Decisions made (and why)

- jo (surface): Jo: "open a normal workload, approved by me now even though it is not flow repair: vendor Addy Osmani's Clarity writing skill (https://github.com/addyosmani/clarity, MIT) into as2 and add it to as2's skill allowlist. Pin tag v0.2.1 = commit e27ceeff60368cf6966b4ea00a5b9b36418ee9a0, copied once and owned from then on, the same way humanizer is (skills/VENDOR.md row 2). Copy SKILL.md, LICENSE, references/{edit,interview,longform,medium,review}.md and scripts/{prose_stats,strip_markdown}.py into skills/clarity/. Leave out commands/, evals/, samples/, site/, README.md and scripts/validate_package.py. Add `- clarity` to includeSkills in profile/config.yml (the allowlist), add the 9 manifest rows in install/manifest.tsv, add the VENDOR.md pack row and row #23, and update the skill counts in install/fresh-machine-test.sh, DESIGN-2.0.md § C6.1 and docs/configuration.md:29 (already stale). Done when install/install.sh passes and install/fresh-machine-test.sh discovers 26 skills with no warnings. That run also proves OMP loads it as /skill:clarity. Do not use `npx skills add`: it runs an unpinned CLI and sends telemetry. Plumb's file-and-line plan and comparables report: /Users/jowolff/code/agent-system-2.0/.tmp/clarity-comparables-2026-10-26.md, section "as2 vendoring steps"." — reading: Jo's brief for this workload, verbatim in the input row: vendor Clarity v0.2.1 (e27ceeff…) into skills/clarity/ with the nine named files, add it to includeSkills, manifest, VENDOR.md and the skill counts; no `npx skills add`; done when install.sh passes and fresh-machine-test discovers 26 skills with no warnings. Approved by Jo now despite not being flow repair.
- jo flipped mode to user-driven
- jo (surface): withdraw wl-mvpp9tk091patc
- orchestrator (surface): close receipt: withdrawn by Jo (in-mvr5r8wfnvxvyz): closed with no done-because: receipt
- assumption (orchestrator-surface): brief-judged: change-small confidence 0.87 judge typesafe/jev-1.13.0

## Dead ends — don't retry these

- none

## Heads-up for whoever touches this next

- none
