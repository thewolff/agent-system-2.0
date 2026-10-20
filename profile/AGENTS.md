snapshot of OMP 18.8.6, 2026-10-20; drift will occur
# OMP harness card (agent-system 2.0)

The full guides are `{repo}/profile/OMP-HARNESS.md` (all 85 built-in slash commands, the profile's dynamic commands, the launch flags and all 541 settings, each with its OMP source anchor and an Ilex / lane / seat verdict) and `{repo}/profile/OMP-RUNTIME.md` (how OMP behaves at run time: profiles, plugin registries, extension order and events, message delivery, compaction, leases, rpc, MCP, approval, what a hand inherits). Read them on demand; do not @-import them. On any OMP upgrade re-verify both guides and this card, then bump the three snapshot lines.

## Rules

- For any OMP or harness question, read the two guides or the OMP source (`omp://` docs, the installed `@oh-my-pi/pi-coding-agent/src`) before answering; never answer from memory.
- A lane runs `omp --mode rpc --no-ui`. TUI-only slash commands do not exist there: rpc runs only the 45 built-ins with a text handler, and any other `/x` text in a lane goes to the model as plain text.
- No agent types a slash command. OMP dispatches them only from user prompt text, never from model output. Ilex suggests one to Jo; a lane uses none.
- The lane runner cannot steer: it sends only `prompt`, `abort`, `get_state` and `set_model`, so a running lane takes new input only at its next prompt.
- Machinery-owned settings change only in `profile/config.yml` plus a re-install, never with `/settings`: `install/install.sh` section 5 rewrites the profile's config.yml on every install, so a `/settings` edit is lost.
- Settings writes through `cfg://<id>` (and `cfg://<id>/save`) work only in the top-level TUI session, so only Ilex, and only with Jo's approval. Lanes and hands cannot change a setting.
- Hands lose every file named `AGENTS.md`: this card and any project `AGENTS.md` (OMP strips them from subagents: `pi-coding-agent@18.8.6 src/task/structured-subagent.ts` `buildExecutorOptions`). Put what a hand needs in its brief; its tier file names the guides.
- `as2` refuses to start while an OMP plugin registry and Claude's disagree on a plugin's version. It checks the default and the active profile's OMP registry (each profile's XDG data root, `$XDG_DATA_HOME/omp` or `$XDG_DATA_HOME/omp/profiles/<name>`, when that root itself exists, else its legacy `~/.omp` root) and the project registry, and prints match and disable commands per plugin; the OMP disable is the sure fix. Then `as2 plugins` rechecks.
- P-11 row 19: when an input is a question about OMP or how to do something in the harness (a keyword, else the judge), your final reply, your outward reply and question tools, and a hand's `yield` are held, with no limit, until a `read`, `grep` or `find` of an `omp://` doc, an `@oh-my-pi/` source file, or `OMP-HARNESS.md` / `OMP-RUNTIME.md` succeeds. Read the guide first.
- When the running OMP's version differs from an OMP doc's snapshot line, every main-conversation model request carries a notice that the docs are stale. Then check any claim from them against the OMP source or `omp://` docs.
- Skills: the 22 in `{repo}/skills` are the only source. Load one with `read skill://<name>` when its trigger fires.
- Workspace dirs (`--add-dir`, `/add-dir`, `workspace.additionalDirectories`) only add system-prompt roots; they never gate file access. A dir that was never added can still be read and written unless a write policy blocks it (plan mode, the paired-coding gate, a fence), and that policy treats added dirs the same.
- `/add-dir` after start works in the TUI, ACP and between rpc turns. It is refused while a turn streams and for a `/collab` guest ("host-only"); `omp -p` never runs it. Graham's paired-mode note and the per-mode table are in the guide § Pairing and workspace directories.

## Commands Ilex may suggest to Jo (Jo types them)

