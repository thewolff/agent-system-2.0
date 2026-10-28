# Configuration

as2 was built for one user on one Mac. This page lists what you can change today, where, and what is still hardcoded. Making every author-specific integration optional, with a documented off-state, is planned ([MIGRATION.md](../MIGRATION.md) item 95).

## Where configuration lives

| File | Installed to | What it controls |
|---|---|---|
| `profile/config.yml` | `~/.omp/profiles/<profile>/agent/config.yml`, rendered with `{repo}` filled in | Extensions, skills, tier → model rows, the judge, the fence switch, the test runner, compaction, display |
| `profile/models.yml` | Beside `config.yml` | The pinned judge model's definition on the `typesafe` provider |
| `profile/mcp.json` | Beside `config.yml` | The profile's MCP servers. The installer refuses a file without an `mcpServers.ctx` entry that has a `command` |
| `tiers/*.md` | Linked into `agents/` | The six role prompts (orchestrator, lane, four hand tiers). Links, so edits are live without a re-install |
| `voice/VOICE.md` | Read in place | The voice the orchestrator writes in; rendered into its system prompt at each `as2` launch |
| `plugins/output-types/skills/output-types/reference.md` | Read in place | The output-types contract injected into every session (the vendored public plugin, plugins/VENDOR.md) |

Edit the files in the checkout and re-run `bash install/install.sh`. The installer overwrites the installed `config.yml`, `models.yml` and `mcp.json` on every run, so edits made directly in `~/.omp/profiles/` are lost at the next install. The one exception is `as2 on` / `as2 off`, which flips `gates.fence.enabled` in the installed file until the next install.

### `profile/config.yml` keys

| Key | Default | Notes |
|---|---|---|
| `task.agentModelOverrides.<tier>` | Anthropic, then OpenAI Codex, then Moonshot, per tier | Attempt order; unusable entries are skipped at spawn. A model may not appear in a higher tier's row, and every provider must be in the lab map (`classifier/src/tier-table.ts`, `classifier/src/lab.ts`) |
| `modelRoles.judge` | `typesafe/jev-1.13.0` | See "Hardcoded today": changing it alone makes every dispatch fail |
| `retry.fallbackChains.judge` | `[]` | Keeps OMP from falling back to another judge |
| `gates.fence.enabled` | `true` | `false` runs bash unwrapped; the gates write one ledger entry per lane session saying so |
| `testRunner.repos` | `thewolff/agent-system-2.0` with `bun test` | The GitHub `owner/repo` origins the test runner serves, each with its test command. Replace it with your own repositories |
| `testRunner.fullCapMin` / `soloCapMin` / `reportCapMb` / `queueMaxMin` | 20 / 10 / 50 / 1440 | Per-run caps for the full suite (a part that passes its cap is killed and ends the run), each test file run alone (changed files with no executed case, or failing files), report size, and lock wait. A merge train's runs never end on the lock-wait cap: dead lock holders and dead waiters are replaced or pruned instead |
| `testRunner.stuckStop` | `shadow` | The stuck-worker detector's mode, written into each run's `caps.json` beside `fullWorkers`. `shadow` logs `stuck-would-stop` and keeps going: a part is never stopped, so the wall cap stays the only stop. `enforce` stops a part whose worker is positively stuck in `Bun.spawnSync` (about 45 s from the first sign to the next run taking the lock), ends the run as an error with a `stuck:` reason and runs no further part. Anything else is refused. The detector is macOS only. `profile/config.yml` leaves it unset; `migration/items/stuck-worker-detector.md` says how to switch it on and read the field report |
| `compaction.thresholdPercent` | 25 | When the orchestrator and lanes compact their context |
| `skills.includeSkills` | 22 skills | Must equal the manifest's `skill` rows exactly, or the install is refused. Adding a skill means adding `skills/<name>/SKILL.md` with a frontmatter `description` and a manifest row |
| `extensions` | surface, gates, classifier | Order matters: the surface must load before the gates, and the gates before the classifier |
| `symbolPreset`, `composer`, `theme`, `display`, `tui`, `hideThinkingBlock` | The author's OMP display settings | Display only; nothing in as2 reads them |

### Environment variables

| Variable | Default | Effect |
|---|---|---|
| `AGENT_SYSTEM_LEDGER_DB` | `$HOME/.agent-system-2/ledger.db` | Ledger file, for the installer and at run time |
| `AGENT_SYSTEM_PROFILE` | `agent-system-2` | OMP profile name, for the installer and `as2` |
| `AGENT_SYSTEM_MAX_LANES` | 3 | Autonomous lanes holding workloads at once |
| `AGENT_SYSTEM_LANE_MAX_TIME` | `2h` | OMP `--max-time` for a lane; the ceiling's remaining wall time takes over when set |
| `AGENT_SYSTEM_VOICE` | `voice/VOICE.md` in the checkout | The voice document |
| `AGENT_SYSTEM_CONTRACT` | `plugins/output-types/skills/output-types/reference.md` in the checkout | The output-types contract |
| `AGENT_SYSTEM_DECISION_LOG` | `<repo>/.ai/decision-log` | Where decision-log entries are read from, and written when no lane branch can take one |
| `AGENT_SYSTEM_TEST_RUNS` | `test-runs/` beside the ledger | The test runner's runs root |

### Per workload, by typing

Stakes, mode, ceiling, review round limit, PRs the test runner may test, and the lane's own model are set per workload through the orchestrator. [USER-GUIDE.md](../USER-GUIDE.md) § 3 lists the words. The lane-model choice sets `--model` on the lane's `omp` process only; hands still use the tier rows.

