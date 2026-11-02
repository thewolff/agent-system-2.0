---
title: Routine calls apply themselves and Jo is told after the fact; Jo is asked only on the § A4 floor
status: building
workload: wl-mvqwn80onq9hq8
pr: none
---
**Built on branch `wl/wl-mvqwn80onq9hq8`, PR pending.** Workload `wl-mvqwn80onq9hq8` (normal stakes, flow repair jo-issues #213, plan revision 13 at `~/agent-scratch/agent-system-2.0/wl-mvqwn80onq9hq8/PLAN.md`, Jo's ledger inputs `in-mvqwmr95k54feo`, `in-mvqyt4a8gezvgg`, `in-mvqyknri0dy4g0`, `in-mvqyy16frc4u80`). Until now Jo was asked about reserved actions that only read or only touched the lane's own scratch folder, about routine record-and-announce questions, about every plan while flow repair was up, about every review round limit, and about every ceiling hit.

**What changed.**
- **Auto-apply of held calls.** A reserved action that is wholly read-only, or writes only inside the lane's own scratch root or own worktree, is applied by the gate with an ESCALATION_BY `auto-applied: <rule> <toolCallId> …` row, a notice `auto-applied (<rule>) on <wl>: <command>` and, after the call, an `auto-applied-result:` row (`gates/extensions/r06-reserved.ts`, classifier `gates/src/routine.ts`, fence profiles `gates/src/fence.ts`). A request that may write, a Seatbelt denial or an unreadable `gh` log writes `auto-apply-tripped:` and turns auto-apply off everywhere; a lost write goes to `~/.agent-system-2/auto-apply-alarms.jsonl` and shows as an `AUTO-APPLY ALARM` needs-you line.
- **The § A4 floor.** Every row 6 hold and git-model reservation is in one class in `FLOOR` (`gates/src/rows/r06-reserved.ts`): `A4` asks Jo; `deploy` is unchanged (wl-mvgorfqqbuyyo0); `guard` is refused with no request; `ordinary` runs; `own-root` auto-applies. `rm -rf` asks only outside the own scratch root and worktree, so `/tmp` no longer exempts it.
- **Ruling `routine-calls`.** `lane_raise_question` takes `routine: { record }`; the tool appends `record-and-announce`. The ruling answers it with a `routine-recorded:` row and the notice `auto-answered …`. Its whole effect is the record and the notice; it authorizes no change (`gates/src/rulings.ts`, `surface/extensions/lane-tools.ts`).
- **Plan auto-start while flow repair is up, and at production stakes.** Condition (e) is `routineOn`, not "flow-repair is not active"; a production plan that passes cross-lab review starts the same way (`planAutoStartRound`).
- **A falling review extends once by itself.** Ruling `review-auto-extend` (`gates/src/rulings.ts`, `classifier/extension.ts`, `classifier/src/rounds.ts`).
- **The ceiling rises once by half on progress.** A hit with a slice closed, a commit pushed or a falling review since the last ceiling notice raises both values by half, rounded down, once per workload, and relaunches the lane; any other hit asks Jo `extend` / `stop`. A failed raise and question write a `CEILING ALARM` line (`surface/src/ceiling.ts`, `surface/scripts/lane.ts`).
- **The merge train boards reviewed production PRs on a full-suite green.** `prStakes` and `landingReady` (`surface/src/merge-train.ts`) admit production; a fast green never auto-boards a production PR (`PRODUCTION_FAST_GREEN`), and Jo's `train <N>` still can. The `merges` ruling no longer excludes production.

**Switch and the off word.** One reader, `routineOn` (`gates/src/routine-switch.ts`), read inside each deciding write: on unless Jo's `ask-all` (off) is the newest word, a trip or latch counts, or Jo ended the ruling. Jo's `ask-all` turns every item above except the train's production boarding back to asking; `auto-routine` turns them on and clears older trips and alarm lines (`surface/src/input.ts`). `end-ruling routine-calls` and `end-ruling review-auto-extend` end one ruling each.

**Docs.** `USER-GUIDE.md` (section 1 plan auto-start, section 2 rulings and Routine calls, section 3 words, section 4 notices and needs-you, section 6 spend at 100 %), `SPEC-2.0.md` § A4, § B3, § B4, § B6 and § B11 (each *Amended 2026-10-27*), `tiers/lane.md`.

**Tests.** `gates/test/routine.test.ts`, `gates/test/routine-gate.test.ts`, `gates/test/routine-switch.test.ts`, `gates/test/r06-floor.test.ts`, `surface/test/ceiling.test.ts`, `surface/test/ceiling-meter.test.ts` and `surface/test/ceiling-surface.test.ts`.

**Rollback.** Jo types `ask-all`: nothing auto-applies, auto-starts, auto-extends or auto-raises, and every routine call asks again. The train's production boarding is not behind that word; reverting the PR removes it. Reverting the PR restores today's asks; rows already written stay in the ledger.
