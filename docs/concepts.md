# Concepts

This page explains the moving parts and where each lives in the code. The rulings behind them are in [SPEC-2.0.md](../SPEC-2.0.md) and [DESIGN-2.0.md](../DESIGN-2.0.md); the words you type are in [USER-GUIDE.md](../USER-GUIDE.md).

## The three roles

| Role | What it is | Where it is defined |
|---|---|---|
| **Orchestrator** | The one OMP session you talk to, started by `as2` with `AGENT_SYSTEM_ROLE=orchestrator`. It opens, launches, closes and answers for workloads. It never writes code, dispatches hands, closes slices or raises a ceiling | `tiers/orchestrator.md`, `surface/` |
| **Lane** | One OMP session that holds one workload and does its work in a git worktree. An autonomous lane is started by `surface/scripts/lane.ts`; a user-driven lane runs in your terminal via `as2 lane <workload>` | `tiers/lane.md`, `surface/scripts/lane.ts` |
| **Hand** | A sub-agent a lane dispatches with OMP's `task` tool, on one of four tier files | `tiers/fast.md`, `standard.md`, `strong.md`, `deep.md` |

Three OMP extensions, loaded in this order by the profile, implement the machinery: the **surface** (`surface/index.ts`), the **gates** (`gates/index.ts`) and the **classifier** (`classifier/extension.ts`). Order matters: OMP runs `tool_call` handlers in load order and stops at the first block.

## Workloads and slices

A **workload** is one unit of work: a brief, a done line, a repository, stakes, mode, an open/closed status and at most one holder with a lease. The orchestrator opens it from your words and records the repository in the ledger at open.

A **slice** is a leaf task inside a workload, with a task, a done condition and inputs. Its states are `open`, `paused`, `done` and `cancelled`, and the schema refuses `done` without a non-empty artifact (`ledger/schema.sql`, table `slices`). Lanes add and complete slices; the orchestrator does not.

A lane works in `<parent of the repo>/<repo name>-lanes/<workload>/` on branch `wl/<workload>` (`worktreePath`, `surface/src/launch.ts`). Its runner state lives in `~/.agent-system-2/lanes/<workload>/`.

## Stakes

Stakes are `throwaway`, `normal` (the default) or `production`. The orchestrator infers them from the brief (the trigger words are in [USER-GUIDE.md](../USER-GUIDE.md) § 1), and one word changes them later. Stakes set four things:

| | `throwaway` | `normal` | `production` |
|---|---|---|---|
| Highest tier a hand may run on (`STAKES_CAP`, `classifier/src/route.ts`) | `fast` | `strong` | `deep` |
| Review before merge | none | one review slice | a review on `deep`, one hand per available other lab, then your approval |
| Ceiling (`CEILING_BY_STAKES`, `surface/src/ceiling.ts`) | $5 / 1 h | $50 / 6 h | $150 / 12 h |
| Review round limit | 3 | 3 | 5 |

A brief the open-time classifier judges `change-large` gets three times the ceiling. Plan-first is the default at normal stakes and always on at production ([USER-GUIDE.md](../USER-GUIDE.md) § 1 has the exceptions). Treating any change under `gates/` as production stakes, whoever opens it, is planned ([MIGRATION.md](../MIGRATION.md) item 82).

## Modes

| Mode | Status | What it means |
|---|---|---|
| `autonomous` | Built (default) | A lane runs on its own. The `ask` tool is denied (P-11 row 14), so a lane that needs you raises a ledger **question** with fixed options, which pauses only that slice |
| `user-driven` | Built | You steer. You run the lane in your own terminal with `as2 lane <workload>` and type to it there; it may use `ask` |
| `paired` | Planned ([MIGRATION.md](../MIGRATION.md) item 49) | You and a lane steer together, one agreed change set at a time |

Also planned: a steered lane launched as a HerdR-managed seat with its own pane and mailbox (item 93), and the orchestrator as a HerdR seat (item 98). as2's machinery does not use HerdR today; one script in the vendored `cross-model-review` skill opens live HerdR panes when HerdR is running and does nothing otherwise.

## Hands, tiers and the classifier

Before every dispatch the classifier asks the judge model (`typesafe/jev-1.13.0`) what kind of task the brief is, then routes:

1. **Kind to tier** (`KIND_TIER`, `classifier/src/route.ts`): `locate` → `fast`; `understand` and `change-small` → `standard`; `change-large` → `strong`; `judge` → `deep`.
2. **Low confidence pulls up.** At a confidence of 0.55 or below, the higher tier of the top two kinds is used.
3. **Stakes cap pulls down** to the stakes' highest tier.
4. **Tier to model** comes from `task.agentModelOverrides` in the profile. Each tier's row lists one model per provider in attempt order; the classifier keeps only entries with a registered model and credentials, and refuses a hand result from a model outside the row.

