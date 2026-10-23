---
title: A green, reviewed normal-stakes lane PR boards the merge train on its own, with no `train <N>` from Jo
status: building
workload: wl-mvbjiettjrfpxc
pr: none
---
**Built on branch `wl/wl-mvbjiettjrfpxc`, PR pending.** Workload `wl-mvbjiettjrfpxc` (normal stakes, jo-issues #132, plan revision 6 at `~/agent-scratch/agent-system-2.0/wl-mvbjiettjrfpxc/PLAN.md`). Until now a train existed only by Jo's `train <N>`, and a lane on this repository asked Jo to integrate each green PR.

**What changed.**
- An autonomous normal-stakes lane on a repository the test runner serves (a merge train or train fix lane excepted) never asks Jo to integrate. A cross-lab review slice must pass before the PR is done; once the PR is green at its head with that review passed, the lane records `done-because:` and releases, and the surface closes the workload. `mergeLine` gives such a lane `TRAIN_LANDS_LINE` (`surface/src/launch.ts`); `tiers/lane.md` § Git shape and completion says the same. A done line's "merged on main" is met by that hand-off.
- The train tick boards the PR (`landingReady`, `boardLanding` in `surface/src/merge-train.ts`) when its workload is closed, was autonomous at normal stakes, carries a holder `done-because:` newer than the tick's `train-autoboard: on` cutover row, its newest full-suite run is green at the PR's head and its cross-lab review passed. It boards onto the repository's open train or opens one, and writes `train-board:`. A PR that fails a test gets one `train-board-skip:` row and no line to Jo.
- `boardLanding` reuses the repository's newest open main train regardless of train age or spend. If that train is held by Jo's stop or has an effective standing `done-because:`, the PR stays pending for a later scan; it does not open a replacement. A new train opens only when no matching open train exists. The existing 14-day candidate scan window and full-ceiling launch enforcement still apply. See `migration/items/reuse-open-train-boarding.md`.
- `train-board:`, `train-board-skip:`, `train-notice:` and `train-autoboard:` are control prefixes only the merge train writes. `trainMembers` reads Jo's `train:` bindings and the tick's boards as one list.
- Jo hears only of a production-stakes merge, a conflict the owner's fix fails twice, a red main (once per `main-red` issue), or a main protection the tick cannot verify (named once per episode). `train <N>` is still how Jo adds any other PR or resumes a stopped train. SPEC-2.0.md § B4, *Amended 2026-10-19 — the merge train lands a normal lane's PR*, records the rule.

**Rollback.** Revert the PR. PRs already boarded stay on their trains and land as Jo-named ones would; new green PRs wait for Jo's `train <N>` again.
