---
date: 2026-10-27T13:50-07:00
engineer: Ilex
session: wl-mv8d7uzu8r63uo
status: resolved
durable: false
supersedes:
workload: wl-mv8d7uzu8r63uo
---

# Jo (2026-10-14, input in-mv8d7lzl0iphq8): "Open a normal workload: your P-11 row 1 refusal at 10:01 was stored as a 20-line instruction from me (surface: lines 1-20 -> an instruction). Gate refusals must never become Jo input rows." Defect: at about 17:01Z (10:01 local), P-11 row 1 held Ilex's reply and returned a refusal notice quoting the held text. The surface then stored that notice as Jo's input ("lines 1–20 → an instruction for you, one row") and applied the `autonomous wl-mv8cvw0lq3rlds` line from Ilex's quoted send line as a mode flip (mode-flip in-mv8cx6kb9k6ps0). That launched lane-mv8cvw0lq3rlds-1 on anthropic/claude-opus-5-5 without Jo's word. The fix: gate refusal notices and any other machine-authored text never become Jo input rows, and never apply as words, mode flips or answers.

done: A P-11 row 1 refusal, or any other gate-authored notice, never creates a Jo input row and never applies a word, mode flip or answer from its quoted text, shown by a regression test that replays the 17:01Z refusal and by a real held reply; merged on main.
done-because: (no receipt recorded)

Rendered from the ledger by Ilex (they/them) at workload close; stakes normal, mode user-driven, opened 2026-10-14T17:09:53.706Z.

## What changed

- none

## Decisions made (and why)

- jo (surface): Jo: "Open a normal workload: your P-11 row 1 refusal at 10:01 was stored as a 20-line instruction from me (surface: lines 1-20 -> an instruction). Gate refusals must never become Jo input rows." — reading: Jo opens the gate-refusal input workload. The P-11 row 1 refusal at 10:01 local (17:01Z) was stored as a 20-line instruction from Jo. Gate refusals must never become Jo input rows.
- jo (surface): withdraw wl-mv8d7uzu8r63uo
- orchestrator (surface): close receipt: withdrawn by Jo (in-mvr5r8wcowluby): closed with no done-because: receipt
- assumption (orchestrator-surface): brief-judged: change-large confidence 0.18 judge typesafe/jev-1.13.0

## Dead ends — don't retry these

- none

## Heads-up for whoever touches this next

- none
