# Getting started

This page takes a Mac from nothing to a first workload, top to bottom. as2 has been installed on one machine, its author's. `install/fresh-machine-test.sh` proves the installer against a temporary `$HOME` on that machine, but no second user has installed it yet ([MIGRATION.md](../MIGRATION.md) items 25 and 95). Expect rough edges, and read [configuration.md](configuration.md) for what assumes the author's setup.

An agent installing as2 on someone's behalf should follow [agent-install.md](agent-install.md) instead: the same steps as checks with expected output, with the steps only a person can do marked.

## 1. Prerequisites

The installer checks only for `bun`. Everything else below is needed at run time, and a missing piece shows up later as a refused call rather than at install. Writing the prerequisites down and checking them at install is planned ([MIGRATION.md](../MIGRATION.md) item 25). Install them in this order.

### Required

| Need | Install | Check | Why |
|---|---|---|---|
| **macOS** | | `uname -s` prints `Darwin` | The write fence runs every bash call under `/usr/bin/sandbox-exec` (`gates/src/fence.ts`); the test-runner setup uses `dscl`; the backup and Phoenix jobs are launchd agents. No Linux support: on a non-macOS host the installer skips the backup job, and the fence has no equivalent |
| **git** | Comes with Apple's Command Line Tools: `xcode-select --install` | `git --version` | Lanes work in git worktrees and push branches |
| **Bun** 1.3.14 or newer | `curl -fsSL https://bun.sh/install \| bash` ([bun.sh](https://bun.sh)), then open a new terminal | `bun --version` | The ledger module uses `bun:sqlite`; every script and test runs on Bun. The repository's GitHub workflow pins 1.3.14 |
| **OMP (oh-my-pi) 18.8.6** | `bun install -g @oh-my-pi/pi-coding-agent@18.8.6` | `omp --version` prints `omp/18.8.6` | as2 is a set of OMP extensions, tier files and a profile. **Pin the version.** The gates refuse to run on an OMP whose major.minor is not `VERIFIED_HOST` in `gates/src/host.ts` (`18.8`), and 18.8.6 is the exact release the shell facts were measured on (`MEASURED_HOST` in `gates/src/shell-start.ts`). A plain `bun install -g @oh-my-pi/pi-coding-agent` installs the newest release, which is past 18.8, and the gates then refuse its calls. For the same reason, do not run `omp update` |
| **GitHub CLI (`gh`), logged in** | [cli.github.com](https://cli.github.com), then `gh auth login` | `gh auth status` exits 0 | A workload close pushes the lane branch and makes sure a PR exists through `gh`; the test runner reads PRs with `gh pr list -R <owner/repo>`. Not checked by the installer ([MIGRATION.md](../MIGRATION.md) item 17). Lanes push to the repository's `origin`, so work on repositories you can push to |
| **`sqlite3` CLI** | Ships with macOS | `/usr/bin/sqlite3 --version` | `install/as2test-setup.sh --undo` reads the runner lock with it; `install/fresh-machine-test.sh` inspects the ledger with it. The ledger itself is written only through Bun |
| **A TypeSafe credential** | See [Provider accounts](#provider-accounts) | | The judge model. Without it every dispatch fails closed |
| **At least one chat provider account; two for normal reviews** | See [Provider accounts](#provider-accounts) | | The tier rows; reviews run on a second lab |

### On by default, optional

| Need | Install | Check | Without it |
|---|---|---|---|
| **Phoenix** (local trace viewer): arize-phoenix **20.3.0** as a `uv` tool | Install [uv](https://docs.astral.sh/uv/getting-started/installation/), then `uv tool install arize-phoenix==20.3.0` | `uv tool list` shows `arize-phoenix v20.3.0` | The installer turns tracing on by default (`observability.phoenix: all` in `profile/config.yml`) and runs `install/phoenix-agent.sh on`, which installs a LaunchAgent serving Phoenix at `http://127.0.0.1:6006`. With no `phoenix` on PATH, or another arize-phoenix version (`CHECKED_VERSION` in `install/phoenix-serve.py`), it prints a note and the install still succeeds; as2's sessions then drop their trace spans. To turn tracing off instead, run `as2 phoenix off` after the install |
| **ctx** (agent-history search) | Not published with as2; ask the person who shared as2 with you | `ctx --version` | `profile/mcp.json` starts `ctx mcp serve` as an MCP server, and the installer registers the profile's session directory as a ctx history root when `ctx` is on PATH. Without it the installer prints a note and skips the registration. Keep the `ctx` entry in `profile/mcp.json` either way: the installer refuses a file without it |

### Optional

| Need | What it adds |
|---|---|
| **sudo** on your account | The isolated test runner ([section 5](#5-the-isolated-test-runner-optional-uses-sudo)) |
| **HerdR** | A file-link handler only. When `herdr` is on PATH the installer runs `herdr plugin link install/herdr-file-links`; otherwise it prints a note. Nothing in as2's machinery needs it |

### Provider accounts

The installer's last line names the providers the rendered profile routes to. From `profile/config.yml` today they are:

| Provider (OMP name) | Used for |
|---|---|
| `anthropic` | Row 1 of every tier (`fast`, `standard`, `strong`, `deep`) |
| `openai-codex` | Row 2 of every tier |
| `moonshot` | Row 3 of every tier |
| `typesafe` | The judge model `typesafe/jev-1.13.0`, which the classifier asks before every dispatch |

You log in to each inside the as2 session with `/login`, after the install ([section 6](#6-first-launch)).

- **The judge is required.** The classifier's 0.55 confidence threshold was measured on `typesafe/jev-1.13.0` only, and the classifier refuses to route on an answer from any other model. With no TypeSafe credential, every dispatch fails closed (`profile/config.yml`, "Judge role"). Get TypeSafe API access before installing; the API and its documentation are at [api.typesafe.ai](https://api.typesafe.ai/docs), the `baseUrl` in `profile/models.yml`. The credential comes from `/login` in the as2 session or from `TYPESAFE_API_KEY` in the environment (the comment in `profile/models.yml`). Making the judge any judge-capable model, with the threshold re-measured, is planned ([MIGRATION.md](../MIGRATION.md) item 95).
- **One chat provider works, with a cost in reviews.** At spawn the classifier keeps only the row entries that are in OMP's model registry and have credentials (`usableRow`, `classifier/extension.ts`), so a tier runs on whichever providers you are logged in to. Reviews must run on a lab other than the builder's. With only one lab available, every review parks and asks you `same-lab` or `wait` (see [concepts.md](concepts.md#review-routing-by-lab)).
- The ceilings are nominal list prices as OMP computes them. The design assumes flat-rate subscriptions for the three chat providers ([SPEC-2.0.md](../SPEC-2.0.md) § B11), so a ceiling bounds a share of subscription capacity, not a bill.

## 2. Install

Clone anywhere outside a synced folder (not iCloud Drive, Dropbox or a network share), then run the installer from the checkout:

```sh
git clone https://github.com/thewolff/agent-system-2.0.git
cd agent-system-2.0
bash install/install.sh
```

To prove the installer on your machine first without touching your real `$HOME`, run `bash install/fresh-machine-test.sh` from the checkout. It clones the checkout into a temporary directory, installs under a temporary `$HOME`, and checks the ledger, profile, skills, extensions, launcher and refusals; it needs `omp` on PATH, because it asks OMP to load the profile. It exits 0 and prints `==> all checks passed` when every check passes, and leaves its work directory in place as evidence.

`install/install.sh` reads `install/manifest.tsv` and runs every check before it writes anything, so a failed install leaves the machine as it found it. It is safe to re-run. In order, it:

1. Validates the manifest and refuses any file under a machinery directory (`ledger install extensions agents profile skills plugins tiers classifier gates bin surface contract voice`) that has no manifest row, and any symbolic link under one.
2. Renders `profile/config.yml` with `{repo}` replaced by the checkout's absolute path, and checks that `skills.includeSkills` matches the manifest's skill rows exactly. The tracing switch `observability.phoenix` keeps the value already installed, so `as2 phoenix off` survives a re-install.
3. Creates or verifies the ledger at `$HOME/.agent-system-2/ledger.db` (schema version 5). It refuses a synced or network folder (exit 3) and a ledger at another schema version (exit 4); there is no upgrade path from older versions.
4. Takes a first backup copy of the ledger, under `backups/` beside it.
5. Writes a launchd plist for the periodic backup to `~/Library/LaunchAgents/com.agent-system-2.ledger-backup.plist`. It does **not** load it; it prints the `launchctl bootstrap` command to load it and the `launchctl bootout` command to unload it.
6. Writes the OMP profile to `~/.omp/profiles/agent-system-2/agent/`: `config.yml` (rendered), `models.yml`, `mcp.json`, and symbolic links from `agents/` to the six tier files in `tiers/`. Skills are used in place from `<checkout>/skills` and the vendored plugins' `skills/` directories.
7. Links `gates/extensions/open-links.ts` into **OMP's default profile** as `~/.omp/agent/extensions/as2-open-links.ts`, a file-link handler for OMP sessions outside as2. When `herdr` is on PATH it also runs `herdr plugin link install/herdr-file-links`.
8. Links `bin/as2` to `~/.local/bin/as2`, and prints a note when `~/.local/bin` is not on PATH.
9. Registers the profile's session directory as a ctx history root named `omp-agent-system-2-sessions`, when `ctx` is installed.
10. On macOS, unless `observability.phoenix` is `off`, runs `bash install/phoenix-agent.sh on`: copies Phoenix's wrapper scripts to `~/.agent-system-2/phoenix/bin/`, writes and loads `~/Library/LaunchAgents/com.agent-system-2.phoenix.plist`, and waits up to 240 seconds for Phoenix to answer. A Phoenix that does not start is a printed note, not a failed install.
11. Prints the providers to log in to.

`as2 install` runs the same script once the launcher is on PATH. The installer also takes three flags for optional launchd jobs (`--chaos-nightly`, `--scratch-sweep`, `--train-tick`); none is needed for normal use, and each is described in the header of `install/install.sh`.

| Environment variable | Default | Effect |
|---|---|---|
| `AGENT_SYSTEM_LEDGER_DB` | `$HOME/.agent-system-2/ledger.db` | Ledger file |
| `AGENT_SYSTEM_PROFILE` | `agent-system-2` | OMP profile name; the profile lives at `~/.omp/profiles/<name>/agent` |

as2 runs in its own OMP profile, which does not load skills from `~/.claude`, `~/.codex` or `~/.agents` (`skills.enable*: false` in `profile/config.yml`). The installer writes one file into OMP's **default** profile, the `as2-open-links.ts` link in step 7; nothing else it writes is under `~/.omp/agent/`.

If the installer says `~/.local/bin` is not on PATH, add it and open a new terminal:

```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

## 3. Check the install

Each of these should hold before the first launch:

| Check | Expected |
|---|---|
| `command -v as2` | `<your home>/.local/bin/as2` |
| `as2 --print` | Exit 0, and one line starting `env` that contains `OMP_PROFILE=agent-system-2 AGENT_SYSTEM_ROLE=orchestrator omp --cwd <checkout>`. It renders the orchestrator's prompt and prints the command without starting OMP |
| `ls ~/.omp/profiles/agent-system-2/agent` | Includes `agents`, `config.yml`, `mcp.json`, `models.yml` and `sessions` |
| `ls ~/.agent-system-2` | Includes `ledger.db` and `backups` |
| `bash install/phoenix-agent.sh status` | Exit 0 when Phoenix is installed and healthy. Exit 1 when it is not running; as2 still works without it |

The judge and the provider logins can only be checked from inside a session: the first workload's first dispatch is the real test ([section 7](#7-first-workload)).

## 4. Plugins

as2 ships the plugins it uses inside the repository, under `plugins/`, copied from one pinned commit of the author's plugin repository (`plugins/VENDOR.md`). You install no plugin to run as2.

| Plugin | What it does in as2 | Where it runs | Turn it down or off |
|---|---|---|---|
| `i-have-audhd` (1.0.0) | Injects a message-shape guide (what needs you first, one closing ask last) and runs a warn-only check on replies. Written for the author, who has ADHD and is autistic | The orchestrator session only (`plugins/index.ts` loads nothing unless `AGENT_SYSTEM_ROLE=orchestrator`) | `I_HAVE_AUDHD_INJECT=off` in the environment stops the guide; `touch ~/.claude/.i-have-audhd-off` stops the check (`plugins/i-have-audhd/README.md`) |
| `ask-graham` (0.2.0) | A "should we build this?" check on new ideas | The orchestrator session only | Its default level is `ask`, so it runs only when you ask for it (`plugins/ask-graham/README.md` § Intensity) |

**Do not also install `i-have-audhd` or `ask-graham` with `omp plugin install` for use in as2.** OMP loads installed plugins from `~/.omp/plugins` into every profile. as2's profile disables those copies by name (`disabledExtensions` in `profile/config.yml`: `extension-module:i-have-audhd-omp` and `extension-module:ask-graham-omp`; clash C11 in `plugins/VENDOR.md`), so only the pinned copy runs. Installing them for your other OMP or Claude Code sessions is fine.

**Pairing.** Driving a workload yourself (a `user-driven` workload, or answering a `pair` offer, then running `as2 lane <workload>`) needs no plugin. Paired coding with agreed change sets, the `pair_start` / `pair_propose` / `pair_write` / `pair_run` tools, needs the `paired-coding` plugin, which as2 does not ship on `main`. Without it, a by-hand lane is a plain user-driven OMP session, and pairing in it is conversation only. Do not install the marketplace `paired-coding` for use in as2: OMP would load it into every as2 session, unpinned and outside as2's gates.

After PR #258 merges: `paired-coding` 1.3.2 ships under `plugins/paired-coding/` and loads only in a lane you run by hand, where its `pair_*` calls pass the same gates as `write`, `edit` and `bash`; `i-have-audhd` and `ask-graham` also run in lanes; and the profile disables the marketplace `paired-coding` copy too.

## 5. The isolated test runner (optional, uses sudo)

Lanes cannot run the full test suite inside the write fence. They call `lane_full_test`, which runs the suite outside the fence as a separate macOS user, `_as2test`, with an empty environment and a throwaway home ([concepts.md](concepts.md#the-test-runner)). The runner only serves repositories listed under `testRunner.repos` in `profile/config.yml`; for any other repository `lane_full_test` refuses and the close check does not apply.

Set the user up once, as yourself, from a checkout with no uncommitted changes whose `origin` is `thewolff/agent-system-2.0` (setup refuses any other origin, including a fork):

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

## 6. First launch

```sh
as2
```

`as2` renders the orchestrator's system prompt to `~/.agent-system-2/orchestrator/system.md` from `voice/VOICE.md` and `contract/output-types.md`, then runs:

```sh
env <OTEL_…=…> OMP_PROFILE=agent-system-2 AGENT_SYSTEM_ROLE=orchestrator omp --cwd <checkout> --append-system-prompt ~/.agent-system-2/orchestrator/system.md
```

`as2 --print` shows that command without running it. The working directory is always the checkout, whatever directory you start from. The `OTEL_…` words are the tracing switch (`observability.phoenix`, `all` by default): the orchestrator's spans go to the local Phoenix at `http://127.0.0.1:6006`, project `as2-orchestrator`. `as2 phoenix off` leaves only `OTEL_SDK_DISABLED=true`; see USER-GUIDE § *Trace to Phoenix*.

The profile sets `setupVersion`, so OMP's first-launch wizard, including its sign-in scene, is skipped. Log in to each provider the installer named with `/login` inside the session, `typesafe` included. Credentials are stored in the profile's own `agent.db`, so logins in OMP's default profile do not carry over.

On its first wake the orchestrator chooses a name and pronouns for itself and records them in the ledger. Each wake (launch, restart, compaction) opens with the ledger rendered: a *needs you* section and one line per open workload.

The prompts and the voice document were written for the author and call the operator "Jo" ([configuration.md](configuration.md#the-human-and-the-authors-setup)). Point `AGENT_SYSTEM_VOICE` at your own voice file to replace the voice; the name in the prompts stays until the personal layer is split out ([MIGRATION.md](../MIGRATION.md) item 26).

Other launcher commands:

| Command | Effect |
|---|---|
| `as2 off` / `as2 on` | Set `gates.fence.enabled` in the installed profile's `config.yml` to `false` / `true`. A re-install resets it to the template's value (`true`) |
| `as2 phoenix off` / `as2 phoenix all` | Set the tracing switch in the installed profile; a re-install keeps it |
| `as2 lane <workload>` | Run a user-driven workload's lane in this terminal |
| `as2 lane stop <workload>` | Ask the workload's lane to stop |
| `as2 lane log <workload>` | Print the path of the lane's runner log and its last 40 lines (once; it does not follow) |
| `as2 lane cleanup <workload>` | Remove the lane's worktree when it is clean and pushed |
| `as2 --help` | Every launcher command |

## 7. First workload

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

If the first dispatch is refused, the refusal names the reason; [troubleshooting.md](troubleshooting.md#every-hand-dispatch-is-refused) covers a missing login, a missing judge credential and an unusable tier row.

**Before using a real repository:** everything typed into a workload is stored in the ledger, and the decision-log entry a close renders quotes the brief, the slices and the decisions, including your words. That entry is committed and pushed with the lane branch. Do not put secrets in a brief.

## 8. Uninstall

There is no uninstall script. Each line below reverses one thing the installer or the optional setup wrote; run the ones that apply, from the checkout, in this order. Quit every `as2` session and lane first.

```sh
# Optional launchd jobs, only if you installed them with a flag (needs no bun; safe when absent)
bash install/install.sh --chaos-nightly=off --scratch-sweep=off --train-tick=off

# Phoenix: stop the LaunchAgent and remove its plist (prints, never runs, the rm -r for its data)
bash install/phoenix-agent.sh off

# The ledger backup job: unload it if you loaded it, then remove its plist
launchctl bootout gui/$(id -u)/com.agent-system-2.ledger-backup
rm ~/Library/LaunchAgents/com.agent-system-2.ledger-backup.plist

# The isolated test runner, only if you set it up (uses sudo; removes only what its SOURCE records)
bash install/as2test-setup.sh --undo

# The ctx history root and the HerdR link, only if ctx / herdr were on PATH at install
ctx sources remove omp-agent-system-2-sessions
herdr plugin unlink as2.file-links

# The link in OMP's default profile, and the launcher
rm ~/.omp/agent/extensions/as2-open-links.ts
rm ~/.local/bin/as2
```

The last two steps delete data, so they are kept apart. `~/.omp/profiles/agent-system-2/` holds the profile, its provider logins (`agent.db`) and every session transcript. `~/.agent-system-2/` holds the ledger, its backups, the Phoenix trace data and lane state. Move them aside rather than deleting them if you may want the history:

```sh
mv ~/.omp/profiles/agent-system-2 ~/as2-profile-removed
mv ~/.agent-system-2 ~/as2-state-removed
```

Lane worktrees live beside each repository, at `<parent>/<repo name>-lanes/<workload>/`; `as2 lane cleanup <workload>` removes a clean, pushed one, and `git worktree remove` removes the rest. OMP, Bun, uv and Phoenix are yours to keep or remove.
