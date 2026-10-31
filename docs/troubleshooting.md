# Troubleshooting

Each entry here is grounded in the code or in [MIGRATION.md](../MIGRATION.md). For a workload that looks stuck (a parked lane, a spent ceiling, "cannot close", "which one?"), start with [USER-GUIDE.md](../USER-GUIDE.md) § 6.

## Install

### `install: FAIL` with exit 2: unmanifested file or symbolic link

Every file under a machinery directory (`ledger install extensions agents profile skills tiers classifier gates bin surface contract voice`) needs a row in `install/manifest.tsv`, and no symbolic link may sit under one. Add the row (path, kind, destination, tab-separated) or move the file. The same exit code covers a profile whose `skills.includeSkills` differs from the manifest's `skill` rows, and a `profile/mcp.json` with no `mcpServers.ctx` command.

### Exit 3: ledger path refused

The ledger may not live in a synced or network folder, because SQLite WAL does not work over a network filesystem (`ledger/src/locality.ts`). Set `AGENT_SYSTEM_LEDGER_DB` to a local path. Nothing was written.

### Exit 4: ledger at another schema version

The installer supports schema version 5 only and has no upgrade path. Move the old file aside and re-run to create a new ledger.

### The backup job never runs

The installer writes `~/Library/LaunchAgents/com.agent-system-2.ledger-backup.plist` but never loads it. Run the `launchctl bootstrap gui/$(id -u) …` line it printed. Unload before re-installing.

## Launch

### `as2` stops before OMP starts

`as2` renders the orchestrator's system prompt from `voice/VOICE.md` (or `AGENT_SYSTEM_VOICE`) and `contract/output-types.md` (or `AGENT_SYSTEM_CONTRACT`) first, and stops, naming the file, when either is missing. It never passes a missing path to OMP, which would read the path as literal prompt text.

### `as2 off` did not stick

`as2 on` and `as2 off` edit the installed profile's `config.yml`. A re-install renders the template again and resets `gates.fence.enabled` to `true`. To keep it off, change `profile/config.yml` in the checkout.

### Every hand dispatch is refused

- **No credentials.** Logins are per OMP profile and stored in the profile's own `agent.db`; logins in OMP's default profile do not count. Run `/login` in the as2 session for each provider the installer named.
- **No judge.** The classifier routes only on `typesafe/jev-1.13.0` and fails closed without a TypeSafe credential, or when the judge in the profile differs from the calibrated one.
- **No usable model in the tier's row.** The refusal lists each row entry with its reason (`not in the model registry`, `provider disabled`, `no credentials`).

### Every review parks with a `same-lab` / `wait` question

Reviews must run on a lab other than the builder's. With credentials for one lab only, there is no other lab. Answer `same-lab` for each review, or log in to a second provider from another lab ([concepts.md](concepts.md#review-routing-by-lab)).

## Lanes and the fence

### Every bash call is refused after an OMP update

The gates read OMP settings through host members verified on one OMP major.minor (`VERIFIED_HOST` in `gates/src/host.ts`, `18.8` today) and refuse every bash call on any other, with a line naming both versions. Go back to an 18.8 release, or re-verify: run `bun test gates/test/host.test.ts` against the new host before bumping the pin.

### Every bash call is refused for the rest of a session

The fence checks after the fact that the command which ran was its own wrapper. If another extension loaded after the gates replaced or blocked a bash call, the fence records a bypass in the ledger and refuses every later bash call until the session restarts (`gates/src/fence.ts`). The fence also refuses bash outright while OMP's `bash.autoBackground.enabled` is `false`; leave that setting unset.

### A command works in a normal shell but fails inside a lane

Fenced bash calls run under `sandbox-exec` with macOS `/bin/bash` 3.2, not OMP's built-in shell (`gates/src/fence.ts`):

- bash 4+ features (`declare -A`, `${x,,}`, `mapfile`) are unavailable;
- setuid binaries such as `/bin/ps` exit 126 under any Seatbelt profile;
- a command containing an OMP internal URL (`skill://`, `artifact://`, `agent://`, ...) is refused, because the wrapper quotes the whole command and OMP would not expand it;
- a command that runs `sandbox-exec` itself is refused;
- writes to the ledger directory and to `.git/hooks` fail.

### The test runner says "re-run install/as2test-setup.sh"

The runner's preflight compares the installed `_as2test` setup with what `SOURCE` records (`installDecision` in `surface/src/as2test.ts`). A reason ending in `re-run install/as2test-setup.sh` is an install problem the refresh helper cannot fix: the `_as2test` account is missing or its ids differ from `SOURCE`, `SOURCE` is missing or does not parse, a path under `/usr/local/libexec/as2test/` or `/Users/Shared/as2test/` has the wrong owner or mode, or the installed `bun` or `refresh` no longer matches its sha-256 in `SOURCE`. A Bun upgrade does not trip it, since setup installed a copy, but the runner keeps that old copy until you re-run setup. Re-run `bash install/as2test-setup.sh` from the checkout the runner uses.

Drift in the bundle itself (an installed `exec` or `test-exec.js`, or a change to `surface/scripts/test-exec.ts` or a file it imports) never ends this way: the runner runs the refresh helper, which rebuilds the bundle from the commit `refs/tags/as2-verified` names (fetched from the fixed origin, never `origin/main`), and checks again ([USER-GUIDE.md](../USER-GUIDE.md) § 5). When that fails, the reason is one of the two below.

### The test runner says `bundle-refresh-failed`

