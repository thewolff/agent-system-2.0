---
date: 2026-10-27T13:49-07:00
engineer: Ilex
session: wl-mv7golz58d7668
status: resolved
durable: false
supersedes:
workload: wl-mv7golz58d7668
---

# Jo (2026-10-14, input in-mv7gogk8twdji8): "Open a normal workload, after wl-mv66ylg1op3wg0 merges: when my prose answers an open question, the next send: line carries my answer as that question's word, so one ok applies it. Prose never applies as an answer without the ok." Sequencing: it builds only after the machine-generated count line workload (wl-mv66ylg1op3wg0) merges, because both touch the closing ask and send: line. Context: today, when Jo answers a lane's open question in prose (for example "ship the Stop-hook checks wired", answering q-mv7gj7oj6t7uo0), the orchestrator records an instruction, but the question stays open until Jo retypes `<option> q-…`. Wanted: the orchestrator's next send: line carries `<option> q-…` mapped from Jo's prose, and one `ok` from Jo applies it. Prose itself never answers a question without that ok.

done: When Jo's prose answers an open question, Ilex's next send: line carries the mapped `<option> q-…` word, a single `ok` from Jo applies it as the question's answer, and prose without that ok never answers a question; this is merged on main after wl-mv66ylg1op3wg0.
done-because: (no receipt recorded)

Rendered from the ledger by Ilex (they/them) at workload close; stakes normal, mode user-driven, opened 2026-10-14T01:59:07.841Z.

## What changed

- none

## Decisions made (and why)

- jo (surface): Jo: "Open a normal workload, after wl-mv66ylg1op3wg0 merges: when my prose answers an open question, the next send: line carries my answer as that question's word, so one ok applies it. Prose never applies as an answer without the ok." — reading: Jo opens the prose-answer ok workload: when Jo's prose answers an open question, the next send: line carries the mapped `<option> q-…`, and one `ok` from Jo applies it; prose never answers a question without that ok. It starts only after the machine-generated count line workload wl-mv66ylg1op3wg0 merges.
- jo (surface): withdraw wl-mv7golz58d7668
- orchestrator (surface): close receipt: withdrawn by Jo (in-mvr5r8wb0basxz): closed with no done-because: receipt
- assumption (orchestrator-surface): brief-judged: change-large confidence 0.46 judge typesafe/jev-1.13.0

## Dead ends — don't retry these

- none

## Heads-up for whoever touches this next

- none
