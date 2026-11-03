---
name: triad
description: Cross-provider code review for Newdle — fans a diff out to three independently-trained models from three different labs (Claude for architecture/blast-radius, Codex/GPT for spec correctness, native Kimi Code for a cold read), each isolated in a different information environment, then synthesizes their findings into one agreement-ranked report in the house newdle-* format. Reviews a code diff specifically — for cross-model takes on a non-code artifact (a plan, doc, or spec) use newdle-triple-check instead, and for an open-ended decision with no code and no diff yet use council. Use when the user asks for a triad review, cross-model review, cross-provider review, multi-lab review, second opinion, or "have other models look at this", and proactively before landing a change that touches shared surface area — API contracts, design tokens, shared components, SSR/meta injection, or anything consumed by more than one repo. Do NOT use for routine single-file diffs; it is expensive and slow by design. REQUIRES all three CLIs installed and authenticated — `claude`, `codex` (https://github.com/openai/codex), and `kimi` (https://code.kimi.com) — and refuses to run if any is missing; there is no reduced-leg mode, because a cross-provider review with one provider is not one.
argument-hint: "[base-ref] [--ticket path/to/ticket.md] [--multi [--only r1,r2] [--skip r1,r2]]"
---

# triad — Cross-Provider Review

From an as2 lane this mode runs as a panel (`triad`, then `triad-verify`), never through `scripts/`: see [`../panel/panel.md`](../panel/panel.md).

## Overview

Single-model review has correlated blind spots. Claude reviewing Claude's code is the same
weights grading their own homework — subagents change the role, not the priors. This skill
fans one diff out to three models from three different labs, each in a deliberately
different information environment, then merges their findings into a single ranked list
where **cross-provider agreement is the primary signal**.

Expensive and slow on purpose. Gate it. The output is a short list you act on, not three
reports you skim.

## Not the other two "3 things" skills

Three skills in this plugin run a triad of agents; they solve different problems and this
is the only one that is cross-provider and code-specific:

| Skill | Reviews | Providers | Use for |
| --- | --- | --- | --- |
| **`triad`** (this) | A code diff | 3 different labs (Claude, GPT, Kimi) | Cross-lab review before landing a risky code change |
| `newdle-triple-check` | An existing non-code artifact (plan, doc, spec) | Same provider, 3 lenses | Catching blind spots in something already drafted |
| `council` | An open-ended decision, no artifact yet | Same provider, 3 objectives | Choosing between options that don't exist as a diff |

If what you have is a diff, this skill. If it's a doc, `newdle-triple-check`. If it's a
decision with nothing written yet, `council`.

## Where this sits in the workflow

Pre-landing, not post-deploy — the counterpart to `canary`, which watches production
*after* a deploy. This runs *before* a merge, the same slot `newdle-land-and-deploy`'s
pre-merge gate occupies: get the triad report, resolve or consciously accept its findings,
then hand off to `newdle-land-and-deploy` to merge, deploy, and have `canary` verify
prod. It does not call either of those skills itself — it's a manual step you run before
you ask for the land.

**The report never leaves your machine, by design.** No PR comments, no review
submissions, no `gh` calls, no posting anywhere — this is a design constraint, not a gap
waiting to be wired up. The report is a local artifact you read; findings reach a PR only
as code changes you decide to make in response, through the normal commit/push workflow.
This is also why the skill works with no PR at all — it reviews a local branch before
anything is pushed or shown to anyone.

## Setup — three CLIs, one of them a real prerequisite

All three legs shell out to a CLI already on your machine or in `PATH`. Leg B also has a
best-effort dependency on the `mcp__linear__*` tools (for automatic ticket resolution — see
"Collect the ticket" in Process) — nothing fails if Linear is unavailable or the tools
aren't connected, leg B just falls back to asking for a ticket or gets dropped:

- **Leg A — `claude`.** Already installed if you're reading this inside Claude Code.
- **Leg B — `codex`.** [github.com/openai/codex](https://github.com/openai/codex). Needs its
  own auth; `codex exec --help` should work if it's set up.
- **Leg C — `kimi` (Kimi Code CLI).** This is the one most teammates won't already have.
  Install: `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash` (macOS/Linux —
  fetched from [moonshotai.github.io/kimi-code](https://moonshotai.github.io/kimi-code/),
  2026-08-03). It's a single-binary install that lands in `~/.kimi-code/bin`, which is
  **not on `PATH` in a non-login shell** — verified 2026-08-03: it resolves in an
  interactive terminal but not from a plain `bash -c`. The script's preflight checks the
  known install path as a fallback, but if you're running `kimi` yourself outside the
  script, add `~/.kimi-code/bin` to `PATH` or the CLI won't resolve. After install, run
  `kimi login` (device-code flow) and confirm with `kimi doctor` / `kimi provider list`.

The script's preflight checks all three are present (and that leg C's provider is actually
configured) before staging anything, and names exactly what's missing rather than failing
mid-fan-out.

**Leg C's design intent stands even though the CLI is a full agent, not a bare completion
endpoint.** Kimi Code has filesystem tools. To keep leg C starved of repo context, the
script runs it in its own empty scratch directory — not the same directory the diff or
sandbox files live in — and hands it the diff as the prompt argument rather than a file on
disk, so there's nothing local worth finding. This has been verified to hold for the
default behavior (an agent given nothing to look at looks at nothing), but **not proven
airtight against a determined instruction to traverse outside its working directory** — the
prompt (`cold-read.md`) never asks it to, and it isn't given a reason to, but that's a
behavioral argument, not a filesystem guarantee the way leg B's read-only permissions
profile is. If that gap matters for your threat model, don't rely on this skill for
isolation you can't otherwise get.

### What leg B's sandbox still guarantees, and what it no longer does

Leg B used to run under `codex exec --sandbox read-only`. That flag denied DNS to every
shell command codex spawned, while codex's own model calls kept working — so a leg that
tried to fetch a URL died with `curl: (6) Could not resolve host` and the leg reviewed the
diff blind instead. It now runs under a permissions profile
(`permissions.netro.extends=":read-only"` plus `network.enabled=true`, selected with
`default_permissions="netro"`), which changes the two halves of the fence differently:

- **The filesystem guarantee survives.** `extends=":read-only"` keeps the read-only fence.
  Measured 2026-08-14 on codex-cli 0.147.0: `touch` was denied with "Operation not
  permitted" in the working directory, and the parent's own run reproduced the same denial
  in `/tmp` and `$HOME`.
- **The network restriction does not survive, and egress is unrestricted.** With the
  network on, a `network.domains` allowlist naming only `example.com` did not stop
  `api.github.com` from returning 200, and a deny rule had no effect (measured 2026-08-14).
  So leg B can reach anything it can resolve, and the diff it holds could in principle
  leave the machine.

That trade was accepted deliberately: without it the leg cannot fetch anything at all.
Treat leg B as read-only on disk and unconstrained on the wire, and don't hand it a diff
you would not be willing to have leave the machine.

The correctness signal is codex's own banner, printed on stderr into `b-correctness.log`:
it must read `sandbox: read-only (network access enabled)`. Plain `sandbox: read-only`
means the profile is not in effect and the leg has no network. `triad-fanout.sh` asserts
that line for any codex leg and fails the leg loudly rather than letting it pass green.
Re-adding `--sandbox read-only` alongside the profile overrides it and silently kills the
network again — the flag has to stay off the command line.

### Legs B and C cannot initialize inside the Claude Code Bash sandbox

**Run the fan-out with the sandbox disabled from the start.** Measured 2026-08-12: in a
sandboxed run, leg B died in 3 seconds (`rc=1`) and leg C in 1 second (`rc=1`), while leg A
completed normally at `ok 381s`. Re-running the identical command with the sandbox disabled
succeeded on both: `b-plan ok 234s`, `c-plan ok 472s`. Discovering this leg by leg costs a
full leg A run each time.

The two log lines, verbatim, so the failure is recognizable on sight:

```
Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)
EPERM: operation not permitted, mkdir '/Users/jowolff/.kimi-code/sessions/wd_c_70f36ca0d3c9'
```

The first is leg B (`codex`), the second leg C (`kimi`). Both are filesystem permission
denial from the sandbox, not network failure.

**Leg A succeeds regardless, which is what makes this look like a partial-provider failure
rather than an environment one.** A 1-of-3 result reads as a broken teammate install or a
provider outage, and can get reported as a quorum. The script's own preflight cannot catch
it either: both CLIs are present and configured, and they only fail once they try to write.

**Auth is not the cause.** At the time of the measurement `codex login status` reported
logged in, `kimi provider list` returned the `moonshot-ai` provider with 4 models, and
`kimi doctor` reported all config files valid. Re-checking those three commands after a
sandboxed failure will tell you nothing; they pass.

**The durable fix is the engineer's, via `/sandbox`** — granting write access to the paths
these CLIs need. One concrete path is known: kimi writes session directories under
`/Users/jowolff/.kimi-code` on the machine this was measured on, `~/.kimi-code` generally.
Codex's requirement was not pinned down beyond its error string, so treat the
sandbox-disabled run as the working path until someone traces what it wants to write.

## Model IDs and CLI flags — the part that turns over

None of the three legs pins a specific dated model ID as of this version:

- **Leg A** keeps `--model opus`, which `claude --help` documents as a rolling alias
  (verified 2026-08-03) — not a fixed model string, so it doesn't rot the way a dated ID
  would, and it's load-bearing: the design wants Opus-class reasoning specifically.
- **Leg C omits `--model`** and leans on kimi's own configured default
  (`~/.kimi-code/config.toml`'s `default_model =`) instead of a hardcoded ID. **Leg B
  passes `-m gpt-6-sol`** by default since 2026-10-12 (Jo's rule, MIGRATION.md item 110: a
  review that routes to OpenAI runs on gpt-6-sol, never gpt-6-astra, until the review-cost
  framework workload lands or Jo says otherwise); before that it also omitted `--model` and
  took `~/.codex/config.toml`'s `model =`. The very first draft of this script had leg B pinned to
  `gpt-5.6-codex`, which matched nothing in a real `~/.codex/config.toml` on the machine
  this was built on (verified 2026-08-03: the configured model was `gpt-5.6-terra`) — it
  looks like an invented string. Relying on each operator's own configured default avoids
  that failure mode entirely, at the cost of leg C's exact model (and leg B's, once Jo's
  rule ends) varying by machine.
  Pin one explicitly via `TRIAD_B_CMD` / `TRIAD_C_CMD` if you want a fixed identity for a
  given run.

Verify all of this against current CLI `--help` output before relying on it — flags and
defaults move.

## Structured output — legs A and B (documented asymmetry)

Legs A and B both return schema-validated JSON. Their flags are not interchangeable:

- **Leg B** — `codex exec --output-schema prompts/correctness.schema.json`, a **file path**
  (verified 2026-08-03: `codex exec --help` lists `--output-schema <FILE>`, "Path to a JSON
  Schema file describing the model's final response shape").
- **Leg A** — `claude --json-schema`, which takes the schema **inline**, not as a path
  (verified 2026-08-04 by live call: passing `prompts/architecture.schema.json` as a path
  errors `--json-schema is not valid JSON`, while the same file's contents passed inline
  return a conforming object). `run_leg` reads `TRIAD_A_SCHEMA` and expands the contents as
  a single quoted argument, because the leg command strings are word-split at their call
  sites and inline JSON contains spaces. Set `TRIAD_A_SCHEMA=` empty to restore leg A's old
  markdown output.

Both schemas share the same finding shape apart from one field: leg B carries `spec` (the
ticket line violated), leg A carries `evidence` (the consumer or logged decision checked).
Neither has the other's, and that is deliberate — it is what keeps the legs in their lanes.

**Leg C still returns markdown.** `kimi --help` shows no equivalent flag (checked
2026-08-03). So expect two JSON objects and one markdown block; do not write a synthesizer
that assumes a uniform shape across all three.

## Output location and the `.triad/` question

`TRIAD_OUT_ROOT` defaults to `${TMPDIR:-/tmp}/triad`, **outside the repo under
review**. `diff.patch` and every leg's raw output land there, and a diff can contain
sensitive code — an in-repo default risked a stray `git add .` or an untracked `.triad/`
directory getting swept into a commit. No gitignore entry is needed for the default; it
never touches the repo's working tree.

If you override `TRIAD_OUT_ROOT` to a relative path (it resolves against the repo root,
matching the original in-repo behavior), that path needs a `.gitignore` entry in *that*
repo — this skill runs against arbitrary target repos, so it can't safely add that entry
for you. Add it yourself before the first run with an in-repo override.

## Leg B silent empty results — root cause and fix (2026-08-03)

The second real run (newdle-web, 1026 lines / 18 files, ticket supplied) had leg B return
`{"status":"no_findings","findings":[]}` in 30 seconds while legs A and C, on the same
diff, took 318s and 435s and found 6 and 11 issues respectively. A 30-second clean bill of
health on a thousand-line diff is not plausible on its face, and it turned out not to be
one.

**The diff-reading hypothesis was wrong.** The obvious suspicion — that `codex exec`'s
sandbox dir tells the model `diff.patch` is on disk but the model never actually reads it
— was checked directly against `b-correctness.log` from that run and falsified: the log
shows four separate `rg`/`sed` tool calls, each one succeeding, that between them paged
through the entire `diff.patch` and `ticket.md`. Leg B had the full diff in context when it
answered `no_findings`.

**The actual cause: reasoning effort.** The `codex exec` log line for that run reads
`reasoning effort: low`, matching `~/.codex/config.toml`'s `model_reasoning_effort = "low"`
default — a setting `TRIAD_B_CMD` never overrode. Verified live, same session: re-running
the exact sandbox dir and prompt from that run with `-c model_reasoning_effort=high` added
returned 3 real, well-specified high-severity findings (a byline edit bypassing the
post-publish gate, a navigation guard with a timing hole, an unawaited `flush()` racing the
Update call) instead of an empty array. A small planted-bug test (a `[0]` on a possibly-empty
filtered array, spec says return `null`) was caught correctly even at the low default,
confirming the failure is specifically about being asked to do a careful line-by-line pass
across a large diff, not an inability to reason about correctness at all.

Leg A was checked for the same latent problem and doesn't show it: `claude`'s default effort
comes from the operator's own `~/.claude/settings.json` (`"effortLevel"`, commonly `medium`
per Claude Code's own default), not `low`, which is consistent with leg A finding a correct
critical issue in both real runs. Because that default lives in a per-operator global
setting rather than anything this script controls, `TRIAD_A_CMD` now pins `--effort high`
explicitly too, rather than depending on whatever effort level happens to be configured on
the machine running it.

**Fix, both legs, in `triad-fanout.sh`:** `TRIAD_A_CMD` gained `--effort high`;
`TRIAD_B_CMD` gained `-c model_reasoning_effort=high`. Neither is a fixed model ID, so
neither rots the way a dated string would — they're config overrides.

## The diff-size gate and `careful`

`TRIAD_MIN_LINES` (default 50) is the knob for exactly this and is already env-overridable
— confirmed by reading the script's `: "${TRIAD_MIN_LINES:=50}"` default-assignment and
running it with an override. **There is no wiring today between `careful` and this
gate.** The "When to Use" list below already half-asserts a relationship ("`careful`
is active and the change is non-trivial"), but nothing currently lowers the threshold when
careful mode is on — that line describes an intent this script doesn't yet implement.

Proposed connection, for Jo to decide on: `careful`'s guardrail state could export
something like `NEWDLE_CAREFUL_ACTIVE=1` (or the invoking skill could just pass
`TRIAD_MIN_LINES=15` — or whatever threshold — when careful mode is active) before calling
`triad-fanout.sh`. That requires either careful-mode to actively lower the env var when it
invokes triad, or the *user's own* invocation to set it when they know both are in play —
either way it's a change to how the two skills are invoked together, not to this script,
and not to `careful` itself (out of scope for this change, and not something to fold
in without Jo's say-so given it changes another skill's behavior).

## Multi-repo review — `--multi` (implemented 2026-08-03)

A real change in this workspace routinely spans newdle-db, newdle-api, newdle-web, and
kitchen — four separate git repos — and the most interesting finding in either real run so
far (run 2's leg A: web would deploy a contract that only exists on unmerged `newdle-api`
and `newdle-db` branches) was only catchable because leg A could see across that boundary.
Single-repo mode reviews exactly one repo (`git rev-parse --show-toplevel`) and is
unchanged; `--multi` is purely additive on top of it.

```
./triad-fanout.sh --multi [base-ref] [--only r1,r2] [--skip r1,r2] [--ticket ...]
```

**Discovery — no branch-name matching.** `--multi` walks every git repo one level under
the shipyard root's `repos/` directory and includes each repo whose merge-base diff
against **that repo's own `origin/main`** is non-empty (or against `base-ref`, resolved
per repo, if one is given). A shared branch-name convention is deliberately not assumed:
the change this was built against spanned `jo/writings-staged-edits` in newdle-db,
newdle-api, and kitchen but `jo/update-button` in newdle-web, because that branch already
existed from unrelated work. Any uniform-name scheme breaks the first time work joins a
branch already in flight; "differs from its own origin/main" is the invariant that holds.
The shipyard root is found by walking up from the invocation cwd to the nearest directory
whose `repos/` contains git repos (override: `TRIAD_SHIPYARD_ROOT`), so the script works
from inside any child repo and hardcodes no personal paths.

**Selection and visibility.** `--only`/`--skip` take comma-separated repo directory
names. Included repos print with their line counts (and per-repo excluded-line counts)
*before* the gate and before any leg spawns, so the operator sees the scope before money
is spent. Repos skipped for having no diff, or an unresolvable base ref, are named rather
than silently absent. The gate sums changed lines across included repos and compares the
total against `TRIAD_MIN_LINES` once; excludes apply per repo exactly as in single-repo
mode.

**One concatenated patch for legs B and C.** Each repo's diff is generated with
`--src-prefix=a/<repo>/ --dst-prefix=b/<repo>/`, so the repo name is baked into every
path inside the patch itself (verified 2026-08-03 against a real newdle-api diff:
`diff --git a/newdle-api/src/... b/newdle-api/src/...`) — a finding cites
`newdle-api/src/routes/writings.ts:558`, never a bare path that could be any of four
repos. A `### repo: <name> (vs <base>, merge-base <sha>, head <sha> — N lines / M files)`
header precedes each repo's section as a courtesy on top of the prefix mechanism, not
instead of it.

**Leg A runs at the shipyard root** with a run-generated preamble
(`$OUT/architecture-multi.md`) listing each included repo and the exact per-repo diff
command, because the stock prompt's "review `git diff main...HEAD`" is wrong at the root.
This is consistency, not new capability — see above: leg A already walked to sibling
repos unaided in single-repo runs; the root cwd just makes its cited paths line up with
the `repos/<name>/` form. The shared `prompts/*.md` files are untouched; legs B and C
need no prompt change because the combined patch's prefixed paths and headers are
self-describing.

**Manifest records per repo**: name, base ref with merge-base sha, head sha, changed
lines, files, and excluded lines — plus which repos were *not* reviewed and why. A reader
can tell exactly what was and was not reviewed without re-deriving it.

**Known limits of `--multi` as shipped:**

- *Leg C prompt size.* The whole combined patch rides one argv value; the existing
  ARG_MAX guard (skip loudly at half of `getconf ARG_MAX`, ~512 KiB here) still applies
  and the four-repo test patch came to ~178 KiB, well inside it. If a monster change ever
  trips the guard, leg C is skipped with the reason in its status file and the manifest —
  never truncated. A per-repo split for leg C would be the follow-up if that starts
  happening in practice; the model's own context window is likely the binding constraint
  before ARG_MAX is.
- *One ticket for all repos.* `--ticket` still supplies a single spec to leg B. A
  cross-repo change usually has one intent, so this probably holds, but it is untested on
  a real multi-repo fan-out — watch leg B's findings on the first real run for signs it
  penalizes one repo for requirements another repo satisfies.

**Worktrees: evaluated on their own merits, not built because they were mentioned.** The one
concrete gap either real run exposed was that the old `git diff "$BASE...HEAD"` only covered
committed history — uncommitted working-tree changes were invisible (an operator mid-change
couldn't get a triad read without committing first). A worktree does not fix that; it
isolates a *second* checkout from the first, it doesn't make uncommitted changes visible to
a diff comparing two commits. The actual fix — diffing against the named merge base with no
second ref, which covers the working tree, staged and unstaged — is what the script now does
by default (`--committed-only` restores the old semantics). No worktree required.
**Conclusion: nothing evidenced by either run calls for adding worktree support.** If a
future need shows up — reviewing a hypothetical rebase or merge result without touching the
operator's actual branch, for instance — that would be a concrete, separate case to evaluate
then, not a speculative addition now.

**Net: both pieces landed — the working-tree merge-base diff as the default, and the
multi-repo fan-out once the base-ref-per-repo question resolved to "each repo vs its own
origin/main" (see `--multi` above), which needs no per-repo ref syntax and no naming
convention.**

## Excluding generated files

Both real runs so far needed a manual `--exclude` to get a usable diff: 70% of run 1's diff
(newdle-api) and 85% of run 2's diff (newdle-web) were a committed Drizzle ORM introspection
dump (`database/schema.ts`, `database/relations.ts`), not reviewable surface. Leg C in
particular reads the raw patch with no repo access at all — it has no way to tell "generated
output" from "code someone wrote," so an un-excluded schema dump is pure noise that costs
tokens and dilutes its findings.

`triad-fanout.sh` now excludes these by default via `TRIAD_DEFAULT_EXCLUDES` (two glob
patterns, `*database/schema.ts` and `*database/relations.ts`, verified against real
`git ls-files` output in newdle-web, newdle-api, and kitchen — matches the five known
generated paths with no false positive on `.cursor/rules/database.mdc` or the
`database/meta/*.json` snapshot files sitting next to them). This is visible, not silent:

- **Override the list:** `export TRIAD_DEFAULT_EXCLUDES="pattern1 pattern2 ..."` (space
  separated).
- **Disable it entirely:** `--no-default-excludes` — use this if the ORM schema file itself
  is what changed and you actually want it reviewed.
- **Add more on top:** `--exclude <pattern>` is repeatable and stacks with the defaults
  (lockfiles, snapshots, and anything else not evidenced by a real run are deliberately not
  in the default list — add them per-run with `--exclude` instead of asking for them to be
  hardcoded).
- **Every run states the reduction.** stderr prints `excluded N lines (raw → filtered) via:`
  with the default and explicit patterns listed separately, and the manifest's `excludes:`
  section records the same, including explicit "disabled" or "none configured" cases — a
  reader of the manifest should never have to guess whether the diff they're looking at was
  filtered.

## When to Use

- A triad / cross-model / cross-provider / multi-lab review or "second opinion" is
  requested, on a code diff
- Before landing changes to shared surface area: API contracts, design tokens, shared
  components, the Fastify SSR layer, anything vendored across repos from shipyard
- After a large agent-authored change where you didn't watch every step
- `careful` is active and the change is non-trivial (see the gate note above — this
  is currently a judgment call you make yourself with `--force` or an env override, not
  something the two skills coordinate on automatically)

**Do not use** for single-file diffs, dependency bumps, copy changes, or anything under
roughly 50 changed lines. The synthesis overhead exceeds the value and you'll train
yourself to ignore the output.

## Scope

Default to `git diff <base>...HEAD`, base defaulting to `main`. State the exact scope and
the three model IDs actually used at the top of the report — a triad report that doesn't
say which models ran is unauditable. (The manifest the script writes already records the
exact `TRIAD_A_CMD` / `TRIAD_B_CMD` / `TRIAD_C_CMD` used — quote it rather than re-deriving.)

**Security is out of scope.** `newdle-cso` owns that lane. If a leg returns a security
finding, pass it through to the FYI appendix with a note to run `newdle-cso`, but do not
adjudicate it here — two skills arguing about the same vuln in different formats is worse
than either alone.

## The three lanes

Isolation is enforced by the execution environment, not by prompt instructions. Each leg
physically cannot see what it isn't supposed to see (leg C's isolation caveat is above).

| Leg | Model | Environment | Lane |
| --- | --- | --- | --- |
| **A — architecture** | Claude (Opus-class) | repo root, full context: `AGENTS.md`, `.ai/` docs, decision log | Blast radius. What else breaks. What contradicts a logged decision. |
| **B — correctness** | Codex / GPT | sandbox dir: `diff.patch` + `ticket.md` only, no repo | Does this do what the ticket says. Edge cases, error paths, off-by-ones. |
| **C — cold read** | Kimi Code (native CLI) | own empty scratch dir, diff via prompt argument, no repo files | What's confusing. What assumes knowledge not in the code. |

Leg C starving is the load-bearing design choice. A and B inherit your framing; C is the
only one positioned to catch "this only makes sense if you already know the system."

## Process

1. **Gate.** Check diff size and surface area. If it's below the threshold or touches one
   leaf file, say so and stop. Don't run the fan-out to be agreeable.
2. **Collect the ticket.** Leg B is scored against intent, so it needs one. Resolution
   order — the first that succeeds wins, nothing later overrides it:
   1. **Explicit `--ticket <path>`, if the user gave one.** Always wins over
      auto-resolution; skip straight to the fan-out with it.
   2. **Auto-resolve from Linear.** Run `git branch --show-current` and search the branch
      name for an identifier shaped like `[A-Za-z]{2,}-[0-9]+` (letters, hyphen, digits —
      don't hardcode `ENG` or any specific team prefix; matched case-insensitively,
      anywhere in the name — e.g. `jo/eng-1479-transition-retunes-...` → `eng-1479`).
      If found, call `mcp__linear__get_issue` with it. If the call succeeds, write a
      ticket file (any scratch path, e.g. `mktemp`) with the returned `id` and `title` at
      the top followed by the `description`, and pass that path as `--ticket` to the
      script. **If no identifier is found in the branch name, the MCP call errors (e.g.
      the issue doesn't exist), or Linear is unreachable, fall back to the next step
      instead of aborting** — a Linear outage costs this leg, not the whole run.
   3. **No ticket resolved.** Ask for a one-paragraph statement of what the change is
      supposed to do. Without one, drop leg B rather than letting it invent the spec —
      `correctness.md` is explicit that a spec reconstructed from the implementation
      cannot disagree with the implementation.

   Record which of the three happened; the report's `**Ticket:**` line (below) must say
   so by name, not just that leg B ran or didn't.
3. **Fan out.** Run `scripts/triad-fanout.sh <base-ref>`. Legs run in parallel with
   per-leg timeouts. Partial failure is survivable — two legs still produce a usable
   report. Note any leg that failed, timed out, or was preflight-skipped in the summary
   line.
4. **Read the three outputs cold.** Do not review the diff yourself first. If you form
   your own findings before reading theirs, you'll anchor and start defending your list.
   You are the synthesizer, not a fourth reviewer.
5. **Parse legs A and B as JSON, leg C as markdown.** They are not the same shape (see
   "Structured output" above) — don't expect to diff them line-for-line. A leg whose JSON
   fails to parse is a failed leg: say so in the `**Legs:**` line rather than salvaging
   prose out of it.
6. **Cluster by defect, not by wording.** Two legs describing the same bug in different
   vocabulary is agreement — count it. Two legs flagging the same *line* for different
   reasons is not.
7. **Rank by agreement, then severity.** 3/3 outranks a 1/3 Critical. A single-leg finding
   is a hypothesis until you verify it against the actual code — verify, or demote to FYI.
8. **Drop taste.** Anything that's a style preference, a naming opinion, or a "consider
   extracting this" with no defect behind it gets cut. You will cut roughly half.
9. **Verify, if asked.** Off by default. See "Verify stage" below — run it when the user
   asks for it, or before landing anything on a critical-infrastructure repo.
10. **Write the report** in the house newdle-* severity format below.

## Verify stage (opt-in)

Cross-provider agreement is a proxy for truth, not a test of it. Three models can agree on
a finding and all three be wrong about what the code does — and agreement is exactly what
makes such a finding *look* safest. The verify stage replaces the proxy with a test.

**Cost.** Three agents per surviving finding. Ten findings is thirty agents. This is why it
is opt-in; run it when landing the change is expensive to get wrong, not routinely.

**How to run it.** After step 8, for each surviving finding, dispatch **three independent
`Task` agents in parallel**, each with:

- `prompts/refute.md`, with that one finding substituted into "The finding" section.
- `prompts/refute.schema.json` as the response contract.
- The repo and `diff.patch`. Nothing else.

Three rules that make the difference between a real test and theater:

- **One finding per agent.** An agent judging a list of findings starts grading on a curve —
  it will kill the weakest to look discerning and spare the rest.
- **No cross-visibility.** Never tell a refute agent how many legs raised the finding, what
  the other legs said, or how another refute agent voted. Agreement is the thing being
  tested; leaking it contaminates the test.
- **Never tell them it's your finding.** An agent that believes it is checking the
  dispatcher's own work argues for it.

**Scoring.** Majority of three. Two or more `refuted: true` kills the finding. Discard any
verdict whose `basis` names no `file:line`, guard, or logged decision — an unreceipted
verdict is not a vote. If that leaves fewer than two usable verdicts, the finding is
unverified, not confirmed: report it under FYI / verify.

**What to do with the result.** Killed findings go in a "Refuted" section — do not delete
them silently, because a finding three models raised and three agents killed is the single
most useful line in the report for whoever reviews this diff next. Survivors get a
`**Verified:**` line carrying the winning `repro`.

**Expect this to feel wrong at first.** If a run refutes nothing, the prompt is being too
polite and needs to get more hostile — agents with repo access rationalize findings rather
than kill them. If it refutes everything, check whether the finding text is reaching the
agents intact; a truncated or context-free finding is trivially "unestablishable" and every
agent will correctly default to refuted.

## Output format

```
## triad — <scope> — <date>
**Legs:** A <model-id> ok | B <model-id> ok | C <model-id> timeout
**Ticket:** auto-resolved from Linear (<IDENTIFIER>) | manually supplied (<path>) | none — leg B dropped
**Summary:** N findings — <c> critical, <h> high, <m> medium, <l> low  ·  <x> unanimous, <y> split
**Verify:** not run | 3 agents per finding — <k> refuted, <s> survived

### [HIGH] <short title>  ·  3/3  ·  survived 3/3
- **Where:** <file:line>
- **What:** <the defect, in your words, not theirs>
- **Legs:** A, B, C — <one line on where they differed, if they did>
- **Verified:** <the winning repro: input, sequence, wrong outcome>
- **Fix:** <specific, minimal change>

### [MEDIUM] <short title>  ·  1/3 (leg C)
- **Where:** <file:line>
- **What:** <defect>
- **Verified:** <what you checked in the code to promote this from a single-leg claim>
- **Fix:** <change>

## Refuted
- <finding>  ·  raised <n>/3, killed <k>/3 — <the ground and its receipt>

## Disagreements worth your attention
- <where legs actively contradicted each other, and which one the code supports>

## FYI / verify
- <single-leg, unverified, one line each>
- <security items → run newdle-cso>
```

The `n/3` agreement count is required on every finding. It's the whole point of the skill.

Drop the `**Verify:**` line, the `survived k/3` suffix, and the `## Refuted` section
entirely when the verify stage didn't run. An empty "Refuted" heading reads as "nothing was
refuted", which is a different and much stronger claim than "nothing was tested".

## Anti-Patterns

| Anti-Pattern | Problem | Fix |
| --- | --- | --- |
| Concatenating the three reports | That's a pile, not a review. Reader does the merge work. | Cluster by defect, one entry per defect |
| Reviewing the diff yourself first | You anchor, then defend your own list against theirs | Read the leg outputs before the code |
| Giving every leg full repo context | Three context-rich agents inherit the same framing — you paid 3x for correlated output | Enforce isolation in the script, not the prompt |
| Passing single-leg findings through unverified | One model's hallucination arrives wearing a severity badge | Verify against code or demote to FYI |
| Running it on every branch | Cost and latency train you to skim it | Gate on surface area and diff size |
| Adjudicating security findings here | Duplicates and contradicts `newdle-cso` | Pass through to FYI, defer |
| Treating leg B's JSON and legs A/C's markdown as the same shape | You'll write a parser that breaks on two of three legs | Parse leg B as JSON, the other two as markdown, explicitly |

## Common Rationalizations

| Rationalization | Reality |
| --- | --- |
| "Three models flagged it, must be real" | Three models trained on overlapping public code share priors. Agreement raises confidence; it doesn't establish fact. Check it. |
| "Leg C didn't have context so its findings are invalid" | That's the lane. "I can't tell what this does" *is* the finding. |
| "More legs would be better" | Past three, synthesis cost climbs and marginal decorrelation collapses. Three is the knee. |
| "The user will want to see all the raw output" | The raw files are on disk if they want them. The deliverable is the merged list. |
| "One leg failed, abort" | Two-leg reports are useful. Say which leg died and ship it. |
| "Leg C not being configured out of the box is fine, it's optional" | It's one of three labs the whole design depends on for decorrelation. Missing it silently degrades the skill to a two-provider review — say so loudly when it happens, don't let it pass quietly. |

## Red Flags

- Every finding is 3/3 — your legs aren't actually isolated, check the script
- No finding is above 1/3 — the diff may be fine, or your prompts are too open-ended
- The report is longer than the diff
- Findings are phrased in three different voices — you concatenated instead of synthesizing
- You can't name which leg produced a given finding
- Leg C ran but its output reads like it read the repo — the isolation caveat above may
  have been the failure mode; check `c-cold-read.log` for tool calls that reached outside
  its scratch dir

## Verification

Before returning: scope and all three model IDs stated (from the manifest, not re-derived);
every finding carries an `n/3` count; single-leg findings are verified against code or sit
in FYI; taste-only items cut; security deferred to `newdle-cso`; disagreements surfaced
rather than silently resolved; raw leg outputs left on disk and their path mentioned once;
any preflight-skipped or failed leg is named, not silently absent from the count; the
`**Ticket:**` line says which of auto-resolved / manual / none actually happened, naming
the identifier if auto-resolved.

Then close by naming the next stage in one line. Triad reports and fixes nothing, so the
findings get addressed first; once they are and the tree is green,
`/newdle-land-and-deploy` takes the PR from approved-and-green through merge, watches the
real deploy run, and verifies production before calling the release done. Don't point at
it while a HIGH finding is open, and skip it when this review was a second opinion on
work that isn't shipping this session — a triad read is a valid endpoint on its own.

## Bundled resources

- `scripts/triad-fanout.sh` — parallel fan-out, isolation enforcement, timeouts, preflight,
  manifest. Leg-runner machinery (run_leg, resolve_cli, timeout preflight) is shared
  with `quorum` via the plugin's `lib/leg-runner.sh`.
- `prompts/architecture.md` — leg A (JSON output, see `architecture.schema.json`)
- `prompts/architecture.schema.json` — leg A's `--json-schema` contract (passed inline)
- `prompts/correctness.md` — leg B (JSON output, see `correctness.schema.json`)
- `prompts/correctness.schema.json` — leg B's `--output-schema` contract (passed as a path)
- `prompts/cold-read.md` — leg C (markdown; no schema flag exists for this CLI)
- `prompts/refute.md` — verify stage, one agent per finding (opt-in)
- `prompts/refute.schema.json` — the verify stage's verdict contract

Model IDs and CLI invocations are env-configurable at the top of the script
(`TRIAD_A_CMD`, `TRIAD_B_CMD`, `TRIAD_C_CMD`, `TRIAD_TIMEOUT`, `TRIAD_MIN_LINES`,
`TRIAD_OUT_ROOT`, `TRIAD_DEFAULT_EXCLUDES`). Verify the strings against each provider's
current docs before first run — they turn over.

## Small lessons from the first two runs

- **A ticket visibly improved leg A, not just leg B.** Leg B is the one scored explicitly
  against a ticket, but run 2 (ticket supplied) and run 1 (no ticket) both had leg A find a
  correct critical issue — the difference was specificity: run 2's ticket let leg A tie a
  finding to an exact requirement line ("the published version stays untouched until
  Update") rather than reasoning about the diff in the abstract. This makes the Linear
  auto-resolution step in "Collect the ticket" worth more than it looks like at a glance —
  it's not just feeding leg B, it sharpens leg A's blast-radius read too.
- **Budget roughly 5–7 minutes wall clock** for a ~1000-line diff, legs running in parallel
  (observed: 318–435s for the slowest leg across both real runs). Know this before invoking
  the skill on something you need back in under a minute.
