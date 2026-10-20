---
title: Day-one provenance: as2Commit and as2Dirty on lane-started, an optional proposal_id manifest column
status: building
workload: wl-mv654hoqwpfhmo
pr: 259
---
**Built on branch `wl/wl-mv654hoqwpfhmo-prov`, PR #259 (PR-P).** Workload `wl-mv654hoqwpfhmo` (production stakes; plan at `~/agent-scratch/agent-system-2.0/wl-mv654hoqwpfhmo/PLAN.md` § 11.3 "Day one", approved by Jo). This is B14.3 part 5: the facts a tuning proposal is later judged against have to be recorded from the first day, because neither can be rebuilt afterwards.

Switch: none — two recorded fields; Jo q-mvfl9h64q7ivpc

**What changed.**
- **`lane-started:` names the as2 checkout.** Each `lane-started:` record now carries `as2Commit`, the HEAD sha of the checkout `surface/scripts/lane.ts` runs from (the machinery the installed profile points at), and `as2Dirty`, true when that checkout has uncommitted changes to tracked files (`git status --porcelain --untracked-files=no` is not empty; untracked files such as `.ai/` notes do not count). The runner and the interactive `as2 lane <wl>` path both read them once per run (`readAs2Provenance` in `surface/scripts/lane.ts`) and pass them to the pure builder `laneStartedBody` in `surface/src/launch.ts`, so every start record of one run names the same commit. A git read that fails, times out (10 s) or cannot run leaves its field `null`; it never blocks a launch. The status read runs with `--no-optional-locks`, so it never writes the checkout's index.
- **`install/manifest.tsv` has an optional fourth column, `proposal_id`.** The header is `path<TAB>kind<TAB>destination<TAB>proposal_id`. A row may stop after three fields, which means `proposal_id` `-` (no tuning proposal made it); every existing row stays exactly as it was. A row a proposal makes carries that proposal's `p-<id>` in the fourth field. `install/install.sh` refuses (exit 2, nothing written) a header without the column name, a row with five or more fields or an empty field, and a present `proposal_id` that is neither `-` nor `p-[a-z0-9]+`. `gates/test/manifest-sync.test.ts` reads the manifest through a strict reader that applies the same rules (a three-column row reads as `-`), and `ledger/test/install.test.ts` and `install/fresh-machine-test.sh` 7c prove the refusals.

**The gap, stated instead of backfilled.** Lanes started before this merges have no `as2Commit` or `as2Dirty` in their `lane-started:` records, and none will be added: the commit a past lane ran under cannot be read back reliably. Readers treat a record without the fields as predating this change (§ 11.6 of the plan falls back to the `origin/main` commit of that day for them). A field that is present and `null` is different: git could not answer at that launch.

**Adding a manifest row from now on.** Three TAB-separated fields as before; add a fourth only when a tuning proposal made the row, and then it is that proposal's `p-<id>`. A branch that adds three-column rows needs no change, and a merge with this PR keeps both sides' rows as they are.

**Install.** Re-run `bash install/install.sh` after merge; the installer and the manifest header move together (an installer from before this PR refuses the new header, and this installer refuses the old one). The new fields reach lanes started after the as2 restart that follows the merge.

**Rollback.** Revert the PR. Records already written keep their two extra fields, which no reader requires.
