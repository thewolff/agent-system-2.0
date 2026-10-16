---
name: cross-model-review
description: Fans a judge slice across the three providers (Claude, Codex/GPT, Kimi) so no single lab's priors decide alone. Two entry points, one skill. Review a code diff (triad) when a change needs an independent read before it stands, a second opinion on a branch or PR, or an adversarial pass on your own work. Generate a plan (quorum) when a brief needs independent plans drafted blind by three labs and compared. Use for any cross-model, second-opinion, red-team, or "are we sure" request on code, plans, specs, or documents; the doubt-driven adversarial pass and the plan-refutation stage live here too.
---

# cross-model-review — one judge slice, three labs

<!-- owned: agent-system 2.0 row #14 (DESIGN-2.0.md § C6.1, Q-a ruled 2026-09-25: "yes to the merge - there are too many entry points"). This file is 2.0's routing text. The two bases are ours, copied once from newdle-claude-plugins plugins/newdle/skills at 2f7e67f8 and kept whole with their prompts and scripts: references/triad/ (diff review) and references/quorum/ (plan generation). The absorbed addyosmani/agent-skills `doubt-driven-development` 0.6.11 text is references/doubt-driven-development.md, carrying the June codex network-profile fix (skills/VENDOR.md); `gaslight`, `newdle-triple-check`, `claudex-loop`, `claudex-route`, `codex-build`, `codex-review` and `council` are absorbed here and not shipped. Provider set per SPEC-2.0.md § B11: the three flat-rate subscriptions; no metered chat key. -->

## Why three labs

Single-model review has correlated blind spots: the same weights grading their own homework, whether the reviewer is the main session or a subagent of it. Subagents change the role, not the priors. Three independently trained models from three labs, each in its own information environment, disagree in useful places; where they agree, the finding is worth more than any one of them.

## Pick the entry point

| the artifact under judgment | entry point | read next |
|---|---|---|
| a code diff (branch vs base, a PR, uncommitted work) | **triad** — three legs review the diff, one agreement-ranked report | `references/triad/triad.md` |
| a brief that needs a plan | **quorum** — three legs draft blind, one synthesis maps convergence and forks | `references/quorum/quorum.md` |
| a plan, spec, or document that already exists and needs an adversarial read | **quorum's refutation stage** (`--refute` against the draft) for a plan; **doubt-driven** for any single artifact, see `references/doubt-driven-development.md` | as named |

Each base is self-contained: its `scripts/` fan out the legs in parallel with the isolation and timeouts it documents, and its `prompts/` are the leg contracts. Relative paths inside `references/triad/triad.md` and `references/quorum/quorum.md` (`scripts/…`, `prompts/…`) resolve against **that** directory, not this skill's root: run the fan-out script from `references/triad/` or `references/quorum/` under this skill's directory. Those scripts are for a user-driven terminal; an as2 lane never runs them and runs every mode as a panel instead (*From an as2 lane: every mode runs as a panel*, below).

## Rules that apply to both

- **Three providers, one skill.** The legs are Claude, Codex/GPT, and Kimi Code, each through its own CLI on its own subscription (SPEC-2.0.md § B11). A leg whose provider is rate-limited or whose CLI is missing is reported as a missing leg, never silently replaced by a second leg on another provider; a two-leg run says so in its report.
- **Same input, no cross-talk.** Every leg gets the identical artifact and prompt and never sees another leg's output until synthesis. That is the whole value; do not "help" a leg with another leg's findings.
- **Read-only legs.** A leg reviews; it never edits the workspace. The bases enforce this per CLI (a read-only sandbox for Codex, a scratch copy for the others); keep those flags exactly as the base text has them. The Codex sandbox note in `references/doubt-driven-development.md` (network enabled, filesystem fenced) is the measured state and applies to every Codex leg here.
- **Synthesis is labeled.** The report separates what all three found, what two found, what one found, and what was refuted. A finding one lab raised and another refuted is reported as a disagreement, not dropped.
- **The slice closes on the report file.** Both bases write a report under the repo's `.tmp/` (or the location the base names); that file is the judge slice's artifact (SPEC-2.0.md § B1). Paste the needs-you section into the reply; the rest stays in the file.

## Mode

Both entry points run in both modes (SPEC-2.0.md § B13.1). User-driven: Jo names the artifact and reads the report. Autonomous: a lane fans out the judge slice its stakes call for and acts on the agreement-ranked findings without waiting; anything the report marks as needing a human decision goes to the lane's question row, not to a pause. From a lane, that fan-out is a panel (next section).

## From an as2 lane: every mode runs as a panel

Inside an as2 lane the cross-model pass is a **panel**: one judge hand per lab (anthropic, openai, kimi), dispatched by the classifier from one `task` item, each pinned to its own lab and given the byte-identical task text, packet and output schema; then one synthesis hand reads the landed outputs and writes the report. No external CLI runs and nothing waits on Jo's terminal. `references/panel/panel.md` has the steps per mode in full.

