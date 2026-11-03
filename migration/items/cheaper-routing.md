---
title: Cheaper routing, phase 2 (as2 routing report, judge reviews on standard, Opus at medium, Haiku 5.5 threshold)
status: building
workload: wl-mv71x5rwdu7eo0
pr: 444
---
Phase 2 of Jo's cheaper-routing workload (in-mv71wv0tc0xo1s). Plan: `/Users/jowolff/agent-scratch/agent-system-2.0/wl-mv71x5rwdu7eo0/PLAN-p2-rev4.md` (rev 3 approved by Jo, q-mv92mqghg2ax34). Phase 1 was `migration/items/headroom-guard.md`.

**What ships.**
- `as2 routing` (`surface/scripts/routing-report.ts`, `surface/src/routing-report.ts`): a read-only report over the ledger's `routings` table. Per kind and tier: rows, outcomes, models, pull-ups and pull-downs, review vs build, dollars and tokens per hand (read from each hand's session file, `n/a` when gone), Jev's share, `headroom-skip:` counts. `--split <ISO>` compares two cohorts. On `--until 2026-10-13T19:04:00Z` it reproduces Jo's figures: `904 rows · jev 904 · change-large 247 of 259 code rows`.
- Sizing proof: main's right-sizing question (landed 2026-10-20 through PR #271) moved the change-small share of code rows from 6.7 % (41 of 614) to 30.1 % (97 of 322). `SIZE-PROOF.md` in the plan directory.
- Reviews (SPEC-2.0.md § B4, *Amended 2026-11-03 — normal judge reviews on standard*): a judge-kind review runs on standard at normal stakes and on fast at throwaway; production keeps deep. Low-confidence reviews keep their pull-up. The OpenAI reviewer is the strong row's gpt-6.1-sol at every review tier (`classifier/src/lab.ts` `reviewRow`). Cross-lab and review park unchanged.
- Opus 5.5 at medium: the strong row's Anthropic entry is `anthropic/claude-opus-5-5:medium`, and a lane gets `setThinkingLevel("medium")` at the first prompt after each entry to Opus (`surface/extensions/lane.ts`), with a `thinking-level:` entry, or a `thinking-level-failed:` entry when the host refuses.
- `compaction.modelThresholds["anthropic/claude-haiku-5-5"] = 250000` (1M window), owed by Jo's in-mv8gcb2bbue4g0 since the fast row moved to Haiku 5.5 on 2026-10-26.

**After it lands.** Run `install/install.sh` so the installed profile carries the `:medium` strong entry and the Haiku threshold. A running lane keeps the code it loaded; it picks up the Opus rule when relaunched.
