---
title: A lane model Jo names is pending until recorded, and no lane starts before it is
status: building
workload: wl-mv8d45mqycd8g0
pr: 149
---
**Draft PR #149; actual paste held.** Workload `wl-mv8d45mqycd8g0` (normal stakes, autonomous; plan revision 3 at `~/agent-scratch/agent-system-2.0/wl-mv8d45mqycd8g0/PLAN.md`, approved in `in-mv8fa1zxpuakg0` on `q-mv8euydop8asqo`). The baseline T1 regression fails in both paste orders because the starter runs with `model: null` (`FAILS-BEFORE.txt` beside the plan). Rebased integration at `aab2002ea9d0d4497301037942d23a0920133132` passes the focused eleven-file artifact: 255 pass, 0 fail, including the pending-model, model, launch, input, recorder, render, ledger, tier and manifest checks; migration item check passes. Jo holds the real OMP RPC paste (`in-mv8slld6rv2wwg`); no live acceptance result has been supplied. Full-suite PR green and the repeat from merged main remain due; this item is not done.

**Defect** (Jo's report). A paste holding `lane model <provider/model> for wl-…` and `autonomous wl-…` started the lane on the profile default before the model was recorded. The paste committed the `autonomous` flip and ran the launch trigger at once; the plain-words model line only reached the orchestrator afterwards, as an echo with no input row, and `orchestrator_record_instruction` wrote no `lane-model:` line and ran no trigger.

**What changes.**

- A whole line `lane model <provider/model | default> for <wl>` that Jo typed is a durable input row (author `jo`, channel `surface`), alone or in a paste, written in the paste's transaction in either line order and echoed with its `in-…` id. `surface/src/pending-lane-model.ts` recognizes it by syntax alone; the selector is checked with `modelProblem`. In a paste, a malformed, invalid, two-target or not-open model line, or a model-bearing paste the surface cannot tie to what Jo typed, refuses the whole paste. Typed alone, an invalid line is warned about, names the model still in force and changes nothing.
- While the newest valid such input for a workload is unrecorded, nothing starts there: the tick, open, resume, the `autonomous` flip, `orchestrator_launch_lane` with or without `model`, the runner's drain and the by-hand `as2 lane <wl>` all refuse, naming the input id. The final check runs inside `reserveLane`'s transaction (`Ledger.launchRows` takes the receipt workload id explicitly). The wake render shows the pending input and model.
- `orchestrator_record_instruction` with that input id writes the instruction, the `lane-model:` line and the reading in one transaction, then runs the trigger: an autonomous workload starts once on the named model, and a user-driven one does not start. An answer to the orchestrator's question about the same workload records the model too. A newer valid line supersedes an older one, and recording the older one is refused with the newer id. Prose naming another model is not a correction: Jo sends the line again.
- Unchanged: a paste's other plain-words runs still reach the orchestrator as words with no input row. Workloads with no pending model launch as before. No schema change.

**Boundary.** Text OMP queues while another turn is streaming has not reached `before_agent_start` and has no row yet, so a background launch in that gap is not held back by it.

**Docs.** `DESIGN-lane-launcher.md` (§ 5 amendment of 2026-10-14, a § 6 failure row, a § 8 paragraph), `USER-GUIDE.md` § 3 "Name a lane's model" and a § 6 line, `tiers/orchestrator.md` (paste and recorder guidance), and two `install/manifest.tsv` rows.

**Acceptance still due.** `surface/test/pending-lane-model.test.ts` failed on an unpacked baseline `4b3799643ce211c8e0e0afce0765bc402d263fd4` at its no-start assertions and passes in the integrated branch's focused artifact. Jo's held real OMP RPC paste must show in a read-only export of its isolated ledger no launch attempt before model and reading commit, then one start whose `lane-started:` `model` and `ranModel` match the named model. Repeat the paste from merged main only after Jo merges and restarts as2.

**Rollback.** Revert the rebased feature commit after integration if needed; Jo's eventual main merge requires its own revert. The pending check and paste capture go; model input rows already written remain ordinary input rows. No ledger schema or data migration.