- **A lane never runs `references/*/scripts`.** The triad and quorum fan-out scripts stay user-driven terminal tools. A lane runs every mode as a panel.
- **The doubt-driven skip does not apply in a lane.** `references/doubt-driven-development.md` skips cross-model in non-interactive contexts because the pass there is an external CLI run with no user to authorize it. Inside a lane the pass is a panel, with no external CLI, authorized by the stakes guidance below, so that skip does not apply there.
- **A panel is its own explicit dispatch** (SPEC-2.0.md § B4, *Amended 2026-10-12 — three-lab review panels*). It includes the builder's lab. It is never a review round and never the plan review: `panel:` and `panel-synth:` are refused on the plan slice, and the ordinary cross-lab review still runs.

### The modes

| artifact under judgment | mode | `prep` flags after the common ones |
|---|---|---|
| a code diff | `triad`, then `triad-verify` on each finding that survives | `--base <ref> --ticket <path> [--repo <worktree>]`; verify: `--finding <json path> --base <ref> [--repo <worktree>]` |
| a brief that needs a plan | `quorum`, then `quorum-refute` | `--brief <path>`, then `--context <path>` or `--repo-context all`, optional `--draft <path>` and `--repo <worktree>`; refutation: `--from <the quorum run>` |
| a plan that already exists | `refute` | `--plan <path>` |
| any single document | `doubt` | `--artifact <path> --contract <path>` |

The common flags are `--run <run> --workload <wl> --slice <sl>`, plus `--leg-timeout-min <lab|default>=<n>`, repeatable (default 90 minutes per leg).

