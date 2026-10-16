# panel — every cross-model-review mode from an as2 lane

<!-- owned: agent-system 2.0, wl-mv5m7qvgkxhpj4 (PLAN.md § 3–4 of that workload). The lane-facing reference for the panel kit: scripts/panel.ts, prompts/, schema/. SKILL.md routes here; the bases (../triad/triad.md, ../quorum/quorum.md, ../doubt-driven-development.md) stay the source of every prompt and synthesis rule. -->

A lane never runs `../triad/scripts` or `../quorum/scripts`; those are user-driven terminal tools. A lane runs a mode as a **panel**: the classifier dispatches one judge hand per lab (anthropic, openai, kimi) on the byte-identical packet and output schema, publishes the landed outputs, and a synthesis hand writes the report. This kit stages the panel's input (`prep`) and proves its report (`check`). Paths below are from the repo root; `panel.ts` is `skills/cross-model-review/references/panel/scripts/panel.ts`.

## Steps per mode

| artifact | mode | lane steps |
|---|---|---|
| a diff | `triad` (then `triad-verify` per surviving finding) | cut a judge slice → `bun …/panel.ts prep triad --run <run> --workload <wl> --slice <sl> --base origin/main --ticket <path>` → `task` item, deep, with the line `panel: <run>` → after the classifier names the group published, `task` item with `panel-synth: <run>` → `bun …/panel.ts check <run>` → close the slice on `check` exit 0 |
| one finding of a triad | `triad-verify` | as triad, `prep triad-verify --finding <json> --base <ref>`; one panel per finding (never a list) |
| a brief | `quorum`, then `quorum-refute` | Step G grounding by one understand hand; the pack gate is a `lane_raise_question` (the skill's only hard gate) or `--repo-context all`; `prep quorum --brief <path> [--context <pack> \| --repo-context all] [--draft <path>]` → panel → synth → check; then `prep quorum-refute --from <the quorum run>` → panel → synth → check |
| an existing plan | `refute` | as triad, `prep refute --plan <path>` |
| one document | `doubt` | as triad, `prep doubt --artifact <path> --contract <path>`; at most 3 cycles (doubt-driven Step 5), a new run each cycle |

`<run>` is a new directory under `$HOME/agent-scratch/` (for a lane: `$HOME/agent-scratch/agent-system-2.0/<wl>/…`). Every prep also takes `--leg-timeout-min <lab|default>=<minutes>` (repeatable; default 90).

## prep

`prep <mode> --run <run> --workload <wl> --slice <sl> …` stages one run and prints its path and the brief line to use. It refuses a run directory that already exists and one whose realpath is not under `$HOME/agent-scratch/`; nothing is written on a refusal. A run is used for exactly one panel: to run again (a missing leg, a new cycle), prep a new run. A single replacement leg is never possible.

| mode | arguments | what the legs get | repo access |
|---|---|---|---|
| `triad` | `--base <ref> --ticket <path> [--repo <worktree>]` | the three lens prompts (`../triad/prompts/architecture.md`, `correctness.md`, `cold-read.md`) as three sections of one packet, the scope, the ticket, `git diff <base>...HEAD`; one union schema whose items carry a `lens` tag | yes, the worktree (default: the cwd's git toplevel) |
| `triad-verify` | `--finding <json> --base <ref> [--repo <worktree>]` | `../triad/prompts/refute.md`, the one finding (`title`, `severity`, `where`, `what` only: never which legs raised it), the diff | yes |
| `quorum` | `--brief <path> [--context <pack> \| --repo-context all] [--draft <path>] [--repo <worktree>]` | `../quorum/prompts/plan.md`, the brief, the pack when given | only with `--repo-context all` |
| `quorum-refute` | `--from <quorum run or its panel dir>` | `../quorum/prompts/refute-plan.md`, the brief and pack, and the other labs' landed plans as `PLAN 1`/`PLAN 2` (each leg its own packet; never its own plan) | as the quorum run |
| `refute` | `--plan <path>` | `../quorum/prompts/refute-plan.md` and the plan as `PLAN 1` | no |
| `doubt` | `--artifact <path> --contract <path>` | doubt-driven Step 3's adversarial prompt with the ARTIFACT and CONTRACT pasted in; never the CLAIM | no |

`--draft` copies the draft to `withheld/draft.md` with a generated canary in it; it is in no leg's inputs, only the synthesis hand's. `quorum-refute` verifies its source against the ledger before reading a byte of it and needs at least two landed plans.

The run holds `manifest.json` (mode, workload, slice, repo access, timeouts, every input's sha256, each leg's and the synthesis hand's inputs, the canary), the packet(s), `schema/leg.schema.json`, `synth.md` (the mode's synthesis prompt with the base's rules expanded verbatim and the material the synthesizer needs), and `schema/synth.schema.json`. The classifier copies it, hash-checked, into the panel directory at `panel:` dispatch and never reads the staging run again.

## The brief lines

- `panel: <run>` on a deep `task` item named after the slice: three members `<sl>--anthropic`, `<sl>--openai`, `<sl>--kimi`, each pinned to its lab, builder lab included.
- `panel-synth: <run>` on a deep `task` item named after the same slice, once the group is published: one hand `<sl>--synth`, on a non-builder lab when one is usable. A failed synthesis may be dispatched again, at most twice per group.
- Word both as reviews: the classifier refuses either item when it does not classify it as a review, and never overrides the kind. For the synthesis, use a verdict-shaped task such as `task: review the panel's leg findings: judge which hold, which conflict and which are unsupported, and rank them in one review verdict`, not "synthesize … into a report". A refused item does not count as a failed synthesis.

Neither is accepted on the plan slice: a panel never stands in for the plan review, and it is in addition to the ordinary cross-lab review, never instead of it.

## check

`check <run or panel dir>` reads the panel directory and the ledger (read-only; `$AGENT_SYSTEM_LEDGER_DB` or `~/.agent-system-2/ledger.db`) and exits 0 with `check: ok <pg>`, or 1 with one `check: FAIL <reason>` line per failed rule:

- **Hashes.** Every file under `in/` matches the `panel-group:` entry, `in/manifest.json` included; every file under `out/` matches a `panel-published:` entry; nothing unrecorded sits in either. The run is not void.
- **Legs.** Each lab has one `panel-leg:` line whose status `out/status.json` repeats; a landed leg's items are `<lab>-1…<lab>-n` and match its `findingIds`; REPORT.md's `**Legs:**` line and `report.json`'s `legs` give every lab its `status.json` status and model.
- **Accounting.** Every landed item id is in exactly one finding's `supportIds`/`refuteIds` or in `dropped` with a reason. Nothing is silently lost, nothing counted twice.
- **Agreement.** Each finding's `n/3` on its line in REPORT.md equals the number of distinct labs in its `supportIds`, and it sits under the `##` section its `section` names.
- **Disagreements.** A finding with both support and refute ids sits under the mode's disagreement section (`Divergent` in quorum, `Disagreements` otherwise).
- **Sections.** triad: `Disagreements` and `FYI` (and `Refuted` exactly when the report carries a `**Verify:**` line, as triad.md's output format says); triad-verify: a `**Verify:**` line; quorum: `Converged`, `Divergent`, `Unique`, and `Vs. the withheld draft` when a draft was withheld; refute and quorum-refute: every finding names each attacking lab; doubt: the four RECONCILE classes.
- **Canary.** When a draft was withheld, its canary is in the withheld file and in no leg output.
- **Labels.** Every statement block of REPORT.md opens with a bold output-types label.

The slice closes on `check` exit 0, with the run path, the `<pg>`, and REPORT.md's path as its artifact. Panel findings become fix slices like review findings.

## A missing leg

A lab with no usable model, a cancelled or timed-out hand, an output failing the schema, or a breach is `missing` or `excluded` in `status.json` and in the ledger; it is never replaced by another lab. The report says so on its `**Legs:**` line and counts `n/3` over the labs that landed. To get three labs, run a whole new panel.

## What a panel isolates, and its limit

Every leg is audited from its own session file: a read of another panel, of `withheld/`, of a session file, or of an `agent://`, `history://`, `proc://`, `artifact://` or `local://` URI excludes it, and in a packet-only mode (`repoAccess` false) any shell, eval, browser or web search call does. With repo access, a leg that computes a path at runtime can evade that literal audit; there no-cross-talk is detected for literal paths only.