| Command | Verdict for Ilex (lane: not for as2, every row) |
|---|---|
| `/queue` | use: queue a message behind a running turn |
| `/retry` | use: retry a failed turn |
| `/compact`, `/shake` | use: compact by hand; `/shake` drops old tool output with no model call. Thresholds are machinery-owned |
| `/context` | use: check context use against `compaction.thresholdPercent` 25 |
| `/tools` | use: check which tools the session sees (extension and gate tools) |
| `/dirs` | use: list the session's workspace roots |
| `/jobs`, `/usage` | use: background jobs; provider limits before a long workload |
| `/export`, `/dump`, `/rename` | use: transcript to HTML; transcript to clipboard, with the path of an LLM request JSON it writes to tmp; title the session |
| `/login` | use: once per profile per provider |
| `/settings`, `/setup` | machinery-owned: keys live in `profile/config.yml`; `setupVersion: 2` skips the wizard |
| `/extended-context` | machinery-owned: `extendedContext: true` in config.yml |
| `/mcp` | machinery-owned: the server set is `profile/mcp.json` (`ctx`) plus any project MCP file in the cwd; Jo may `list` or `reconnect` |

Every other built-in is `Jo only` or `not for as2` for Ilex (plan, goal, vibe, loop, collab, wt and others: see the guide).

## Launch flags (machinery-owned; set by `bin/as2` or `surface/src/launch.ts`)

Ilex: `OMP_PROFILE=<profile> omp --cwd <repo> --append-system-prompt <prompt>` (`<profile>`: `$AGENT_SYSTEM_PROFILE` or `agent-system-2`). Lane: `--mode rpc --no-ui --cwd <worktree> --session-dir <dir> --append-system-prompt <file> --max-time <t> [--model <m>] [--resume <id>]`. as2 passes no `--config` and no `--add-dir`.

## Settings that are `use` or `machinery-owned` for Ilex or lanes

| Setting | Verdict |
|---|---|
| `setupVersion` | machinery-owned: `2` |
| `symbolPreset`, `composer.shape`, `theme.dark`, `theme.light`, `hideThinkingBlock`, `display.hideToolActivity`, `display.showTokenUsage`, `display.showTurnTime`, `display.shimmer`, `tui.resizeScrollback`, `tui.hyperlinks` | machinery-owned: Jo's look, display only (inert in a lane) |
| `compaction.thresholdPercent`, `compaction.methodOrder`, `compaction.modelThresholds`, `extendedContext` | machinery-owned: `25`; shake first; `moonshot/kimi-k2.*` at 180000; `true` |
| `extensions` | machinery-owned: surface, gates, classifier, plugins, in that order, after the ambient `agent/extensions/*` |
| `skills.enabled`, `skills.customDirectories`, `skills.includeSkills`, the seven `skills.enable*` provider keys | machinery-owned: `{repo}/skills` only, 22 names allowlisted, other providers off |
| `modelRoles`, `retry.fallbackChains` | machinery-owned: judge `typesafe/jev-1.13.0`, empty judge chain |
| `task.agentModelOverrides` | machinery-owned: the tier → model table |
| `tools.approvalMode`, `tools.approval` | machinery-owned, unset (OMP default `yolo`, `{}`): the M4 tool-policy slot owns them |
| `tools.xdev` | machinery-owned, unset (`true`): the gates expect xd:// devices |
| `bash.autoBackground.enabled` | machinery-owned, unset (`true`): the fence refuses every bash call while it is false |
| `extensionHandlers.toolCallTimeoutMs` | machinery-owned, unset (30000 ms): the as2 `tool_call` handlers run under it |
| `ask.enabled` | Ilex use: asks Jo; lane machinery-owned: gates drop `ask` unless the workload is user-driven |
| `find.enabled` | use: `auto` turns `find` on because the judge is a jev model |
| `disabledProviders` | lane use (read only): the classifier drops these providers from a tier row; never set by as2 |
| Other `task.*` keys in OMP's task domain (not isolation, worktree, prewalk, advisor or the model badge) | lane use at OMP defaults: they govern the hands a lane spawns; change only in config.yml `task:` |
| `gates`, `testRunner`, `pairSuggest` (not OMP settings) | machinery-owned: read by the fence, the test runner, `as2 pair-suggest` |

Everything else is `Jo only` or `not for as2`; the guide lists every id.
