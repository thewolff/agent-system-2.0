---
title: Opus is the as2 default role; Kimi is off the tier rows until Moonshot is paid
status: building
workload: wl-mvplvvhwvmy134
pr: 314
---
**Built on branch `wl/wl-mvplvvhwvmy134`, PR #314.** Jo approved both changes on 2026-10-26 (ledger input `in-mvplvhx6h1c35s`). The Moonshot/Kimi account is suspended for insufficient balance, and Jo is paid on 2026-10-30.

## What changed

1. **`modelRoles.default: anthropic/claude-opus-5-5`** in `profile/config.yml`. An unnamed lane and Ilex now start on Opus by setting, not by OMP's provider-default order. A lane Jo pinned with `lane-model:` passes `--model` (`laneArgv` in `surface/src/launch.ts`) and is unaffected. `retry.fallbackChains` and every other key are untouched.
2. **The four moonshot entries are gone from `task.agentModelOverrides`** in `profile/config.yml`: `moonshot/kimi-k2.7-code-highspeed` (fast), `moonshot/kimi-k2.5` (standard), `moonshot/kimi-k2.7-code` (strong), `moonshot/kimi-k3` (deep). Anthropic and openai-codex entries and their order are unchanged. The `modelThresholds` entries for `moonshot/kimi-k2.*` stay, since they are needed again on restore. The tier-block comment in the config says the same.
3. **Tests** now pin the shipped state: `classifier/test/tier-table.test.ts` asserts every row spans exactly `anthropic` and `openai-codex` and that no row names a kimi-lab entry (T17 rewritten); `surface/test/chaos-stub.test.ts` derives the must-stay-enabled row providers from the shipped `task.agentModelOverrides`, plus typesafe, minimax and groq. `classifier/test/fixtures/ledger-replay/golden.txt` was regenerated with `bun classifier/scripts/ledger-replay.ts --update` (238 lines; every change is the kimi lab dropping out of a row or its decision). Two row-dependent tests now pin their own rows and no longer follow the shipped ones: the production-review test in `classifier/test/ledger-replay.test.ts` builds three-lab rows with `tierTableFromConfig`, and the `source 5h hard ceiling` test in `surface/test/lane-headroom-script.test.ts` installs `[A, SOL, K]` as the strong row.

## Interaction with KIMI_OUT_RULE

`KIMI_OUT_RULE` in `classifier/src/lab.ts` (`endsAt` 2026-11-01T00:00:00-07:00, `rowOmission`) treats a tier row with no kimi entry as Kimi out while the rule is active. Restoring the entries before that date means a review needs a live Kimi entry again, and a Kimi quota 429 then counts through the provider-refused path.

## Restore (after 2026-10-30, once Jo confirms the Moonshot balance is paid)

`modelRoles.default` stays after the restore; only the Kimi rows come back.

1. In `profile/config.yml`, re-add the four exact entries as row 3 of each tier under `task.agentModelOverrides`:
   - fast: `moonshot/kimi-k2.7-code-highspeed`
   - standard: `moonshot/kimi-k2.5`
   - strong: `moonshot/kimi-k2.7-code`
   - deep: `moonshot/kimi-k3`
2. In `classifier/test/tier-table.test.ts`, restore the three-provider assertion (`anthropic`, `openai-codex`, `moonshot`) and the original T17 (each tier's `[2]` entry is the moonshot entry above, and no row names `kimi-code/`).
3. Revert the tier-block comment in `profile/config.yml` ("Rows 2-3 (openai-codex, moonshot) ...") to drop the removal note. The `surface/test/chaos-stub.test.ts` derivation needs no change.
4. Regenerate `classifier/test/fixtures/ledger-replay/golden.txt` with `bun classifier/scripts/ledger-replay.ts --update` (not `--refreeze`) after re-adding the rows, and commit it. The two pinned-row tests above need no change.
5. Merge, fast-forward the main checkout, re-run install, relaunch lanes.

Re-adding the rows does not clear refusals already recorded. A workload whose ledger has `provider-refused: moonshot status 429 token <dt>` keeps skipping Moonshot, because `refusedProviders` in `classifier/extension.ts` honours a quota 429 while `kimiOutRuleActive(now)` holds, that is until `KIMI_OUT_RULE.endsAt` (2026-11-01T00:00:00-07:00) in `classifier/src/lab.ts`. Only a `provider-ok: moonshot by <instruction>` written by the surface clears it earlier, and nothing in `surface/` writes that entry today, so those workloads get Moonshot back at the rule's end, not at the restore.