The refresh helper, `/usr/local/libexec/as2test/refresh`, failed, and the reason names its exit code and the last line it wrote to stderr (`installCheck` in `surface/scripts/test-runner.ts`). The run ends as `error`, without a question to you.

- **70, fetch:** the helper could not fetch `refs/tags/as2-verified` from `https://github.com/thewolff/agent-system-2.0.git`, or the tag is missing or names no commit. Check the network or GitHub's status, then let the next run retry; there is nothing to repair. When setup's own last step fails this way, setup has already installed a provisional `SOURCE`: the next run's preflight finds `exec` and `test-exec.js` unbuilt and runs the helper again, a re-run of setup takes over the account it created, and `--undo` removes everything.
- **71, build:** the runner's reason reads `build (exit 71: <libexec>/resources.json missing or unusable, or the build, a check of its output, a signal or the helper's cap stopped it)`, then the helper's last stderr line, which says which. When the fetched commit's `render-exec` refuses, that line is `as2test-refresh: as2test.ts render-exec at <sha> failed (exit N): ` followed by render-exec's cause: its last stderr line that is not blank, a stack frame or the `Bun v<version> (<os> <arch>)` line Bun ends an uncaught error with, such as `as2test: render-exec: refusing to render an executor that cannot admit a test part: …` or `error: <message>`; `it wrote no cause line to stderr` means it wrote none of those. render-exec's whole stderr streams to the helper's stderr as it is written, so it is there above that line, and above `ended by a signal` or `stopped at its own 840 s cap` when either stopped render-exec. A helper installed before that change ends with the bare `as2test.ts render-exec at <sha> failed` line instead, and render-exec's reason is the line above it, which the runner does not keep: run `sudo -n /usr/local/libexec/as2test/refresh` yourself to read it. A missing or unusable `resources.json` (not a regular root-owned file, writable by a group or other, or not a measured policy): re-run setup with `--resources=/absolute/measured-policy.json`; nothing was fetched or installed. Otherwise the tagged commit's build is broken: `surface/scripts/test-exec.ts` does not compile at the commit `refs/tags/as2-verified` names, or a check of the built output failed. Fix it on `main`; the next run picks it up once the tag names the fix. If that commit changed the `render-exec` or `bundle-inputs` command the helper calls, re-run setup to install the matching helper. The same code, with `ended by a signal` or `stopped at its own 840 s cap` and `nothing was installed`, means the helper ended what it was running and left the install as it was; the next run retries.
- **`… after the runner's 15 min cap`:** the helper was still running when the runner stopped waiting; the runner signals only its own `sudo`, so the helper's own 14-minute cap is what ends the root process. If this repeats, look for a hung fetch or build in `runner.log`.
- **69, lock:** another refresh held the helper's lock for 10 minutes. Wait for it to finish, then run again.
- **72, install:** installing the built files failed. **64, usage:** the helper was given arguments. **77, not root:** it did not run as root. Each points at a damaged install; re-run setup.
- **`failed (exit N)`** names a code the helper does not define, such as sudo refusing the call when the second sudoers line is missing; re-run setup.

The same reason, `the helper exited 0 but installed exec does not match SOURCE` (or `test-exec.js`), means the helper reported success and a file still mismatches. Re-run setup.

### The test runner says `checkout-drift`

The refresh worked, but a bundle input in the runner's checkout (your main checkout) still differs from the bundle, because the checkout is not at the commit `refs/tags/as2-verified` names: behind, ahead, on another branch, or carrying local edits. The reason names the file, the checkout, its HEAD and that commit's sha. Bring the checkout to that commit: normally check out `main`, clean, and pull, once the tag names main's head. The helper builds only the tagged commit, so another refresh, or setup, cannot fix it.

### `lane_full_test` refuses

The runner serves only repositories listed under `testRunner.repos` in the profile, by GitHub `owner/repo` origin, and only github.com remotes map to one. Add your repository there and re-install ([configuration.md](configuration.md#profileconfigyml-keys)).

### A merged change does not take effect

A running session keeps the code it started with. Restart `as2` after merges that change surface or lane code ([USER-GUIDE.md](../USER-GUIDE.md) § 5). Every merge to `main` reaches the running system at the next restart; there are no releases yet ([MIGRATION.md](../MIGRATION.md) item 35).

## Long-running use

### The orchestrator compacts every few hours

Each wake (launch, restart, compaction) renders the ledger into the orchestrator's context. Until commit `c86c514` the wake re-sent every open workload's full block, which on a busy ledger filled most of the post-compaction context and caused repeated compaction. The wake now renders one line per open workload; the full block comes from `orchestrator_ledger` with a workload id. If compaction still loops, close finished workloads: the wake size grows with the number of open workloads. The profile compacts at 25 % of the context window (`compaction.thresholdPercent`).

### Disk use grows under `~/.agent-system-2/lanes/`

Each workload's lane directory holds `runner.log` (appended), one `lane-<n>.jsonl` frame log per lane run (appended), and the lane's OMP session files. Nothing in `surface/scripts/lane.ts` deletes them, and `as2 lane cleanup <workload>` removes only the worktree. On the author's machine single workload directories passed 2 GB. Remove directories of closed workloads by hand when you no longer need their transcripts. The test runner, by contrast, keeps its newest 10 runs whole and prunes the rest.

### Lane worktrees pile up beside the repository

Lanes work in `<parent>/<repo name>-lanes/<workload>/`. `as2 lane cleanup <workload>` removes one when its tree is clean and its branch is pushed.
