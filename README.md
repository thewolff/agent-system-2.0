# agent-system-2.0 (as2)

as2 is a coding-agent orchestration system built on [oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi). One person talks to one orchestrator session. The orchestrator opens units of work, hands each to an autonomous OMP session (a *lane*) running in its own git worktree, and lanes dispatch short-lived sub-agents (*hands*) on model tiers chosen per task. Every piece of state lives in one SQLite file, the *ledger*. Mechanical gates sit between the agents and the machine: they refuse unreceipted claims, reserved actions such as a push to a protected branch, and raw writes to the ledger, and an OS sandbox (the *write fence*) wraps every shell command.

The orchestrator names itself on its first run; on the author's machine it is called Ilex, and the docs here use that name.

## Status

- **Pre-1.0 and changing daily.** There are no releases or tags. Every merge to `main` reaches the running system at the next `as2` restart. Shipping as versioned releases is planned, not built ([MIGRATION.md](MIGRATION.md) item 35).
- **macOS only.** The write fence uses macOS `sandbox-exec`, the isolated test runner creates its user with `dscl`, and the backup and nightly jobs are launchd agents. There is no Linux path today.
- **Built for one user.** The prompts, the voice document and several defaults are written for the author, who is referred to as "Jo" throughout the code and docs. Splitting that personal layer into a template is planned ([MIGRATION.md](MIGRATION.md) items 26 and 95). [docs/configuration.md](docs/configuration.md) lists what is hardcoded today.
- **No CI test run.** The one GitHub workflow numbers migration items. The test suite runs locally and on the outside-the-fence test runner (see [docs/concepts.md](docs/concepts.md#the-test-runner)).

## Five-minute tour

1. **You type to the orchestrator.** `as2` starts an OMP session in the orchestrator role. You describe work in plain words; short command words (`approve`, `production`, `ceiling 60 8`) are applied by the surface before the orchestrator reads the turn. [USER-GUIDE.md](USER-GUIDE.md) lists them.
2. **The orchestrator opens a workload.** A workload is one unit of work with a brief, a done line, a repository, *stakes* (`throwaway`, `normal`, `production`) and a *mode* (`autonomous` or `user-driven`). Stakes set the review policy and a spend ceiling ($5 / 1 h, $50 / 6 h, $150 / 12 h). The orchestrator never writes code or dispatches hands itself.
3. **A lane takes the workload.** An autonomous lane is an `omp` process started in a worktree at `<parent>/<repo>-lanes/<workload>/` on branch `wl/<workload>`. At normal stakes its first slice is a plan, which waits for your `approve`. At most three autonomous lanes run at once by default.
4. **The lane splits the work into slices and dispatches hands.** A slice is a leaf task with a done condition, closed only on an artifact (a commit, a test command and its result). Before each dispatch a classifier asks a judge model what kind of task the brief is (`locate`, `understand`, `change-small`, `change-large`, `judge`) and maps it to a tier (`fast`, `standard`, `strong`, `deep`), capped by stakes.
5. **Reviews cross labs.** A review hand runs on a model from a lab (Anthropic, OpenAI, Moonshot/Kimi) that did not build the work. At production stakes every available other lab reviews.
6. **Tests run outside the fence.** For repositories listed in the profile, a lane asks the test runner for the full suite, which runs it as a separate, credential-less macOS user at the PR head and records the result in the ledger.
7. **Questions come back to you.** A lane that needs a decision raises a question with fixed options; it appears under *needs you* in the orchestrator, and you answer with one word. Reserved actions (a push to `main`, a force-push, a deploy) wait for your `approve`. Production merges are yours; at lower stakes the lane is told to merge on its own (after its review, at `normal`), except on the as2 repository itself, where it never merges.
8. **Close renders the record.** Closing a workload renders a decision-log entry from the ledger into the repository's `.ai/decision-log/` and commits it on the lane branch.

## Quickstart

Before you start you need: a Mac, git, Bun, **OMP 18.8.6** (`bun install -g @oh-my-pi/pi-coding-agent@18.8.6`; the gates refuse any OMP outside 18.8, and an unpinned install gets a newer one), the GitHub CLI logged in, **a TypeSafe API credential** for the judge model (without it every dispatch fails closed), and an account with at least one of Anthropic, OpenAI Codex or Moonshot (two for cross-lab reviews). Phoenix (`uv tool install arize-phoenix==20.3.0`) is optional and on by default. [docs/getting-started.md](docs/getting-started.md) gives the install command and check for each; the installer itself checks only for Bun.

```sh
git clone https://github.com/thewolff/agent-system-2.0.git
cd agent-system-2.0
bash install/install.sh
as2
```

Then `/login` to each provider the installer names, inside the `as2` session. The installer writes the ledger and state under `~/.agent-system-2/`, an OMP profile under `~/.omp/profiles/agent-system-2/`, the launcher link `~/.local/bin/as2`, one link in OMP's default profile, and launchd plists; [docs/getting-started.md](docs/getting-started.md) lists each, how to check the install, and how to undo it.

Having an agent do the install for you? Point it at [docs/agent-install.md](docs/agent-install.md).

## Documentation map

| Document | What it covers |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | Prerequisites with install commands, install, checking the install, plugins, the `_as2test` test-runner user, first launch, first workload, uninstall |
| [docs/agent-install.md](docs/agent-install.md) | The install as a runbook for a coding agent: checks, expected output, stop conditions, and the steps only a person can do |
| [docs/concepts.md](docs/concepts.md) | Workloads, slices, lanes, hands, stakes, modes, ceilings, reserved actions, review routing, the test runner, the ledger |
| [docs/configuration.md](docs/configuration.md) | What is configurable and where; what is hardcoded today |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Known failure modes with their fixes |
| [USER-GUIDE.md](USER-GUIDE.md) | The words you type at the orchestrator, and how to read its screen |
| [SPEC-2.0.md](SPEC-2.0.md) | The design rulings, section by section |
| [DESIGN-2.0.md](DESIGN-2.0.md) | What was kept, changed and dropped from the earlier system, and the mechanical-rule (P-11) table |
| [DESIGN-lane-launcher.md](DESIGN-lane-launcher.md), [DESIGN-workload-ceiling.md](DESIGN-workload-ceiling.md) | The lane launcher and the spend ceiling |
| [MIGRATION.md](MIGRATION.md) | Build steps and numbered follow-up items, with status; "planned" in these docs cites an item here |
| [ledger/SCHEMA.md](ledger/SCHEMA.md) | The ledger schema in prose |
