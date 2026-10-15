# skills/ — vendored sources and pins

Every directory under `skills/` is one of the 23 rows of DESIGN-2.0.md § C6.1. Rows 1–21 were copied from the source named here at the pin named here (§ C6.4, refreshed per `research/skill-pack-refresh.md` § 7) and then owned by this repo; row 22, `seo-audit`, was written in this repo (workload wl-mv5jz4vewt8mbk, `migration/items/seo-audit-skill.md`) and has no upstream; row 23, `jev`, was written in this repo (workload wl-mv8s8swjr478qo, `migration/items/jev-capability-card.md`) and has no upstream. Nothing here tracks upstream automatically; a re-pin is a deliberate re-diff against the commit in this table. Every edit made after the copy is marked in-file with a `<!-- owned: … -->` comment at the edit, so `grep -rn 'owned:' skills/` lists the whole delta.

Copied 2026-09-29 by the M6 migration step (`MIGRATION.md` M6). The copy script and the tag clones it read from are scratch: `/Users/jowolff/agent-scratch/agent-system-2.0/migration/M6/{build-skills.sh,clones/}`.

## Packs

| pack | clone URL | tag | commit | licence | date |
|---|---|---|---|---|---|
| addyosmani/agent-skills | https://github.com/addyosmani/agent-skills.git | `0.6.11` | `2686b620fc1fed2e8f60c704839c766b8594c6b6` | MIT | 2026-09-29 |
| pmndrs/impeccable | https://github.com/pmndrs/impeccable.git | `skill-v4.3.1` | `cd12f8660e2dde57b9615c8a6b8ea674101f9cfc` | Apache 2.0 | 2026-09-29 |
| blader/humanizer | https://github.com/blader/humanizer.git | `v3.1.0` | `225a6f39ac85f76ee48dbad772ea4abe4ed6c9d8` | MIT (`humanizer/LICENSE`) | 2026-09-29 |
| obra/superpowers | https://github.com/obra/superpowers.git | `v6.4.2` | `8ca22dba9a94f28898bbce59f2537ff4d87c747d` | MIT (`execute-plan/LICENSE`) | 2026-09-29 |
| newdle-claude-plugins (ours) | `/Users/jowolff/code/shipyard/repos/newdle-claude-plugins`, `plugins/newdle/skills/` | — | `2f7e67f8c1463df64895804815d16b88e266ff90` | ours | 2026-09-29 |
| Jo's user skill dirs (ours) | `~/.claude/skills/`, `~/.agents/skills/` | — | not versioned; copied as found | ours | 2026-09-29 |

The impeccable skill runs a launcher (`impeccable/scripts/impeccable`) that downloads its engine binary on first use; the engine pin at `skill-v4.3.1` is `engine-v0.1.5` (research/skill-pack-refresh.md § 7). Nothing in this repo vendors the binary.

## Rows

