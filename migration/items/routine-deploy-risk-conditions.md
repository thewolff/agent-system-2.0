---
title: Routine deploys run without Jo; a deploy escalates only on a named risk condition
status: building
workload: wl-mvgorfqqbuyyo0
pr: 291
---
Routine deploys (Jo, `in-mvgor1imswhbsw` and `in-mvgpe7k1np4xkw`; plan `/Users/jowolff/agent-scratch/agent-system-2.0/wl-mvgorfqqbuyyo0/PLAN.md` rev 9; builds on escalation phase 2, PR #278). Before this change row 6 refused every deploy command, and a merge to a repo that deploys on push was not seen as a deploy at all.

What changes:
- **One routine shape** (`gates/src/deploy-risk.ts`, `gates/src/rows/r06-reserved.ts`). A lane's bash call equal, byte for byte, to a declared target's `gh workflow run <file> --ref <branch> -R <repo>` command runs without Jo when no condition holds. Every other deploy CLI, `infrastructure change`, `publishes a package`, `gh release` and any workflow run matching no target stays reserved.
- **Conditions with sources.** Holds `O1`, `U1`, `U2`, `U3` are plain refusals. Escalations `E0` to `E11` and `M1` become a reserved request that is NOW and that `approve` admits once, bound to the condition instances and the commit. `D1` (outside the window) waits for Jo's window. Warnings `W1` to `W4` never block. Each condition cites its research in `docs/deploy-risk.md`.
- **May, not must.** A lane may deploy but never must after a merge; nothing in as2 deploys on its own. Cross-repo order is `O1`, a hold the lane resolves by deploying the predecessor first.
- **Settle.** `as2 deploy settle <dp-...>` (`surface/scripts/deploy.ts`) binds the run, checks the shipped commit and health, records `deploy-settled:` and sends one notice. `lane_release` and `lane_handoff` refuse with an unsettled deploy.
- **Profile and word.** `profile/config.yml` ships `deploy:` with `targets: []`. Jo's word `deploy-policy <sha12>|off` accepts or revokes the section; only the newest word counts.
- Docs: `SPEC-2.0.md` § A4 (*Amended 2026-10-20*), `docs/deploy-risk.md`, `docs/concepts.md`, `tiers/lane.md`, `USER-GUIDE.md`.

**What Jo does to enable a target.** After merging and re-running `bash install/install.sh` (the installed profile then carries the `deploy:` block):
1. Declare: add the target to `deploy.targets` in the installed profile (`name`, `repo`, `command`, `workflowBlob` of the workflow you accept, `deployJob`, `requiredChecks`, `rollback`, `health`), and `deploy.order` when repos depend on each other. List push-to-main deploy repos in `mergeTriggered`.
2. Accept: send `deploy-policy <sha12>` with the first 12 hex of the section's hash. Until then, or after any later edit, every deploy is an escalation (`E0`).
3. A target stays escalated by `E6` until it has one settled-ok deploy and a rollback text.

**Reversal.** Send `deploy-policy off`: every deploy is again a reserved request. To remove the change, revert the PR on main, fast-forward, re-run the install and restart `as2`. `deploy:`, `deploy-run:`, `deploy-settled:`, `deploy-merge:`, `merge-inflight:`, `merge-done:` and `deploy-policy:` entries stay as plain entries no reader looks at.
