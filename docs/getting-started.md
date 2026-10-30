# Getting started

This page takes a Mac from nothing to a first workload. as2 has been installed on one machine, its author's. `install/fresh-machine-test.sh` proves the installer against a temporary `$HOME` on that machine, but no second user has installed it yet ([MIGRATION.md](../MIGRATION.md) items 25 and 95). Expect rough edges, and read [configuration.md](configuration.md) for what assumes the author's setup.

## 1. Prerequisites

The installer checks only for `bun`. Everything else below is needed at run time, and a missing piece shows up later as a refused call rather than at install. Writing the prerequisites down and checking them at install is planned ([MIGRATION.md](../MIGRATION.md) item 25).

| Need | Why | Notes |
|---|---|---|
| **macOS** | The write fence runs every bash call under `/usr/bin/sandbox-exec` (`gates/src/fence.ts`); the test-runner setup uses `dscl`; the backup job is a launchd agent | No Linux support. On a non-macOS host the installer skips the backup job, and the fence has no equivalent |
| **OMP (oh-my-pi) 18.8.x** | as2 is a set of OMP extensions, tier files and a profile | The gates refuse to run on an OMP whose major.minor is not `VERIFIED_HOST` in `gates/src/host.ts` (`18.8` today). The author's OMP is the `@oh-my-pi/pi-coding-agent` package installed globally with Bun |
| **Bun** | The ledger module uses `bun:sqlite`; every script and test runs on Bun | The repository's GitHub workflow pins Bun 1.3.14 |
| **git** | Lanes work in git worktrees and push branches | |
| **GitHub CLI (`gh`), logged in** | A workload close pushes the lane branch and makes sure a PR exists through `gh`; the test runner reads PRs with `gh pr list -R <owner/repo>` | Not checked anywhere ([MIGRATION.md](../MIGRATION.md) item 17). Lanes push to the repository's `origin`, so work on repositories you can push to |
| **`sqlite3` CLI** | `install/as2test-setup.sh --undo` reads the runner lock with it; `install/fresh-machine-test.sh` inspects the ledger with it | Ships with macOS at `/usr/bin/sqlite3`. The ledger itself is written only through Bun |
| **ctx** (optional, except for `--train-tick`) | A local agent-history search tool. The installer registers the profile's session directory as a ctx history root, and `profile/mcp.json` starts `ctx mcp serve` as an MCP server | Without `ctx` on PATH the installer prints a notice and skips the registration; the rest runs. `--train-tick` requires it: the lanes the tick launches inherit the tick's PATH and need ctx for that MCP server and their history index, so without ctx the flag is refused with exit 2 |

### Provider accounts

The installer's last line names the providers the rendered profile routes to. From `profile/config.yml` today they are:

| Provider (OMP name) | Used for |
|---|---|
| `anthropic` | Row 1 of every tier (`fast`, `standard`, `strong`, `deep`) |
| `openai-codex` | Row 2 of every tier |
| `moonshot` | Row 3 of every tier |
| `typesafe` | The judge model `typesafe/jev-1.13.0`, which the classifier asks before every dispatch |

