---
name: quorum
description: Cross-provider plan generation for Newdle — three independently-trained models from three different labs (Claude, Codex/GPT, native Kimi Code) each draft a plan for the same brief, blind to each other and under an identical prompt, then a synthesis pass maps where they converged, where they forked, what only one lab saw, and how they compare to any draft plan you withheld. Generates plans from a brief specifically — for reviewing a code diff use triad, for critiquing a plan or doc you have already drafted use newdle-triple-check, and for a bounded either/or between named options use neither (do a direct primary-source comparison; council/SKILL.md explains why a fixed triad misfires there). Use when the user asks for a quorum, cross-provider plan, cross-model plan, multi-lab plan, or independent plans for a brief. The most expensive skill in the store — each leg generates a full plan; never run it unrequested. REQUIRES the CLI for each leg you run, installed and authenticated — `claude` for leg a, `codex` (https://github.com/openai/codex) for leg b, `kimi` (https://code.kimi.com) for leg c — and refuses to start if one is missing; unlike triad, `--only a,b` or `--skip c` lets you run the legs you do have.
argument-hint: "<brief files, directory, or inline prose> [--draft path] [--context path] [--no-context] [--repo-context all] [--refute] [--objectives] [--only a,b] [--skip c] [--force]"
---

# quorum — Cross-Provider Plan Generation

From an as2 lane this mode runs as a panel (`quorum`, then `quorum-refute`), never through `scripts/`: see [`../panel/panel.md`](../panel/panel.md).

## Overview

One model planning is one lab's priors deciding what the plan looks like — subagents
change the framing, not the weights. This skill hands the **same brief, under the same
prompt**, to three models from three different labs, each blind to the others, then maps
the results: converged, divergent, unique, and versus any draft you withheld.

The identical prompt is the load-bearing decision. `council` varies the objective
because framing is the only independence axis it has; here the axis is that the three
models were trained by different labs on different corpora, and if the prompts also
differed, a divergence could not be attributed — you couldn't tell whether two labs
disagreed because they're different models or because one was told to optimize for
speed. Identical prompt, different provider, clean attribution. The tradeoff is
coverage breadth — council's three objectives deliberately spray wider — and
`--objectives` exists to layer that back on, at the recorded cost of waiving
attribution.

Expensive and slow on purpose: three full plan *generations*, not critiques, plus a
grounding pass when the brief is codebase-specific. **Never run it unrequested** — that
rule now lives only in this description and this line, because the
`disable-model-invocation: true` flag that used to enforce it was removed on 2026-08-14:
it hid the skill from the model so completely that asking for "a quorum" in prose reached
`council` instead. There is **no companion `commands/` file** — a skill plus a same-named
command double-registers in the picker.

## Not the other three "3 things" skills

| Skill | Artifact | Independence axis | Mode |
| --- | --- | --- | --- |
| **`quorum`** (this) | A brief that needs a plan | 3 different labs, identical prompt | Generate |
| `triad` | A code diff | 3 different labs, different lanes | Review |
| `newdle-triple-check` | An existing plan/doc/spec | Same provider, 3 lenses | Critique |
| `council` | An open-ended decision | Same provider, 3 objectives | Generate |

A diff goes to `triad`. A plan you've already drafted and want critiqued goes to
`newdle-triple-check` (or is withheld here via `--draft` for the stronger blind
cross-check). A bounded either/or between named options goes to **none of these** — do a
direct primary-source comparison instead.

## Setup

Same three CLIs as `triad` — `claude`, `codex`, and `kimi` — including kimi's
off-PATH install at `~/.kimi-code/bin` and its `kimi login` / `kimi provider list`
prerequisite. See `triad/SKILL.md` § "Setup" for the full install and auth notes;
the script's preflight checks all of it before staging anything and names exactly what's
missing. No leg pins a dated model ID (leg A uses the rolling `--model opus` alias; B
passes `-m gpt-6-sol` by default since 2026-10-12 — Jo's rule, MIGRATION.md item 110: a
review that routes to OpenAI runs on gpt-6-sol, never gpt-6-astra, until the review-cost
framework workload lands or Jo says otherwise; C uses its CLI's configured default), and
legs A and B pin explicit high reasoning effort — that pin is load-bearing, not tuning (see
the config comments in `scripts/quorum-fanout.sh`).

Legs B and C also cannot initialize inside the Claude Code Bash sandbox, and leg A succeeds
regardless, so the run looks like a partial-provider failure rather than an environment one.
Run the fan-out with the sandbox disabled from the start; see `triad/SKILL.md` § "Legs B and
C cannot initialize inside the Claude Code Bash sandbox" for the error strings, why auth is
not the cause, and the durable `/sandbox` fix.

Leg B runs under codex's read-only permissions profile with the network enabled, so it is
still fenced out of writing to disk but its egress is unrestricted — see `triad/SKILL.md`
§ "What leg B's sandbox still guarantees, and what it no longer does" for the measurements
and the trade that was accepted.

## Flow

### Step 0 — Cost gate (advisory, not a block)

Three full plan generations plus synthesis, plus a grounding pass if the brief is
codebase-specific — the most expensive skill in the store. Before running: state the
estimate and the brief's size, and if the decision is reversible or a primary-source
check would settle it, say so and suggest that instead. On explicit invocation the
user's call wins — this is a heads-up, not an override, and `--force` skips it
entirely. The only hard stop at this stage is a brief that is empty or unreadable.

### Step 1 — Resolve the brief

Files or a directory pass straight through to the script. Inline prose gets written to
a scratchpad file first (the script takes paths, not prose). If the user has a draft
plan already, it rides `--draft` — **withheld from all three legs**, held back for the
Step 4 cross-check. Independence is the entire product; showing the legs your draft
destroys it.

### Step G — Grounding pass (the only hard gate)

For a codebase-specific brief, an ungrounded plan is a shape, not a plan. The fix is
never to grant repo access to one leg — it is to ground all three identically:

1. **Ask, don't auto-detect:** is this brief about this codebase? A product, process,
   or org plan needs no repo and the pass would only add noise — skip to Step 2.
2. If yes, spawn **one** Claude agent (Agent tool) with `prompts/ground.md`, the brief,
   and the byte cap (`QUORUM_CONTEXT_MAX_BYTES`, default 131072). It reads the relevant
   repos and writes the pack — real paths, hard constraints, cross-repo seams, current
   state, receipts on every fact — to a scratchpad file. The output-types contract reaches it through the
   system prompt (P-11 row 2), so the prompt need not restate it.
3. **Gate: show the user the pack's path and byte size, and wait for approval before
   any leg spawns.** It is the one input every leg shares, so a bad pack wastes the
   entire run — and it is a single point of bias: a Claude blind spot here propagates
   to all three legs and then *looks like convergence*. The user inspects, edits, or
   adds to it; only then does the approved path go to the script as `--context <path>`
   (the script copies it into the run dir as `context.md` and records its size and
   hash in the manifest). This is the only hard gate in the flow; everything else is
   advisory.

Overrides: `--context <path>` supplies a hand-written pack and skips the agent (the
gate still applies — show it and wait). `--no-context` forces the pass off. And
`--repo-context all` is the escape hatch for briefs whose relevant surface isn't known
in advance: all three legs get live repo access instead of a pack — still symmetric, so
attribution survives, but 3x the exploration cost and **non-reproducible**, since each
leg surfaces different facts and a re-run silently changes the input. There is
deliberately no per-leg variant; the script rejects anything but `all`.

The grounding agent runs skill-side precisely so the script has no Agent-tool
dependency and the approval gate sits where a human is already looking.

### Step 2 — Fan out

```
scripts/quorum-fanout.sh <brief...> [--context <pack>] [--draft <plan>] [flags]
```

Three legs in parallel, per-leg timeout (`QUORUM_TIMEOUT`, default 900s — higher than
triad's 600 because generation is slower than review), each in its own scratch dir
holding `brief.md` (+ `context.md`) and nothing else. Each writes `<leg>-plan.md`,
`.log`, `.status` into the run dir under `QUORUM_OUT_ROOT` (default
`${TMPDIR:-/tmp}/quorum` — outside any repo, because briefs and model output can
be sensitive). Partial failure is survivable: a preflight-skipped or dead leg is
recorded in the manifest, and a 2/3 run is a valid run with a caveat, not a failure.

Legs A and B return schema-validated JSON (`prompts/plan.schema.json` — claude takes
the schema inline, codex takes it as a path; not interchangeable). Leg C has no
structured-output flag: it is asked for the same JSON object and parsed leniently.
Never gate the run on all-three-structured.

### Step 3 — Cross-refutation (opt-in, `--refute`)

Each surviving leg is handed the *other* plans — never its own, never told which model
produced which (anonymized as `PLAN 1`/`PLAN 2`) — and asked to attack them: false
assumptions, omissions, break points (`prompts/refute-plan.md`). Off by default.

The machinery is proven. `triad`'s finding-level verify stage — the same refute pattern,
same no-cross-visibility rule — ran against real output on 2026-08-06: 8 candidate
findings, three independent refute agents each, 24 verdicts every one carrying a
`file:line`, a DB constraint, or a vendor doc fetched during the run; four findings
survived 3/3 and four were killed 3/3, and the kills clustered on the cold-read leg
exactly as designed. Receipt: newdle-claude-plugins
`.ai/decision-log/2026-08-06--1224--jo-wolff--triad-verify-and-wrap-up-handoff.md`.

The **grain** is validated too — attacking whole plans rather than discrete findings holds
up. A full six-leg run on 2026-08-13 (brief `quorum-brief-20260813-164448`, a production
performance-planning brief for newdle-web, shared pack at 76,881 B) completed every leg:
`a-plan ok 363s`, `a-refute ok 369s`, `b-plan ok 155s`, `b-refute ok 95s`, `c-plan ok 666s`,
`c-refute ok 749s`. The refutations were specific and receipted rather than generic — they
caught self-contradictions (a plan that deleted a marker from `index.html` and then required
routes serving that document to be byte-identical), unsatisfiable gate orderings (a step
gated on a measurement obtainable only by taking the step), an acceptance band that passed by
construction against a known regression, and a design whose control condition the plan had
already deleted. Two refuters independently surfaced an assumption about a response shape
that two of the three plans had leaned on without examining — turning a load-bearing guess
into a one-minute primary-source check, which cleared it. That is the stage working: its
value is forcing an unchecked assumption into the open, not being right about the defect.
One refuter attacked an assumption shared by *both* other plans, using a pack receipt those
two had read and not applied.

Triad's diagnostic still carries over as the health check — a run that refutes nothing means
the prompt is too polite, a run that refutes everything means the plan text probably is not
reaching the agent. Neither extreme is a result; both are a broken harness. The 08-13 run sat
in neither: no leg refuted nothing and no leg refuted everything.

One lesson from that triad run applies directly: **the stage tests claims, not remedies.**
A refutation that leaves a plan step standing says the step's reasoning survived attack, not
that the step will work.

### Step 4 — Synthesize

Skill-level, not script-level: the script returns a run directory; you read the legs
and produce the map. **Provider labels stay attached throughout — never anonymize,
never shuffle.** That Codex and Kimi independently landed on the same migration order
*is* the signal; stripping the label destroys it.

Buckets, in order:

1. **Converged across labs** — 2+ providers independently proposed the same step,
   ordering, constraint, or risk. The strongest signal any skill in this store
   produces: the shared-model confound is gone by construction, which is also why
   there is **no "corroborated but probably a shared-model artifact" quarantine
   bucket** here — removing that confound is most of the point of this skill. Note
   explicitly when two labs arrived by visibly different reasoning. **Caveat when
   Step G ran:** convergence on something the pack stated outright is the legs
   agreeing with their shared input, not with each other — check bucket-1 items
   against `context.md` and demote anything the pack handed them.
2. **Divergent — the real decision points.** Where the plans genuinely conflict, what
   drives each choice, and why it's a tradeoff rather than one lab being wrong. Hand
   these to the user. Do not resolve them.
3. **Unique and load-bearing** — raised by exactly one lab, but consequential. Do not
   soften these for lack of corroboration.
4. **Vs. the withheld draft**, if one was supplied: where the blind plans corroborated
   a branch of it (strong), and where all three went somewhere it doesn't (a real
   gap). A primary output, not an appendix.

If `--refute` ran, fold each surviving attack under the plan item it targets, with the
attacking provider named. If `--objectives` ran, say so at the top of the map: the
attribution guarantee was waived for this run, and bucket 1 is council-strength
evidence, not quorum-strength.

### Step 5 — Hand back

Present the map in chat with the run directory path. **Never declare a winner.** Do
not auto-write anywhere: offer to persist only on explicit confirmation and only after
the user names a filename. Docs only — no source changes, no git.

## Flags and env

| Flag | Default | Effect |
| --- | --- | --- |
| `--draft <path>` | none | Withhold this draft from the legs; cross-check it in Step 4 |
| `--context <path>` | none | Hand-written grounding pack; skips the Step G agent (gate still applies) |
| `--no-context` | off | Skill-level: force Step G off for a codebase-specific brief |
| `--repo-context all` | off | All three legs get live repo access instead of a pack — symmetric, 3x cost, non-reproducible |
| `--refute` | off | Run Step 3 cross-refutation |
| `--objectives` | off | Layer council's three framings per leg; waives clean attribution (recorded in the manifest) |
| `--only a,b` / `--skip c` | all | Run a subset of legs |
| `--force` | — | Skill-level: skip the Step 0 advisory |

`--no-context` and `--force` are consumed by this skill, not the script — the script's
Step G involvement is only the `--context` path it receives, and its only hard stop is
an empty brief.

Env: `QUORUM_{A,B,C}_CMD`, `QUORUM_{A,B}_SCHEMA`, `QUORUM_{A,B}_REFUTE_SCHEMA`,
`QUORUM_TIMEOUT`, `QUORUM_OUT_ROOT`, `QUORUM_CONTEXT_MAX_BYTES`. The manifest records
the grounding mode and the pack's byte size and hash, so a reader can always tell why a
run's plans were concrete or abstract without re-deriving it.

## Anti-patterns

| Anti-pattern | Problem | Fix |
| --- | --- | --- |
| Different prompts per leg | Divergence stops being attributable to the model | Identical prompt always; `--objectives` only with the waiver recorded |
| Repo access for one leg | A unique finding could mean "this model caught it" or "only this leg was shown it" — contaminates every bucket | Shared pack, or `--repo-context all` |
| Showing the legs your draft | The blind cross-check is the product | `--draft` withholds it by construction |
| Skipping the pack gate | A bad pack wastes the whole run and its bias masquerades as convergence | Show path + size, wait for approval |
| Treating pack-stated convergence as lab agreement | The legs agreed with their input, not each other | Check bucket 1 against `context.md`, demote |
| Declaring a winner | The output is a decision map for the user, not a verdict | Present converged/divergent/unique/vs-draft and stop |

## Verification

Before returning: the manifest's grounding mode, leg statuses, and cmds are quoted
rather than re-derived; every bucket-1 item was checked against `context.md` when a
pack ran; provider labels are attached to every point in the map; any dead or skipped
leg is named, not silently absent; divergences are handed over unresolved; the run
directory path appears once; nothing was written to disk without an explicit ask and a
user-named filename.

## Bundled resources

- `scripts/quorum-fanout.sh` — brief staging, symmetric isolation, parallel fan-out,
  timeouts, preflight, opt-in cross-refutation, manifest. Leg-runner machinery
  (run_leg, resolve_cli, timeout preflight) is shared with `triad` via the plugin's
  `lib/leg-runner.sh`, extracted 2026-08-14 once this skill had a validated run.
- `prompts/ground.md` — the Step G grounding agent (skill-spawned, script-free)
- `prompts/plan.md` — the one identical leg prompt (JSON per `plan.schema.json`)
- `prompts/plan.schema.json` — leg A inline via `--json-schema`, leg B as a path via
  `--output-schema`, leg C unenforced
- `prompts/refute-plan.md` — Step 3 cross-refutation (opt-in)
- `prompts/refute-plan.schema.json` — the refutation contract, same per-CLI delivery