"Source path" is relative to the pack's clone root (or to the plugin's `plugins/newdle/skills/` for ours). "Absorbed" names the upstream or 1.x skills whose text was folded in as skill-local `references/`; they are not discoverable as skills (nested `SKILL.md` files were renamed so OMP's provider counts exactly 23).

| # | skill dir | pack @ pin | source path(s) | absorbed into it | owned edits |
|---|---|---|---|---|---|
| 1 | `ctx` | Jo's dirs | `~/.claude/skills/ctx/SKILL.md` | — | header marker |
| 2 | `humanizer` | humanizer v3.1.0 | `SKILL.md`, `LICENSE` | — | header marker. 3.x has 26 numbered patterns (2.x had 35); no 2.0 text cites a pattern number (grepped 2026-09-29) |
| 3 | `spec-and-plan` | agent-skills 0.6.11 | `skills/spec-driven-development/SKILL.md` → `SKILL.md`; `skills/planning-and-task-breakdown/SKILL.md` → `references/planning-and-task-breakdown.md`; `references/definition-of-done.md` → `references/` | planning-and-task-breakdown; `~/.agents` `incremental-implementation` (dropped, superseded by execute-plan) | rename, merged description, planning pointers, Phase 4 → execute-plan, link rewrites |
| 4 | `test-driven-development` | agent-skills 0.6.11 | `skills/test-driven-development/`; `references/testing-patterns.md` → `references/` | `~/.agents` `tdd` (dropped) | link rewrite `../../references/` → `references/` |
| 5 | `debugging-and-error-recovery` | agent-skills 0.6.11 | `skills/debugging-and-error-recovery/` | `~/.agents` `diagnosing-bugs` (dropped) | header marker |
| 6 | `code-review-and-quality` | agent-skills 0.6.11 | `skills/code-review-and-quality/`; `references/{performance-checklist,security-checklist}.md` → `references/`; `skills/code-simplification/SKILL.md` → `references/code-simplification.md`; `skills/constraint-driven-development/references/floor-guard.md` → `references/floor-guard.md` | code-simplification; constraint-driven-development's Floor + Step 6 (as "Step 6: Guard the Bar") | header marker, Step 6 section, See Also pointers, link rewrites |
| 7 | `git-workflow-and-versioning` | agent-skills 0.6.11 | `skills/git-workflow-and-versioning/` | `split-to-prs`, `git-guardrails-claude-code` (dropped) | header marker |
| 8 | `resolving-merge-conflicts` | Jo's dirs | `~/.agents/skills/resolving-merge-conflicts/{SKILL.md,agents/openai.yaml}` | — | header marker |
| 9 | `security-and-hardening` | agent-skills 0.6.11 | `skills/security-and-hardening/`; `references/security-checklist.md` → `references/` | `newdle-security-audit`, `newdle-cso` (product, dropped) | link rewrites in SKILL.md and `references/hardening-patterns.md` |
| 10 | `documentation-and-adrs` | agent-skills 0.6.11 | `skills/documentation-and-adrs/` | — | header marker |
| 11 | `research` | agent-skills 0.6.11 | `skills/source-driven-development/SKILL.md` → `SKILL.md` | `~/.agents` `research` (its findings-file rule folded in as a section), `newdle-research` (dropped) | rename, description, "Findings file — the artifact" section |
| 12 | `interview-me` | agent-skills 0.6.11 | `skills/interview-me/`; `skills/idea-refine/` (whole dir) → `references/idea-refine/` (its `SKILL.md` → `idea-refine.md`) | idea-refine; plugin `grilling`, `grill-me`, `grill-with-docs`, `to-questionnaire` (dropped) | header marker, "Interaction with Other Skills" renamed to 2.0 skills |
| 13 | `writing-for-agents` | Jo's dirs | `~/.agents/skills/writing-for-agents/{SKILL.md,SKILL-MECHANICS.md,agents/openai.yaml}` | `create-skill`, `using-agent-skills` (dropped) | header marker |
| 14 | `cross-model-review` | ours 2f7e67f8 + agent-skills 0.6.11 | plugin `triad/` (whole dir) → `references/triad/` (`SKILL.md` → `triad.md`); plugin `quorum/` → `references/quorum/` (`SKILL.md` → `quorum.md`); `skills/doubt-driven-development/SKILL.md` → `references/doubt-driven-development.md`; `references/orchestration-patterns.md` → `references/` | triad, quorum, doubt-driven-development; `gaslight`, `council`, `newdle-triple-check`, `claudex-*`, `codex-*` (dropped) | new `SKILL.md` (router); doubt-driven carries the plugin's codex network-profile fix (plugin `doubt-driven-development/SKILL.md` at 2f7e67f8, measured 2026-08-14) in place of upstream's `--sandbox read-only`; link rewrites |
| 15 | `api-and-interface-design` | agent-skills 0.6.11 | `skills/api-and-interface-design/` | `codebase-design`, `domain-modeling`, `setup-pre-commit` (dropped) | header marker |
| 16 | `performance-optimization` | agent-skills 0.6.11 | `skills/performance-optimization/`; `references/performance-checklist.md` → `references/` | `newdle-performance-audit` (dropped) | link rewrite |
| 17 | `observability-and-instrumentation` | agent-skills 0.6.11 | `skills/observability-and-instrumentation/`; `references/observability-checklist.md` → `references/` | — | link rewrite |
| 18 | `deprecation-and-migration` | agent-skills 0.6.11 | `skills/deprecation-and-migration/` | `migrate-to-shoehorn` (dropped) | header marker |
| 19 | `accessibility` | ours 2f7e67f8 | plugin `newdle-a11y-audit/{SKILL.md,WCAG-AA-CHECKLIST.md}` | `newdle-responsive-audit` etc. (dropped) | rename to `accessibility`, description, plugin auditor-spawn block removed, verdict marker renamed |
| 20 | `impeccable` | impeccable skill-v4.3.1 | `.pi/skills/impeccable/` (whole dir: `SKILL.md`, `reference/`, `scripts/`) — the `.pi` variant, chosen because OMP leaves `${CLAUDE_SKILL_DIR}` unexpanded (M6 check 1) | — | `allowed-tools` frontmatter key dropped; base-directory note names the OMP location |
| 21 | `execute-plan` | superpowers v6.4.2 | `skills/subagent-driven-development/SKILL.md` → `SKILL.md`; `skills/subagent-driven-development/{implementer-prompt,task-reviewer-prompt,re-review-prompt}.md`; `skills/subagent-driven-development/scripts/{sdd-workspace,task-brief,review-package}` + `skills/executing-plans/scripts/{task-start,task-done}` → `scripts/`; `skills/executing-plans/SKILL.md` → `references/executing-plans.md`; `skills/requesting-code-review/code-reviewer.md` → `code-reviewer-prompt.md`; `LICENSE` | executing-plans; `incremental-implementation` | rename + description; `superpowers:*` refs → rows #3–#7; four stops → SPEC § A4 reserved list; `Ruling:` → ledger `assumption` entry; main-branch consent line and `finishing-a-development-branch` hand-off removed. Scripts unchanged (workspace path `.superpowers/sdd/` kept) |
| 22 | `seo-audit` | — (written in this repo, 2026-10-12) | — | supersedes the plugin's `newdle-seo-audit`; no text copied | not a copy: every rule row cites a primary source listed in `references/sources.md` |
| 23 | `jev` | — (written in this repo, 2026-10-14) | — | — | not a copy: the Jev capability card; every figure points to Plumb's profile, committed verbatim under `research/jev-profile/` |

## Discovery contract

The profile's `skills` block (`profile/config.yml`) points `customDirectories` at this directory and lists these 23 names in `includeSkills`; every provider that would pull skills from `~/.claude`, `~/.codex`, or `~/.agents` is off. OMP's native provider requires a frontmatter `description` (`omp://skills.md`); every `SKILL.md` here has one. Skill-local links are relative to the skill directory (`references/…`), because `skill://<name>/<path>` refuses `..`.
