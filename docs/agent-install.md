# Installing as2: a runbook for an agent

This page is for a coding agent installing as2 on a person's Mac on their behalf. A person installing it themselves should read [getting-started.md](getting-started.md), which explains each step; this page is the same install as commands, expected output, and stop conditions.

## Rules for the agent

- **Run the steps in order.** Each step names its command and the output that counts as a pass.
- **Stop on the first failure** that the step marks **STOP**, and report: the step number, the command, its exit code, and the last lines of its output. Do not work around a failed check.
- **HUMAN** steps need the person at the keyboard: interactive logins, sudo, account sign-ups, and anything that changes their machine outside the as2 checkout and as2's own directories. Ask, wait for their answer, and do not attempt the step yourself.
- **Install no prerequisite without asking.** Steps 2 and 3 give the install command for each missing tool; show it to the person and run it only once they agree.
- Run commands in `zsh` or `bash` from the person's own login, with their real `$HOME`. Nothing on this page needs `sudo` except the optional test-runner setup in step 11, which the person runs.

## Step 1. Platform

```sh
uname -s
```

Pass: prints `Darwin`. Anything else: **STOP**. as2 runs only on macOS (the write fence uses `/usr/bin/sandbox-exec`).

## Step 2. Required tools

Run each check. Collect every miss before asking the person, so they answer once.

| Check | Pass | If it fails |
|---|---|---|
| `git --version` | Prints `git version …` | Ask: `xcode-select --install` (**HUMAN**: it opens a macOS dialog) |
| `bun --version` | `1.3.14` or newer | Ask to run `curl -fsSL https://bun.sh/install \| bash`, then open a new shell |
| `omp --version` | Exactly `omp/18.8.6` | Ask to run `bun install -g @oh-my-pi/pi-coding-agent@18.8.6`. Any version outside 18.8 is a **STOP** until fixed: the gates refuse to run on it (`VERIFIED_HOST` in `gates/src/host.ts`). Another 18.8 patch (for example `omp/18.8.9`) runs, but only 18.8.6 is measured (`MEASURED_HOST` in `gates/src/shell-start.ts`); report it and recommend 18.8.6. Never install OMP without the version pin, and never run `omp update` |
| `gh --version` | Prints `gh version …` | Ask to install it from https://cli.github.com |
| `gh auth status` | Exit 0 | **HUMAN**: `gh auth login` |
| `/usr/bin/sqlite3 --version` | Prints a version | **STOP**: it ships with macOS, so its absence means something else is wrong |

## Step 3. Optional tools

Report which are present. Install none without asking.