- **The judge is required.** The classifier's 0.55 confidence threshold was measured on `typesafe/jev-1.13.0` only, and the classifier refuses to route on an answer from any other model. With no TypeSafe credential, every dispatch fails closed (`profile/config.yml`, "Judge role"). Making the judge any judge-capable model, with the threshold re-measured, is planned ([MIGRATION.md](../MIGRATION.md) item 95).
- **One chat provider works, with a cost in reviews.** At spawn the classifier keeps only the row entries that are in OMP's model registry and have credentials (`usableRow`, `classifier/extension.ts`), so a tier runs on whichever providers you are logged in to. Reviews must run on a lab other than the builder's. With only one lab available, every review parks and asks you `same-lab` or `wait` (see [concepts.md](concepts.md#review-routing-by-lab)).
- The ceilings are nominal list prices as OMP computes them. The design assumes flat-rate subscriptions for the three chat providers ([SPEC-2.0.md](../SPEC-2.0.md) § B11), so a ceiling bounds a share of subscription capacity, not a bill.

### MCP logins (Linear and PostHog)

`profile/mcp.json` gives every lane the hosted Linear (`https://mcp.linear.app/mcp`) and PostHog (`https://mcp.posthog.com/mcp`) MCP servers, with full read and write access. The file holds definitions only. OMP stores each OAuth login in the profile's own `agent.db`, keyed by profile and server URL, and a login made under your default profile does not reach this one. Log in once per server under the as2 profile: start `env -u PI_PROFILE -u PI_CODING_AGENT_DIR -u PI_CONFIG_DIR OMP_PROFILE=agent-system-2 omp` (the `-u` clears stop an inherited `PI_PROFILE` or agent-dir variable from picking another profile), then run `/mcp reauth linear` and `/mcp reauth posthog`, and finish each browser sign-in.

- **One login per service, shared by every lane.** Every lane, autonomous or steered, connects with that one login, so every Linear and PostHog change a lane makes appears as the person who logged in.
- **Expiry hits every lane at once.** When a login expires or is revoked and OMP cannot refresh it, the server fails to load (HTTP 401, logged as `MCP tool load failed` in `~/.omp/profiles/agent-system-2/logs/`) and every lane that starts then has none of its tools, until you log in again under this profile. A lane still starts and its other tools still work. A headless lane is not told (the follow-up is tracked in the issue linked from PR #400). The daily self-heal report is the signal for now: its `mcp-load` detector reads the profile's OMP logs, rotated ones (`.log.1`, `.log.2`, …) included, and gives one finding per server and failure in the window, with the count. Those are past failures, so for a 401 or 403 the finding says the login's current health is unknown until a live load, and to start `env -u PI_PROFILE -u PI_CODING_AGENT_DIR -u PI_CONFIG_DIR OMP_PROFILE=agent-system-2 omp` (for the default profile, `env -u OMP_PROFILE -u PI_PROFILE -u PI_CODING_AGENT_DIR -u PI_CONFIG_DIR omp`) and see whether the server loads. A stored login is not proof that it works: only a live load or call shows that. A logs directory or log it cannot read gives its own `mcp-load: OMP logs unreadable` finding. To redo a stored login that no longer works, type `/mcp unauth <name>` and then `/mcp reauth <name>` in the same profile.
- PostHog runs in its CLI mode (`x-posthog-mcp-mode: cli`), which exposes one `exec` tool that finds and calls PostHog's tools on demand instead of mounting all of them.

## 2. Install

Clone anywhere outside a synced folder, then run the installer from the checkout:

```sh
git clone https://github.com/thewolff/agent-system-2.0.git
cd agent-system-2.0
bash install/install.sh
```

`install/install.sh` reads `install/manifest.tsv` and runs every check before it writes anything, so a failed install leaves the machine as it found it. It is safe to re-run. In order, it:

1. Validates the manifest and refuses any file under a machinery directory (`ledger install extensions agents profile skills tiers classifier gates bin surface contract voice`) that has no manifest row, and any symbolic link under one.
2. Renders `profile/config.yml` with `{repo}` replaced by the checkout's absolute path, and checks that `skills.includeSkills` matches the manifest's skill rows exactly.
3. Creates or verifies the ledger at `$HOME/.agent-system-2/ledger.db` (schema version 5). It refuses a synced or network folder (exit 3) and a ledger at another schema version (exit 4); there is no upgrade path from older versions.
4. Takes a first backup copy of the ledger.
5. Writes a launchd plist for the periodic backup to `~/Library/LaunchAgents/com.agent-system-2.ledger-backup.plist`. It does **not** load it; it prints the `launchctl bootstrap` command to load it and the `launchctl bootout` command to unload it.
6. Writes the OMP profile to `~/.omp/profiles/agent-system-2/agent/`: `config.yml` (rendered), `models.yml`, `mcp.json`, and symbolic links from `agents/` to the six tier files in `tiers/`. Skills are used in place from `<checkout>/skills`.
7. Links `bin/as2` to `~/.local/bin/as2`, and prints a note when `~/.local/bin` is not on PATH.
8. Registers the profile's session directory as a ctx history root, when `ctx` is installed.
9. Prints the providers to log in to.

`as2 install` runs the same script once the launcher is on PATH.

| Environment variable | Default | Effect |
|---|---|---|
| `AGENT_SYSTEM_LEDGER_DB` | `$HOME/.agent-system-2/ledger.db` | Ledger file |
| `AGENT_SYSTEM_PROFILE` | `agent-system-2` | OMP profile name; the profile lives at `~/.omp/profiles/<name>/agent` |

The installer never touches OMP's default profile. as2 runs in its own profile, which does not load skills from `~/.claude`, `~/.codex` or `~/.agents` (`skills.enable*: false` in `profile/config.yml`).

To prove the installer on your machine without touching your real `$HOME`, run `bash install/fresh-machine-test.sh`. It clones the checkout into a temporary directory, installs under a temporary `$HOME`, and checks the ledger, profile, skills, extensions, launcher and refusals. It exits 0 when every check passes and leaves its work directory in place as evidence.

## 3. The isolated test runner (optional, uses sudo)

Lanes cannot run the full test suite inside the write fence. They call `lane_full_test`, which runs the suite outside the fence as a separate macOS user, `_as2test`, with an empty environment and a throwaway home ([concepts.md](concepts.md#the-test-runner)). The runner only serves repositories listed under `testRunner.repos` in `profile/config.yml`; for any other repository `lane_full_test` refuses and the close check does not apply.

Set the user up once, as yourself, from the checkout:

```sh
bash install/as2test-setup.sh --dry-run   # print the plan; nothing changes, sudo is not called
bash install/as2test-setup.sh             # previews each step, asks before each, uses sudo
```

It creates:

- the hidden user and group `_as2test` (the first id of 600 or above free for both), shell `/usr/bin/false`, home `/var/empty`;
- `/Users/Shared/as2test/` with `stage/`, `runs/` and `locks/`;
- `/usr/local/libexec/as2test/`, holding the `exec` wrapper, a copy of your `bun`, a bundled `test-exec.js`, a `SOURCE` record with the checksum of every installed file and every bundle input, the `refresh` helper that rebuilds the bundle from origin/main, and `refresh.d/`, the helper's root-only lock, mirror and staging directory;
- `/etc/sudoers.d/as2test`, checked with `visudo` before it is moved in, with two lines: `<you> ALL=(_as2test) NOPASSWD: /usr/local/libexec/as2test/exec`, which runs the tests, and `<you> ALL=(root) NOPASSWD: /usr/local/libexec/as2test/refresh ""`, which runs the helper as root with no arguments and nothing else.

Its last step runs the helper, which builds the bundle from origin/main. After that the runner keeps the bundle current itself: when a pull or merge changes `surface/scripts/test-exec.ts` or a file it imports, the runner's preflight runs the helper once and checks again ([USER-GUIDE.md](../USER-GUIDE.md) § 5). Re-run setup only after a Bun upgrade, after a change to the refresh helper itself, or when the runner's reason ends in `re-run install/as2test-setup.sh` ([troubleshooting.md](troubleshooting.md#the-test-runner-says-re-run-installas2test-setupsh)). `bash install/as2test-setup.sh --undo` removes only what `SOURCE` says setup created.

To let the runner serve your own repository, add it under `testRunner.repos` in `profile/config.yml` by its GitHub `owner/repo` and test command, then re-run `bash install/install.sh`. The shipped template lists only `thewolff/agent-system-2.0` with `bun test`.

## 4. First launch

```sh
as2
```

`as2` renders the orchestrator's system prompt to `~/.agent-system-2/orchestrator/system.md` from `voice/VOICE.md` and `contract/output-types.md`, then runs:

```sh
env <OTEL_…=…> OMP_PROFILE=agent-system-2 AGENT_SYSTEM_ROLE=orchestrator omp --cwd <checkout> --append-system-prompt ~/.agent-system-2/orchestrator/system.md
```

`as2 --print` shows that command without running it. The working directory is always the checkout, whatever directory you start from. The `OTEL_…` words are the tracing switch (`observability.phoenix`, `all` by default): the orchestrator's spans go to the local Phoenix at `http://127.0.0.1:6006`, project `as2-orchestrator`. `as2 phoenix off` leaves only `OTEL_SDK_DISABLED=true`; see USER-GUIDE § *Trace to Phoenix*.

The profile sets `setupVersion`, so OMP's first-launch wizard, including its sign-in scene, is skipped. Log in to each provider the installer named with `/login` inside the session. Credentials are stored in the profile's own `agent.db`, so logins in OMP's default profile do not carry over.

On its first wake the orchestrator chooses a name and pronouns for itself and records them in the ledger. Each wake (launch, restart, compaction) opens with the ledger rendered: a *needs you* section and one line per open workload.

Other launcher commands:

| Command | Effect |
|---|---|
| `as2 off` / `as2 on` | Set `gates.fence.enabled` in the installed profile's `config.yml` to `false` / `true`. A re-install resets it to the template's value (`true`) |
| `as2 lane <workload>` | Run a user-driven workload's lane in this terminal |
| `as2 lane stop <workload>` | Ask the workload's lane to stop |
| `as2 lane log <workload>` | Print the path of the lane's runner log and its last 40 lines (once; it does not follow) |
| `as2 lane cleanup <workload>` | Remove the lane's worktree when it is clean and pushed |

## 5. First workload

Pick a small change in a repository you own that has a GitHub `origin` you can push to, and describe it to the orchestrator in plain words, naming the repository. The template from [USER-GUIDE.md](../USER-GUIDE.md):

```
new workload, normal stakes, plan first: <what to build>.
```

What to expect:

1. The orchestrator opens the workload, states the stakes and mode it inferred, and launches a lane. Stakes and mode change with one word (`throwaway`, `production`, `user-driven`).
2. The lane's first slice is a plan. A question appears under *needs you* with the plan's file path; answer `approve`, `revise` or `cancel`.
3. The lane builds, a review hand from another lab reviews, and the lane pushes `wl/<workload>` and opens a PR.
4. Who merges depends on stakes. The lane's first prompt tells it: at `throwaway`, merge when green; at `normal`, merge after the review passes and report it in one line; at `production`, you approve the merge. On the as2 repository itself the lane never merges (`mergeLine`, `surface/src/launch.ts`). This is an instruction in the lane's prompt, not a gate: `gh pr merge` is a reserved action only with `--admin`, while a direct push to a protected branch always is (`gates/src/rows/r06-reserved.ts`).
5. Tell the orchestrator to close the workload. The close renders a decision-log entry into the repository's `.ai/decision-log/` on the lane branch.

For a first run, `throwaway` stakes keep the ceiling at $5 / 1 h and skip review, and `production` keeps every merge with you. [USER-GUIDE.md](../USER-GUIDE.md) has every word the surface understands.

**Before using a real repository:** everything typed into a workload is stored in the ledger, and the decision-log entry a close renders quotes the brief, the slices and the decisions, including your words. That entry is committed and pushed with the lane branch. Do not put secrets in a brief.