Every dispatch writes one `routings` row with the kind, confidence, tiers, models and outcome. A dispatch must name a tier file (P-11 row 4) and carry six brief fields (`workload`, `task`, `done-condition`, `inputs`, `stakes`, `ceiling-share`; P-11 row 5). Row 17 limits how many hands a lane may spawn in a time window.

## Review routing by lab

A dispatch is a review when its kind is `judge` (or `judge` was in the top two of a low-confidence answer). Reviews run on a lab other than the one that built the work (`reviewPlan`, `classifier/src/lab.ts`):

- Providers map to labs explicitly: `anthropic` → Anthropic; `openai` and `openai-codex` → OpenAI; `moonshot` and `kimi-code` → Kimi. A provider not in the map has no lab, and a review whose row names one parks rather than counting it as independent.
- Below production stakes, a review is one hand, constrained to the row's usable other-lab entries in attempt order. At production stakes with more than one other lab usable, one hand runs per other lab.
- When no other lab is usable, the review **parks** and asks you: `same-lab` (this one review runs on the builder's lab) or `wait`.
- A deep-tier review's OpenAI reviewer runs on the strong row's OpenAI model (`REVIEW_ROW_FROM`, [MIGRATION.md](../MIGRATION.md) item 110).
- Each review loop has a round limit; at the limit you answer `extend`, `accept` or `stop`.

## Ceilings: the extend / stop / split question

Each workload has a ceiling in nominal dollars (list price as OMP computes it, summed from the lane's session files) and in wall-clock minutes of lane run time (`surface/src/ceiling.ts`). When either half reaches 80 %, the lane gets a question with three options:

| Answer | Effect |
|---|---|
| `stop` (default) | The lane halts at 100 % |
| `extend` | One more ceiling block and a relaunch |
| `split` | Halts like `stop`; the orchestrator then offers a new workload for the rest |

At 100 % the lane stops. A raise always needs your word: `extend`, or `ceiling <usd> [<hours>]`. Lanes also run with OMP's `--max-time` (`AGENT_SYSTEM_LANE_MAX_TIME`, default `2h`) as a backstop. The design is in [DESIGN-workload-ceiling.md](../DESIGN-workload-ceiling.md). Spend is recorded per lane run only; per-slice and per-hand spend are planned ([MIGRATION.md](../MIGRATION.md) item 22).

## Reserved actions and approvals

Reserved actions are irreversible actions outside the repository ([SPEC-2.0.md](../SPEC-2.0.md) § A4): force-push, hard reset, branch or tag deletion, `rm -rf`, `DROP` / `TRUNCATE`, production database writes, infrastructure teardown, secret rotation, a push to a protected branch (`main`, `master`, `production`, `prod`, `release`), and deploy. Pushes to feature branches and merges of approved, green PRs are not reserved.

P-11 row 6 (`gates/src/rows/r06-reserved.ts`) refuses a reserved command and writes a `reserved-request` entry; it appears under *needs you* and you answer `approve` or `deny`. A process started from the `eval` tool is refused outright and the lane is told to use `bash`, where the gate can read the command.

The gates guard against a lane doing a reserved thing by mistake or over-eager judgment. Deliberate evasion by the lane is out of scope ([SPEC-2.0.md](../SPEC-2.0.md) § A4, "Threat model"); the write fence is the layer a parser gap cannot talk past.

## The write fence

The gates rewrite every bash call to run under a macOS Seatbelt profile (`sandbox-exec`) that denies writes to the ledger's directory and to each repository's `.git/hooks` and `.git` entry (`gates/src/fence.ts`). It fails closed: if `sandbox-exec` is missing, a path cannot be canonicalized, or the OMP host version is not the verified one, the call is refused. `as2 off` disables it for the installed profile, and the gates record that once per lane session.

The fence does not cover the `eval` tool's subprocesses or the file tools (`write`, `edit`), which run in OMP's own process; the parse-time rows remain the line there. Wrapped commands run macOS `/bin/bash` 3.2, not OMP's built-in shell.

## Output types and the other gates

Every as2 session gets the output-types contract (`contract/output-types.md`) injected (P-11 row 2): statements are labelled CLAIM, CITE, GUESS, ACTION or QUESTION, each with its receipt rule. Row 3 checks receipts (a cited `file:line` was read and matches disk, a CITE's URL was fetched, an ACTION's exit code matches the run) and flags, never blocks. Row 1 refuses a message to you with more than one question, or one that hands you a command other than as a script path; on the orchestrator it refuses any command at all. Other rows: the wake read (7), push freshness against a passing test record (8), edits on a protected branch (9), raw writes to the ledger (10), your instructions to a lane recorded as instructions (11), the orchestrator not doing lane work (15), and a typed copy of the fence wrapper (18). The full table is the P-11 list in [DESIGN-2.0.md](../DESIGN-2.0.md) § "Mechanical-rule list".

## The test runner

A lane cannot run a full suite inside the fence. For a repository listed under `testRunner.repos` in the profile, the lane calls `lane_full_test`; the runner (`surface/scripts/test-runner.ts`) runs the suite at the PR head and records a `test-run:` entry with the verdict. A full part that times out ends the run as an error: no solo or base parts, and a `<part>.stuck.log` capture of what was running is kept in the run directory. A second stop reason sits beside the wall cap: a stuck-worker detector inside the executor (`testRunner.stuckStop`, `shadow` unless set to `enforce`) recognizes a worker spinning inside `Bun.spawnSync` on a child it never reaped, and in `enforce` stops the part, keeps a `<part>.signature.log` capture and ends the run as an error whose reason starts `stuck:`. After a stuck or stalled part the runner checks without spawning that no `_as2test` process is alive before it releases the lock, and every run makes the same check, the admission gate, before its first part, so a survivor of an earlier run ends the next run as `admission refused` instead of sharing the machine with it. After an all-pass full part only the changed test files with no executed case run alone; after a red only the failing files outside `gates/test/` run alone, a diagnostic that never turns a red green. Base is compared by running those same files alone on base (never the full suite), and `red-main` needs every full-part failure reproduced alone and failing on base. A green run completes the full-suite slice. A workload on a served repository cannot close until its PRs have a green run at their head. A merged PR also passes on a green run from any workload whose commit is on the default branch and contains the PR's merge commit; when nothing covers it, Jo's `waive-pr` lets it pass. A waiver never passes an open PR.

The runner executes lane-written code outside the fence, so it narrows what that code can reach rather than sandboxing it ([USER-GUIDE.md](../USER-GUIDE.md) § 5 lists the limits): tests run as the `_as2test` user with an empty environment, a throwaway home, git without a credential helper, and a preflight that refuses the run if `_as2test` can open a known credential path, the ledger or the runner's lock. A test can still reach the network and read world-readable files. The profile caps each run (`fullCapMin: 20`, `soloCapMin: 10`, `reportCapMb: 50`, `queueMaxMin: 1440`; a merge train's runs are exempt from the lock-wait cap); the newest 10 runs are kept whole.

## The ledger

One SQLite file, `~/.agent-system-2/ledger.db`, in WAL mode, schema version 5. It is the only record: the orchestrator's wake is the ledger rendered, never a lane's prose. The rules live in the file itself as CHECK constraints and triggers, so they bind every writer, including a person at the `sqlite3` prompt. Rows are never deleted or replaced, every update is stamped (`rev`, `changed_by`, `changed_at`), and a trigger appends a provenance row for every write. The prose description is [ledger/SCHEMA.md](../ledger/SCHEMA.md).

| Table | Holds |
|---|---|
| `workloads` | Brief, stakes, mode, status, holder and lease |
| `slices` | Task, done condition, inputs, state, artifact |
| `messages` | A four-state queue: held → delivered → consumed → acted-on |
| `instructions` | Your words to a lane: instructions, answers, withdrawals, mode flips. Append-only |
| `questions` | Lane-raised questions with at least two options; resolved only by an answer or withdrawal |
| `routings` | One row per dispatch: kind, confidence, tiers, model row, judge model, outcome |
| `entries` | Lane- and machinery-written facts: wake reads, mode acknowledgements, assumptions, reserved requests. Control records such as `ceiling:`, `spend:`, `repo:` and `test-run:` are prefixed `assumption` entries |
| `provenance` | Append-only log of every insert and update, written by triggers |

The installer takes a backup copy into the ledger's own `backups/` directory, and the optional launchd job repeats it on a schedule. The ledger refuses to live in a synced or network folder, because SQLite WAL does not work over a network filesystem.

## Ticket systems

as2 has no Linear, Jira or GitHub Issues integration in its code today. [SPEC-2.0.md](../SPEC-2.0.md) § B10 rules that a workload may carry an optional link to a Linear or GitHub issue, mirrored only at open and close and never read as the source of truth; that link is not built (the `workloads` table has no column for it), and no MIGRATION.md item tracks it yet. The design intent is that as2 knows a ticket system only through what the ledger records.