- **quorum** keeps its Step G grounding. For a codebase-specific brief one `understand` hand writes the context pack, and the pack gate (the base's only hard gate) is a `lane_raise_question` showing the pack's path and size; `--repo-context all` gives all three legs repo access instead. `--draft` withholds the lane's own plan from every leg; only the synthesis hand reads it.
- **quorum-refute** preps from the finished quorum run, which needs at least two landed plans; each leg gets the other two plans, anonymized.
- **doubt** runs at most three cycles (doubt-driven Step 5), one panel per cycle.

### Steps

1. **Cut a judge slice** for the panel (`lane_add_slice`, kind `judge`). Never the plan slice.
2. **Prep the run** in bash:
   ```
   bun skills/cross-model-review/references/panel/scripts/panel.ts prep <mode> --run <run> --workload <wl> --slice <sl> <mode flags>
   ```
   `<run>` is a new directory under `$HOME/agent-scratch/`, for example `$HOME/agent-scratch/<wl>/panel-<mode>-<n>`; prep refuses one that exists or whose real path is elsewhere. Prep writes `manifest.json` and the inputs, with each input's sha256.
3. **Dispatch the legs**: one `task` item at tier `deep`, named after the judge slice, carrying the six brief fields and the line `panel: <run>` (the absolute path prep was given). The classifier checks the run against your workload and slice, copies the hash-checked inputs into its panel directory, and spawns `<sl>--anthropic`, `<sl>--openai` and `<sl>--kimi`, each pinned to its lab, all with the same task text. Its dispatch result names the panel directory `<pdir>`. Write the task text once for all three; never steer one leg. Your transcript then shows your one item rewritten into those three items, with the classifier's packet text and the tier it routed to: that is the classifier's doing, not a mistake of yours, so never cancel them. A cancelled leg may never settle, and the panel then waits for its timeout.
4. **Dispatch the synthesis** once every lab's leg has landed, gone missing or been excluded: one `task` item at tier `deep`, named after the same slice, carrying `panel-synth: <run>`. It is refused before then. It runs on a lab that built none of the work when one is usable, otherwise on a builder lab, which the report names. A failed synthesis may be dispatched again, twice at most per panel; after that the run is void and the lane runs a new panel or reports the failure.

   **Word both items as reviews.** The classifier refuses a `panel:` or `panel-synth:` item it does not classify as a review, and it never overrides the kind. The synthesis is the one at risk: "synthesize … into a report" with a done-condition about a file being written can classify as change work. Phrase the synthesis brief as a verdict, for example:
   ```
   task: review the panel's leg findings: judge which hold, which conflict and which are unsupported, and rank them in one review verdict
   done-condition: a review verdict over every landed leg finding is returned in the synthesis schema
   ```
   A refused item is not a failed synthesis and does not count toward the two; reword it and dispatch again.
5. **Check the run** in bash:
   ```
   bun skills/cross-model-review/references/panel/scripts/panel.ts check <run>
   ```
   `check` is read-only. It exits non-zero unless every lab is in the report's legs line with its status and model, every landed finding is either in a report finding or dropped with a reason, every `n/3` count matches its supporting labs, and the mode's sections are present.
6. **Close the slice on `check` exit 0** (`lane_complete_slice`, artifact: the command, its exit code, and `<pdir>/out/REPORT.md`). That report is the slice's artifact; paste its needs-you part into the reply as for any base. Its findings become fix slices, as review findings do, and anything it marks as a human decision goes to the lane's question row.

### When a lane runs one (approved recommendation)

This is the recommendation Jo approved with the plan of wl-mv5m7qvgkxhpj4 (its PLAN.md § 4), not a gate: nothing enforces it.

- **throwaway**: no panel.
- **normal**: at the lane's judgment.
- **production**: a `triad` on the final diff when it changes 50 or more non-doc lines; `quorum` or `refute` on a plan with a contested design fork.
- **Always in addition to the ordinary cross-lab review** (SPEC-2.0.md § B4), never instead of it.
- A slice takes at most as many panels as its review round limit (3 at normal stakes, 5 at production; Jo's `rounds` word raises it), and `stop-reviews` on the workload or slice refuses further panels there.

### A missing leg

- A lab that gives no usable leg (no usable model, rate-limited, a failed dispatch, a cancelled or lost hand, an output withheld or failing the schema, a breach, or no answer within `legTimeoutMin`) is recorded `panel-leg: <pg> <lab> missing|excluded <reason>`, and the report names it with that reason. Each leg is pinned to its own lab, so no other lab stands in for it.
- Never dispatch a single replacement leg. For a full panel, run a whole new one: a new run directory, a new prep, a new `panel:` dispatch.
- A panel with fewer than two landed legs still publishes, and the report says `N/3`.

### Cost and wall (estimates)

These are estimates, not measured panels. They come from wl-mv5i3lulwwbbi8's deep plan reviews (gpt-6-astra $1.86–2.41 and kimi-k3 $0.75–3.62 per hand; fable unmeasured) and deep-hand wall time since 2026-10-08 (astra average 6.1 / max 26.4 min, kimi-k3 average 17.1 / max 44.9 min). One panel plus its synthesis is about 4 hands, **$6–14 and 25–60 min** (the slowest leg, then the synthesis).

| mode | panels | estimate |
|---|---|---|
| `triad` | 1, plus 1 `triad-verify` per surviving finding | $6–14 and 25–60 min, the same again per verify |
| `quorum` then `quorum-refute` | 2, plus the grounding hand for a codebase-specific brief | $12–28 and 50–120 min, plus the grounding hand |
| `refute` | 1 | $6–14 and 25–60 min |
| `doubt` | 1 per cycle, at most 3 | $6–14 and 25–60 min per cycle |

### What a panel isolates, and its limit

- **Writes are refused or tamper-evident.** Every panel hand is refused the editing tools, the worktree is fingerprinted as for any review, and the inputs sit in a panel directory no fenced bash can write and no editing tool may touch. Code run from `eval` can still write there, so the ledger is the record, not the directory: input and output hashes go into ledger entries and every consumer re-checks them; a mismatch voids the run.
- **Cross-talk is detected by an audit, not prevented.** Each leg's session is audited when it ends. A tool call naming a panel file outside the leg's own inputs, another panel, the withheld draft, the lane's or another hand's session, or an `agent://`, `history://`, `proc://`, `artifact://` or `local://` URI is a breach; in a packet-only mode, so is any `bash`, `eval`, `browser` or `web_search` call and any read outside the leg's inputs, except an installed skill's own docs (`skill://<name>`), which OMP tells every hand to read first.
- **With repo access, a computed path can evade the audit.** In a mode with repo access (the manifest's `repoAccess`, true for a triad, a triad-verify and a quorum with `--repo-context all`), a leg that builds a path at runtime (a variable, a `cd`-relative path, a string built in `eval`) is not caught, because the audit reads literal paths. There, cross-talk is detected for literal paths only.
- **A breached leg is excluded**: `panel-leg: <pg> <lab> excluded breach <call>`. An excluded leg's output is not published and the synthesis never sees it.
- **A leg's result file is bound to its reply, and its line says how.** A leg lands with `panel-leg: <pg> <lab> landed sha256 <hex> bound <how>`, the hash of its result file. `bound session`: the file is exactly the reply the leg's own session recorded in its `yield`. `bound delivered`: the session holds no such record, and the file is exactly the whole output delivered to the lane. `bound file`: neither, so the file alone is the output. That happens when nothing was delivered (a recovery) or only part of it was (a preview's head, a capped tail). A leg whose file differs from its recorded reply or from what was delivered is excluded: `panel-leg: <pg> <lab> excluded delivered-mismatch <why>`.
- **The binding's limit.** The session record is re-derived only for a plain final `yield` in the default `permissive` schema mode. A `strict` session, a reply with no `yield`, and a reply OMP truncated when it saved the session fall back to `delivered` or `file`. The record is the leg's own session file, so `eval` code that rewrites both its session and its result file is not caught. The synthesis hand's reply is not bound this way: its result file is checked for shape and hashed when it is published.

## Verification

- [ ] The right base was chosen: diff → triad, brief → quorum, existing plan or artifact → refutation / doubt-driven
- [ ] All three legs ran, or the report names which leg is missing and why
- [ ] No leg saw another leg's output before synthesis
- [ ] The report file exists at the location the base names and the reply points at it
- [ ] Disagreements between legs are reported as disagreements, not resolved silently
- [ ] From a lane: the mode ran as a panel, no `references/*/scripts` ran, and the slice closed on `panel.ts check <run>` exit 0
