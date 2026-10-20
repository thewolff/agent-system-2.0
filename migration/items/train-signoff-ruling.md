---
title: Jo's train word is the production merge sign-off — standing ruling train-signoff, and one notice per PR a train merged
status: open
workload: wl-mvg8itbt0rz3ls
pr: none
---
Jo's words, 2026-10-19 9:10 PM PDT: *"i dont want to be asked twice"* (jo-issues #155). His standing ruling, ledger input `in-mvg8clpoo9xn28`: *"my train word on a production-stakes PR is my merge approval. The train merges that PR once it is green and its review passes, without asking me again, and tells me in one line after it merges."* He answered `machinery` (in-mvg8ibntzpnzeo): carry it in every train. He answered `issue155` (instruction in-mvg9zz54ejepz4): this is the permanent rule, and the PR closes jo-issues #155. Plan: `/Users/jowolff/agent-scratch/agent-system-2.0/wl-mvg8itbt0rz3ls/PLAN.md` (§§ 1–2 and § 6, branch `issue155`). Before this change a production PR needed Jo's `train <N>` to board, and then the train asked him merged / skip / stop before it merged. No train told Jo about a merge.

Depends on PR #267 (escalation policy phase 1, `migration/items/escalation-policy.md`): the ruling lives in its `STANDING_RULINGS` and ends with its `end-ruling` word. The train lands #267 first.

What changed:
- **Standing ruling `train-signoff`** (`gates/src/rulings.ts`). It decides a train lane's merged / skip / stop question, answer `merge`, when the question tool finds all of these, by reading the ledger and `gh` itself: an authenticated `train` word of Jo's named the PR; the PR is on a same-repo `wl/` branch whose workload's newest review is settled and passed; a green run tested its current head; and main's protection reads `ok` live. Then no question row is written. The tool records `ruling-applied: train-signoff kind merge slice <sl> answer merge` and tells the lane to merge at once: a merge commit with `--match-head-commit <head>`, never `--admin`, `--squash`, `--rebase` or `--auto`. Anything else asks Jo as before: a PR only the tick boarded, a non-`wl/` branch or a fork, a review not passed or still running, no green at the head, protection `gap` or `unknown`, or a failed `gh` read.
- **The fact** (`trainSignoff`, `surface/src/merge-train.ts`; read in `lane_raise_question`, `surface/extensions/lane-tools.ts`). It is computed by the tool, never taken from the lane's words.
- **The train brief** (`trainBrief`). A new train's production paragraph says the question goes through Jo's rulings, and the Rules line reads "a production PR's merge is Jo's: his merged answer, or his ruling train-signoff deciding the question". A train opened earlier gets the same steps from the ruling's action text the next time it asks.
- **Merge notice** (`surface/scripts/train-tick.ts` step 3e, `trainMergedNoticeBody` in `surface/src/notice.ts`). The tick sends Jo one notice per PR any train merged, normal or production, deduplicated by a `train-notice: merged <owner/repo> #<n> <train>` entry on the standing workload. None for `merged by Jo …` or `skipped: …`.
- Docs: `SPEC-2.0.md` (§ B4 production row and its dated amendment, § B12.1 item 5) and `USER-GUIDE.md` (standing rulings, `end-ruling`, the `train` word, notices). Test: `surface/test/train-signoff.test.ts` (new, with a manifest row).

Not changed: auto-boarding still never boards a production PR (`liveHalf`, `landingReady`); `prStakes`; P-11 row 6's refusal of `gh pr merge --admin`.

**Escalation phase 2.** sl-p2-train of wl-mvg1vs0rhnu3gg drops its merge notice: the tick step it planned is built here, in the same shape.

**Cutover.** The ruling is checked only when a question is raised. A merged / skip / stop question already open when this lands stays Jo's: his `merged`, `skip` or `stop` works as before. The PR body lists any such question.

**What an installed system needs.** After the merge:
1. Fast-forward the main checkout.
2. Re-run `bash install/install.sh` (the manifest has a new row for `surface/test/train-signoff.test.ts`).
3. Restart `as2`, so `end-ruling` accepts `train-signoff`.
4. Relaunch every running train lane, so its question tool carries the ruling check.

The train tick needs no reinstall; it runs from the checkout each pass. No schema change. `train-notice: merged …` and `ruling-applied: train-signoff …` rows are new and inert under the old code.

**Ending it.** Jo types `end-ruling train-signoff`. From then on every production PR asks him again. No code change.

**Reversal.** Revert the PR on main, fast-forward, re-run the install, restart `as2` and relaunch train lanes. Rows already written stay in the ledger.