| Check | Pass | Meaning of a miss |
|---|---|---|
| `uv tool list` | Contains the line `arize-phoenix v20.3.0` | Tracing to the local Phoenix is on by default but will not start. Offer `uv tool install arize-phoenix==20.3.0` (uv itself: https://docs.astral.sh/uv/getting-started/installation/). Another arize-phoenix version is refused by `install/phoenix-agent.sh`. The install succeeds either way |
| `command -v ctx` | Prints a path | No agent-history search, and no history root is registered. ctx is not published with as2; tell the person and continue |
| `command -v herdr` | Prints a path | No file-link handler in HerdR. Continue |

## Step 4. Accounts (HUMAN)

Ask the person, and record the answers for the report:

1. **Do they have TypeSafe API access?** Required. The judge model `typesafe/jev-1.13.0` is asked before every dispatch, and with no TypeSafe credential every dispatch fails closed (`profile/config.yml`, "Judge role"). The API is at https://api.typesafe.ai. If they have no access, continue the install but report that as2 cannot dispatch work until they do.
2. **Which chat providers will they log in to:** `anthropic`, `openai-codex`, `moonshot`? At least one is required. With fewer than two, warn that every review will park and ask `same-lab` or `wait`, because reviews must run on a lab other than the builder's.

## Step 5. Clone

Ask where they want the checkout. It must not be in a synced or network folder (iCloud Drive, Dropbox, a network share). Then:

```sh
git clone https://github.com/thewolff/agent-system-2.0.git <chosen parent>/agent-system-2.0
cd <chosen parent>/agent-system-2.0
```

Pass: exit 0. Run every later command from this directory.

## Step 6. Prove the installer without touching the real home

```sh
bash install/fresh-machine-test.sh
```

Pass: exit 0 and the line `==> all checks passed`, followed by `work dir kept as evidence: <path>`. Keep that path for the report. It installs into a temporary `$HOME` only, and needs `omp` on PATH. Non-zero: **STOP**; report the last `FAIL` line.

## Step 7. Install

```sh
bash install/install.sh
```

Pass: exit 0, a line `==> install complete: ledger at <home>/.agent-system-2/ledger.db`, and a last line starting `==> first launch: this profile routes to` followed by the provider list. Keep that list for step 12.

| Exit | Meaning | Action |
|---|---|---|
| 1 | Another failure, named on the `install: FAIL:` line | **STOP** |
| 2 | Manifest or profile check failed; nothing written | **STOP**. The `FAIL` line and the lines above it name the cause, for example a file under a machinery directory (`ledger install extensions agents profile skills plugins tiers classifier gates bin surface contract voice`) with no manifest row |
| 3 | The ledger path is in a synced or network folder; nothing written | **STOP**. Ask the person for a local path and re-run with `AGENT_SYSTEM_LEDGER_DB=<path> bash install/install.sh` |
| 4 | A ledger exists at another schema version; nothing written | **STOP**. Report the path; moving the old file aside is the person's call |

Also read the installer's notes and report each one:

- `note: <home>/.local/bin is not on PATH` → step 8.
- `note: Phoenix did not start` → tracing is off until Phoenix is installed; not a failure.
- `note: ctx is not on PATH` / `note: herdr is not on PATH` → expected when step 3 found them missing.
- `backup job written, not loaded` → step 10.

The installer writes one file into OMP's default profile: the link `~/.omp/agent/extensions/as2-open-links.ts`. Tell the person.

## Step 8. PATH

```sh
command -v as2
```

Pass: prints `<home>/.local/bin/as2`. Otherwise ask the person before editing their shell file; the line to add to `~/.zshrc` is `export PATH="$HOME/.local/bin:$PATH"`. Then re-check in a new shell.

## Step 9. Check the install

| Command | Pass |
|---|---|
| `as2 --print` | Exit 0; one line starting `env` that contains `OMP_PROFILE=agent-system-2 AGENT_SYSTEM_ROLE=orchestrator omp --cwd <checkout>` |
| `ls ~/.omp/profiles/agent-system-2/agent` | Includes `agents`, `config.yml`, `mcp.json`, `models.yml`, `sessions` |
| `ls ~/.agent-system-2` | Includes `ledger.db` and `backups` |
| `bash install/phoenix-agent.sh status` | Exit 0 when Phoenix was installed in step 3. Exit 1 is expected when it was not |

Any failure in the first three rows: **STOP**.

## Step 10. Personalize (ask before each)

- **Their own repositories for the test runner.** `testRunner.repos` in `profile/config.yml` lists only `thewolff/agent-system-2.0`. If they want the isolated test runner for their own repositories, add each as `- origin: <owner>/<repo>` with `command: <test command>`, then re-run step 7.
- **Their own voice file.** The orchestrator's voice (`voice/VOICE.md`) and prompts were written for the author, "Jo". `AGENT_SYSTEM_VOICE=<path>` in their shell profile replaces the voice; the name in the prompts stays.
- **Tracing.** If they do not want Phoenix, run `as2 phoenix off` and then `bash install/phoenix-agent.sh off`.
- **The ledger backup job** (**HUMAN** choice): to load it, run the `launchctl bootstrap gui/$(id -u) …` line the installer printed.

Do not install the marketplace copies of `i-have-audhd`, `ask-graham` or `paired-coding` for as2 (`omp plugin install`). as2 ships `i-have-audhd` and `ask-graham` itself and disables the marketplace copies (`disabledExtensions` in `profile/config.yml`). `paired-coding`, which provides the `pair_*` tools, is not shipped on `main`; after PR #258 merges it ships under `plugins/paired-coding/` and loads in by-hand lanes.

## Step 11. Test runner (HUMAN, optional)

Only if the person wants lanes to run full test suites, and only from a clean checkout whose `origin` is `thewolff/agent-system-2.0` (setup refuses any other). Run the dry run yourself and show its output:

```sh
bash install/as2test-setup.sh --dry-run
```

The real setup uses sudo and asks before each step, so the person runs it: `bash install/as2test-setup.sh`. `bash install/as2test-setup.sh --undo` reverses it.

## Step 12. First launch and logins (HUMAN)

The person runs, in their own terminal:

```sh
as2
```

Inside the session they run `/login` once for each provider from the step 7 provider list, `typesafe` included. Logins are per OMP profile: logins in OMP's default profile do not carry over. You cannot do this step: `/login` is interactive inside OMP's terminal UI.

The judge and the logins are proved only by the first workload's first dispatch. Suggest a small `throwaway` workload in a repository they can push to ([getting-started.md](getting-started.md#7-first-workload)).

## Step 13. Report

Report, in this order:

1. **Waiting on the person:** each HUMAN step not yet done (TypeSafe access, `gh auth login`, `/login` per provider, the backup job, the test runner).
2. **Results:** the output of steps 1, 2, 3, 6 (with the work directory), 7 (the provider list and every note), 8 and 9.
3. **Skipped:** each optional step not run, and why.
4. **Changed on the machine:** the checkout path, `~/.agent-system-2/`, `~/.omp/profiles/agent-system-2/`, `~/.omp/agent/extensions/as2-open-links.ts`, `~/.local/bin/as2`, `~/Library/LaunchAgents/com.agent-system-2.ledger-backup.plist`, and, when Phoenix started, `~/Library/LaunchAgents/com.agent-system-2.phoenix.plist` and `~/.agent-system-2/phoenix/`. The undo for each is in [getting-started.md § 8](getting-started.md#8-uninstall).