## Hardcoded today

Each item names where it lives, so a change starts in the right file.

### The human and the author's setup

- **The operator is "Jo".** The surface stamps every instruction you type with `author: "jo"` (`surface/src/input.ts`), a lane hands a workload back to the holder `jo` (`JO_HOLDER`, `surface/src/launch.ts`), and the tier prompts address Jo by name. The value is a label, not an identity check, so the system runs for another person, but the prompts will call them Jo. Splitting this personal layer into a template is planned ([MIGRATION.md](../MIGRATION.md) item 26).
- **The voice document is written for the author.** `voice/VOICE.md` describes how to write for its one reader. Point `AGENT_SYSTEM_VOICE` at your own file to replace it.
- **Names from the earlier seat-based system.** `tiers/lane.md`, `tiers/orchestrator.md` and [USER-GUIDE.md](../USER-GUIDE.md) § 5 still mention "Plumb", a seat that ran the test suite by hand before the test runner existed.
- **The orchestrator's name is not hardcoded.** It picks a name and pronouns on first wake and stores them as a ledger entry; "Ilex" is the name on the author's machine.
- **Author paths outside the install path.** `scripts/create-remote.zsh`, `scripts/enum-skills.sh` and the project agents in `.omp/agents/` name the author's home directory. The installer does not read `scripts/`. The nightly chaos run reports to `~/agent-scratch/agent-system-2.0/chaos/` (`surface/scripts/chaos.ts`, `install/install.sh`); it only runs with `--chaos-nightly`.
- **Display settings** in `profile/config.yml` are copied from the author's own OMP profile.

### Models and providers

- **The provider → lab map** is a constant, `PROVIDER_LAB` in `classifier/src/lab.ts`: `anthropic`, `openai`, `openai-codex`, `kimi-code`, `moonshot`. A provider outside it has no lab, so it cannot review, and a tier row naming it parks every review on that row. Adding a provider (Google, a gateway) means editing this map.
- **The OpenAI review rule.** `REVIEW_ROW_FROM` in `classifier/src/lab.ts` sends a deep-tier review's OpenAI reviewer to the strong row ([MIGRATION.md](../MIGRATION.md) item 110).
- **The judge.** The classifier's 0.55 threshold (`LOW_CONFIDENCE_THRESHOLD`, `classifier/src/route.ts`) was measured on `typesafe/jev-1.13.0`, recorded in `classifier/calibration.json`, and the classifier refuses to route on any other judge. Moving the judge needs a new classifier sample and calibration, not only a profile edit. A TypeSafe account is therefore required today. Planned: any judge-capable model, re-measured ([MIGRATION.md](../MIGRATION.md) item 95).
- **Cross-lab review is always required.** With one lab, every review parks on a `same-lab` / `wait` question. There is no setting to allow same-lab reviews by default.
- **Kind → tier and stakes → cap** (`KIND_TIER`, `STAKES_CAP` in `classifier/src/route.ts`), **ceilings by stakes** and the `change-large` factor of 3 (`CEILING_BY_STAKES`, `CHANGE_LARGE_FACTOR` in `surface/src/ceiling.ts`), and **review round limits** (`classifier/src/rounds.ts`) are constants. The per-workload words change one workload, not the defaults.

### Git host and repositories

- **GitHub only.** Closing a workload pushes the lane branch and checks for its PR with `gh`; the test runner maps a remote to `owner/repo` only for github.com URLs (`ownerRepoOf`, `surface/src/test-run.ts`). There is no GitLab or other forge path.
- **Protected branch names** are a regular expression, `PROTECTED_BRANCH` in `gates/src/types.ts`: `main`, `master`, `production`, `prod`, `release`. Pushes to them are reserved actions; edits on them are refused.
- **Worktree location.** Lanes work in `<parent>/<repo name>-lanes/<workload>/`, beside the repository (`worktreePath`, `surface/src/launch.ts`).
- **State root.** Lane directories, the rendered orchestrator prompt and the default runs root live under `~/.agent-system-2/`.
- **The as2 repository is special.** When a workload's repository is the as2 checkout itself, the lane is told never to merge.

### Platform

- **macOS only.** The write fence is a Seatbelt profile run through `/usr/bin/sandbox-exec` (`gates/src/fence.ts`), and every bash call is refused when `sandbox-exec` is missing unless the fence is off. The `_as2test` user is created with `dscl` (`install/as2test-setup.sh`). The ledger backup and the nightly chaos run are launchd agents; off macOS the installer skips the backup job and refuses `--chaos-nightly`. No Linux fence, test-runner setup or scheduler exists.
- **OMP 18.8.** `VERIFIED_HOST` in `gates/src/host.ts` refuses any other major.minor, and `setupVersion` in `profile/config.yml` matches one OMP release's first-launch wizard. After an OMP upgrade, `gates/test/host.test.ts` and `install/fresh-machine-test.sh` say whether the pin still holds.
- **HerdR and moshi** are not used by as2's machinery. Planned seat integrations are optional ([MIGRATION.md](../MIGRATION.md) items 93 and 98).

## Ticket systems

Nothing in as2's code or configuration names Linear, Jira or any other issue tracker; work items are ledger workloads and slices. The design intent is that the user chooses their ticket systems and as2 knows them only through what the ledger records. [SPEC-2.0.md](../SPEC-2.0.md) § B10 rules an optional per-workload link to a Linear or GitHub issue, mirrored at open and close and never read as truth; it is not built, and no MIGRATION.md item tracks it.
