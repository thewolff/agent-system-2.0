snapshot of OMP 18.8.6, 2026-10-20; drift will occur
# OMP runtime guide (agent-system 2.0)

This is the runtime companion to `OMP-HARNESS.md`. That guide is a catalog: what each slash command, launch flag and setting is. This one says how OMP behaves while it runs: which profile files a session reads, how plugins and extensions load and in what order, how a message reaches the model, when hooks fire and when they are skipped, what a hand inherits, and what the rpc protocol offers a lane. It closes the 22-subsystem coverage table of the 2026-10-20 audit of `OMP-HARNESS.md` (PLAN wl-mv8k0fby51uakg D6), one `## ` section per subsystem, under the audit's own subsystem names. Every claim cites the OMP 18.8.6 source (`pi-coding-agent@18.8.6 src/<file>`, `pi-utils@18.8.6 src/<file>` or `pi-agent-core@18.8.6 src/<file>`, plus a symbol), an `omp://` doc, or a command and what it printed on 2026-10-20. Where a fact could not be checked, the text says `(unverified)`. The snapshot line above names the OMP version these facts were read from: on any other OMP, check a fact against the source before acting on it.

Roles are the ones in `OMP-HARNESS.md` § Verdict key and roles: **Ilex** (the as2 orchestrator TUI, as2 profile), **lane** (`omp --mode rpc --no-ui`, as2 profile, driven by `surface/scripts/lane.ts`), **hand** (a `task` subagent of a lane, in the lane's process), **seat** (a HerdR seat on Jo's default profile; the `ilex` seat is Ilex). Each section ends with a verdict row for the four roles.

## Built-in and dynamic slash commands

Covered in full by `OMP-HARNESS.md` § Built-in slash commands (all 85 specs, `pi-coding-agent@18.8.6 src/slash-commands/builtin-registry.ts` `BUILTIN_SLASH_COMMAND_REGISTRY`) and § Dynamic slash commands. The audit adds two corrections, both now applied in that guide's rows:

- `/reload-plugins` refreshes plugin-root caches, task agents, skills, file slash commands, capabilities and MCP connections. It re-imports no extension module or hook file and reloads no custom tool (`pi-coding-agent@18.8.6 src/slash-commands/builtin-marketplace.ts` `reloadTuiPluginState`). After editing an extension (gates, surface, classifier, `agent/extensions/*`), `/restart` or relaunch.
- Over rpc and ACP, `/mcp reload` only refreshes the command list; `reauth`, `unauth`, `reconnect`, `smithery-login`, `smithery-logout` and `notifications` are TUI-only (`pi-coding-agent@18.8.6 src/slash-commands/helpers/mcp.ts` `handleMcpAcp`, `TUI_ONLY_MCP_VERBS`). The TUI's reload re-runs discovery (`pi-coding-agent@18.8.6 src/modes/controllers/mcp-command-controller.ts` `reloadServers` → `discoverAndConnect`).

| Ilex | lane | hand | seat |
|---|---|---|---|
| Jo types; Ilex may suggest (guide columns) | none sent; a `/x` text reaches the model as text | no slash commands | Jo only |

## Settings catalog and defaults

Covered in full by `OMP-HARNESS.md` § Settings (all 541 ids, `pi-coding-agent@18.8.6 src/config/all-settings.ts` `orderedSettings`). The audit adds runtime facts that live in other sections here: the queue-drain settings `steeringMode`, `followUpMode`, `interruptMode` (§ Message delivery semantics), the compaction thresholds as2 sets (§ Compaction runtime (events, stop-hook skip)), `tools.approvalMode` (§ Tool approval policy) and `mcp.enableProjectConfig` (§ MCP sources and OAuth scoping). Protocol hosts (rpc, rpc-ui, ACP) pin settings that declare a `protocolDefault` to that neutral value while nothing configures them (`pi-coding-agent@18.8.6 src/main.ts` `applyProtocolDefaults`).

| Ilex | lane | hand | seat |
|---|---|---|---|
| guide verdicts | guide verdicts; `protocolDefault` values apply where the profile is silent | the lane's settings through a live overlay, with the overrides in § Subagent inheritance | Jo's default profile |

## Launch flags as2 passes

Covered by `OMP-HARNESS.md` § Launch flags, which now also lists the flags no as2 launcher passes (`--no-extensions`, `--no-skills`, `--approval-mode`, `--auto-approve`/`--yolo`, `--trusted-extension`, `--tools`, `--no-rules` and the rest, from `pi-coding-agent@18.8.6 src/cli/flag-tables.ts` and `src/cli/args.ts`), each with its verdict. The three that matter at run time:

- `--no-extensions` sets `disableExtensionDiscovery`. Only explicit `-e`/`--hook` paths load; the settings `extensions:` list, ambient `agent/extensions/*` and the `disabledExtensions` filter all drop (`pi-coding-agent@18.8.6 src/sdk.ts` `discoverSessionExtensionPaths`). For as2 that removes the surface, gates, classifier and plugins, for the session and every hand under it.
- `--no-skills` sets `options.skills = []`; hands inherit the empty list (`pi-coding-agent@18.8.6 src/main.ts`, `if (parsed.noSkills)`; `src/task/structured-subagent.ts` `buildExecutorOptions`).
- `--approval-mode` is a non-persisted override of `tools.approvalMode` (`pi-coding-agent@18.8.6 src/main.ts`, `cfgToolsApprovalMode.override`); see § Tool approval policy for why a lane must not get one.

| Ilex | lane | hand | seat |
|---|---|---|---|
| `bin/as2` argv only; the three above are not for as2 | `laneArgv` only; the three above are not for as2 | no CLI; inherits the parent's resolved set | `launch-seat`'s argv; Jo only |

## Workspace dirs / pairing

Covered in full by `OMP-HARNESS.md` § Pairing and workspace directories (`pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "add-dir"`). The audit adds one hand fact: a hand gets the parent's `additionalDirectories`, except a hand running in an isolation worktree, which gets none (`pi-coding-agent@18.8.6 src/task/executor.ts` `runSubprocess`, the subagent session spec's `additionalDirectories: worktree !== undefined ? undefined : …`; `src/task/structured-subagent.ts` `buildExecutorOptions` only passes the parent's list through). Isolation is off by default (`task.isolation.enabled` false, `pi-coding-agent@18.8.6 src/task/settings.ts`).

| Ilex | lane | hand | seat |
|---|---|---|---|
| guide verdicts | guide verdicts | inherits added dirs unless isolated | guide verdicts |

## Profile directory scoping

`OMP_PROFILE` wins over `PI_PROFILE`; an explicitly empty `OMP_PROFILE` selects the default profile; an invalid name at module load falls back to the default silently (`pi-utils@18.8.6 src/dirs.ts` `resolveProfileEnv`, `readProfileFromEnvSafe`). `setProfile` writes `OMP_PROFILE`, `PI_PROFILE` and `PI_CODING_AGENT_DIR` into `process.env`, so child processes inherit the profile (`pi-utils@18.8.6 src/dirs.ts` `setProfile`; `pi-coding-agent@18.8.6 src/cli.ts`). With a profile active, `PI_CODING_AGENT_DIR` as an agent-dir override is ignored (`pi-utils@18.8.6 src/dirs.ts` `DirResolver`).

A profile has three scopes (`pi-utils@18.8.6 src/dirs.ts` `rootSubdir`, `agentSubdir`, `baseRootSubdir`):

| Scope | Where (as2 profile) | What lives there | Receipt |
|---|---|---|---|
| profile root | `~/.omp/profiles/<profile>/` | `logs/`, `plugins/` (OMP's plugin registry and installs), `marketplaces.json`, `stats.db`, `reports/`, `wt/` (worktrees), `cache/` | `pi-utils@18.8.6 src/dirs.ts` `getLogsDir`, `getPluginsDir`, `getMarketplacesRegistryPath` |
| profile agent dir | `~/.omp/profiles/<profile>/agent/` | `config.yml`, `mcp.json`, `AGENTS.md`, `agents/`, `extensions/`, `agent.db` (credentials and settings), `sessions/`, `terminal-sessions/`, `history.db`, `models.db` | `pi-utils@18.8.6 src/dirs.ts` `getAgentDbPath`, `getSessionsDir`, `getMCPConfigPath` |
| shared by every profile | `~/.omp/run/session-owners`, `~/.omp/run/daemons/global/` | session ownership leases, global daemons | `pi-utils@18.8.6 src/dirs.ts` `getSessionOwnersDir`, `getGlobalDaemonRuntimeRoot` |

So plugins, logs and auth are per profile: nothing in the as2 profile is shared with the default profile's `~/.omp/` except the two shared dirs. On 2026-10-20 `ls ~/.omp/profiles/agent-system-2/` printed `agent autoqa.db cache gpu_cache.json logs puppeteer run stats.db …` and no `plugins/`.

`.env` files are read from `$HOME/.env`, the profile root, the agent dir and the session cwd; a key is set only when the environment lacks it (`pi-utils@18.8.6 src/env.ts`). A `.env` in a lane's worktree can therefore add env vars to that lane.

| Ilex | lane | hand | seat |
|---|---|---|---|
| `bin/as2` pins `OMP_PROFILE` (`agent-system-2` or `$AGENT_SYSTEM_PROFILE`) | same profile (`surface/scripts/lane.ts` sets `env.OMP_PROFILE`); shares `agent.db`, sessions tree and logs dir with Ilex | runs in the lane's process (`pi-coding-agent@18.8.6 src/task/executor.ts` `runSubprocess` calls `createAgentSession`), so same profile and env | default profile: `~/.omp/agent`, `~/.omp/logs`, `~/.omp/plugins` |

## Session resume / selection

`createSessionManager` resolves, in order (`pi-coding-agent@18.8.6 src/main.ts` `createSessionManager`): `--fork`; `--no-session` (in-memory); `--resume <value>`; `--continue`; `--session-dir` alone (new session there); the `autoResume` setting (default false); else a new session.

- **`--resume <value>`.** A value with `/`, `\` or ending `.jsonl` is a path, opened with `throwIfMissing`: a missing file exits with `Session "<arg>" not found.` instead of starting fresh. Any other value is an id or file-name prefix. OMP searches the session dir first; on a miss with **no `--session-dir`** it searches every project's sessions (`pi-coding-agent@18.8.6 src/session/session-listing.ts` `resolveResumableSession` → `listAllSessions`).
- **`--continue` and `autoResume`** pick by a per-terminal breadcrumb, `<agentDir>/terminal-sessions/<terminalId>`, not the newest file (`pi-coding-agent@18.8.6 src/session/session-manager.ts` `continueRecent`; `src/session/session-paths.ts` `readTerminalBreadcrumbEntry`). The terminal id is the tty, else the first of `ZELLIJ_PANE_ID`, `TMUX_PANE`, `CMUX_SURFACE_ID`, `KITTY_WINDOW_ID`, `WEZTERM_PANE`, `TERM_SESSION_ID`, `WT_SESSION` (`pi-tui@18.8.6 src/ttyid.ts`). An rpc lane's stdin is a pipe, so its id comes from those inherited env vars: on 2026-10-20, 6 of the 23 files in `~/.omp/profiles/agent-system-2/agent/terminal-sessions` named a lane session under `~/.agent-system-2/lanes/` (`grep -l "agent-system-2/lanes" … | wc -l` → 6).
- **Where files live.** `<agentDir>/sessions/<encoded cwd>`, per profile (`pi-utils@18.8.6 src/dirs.ts` `getSessionsDir`); `--session-dir` replaces that dir. The JSONL is written lazily, once there is an assistant message (`pi-coding-agent@18.8.6 src/session/session-manager.ts` `#shouldHaveSessionFile`).

| Ilex | lane | hand | seat |
|---|---|---|---|
| no `--session-dir`, so `as2 --resume <prefix>` that misses locally can open another project's session: pass a path or the full id. `--continue` may land on a breadcrumb a lane left in that terminal | `--session-dir` per workload, so prefixes stay local; `--resume` gets the recorded file path, and a deleted file kills the lane at start (`surface/src/launch.ts` `laneArgv`) | no `--resume`; its session file sits under the parent's, or it is in memory (`pi-coding-agent@18.8.6 src/task/structured-subagent.ts`, `src/task/executor.ts` `SessionManager.inMemory`) | breadcrumb per tty, default profile's `terminal-sessions`; a prefix without `--session-dir` falls back globally |

## Compaction runtime (events, stop-hook skip)

`checkCompaction` runs after every non-aborted assistant turn: overflow (promote to a larger model, else recovery compaction and retry), output cut at `length`, and the threshold test (`pi-coding-agent@18.8.6 src/session/session-maintenance.ts` `checkCompaction`). A mid-turn check runs before the next provider request at a tool-loop boundary (`compaction.midTurnEnabled`, default true); idle compaction is off by default (`pi-coding-agent@18.8.6 src/session/context-settings.ts`). as2 sets `thresholdPercent: 25`, `methodOrder: [shake, remote, snapcompact, handoff, soft]` and a Kimi model threshold (`profile/config.yml` «Compaction»); everything else is the OMP default.

- **Shake fires no `session_compact`.** Shake drops whole tool results and big blocks into a session artifact and writes no summary (`pi-coding-agent@18.8.6 src/session/shake-types.ts`). Its pass emits only `auto_compaction_start`/`auto_compaction_end` (`pi-coding-agent@18.8.6 src/session/session-maintenance.ts` `#runAutoShake`). `session_before_compact`, `session.compacting` and `session_compact` fire only when a summarizing method runs. With shake first, a PreCompact-style hook mapped to `session_before_compact` does not run on the passes shake resolves.
- **The stop-hook skip is only on the compacting settle.** At `agent_end`, after `checkCompaction`: a last message with tool calls returns early; if compaction scheduled a continuation or blocked automatic continuation, OMP returns **before** the `session_stop` pass; a pending async wake defers it; only then `#emitSessionStopEvent` runs (`pi-coding-agent@18.8.6 src/session/agent-session.ts`, the `agent_end` handler). A continuation is scheduled when messages are queued, an overflow or promotion retry is due, or auto-continue applies; a plain final text answer with no active goal schedules none (`#scheduleCompactionContinuation`). So an ordinary final answer that crosses the threshold compacts and **then** runs `session_stop`; the skipped case is a settle with queued input, a retry or a dead end, and the continuation turn runs `session_stop` at its own stop.
- **Summarizing methods** keep the newest `keepRecentTokens` (20000) and re-enter the summary as a `user` message with attribution `agent` (`pi-agent-core@18.8.6 src/compaction/compaction.ts` `findCutPoint`; `src/compaction/messages.ts`).
- **Over rpc**, `auto_compaction_*` are frames, and `compact` / `set_auto_compaction` are commands; the lane runner reads and sends none of them (`grep` of `surface/scripts/lane.ts` → no match).

| Ilex | lane | hand | seat |
|---|---|---|---|
| shake runs first at 25%; the as2 `session_stop` gates (r01, r03, r07) still run on final answers except a settle with queued input or a dead end | same; a compaction is invisible to the ledger. A manual rpc `compact` aborts and resumes the turn; that the runner then sees `status:"aborted"` for its prompt is (unverified) | mid-turn checks always on (`createSubagentSettings`); no `session_stop` ever | Jo's default profile sets the same compaction block, so a seat's PreCompact adapter mapping fires only when shake falls through |

## MCP sources and OAuth scoping

`loadAllMCPConfigs` gathers servers from every discovery provider, dedupes by name with the highest-priority provider winning, and, when `mcp.enableProjectConfig` is false, drops project-level entries first (`pi-coding-agent@18.8.6 src/mcp/config.ts` `loadAllMCPConfigs`). `mcp.enableProjectConfig` defaults to **true**, and as2's config does not set it (`pi-coding-agent@18.8.6 src/mcp/settings.ts`).

- **User level**: the profile agent dir's `mcp.json` and `.mcp.json` (`pi-coding-agent@18.8.6 src/discovery/builtin.ts`); for as2 that is `profile/mcp.json`, server `ctx`.
- **Project level, from the session cwd, on by default**: `.omp/mcp.json`, `.omp/.mcp.json` (`src/discovery/builtin.ts`), `.claude/mcp.json`, `.claude/.mcp.json` (`pi-coding-agent@18.8.6 src/discovery/claude.ts`), root `mcp.json`/`.mcp.json` (`pi-coding-agent@18.8.6 src/discovery/mcp-json.ts`), plus `.vscode/mcp.json`, `.cursor/mcp.json` and codex/gemini project files. The foreign-provider opt-in does not gate project files.
- **`~/.claude.json`, `~/.claude/mcp.json`** load only when the `claude` user source is on (§ Foreign provider opt-in).
- **OAuth tokens are per profile.** The credential id is `mcp_oauth:profile:<profile>:<serverUrl>`, stored in that profile's `agent.db` (`pi-coding-agent@18.8.6 src/mcp/oauth-flow.ts`; `src/mcp/oauth-credentials.ts`). A server definition can cross from Claude Code or another profile while its token does not. Only the TUI installs an auth handler; with none (rpc, print) an auth challenge is logged and fails (`pi-coding-agent@18.8.6 src/mcp/manager.ts`, "no auth handler is configured").
- Subagents use the parent's `MCPManager` through proxies; sessions built with `restrictToolNames` get no MCP (`pi-coding-agent@18.8.6 src/sdk.ts` `createAgentSession`).

| Ilex | lane | hand | seat |
|---|---|---|---|
| `ctx` plus any project MCP file in the checkout; runs every `/mcp` verb and the OAuth flow. An OAuth server added to the as2 profile is authorised once here | same user set plus project files in its worktree; cannot start OAuth or `reauth` | the lane's servers through proxies | default profile's `~/.omp/agent/mcp.json` and Claude sources; its own tokens |

## Subagent inheritance

A hand is built by `runStructuredSubagent` → `buildExecutorOptions` → `runSubprocess` → `createAgentSession`, in the lane's process (`pi-coding-agent@18.8.6 src/task/structured-subagent.ts`; `src/task/executor.ts`).

| Input | Does a hand get it? | Receipt |
|---|---|---|
| Base system prompt | Rebuilt for `subagent: true`, then the tier file body and the brief | `pi-coding-agent@18.8.6 src/task/executor.ts` `buildSubagentSessionOptions` |
| Parent's `--append-system-prompt` / `--system-prompt` | **No** | same (the child's session spec carries neither); `src/sdk.ts` `composeAppendPrompt(appendParts, options.appendSystemPrompt)` gets undefined |
| Context files | Yes, minus **every file whose basename is `agents.md`**: the profile card and any project `AGENTS.md` in the repo. `CLAUDE.md` passes | `pi-coding-agent@18.8.6 src/task/structured-subagent.ts` `buildExecutorOptions`, the `contextFiles` filter |
| Skills | Yes, the parent's resolved list | same, `skills: [...session.skills]` |
| Rules | Yes (`--no-rules` reaches hands) | same, `session.rules` |
| Extensions | Yes: the parent's prepared extensions re-bound to the child, so gates, fence and classifier `tool_call` handlers run for hand calls | same, `preloadedPreparedExtensions`; `src/sdk.ts` |
| MCP | Yes, the parent's manager (not in plan-mode / restricted sessions) | `src/task/structured-subagent.ts` |
| Tools | The tier's `tools` frontmatter plus `yield`; the parent's `--tools` is not passed; `ask` never (no UI) | `src/task/executor.ts`; `src/tools/ask.ts` |
| Settings | Live read-through overlay of the parent's, forcing `tools.approvalMode: "yolo"`, `advisor.enabled: false`, `compaction.midTurnEnabled: true` | `pi-coding-agent@18.8.6 src/task/executor.ts` `createSubagentSettings` |
| Model | `task.agentModelOverrides[<tier>]`, else frontmatter, else the parent's; a `before_subagent_spawn` handler may replace it (as2's classifier does) | `src/config/model-resolver.ts`; `classifier/extension.ts` `before_subagent_spawn` |
| Credentials | Yes, the same `authStorage` and model registry | `src/task/structured-subagent.ts` |
| `session_stop` | **Never** for a subagent | `pi-coding-agent@18.8.6 src/session/agent-session.ts` `#emitSessionStopEvent` (`#agentKind === "sub"`) |
| Recursion | `task.maxRecursionDepth` default 2 | `src/task/settings.ts` |

The output-types contract reaches hands through the gates' `before_agent_start` injection, which runs in the child because extensions are re-bound (`gates/src/rows/r02-contract.ts` header), not through `--append-system-prompt`.

| Ilex | lane | hand | seat |
|---|---|---|---|
| same rules for any hand Ilex spawns | put everything a hand needs in the brief or context: the card, project `AGENTS.md` files and the lane's appended prompt never reach it | gets the tier file, the brief, skills, extensions, MCP and `CLAUDE.md`-style context; no card, no `AGENTS.md`, no Stop hooks | same strip; a seat hand gets Jo's `CLAUDE.md` because the default profile enables `claude` (`head -3 ~/.omp/agent/config.yml` → `enabledProviders: [claude]`) |

## Credentials (`/login`, agent.db per profile)

The local credential store is `<agentDir>/agent.db` (`pi-utils@18.8.6 src/dirs.ts` `getAgentDbPath`); `/login` writes there (`pi-coding-agent@18.8.6 src/modes/controllers/selector-controller.ts`). An auth broker, when configured by `OMP_AUTH_BROKER_URL`/`_TOKEN`, `auth.broker.*` in the profile config or `<profile root>/auth-broker.token`, replaces the local store (`pi-ai@18.8.6 src/auth-broker/discover.ts` `resolveAuthBrokerConfig`). A key resolves runtime `--api-key` → `models.yml` key → OAuth → login key → env → stored key (`pi-ai@18.8.6 src/auth-storage.ts`). The as2 and default profiles therefore hold separate credential rows and separate refresh tokens; whether a provider that rotates refresh tokens invalidates one copy when the other refreshes is (unverified).

| Ilex | lane | hand | seat |
|---|---|---|---|
| `/login` once per provider; persists for every as2 process | same `agent.db`, no extra login; rpc has a `login` command (`pi-coding-agent@18.8.6 src/modes/rpc/rpc-types.ts` `type: "login"`) but the lane runner never sends it, so a lane cannot log in | the lane's `authStorage` | default profile's `agent.db` |

## rpc protocol commands

Newline-delimited JSON on stdin/stdout (`pi-coding-agent@18.8.6 src/modes/rpc/rpc-input.ts`). The first frame is `ready` (protocol 1; `negotiate_protocol` can switch to 2, which chunks big frames) (`src/modes/rpc/rpc-mode.ts`). `RpcCommand` has 67 command types (`pi-coding-agent@18.8.6 src/modes/rpc/rpc-types.ts`; omp://rpc.md). Every command gets a `response` frame (`success`, `data` or `error`, sometimes `code`); a `prompt` also owes exactly one `prompt_result` frame with `status: completed | aborted | error` and `sessionSettled`, followed by `session_settled` when it was false. Session events are forwarded as frames with their own `type`; a session move is announced as `notice {source: "session-persistence"}`.

**What the lane runner uses.** `surface/scripts/lane.ts` sends four commands: `prompt`, `abort`, `get_state`, `set_model`. It reads `response` frames for its own ids, `sessionFile`, `prompt_result`, `session_settled` and `get_state.isSettled`; every other frame only refreshes its idle clock. It never sends `steer`, `follow_up`, `compact`, `set_event_filter` or a subagent command, never negotiates protocol 2, and never answers an `extension_ui_request` (the lane runs `--no-ui`, so none is sent). The rpc `prompt` command takes an optional `streamingBehavior` (`steer` or `followUp`) that would queue it behind a running turn (`pi-coding-agent@18.8.6 src/modes/rpc/rpc-mode.ts`, `streamingBehavior: command.streamingBehavior`); the runner sets none, so a `prompt` it sent while the lane streams would fail with `AgentBusyError` (`pi-coding-agent@18.8.6 src/session/agent-session.ts` `prompt`, "throws Error if streaming and no streamingBehavior specified").

| Ilex | lane | hand | seat |
|---|---|---|---|
| a TUI, not an rpc client; reaches a lane only through the ledger and the runner, the lane's one stdin writer | 4 of 67 commands; **no mid-turn steer path exists today**; compaction is whatever the profile says | no rpc surface; a host could reach hands with `get_subagents`/`steer_subagent`, which the runner does not send | TUI; not an rpc client |

## Tool approval policy

Modes `always-ask` / `write` / `yolo`, **default `yolo`**; a call whose tier (`read`, `write`, `exec`) exceeds the mode's ceiling prompts (`pi-coding-agent@18.8.6 src/tools/approval.ts`; `src/tools/settings.ts`). `tools.approval.<tool>: allow | deny | prompt` is honoured in every mode, yolo included (`src/tools/approval.ts` `resolveApprovalFromContext`). The gate is in `ExtensionToolWrapper.execute`: deny short-circuits before any extension sees the call, then the `tool_call` hooks, then the full resolve, then a prompt (`pi-coding-agent@18.8.6 src/extensibility/extensions/wrapper.ts`). **With no UI, a call that needs a prompt throws** "requires approval but no interactive UI available" (same file). Hands are forced to `yolo` by the subagent settings overlay (`pi-coding-agent@18.8.6 src/task/executor.ts` `createSubagentSettings`). as2 sets no `tools.approvalMode` and passes no `--approval-mode` (`profile/config.yml` M4 tool-policy slot is empty).

| Ilex | lane | hand | seat |
|---|---|---|---|
| yolo; a lowered mode would prompt Jo in the TUI | yolo; **a lowered mode would make every exec-tier call throw**, since `--no-ui` gives no UI context | always yolo; only `tools.approval` deny/prompt policies reach it, and a `prompt` policy throws | yolo: Jo's default config sets no approval key (`grep -i approval ~/.omp/agent/config.yml` → no match, 2026-10-20) |

## Foreign provider opt-in

The foreign user providers are cursor, codex, claude, claude-plugins, gemini, opencode, windsurf and github. Their `~/` sources load only when `enabledProviders` holds the id, `*` or `all`, **or, for `claude`, whenever `CLAUDE_CONFIG_DIR` is non-empty**; `claude-plugins` follows `claude` (`pi-coding-agent@18.8.6 src/capability/index.ts` `isUserSourceEnabled`, `FOREIGN_USER_PROVIDERS`). The gate covers user scope only: project-scope files from a foreign provider (`.claude/…` in the cwd) are not gated, and project-scope Claude plugin roots for the active project still load (`pi-coding-agent@18.8.6 src/discovery/claude-plugins.ts`). The as2 profile sets no `enabledProviders`; the default profile sets `[claude]`.

| Ilex | lane | hand | seat |
|---|---|---|---|
| `~/.claude` CLAUDE.md, skills, plugins and MCP off; a shell exporting `CLAUDE_CONFIG_DIR` turns them on silently | same | the parent's resolved set | Claude user config, skills, plugins and MCP on |

## Extension discovery / ordering

`discoverExtensionPaths` loads, in order (`pi-coding-agent@18.8.6 src/extensibility/extensions/loader.ts` `discoverExtensionPaths`):

1. ambient `extension-module` capability: every `*.ts`/`*.js` and `*/index.{ts,js}` in `<agentDir>/extensions` and the project's `.omp/extensions` (`pi-coding-agent@18.8.6 src/discovery/builtin.ts`);
2. hook-capability `.ts`/`.js` files (plugin `hooks/pre|post`);
3. plugin extension paths (`getAllPluginExtensionPaths`);
4. configured paths: CLI `--extension`/`--hook`, then the settings `extensions:` list (`pi-coding-agent@18.8.6 src/sdk.ts` `discoverSessionExtensionPaths`).

Paths dedupe by resolved path. `disabledExtensions: ["extension-module:<name>"]` filters discovered paths only, never configured ones. Modules import concurrently but bind in path order; a load error is a warning, not fatal (`loader.ts`; `src/sdk.ts`). So **ambient extensions load, and their `tool_call` handlers run, before the as2 gates**. Run `ls ~/.omp/profiles/<profile>/agent/extensions` for the current ambient set; no as2 file lists it.

| Ilex | lane | hand | seat |
|---|---|---|---|
| ambient files first, then surface, gates, classifier, plugins (`profile/config.yml` `extensions:`) | same | the parent's set, re-bound | default profile's `agent/extensions` plus `launch-seat`'s `--hook`/`--extension` |

## Extension event lifecycle, fail-closed `tool_call`

Extensions subscribe with `pi.on(event, handler)` (`pi-coding-agent@18.8.6 src/extensibility/extensions/types.ts`; omp://extensions.md). The ones as2 relies on: `session_start`, `before_agent_start`, `input`, `context`, `tool_call`, `tool_result`, `assistant_message`, `before_subagent_spawn`, `session_before_compact`, `session_compact`, `agent_end`, `session_stop`, `session_shutdown`.

- **`tool_call` fails closed.** Handlers run in extension load order; the first `block` wins; a handler that throws **or times out** blocks the tool with `Extension <path> failed: …` or `… timed out after Nms`; an aborted signal also blocks (`pi-coding-agent@18.8.6 src/extensibility/extensions/runner.ts` `emitToolCall`). The timeout is `extensionHandlers.toolCallTimeoutMs`, default 30000.
- **Every other event fails open.** A throwing or timed-out handler is logged and reported, and the event goes on as if it returned nothing (`runner.ts` `#runHandlerWithTimeout` with no `onFailure`). Other handlers time out at 30 s; `session_shutdown` handlers at 2 s, in parallel.
- Session-before events stop at the first `cancel`; `session_stop` takes the first `decision: "block"`; `input` transforms chain (`runner.ts` `emit`).
- `session_stop` fires for top-level sessions only (§ Subagent inheritance) and is skipped on a compacting settle (§ Compaction runtime (events, stop-hook skip)).

| Ilex | lane | hand | seat |
|---|---|---|---|
| a gate that must refuse uses `tool_call`; nothing else blocks on failure | same | `tool_call` handlers run; no `session_stop`, so a hand's `yield` call is its only exit a gate can hold | an ambient or `--hook` extension that hangs in `tool_call` stops every tool |

## OTEL telemetry

`telemetry.otlpExportEnabled` defaults to true and is not set by as2. Export starts in any mode as soon as an `OTEL_EXPORTER_OTLP*_ENDPOINT` is set, unless `OTEL_SDK_DISABLED=true`; only `http/protobuf` is supported; message content is exported only when `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` asks for it (`pi-coding-agent@18.8.6 src/telemetry-export.ts` `initTelemetryExport`; `pi-agent-core@18.8.6 src/telemetry.ts`). as2's launchers own the switch: `surface/src/tracing.ts` `tracingEnv` drops every inherited `OTEL_*` and sets either `OTEL_SDK_DISABLED=true` or the `observability.otel` map from `profile/config.yml`; `bin/as2` (`tracing_words`) applies it to Ilex and `surface/scripts/lane.ts` (`laneSpawnEnv`) to lanes. The audit's finding that `bin/as2` sets no OTEL is stale.

| Ilex | lane | hand | seat |
|---|---|---|---|
| traced when `observability.phoenix` covers it; set with `as2 phoenix` | traced with `as2.workload`/`as2.lane` attributes; capture `none` | the lane's process, so its exporter | `launch-seat` applies the same switch |

## Plugin registry precedence

Plugin registries (jo-issues#51). Two registries feed OMP's plugin roots, merged in `listClaudePluginRoots` (`pi-coding-agent@18.8.6 src/discovery/helpers.ts` `listClaudePluginRoots`), lowest to highest:

1. **Claude Code's registry**, `<claude config dir>/plugins/installed_plugins.json` (`~/.claude` unless `CLAUDE_CONFIG_DIR`). An entry counts unless `enabled: false` or `enabledPlugins[id] === false` in Claude's `settings.json` or the project's `.claude/settings*.json`. Scope `user` counts everywhere; `project` and `local` count only when `projectPath` is the active project, or when `enabledPlugins[id] === true`.
2. **OMP's per-profile registry**, `getPluginsDir()/installed_plugins.json` (`pi-utils@18.8.6 src/dirs.ts` `getPluginsDir`, which returns `dirs.rootSubdir("plugins", "data")`). It is authoritative: an id it lists **removes every Claude root with that id**, in any scope (source comment "OMP registry is authoritative"). Where that dir is, per the `DirResolver` constructor (`pi-utils@18.8.6 src/dirs.ts` `DirResolver`, its `resolveIf` helper, `rootSubdir`, `getProfileConfigRoot`):
   - **XDG root, when it exists.** On Linux and macOS, with `XDG_DATA_HOME` set and the default agent dir in use (for the default profile, the resolved agent dir equals the default `<config root>/agent`, where the override is read from `PI_CODING_AGENT_DIR` after OMP's dotenv fill, `refreshDirsFromEnv`; a named profile ignores that override), the data root is `$XDG_DATA_HOME/omp` for the default profile when that dir exists, and `$XDG_DATA_HOME/omp/profiles/<profile>` for a named profile when that profile dir exists. A named profile never falls back to the base `$XDG_DATA_HOME/omp`, so its location is fixed at first activation. Plugins are then `<data root>/plugins/`.
   - **Legacy root, otherwise.** `~/.omp/plugins/` for the default profile, `~/.omp/profiles/<profile>/plugins/` for any other (`.omp` is `PI_CONFIG_DIR` when set, `getConfigDirName`). `XDG_DATA_HOME` was unset in the shell checked on 2026-10-20 (`printenv XDG_DATA_HOME` → exit 1), so the legacy paths are the ones in use there.
3. **A project OMP registry**, `.omp/plugins/installed_plugins.json` found by walking up from the cwd: its ids replace both of the above.
4. **`--plugin-dir` roots** win over everything.

**Nothing in OMP compares versions.** The loaded version is just the winning entry's `version` (`helpers.ts`); a Claude 1.2.0 and an OMP 1.3.0 of one id never produce a warning, and a seat runs the OMP one whatever Claude Code shows. `omp plugin …` writes the registry of the profile it runs under (§ Plugin CLI (install/upgrade, dry-run)).

**What an as2 session loads.** None of the marketplace plugins, from either registry. The as2 profile has no `plugins/` dir (`ls ~/.omp/profiles/agent-system-2/plugins` → No such file or directory, 2026-10-20), so layer 2 is empty, and the `claude` user source is off (§ Foreign provider opt-in), so Claude user-scope roots drop. as2 vendors i-have-audhd and ask-graham under `plugins/` and loads them through `plugins/index.ts` (orchestrator only; `plugins/VENDOR.md`). The two `disabledExtensions` entries in `profile/config.yml` are a guard that is inert today; they would matter only if someone ran `omp plugin install` under the as2 profile.

**The start refusal.** `as2` start (default arm and `--print`) runs `bun surface/scripts/plugin-registries.ts check --cwd <repo>` first and refuses, exit 1, when an OMP registry's effective entry for a plugin differs in `version` from an active Claude entry for the same id (`surface/src/plugin-registries.ts` `findDisagreements`).
The OMP registries are resolved the way OMP's `getPluginsDir` does (`surface/src/plugin-registries.ts` `ompSession`, `ompSessions`): for the default profile and the active profile, the XDG data root (`$XDG_DATA_HOME/omp[/profiles/<name>]`) when it exists, else the legacy `~/.omp[/profiles/<name>]` paths; a project OMP registry is checked too.
The refusal prints each plugin, both versions and paths, the two match commands and the two scoped disable commands (`fixCommands`). For a profile's user registry they are `OMP_PROFILE=<profile> omp plugin install --force <id>` and `OMP_PROFILE=<profile> omp plugin disable --scope user <id>`; for a project registry they run in the project, `(cd <project> && omp plugin install --force --scope project <id>)` and `(cd <project> && omp plugin disable --scope project <id>)`, with the Claude pair `claude plugin update <id>` and `claude plugin disable <id>` (in the project too for a project registry). `as2 plugins` runs the check alone.
The OMP disable is the sure recovery: Claude refuses its disable with "already disabled" when its settings never enabled the plugin, yet OMP still reads Claude's registry entry (`surface/scripts/plugin-registries.ts`). Disabling one OMP entry can expose a lower OMP entry for the same plugin (a project disable leaves the profile registry's entry in force) that disagrees with Claude too, so run `as2 plugins` again after each fix.

| Ilex | lane | hand | seat |
|---|---|---|---|
| no marketplace plugins; `as2` refuses to start while the two registries disagree: run a printed fix, then `as2 plugins` | no marketplace plugins; lane launches are not checked | the parent's roots | runs the OMP registry's version (paired-coding, i-have-audhd, ask-graham on 2026-10-20) plus active Claude roots |

## Claude-plugin hooks / adapter

OMP's Claude-plugin provider loads a plugin's skills, `rules/`, `commands/`, `tools/` and MCP servers (task agents come from the same roots through `pi-coding-agent@18.8.6 src/task/discovery.ts` `discoverAgents`), but for hooks it scans only `<plugin>/hooks/pre/*` and `hooks/post/*` (`pi-coding-agent@18.8.6 src/discovery/claude-plugins.ts` `loadHooks`, `hookTypes = ["pre", "post"]`), and the loader keeps only `.ts`/`.js` files from them (`pi-coding-agent@18.8.6 src/extensibility/extensions/loader.ts` `discoverExtensionPaths`, the `isExtensionFile` filter on hook-capability paths). Nothing parses Claude's `hooks/hooks.json`: a search for `hooks\.json|SubagentStop|PreCompact|UserPromptSubmit` over `pi-coding-agent@18.8.6 src/` found no match (2026-10-20). A Claude plugin's `SessionStart`, `PreToolUse`, `PreCompact`, `Stop`, `SubagentStop` and `SessionEnd` hooks therefore run in OMP only through an adapter extension that maps them to OMP events; Jo's seats use `~/.omp/agent/extensions/newdle-hooks.ts`, passed by `launch-seat` with `--hook`. No OMP event exists for a subagent stop (`session_stop` is top-level only), so a `SubagentStop` hook has no OMP equivalent.

| Ilex | lane | hand | seat |
|---|---|---|---|
| no Claude hooks run (no Claude user plugins load) | same | same | Claude hooks run only through the `--hook` adapter, and `SubagentStop` never |

## Message delivery semantics

Five routes (`pi-coding-agent@18.8.6 src/session/agent-session.ts`; `pi-agent-core@18.8.6 src/agent.ts`):

| Route | Idle session | Streaming session | What the model sees |
|---|---|---|---|
| **prompt** (`prompt`) | starts a turn | throws `AgentBusyError` unless `streamingBehavior` is given, which queues it | a `user` message |
| **steer** (`steer`) | queued, then drained into a turn | delivered after the current tool finishes; **the rest of the tool batch is skipped** | a `user` message wrapped in a "User interjection during work" notice |
| **follow_up** (`followUp`) | queued, then drained into a turn | delivered only when the agent has no tool calls or steers left | a plain `user` message |
| **aside** (`deliverAs: "aside"`, incoming IRC/`agent://` messages) | starts a turn | IRC aside queue, polled at step boundaries; does not interrupt the batch | the message, no envelope |
| **custom** (`sendCustomMessage`, extension `pi.sendMessage(msg, {triggerTurn, deliverAs})`) | `triggerTurn: true` starts a turn (with or without `nextTurn`); without it the message is appended with **no turn** (`nextTurn` included) | `nextTurn` parks it, and with `triggerTurn: true` a turn follows the current prompt; `followUp`, `steer` (also the default) and `aside` as above | a `developer` message |

`deliverAs: "nextTurn"` depends on whether the session is streaming and on `triggerTurn` (`pi-coding-agent@18.8.6 src/session/agent-session.ts` `#dispatchCustomMessage`):

- **Idle, `triggerTurn: true`**: it starts a turn at once (`#promptAgentInitiatedMessage`). An ACP client that defers agent-initiated turns parks it instead, without a trigger.
- **Idle, `triggerTurn` false**: it is appended to the context and the session file with no turn, the same as a plain idle custom message.
- **Streaming, `triggerTurn: true`**: it is parked in the hidden next-turn queue, and the park schedules one post-prompt task per prompt generation (`#queueHiddenNextTurnMessage`). When the running prompt ends, that task prompts with every parked message, the last as the prompt and the rest prepended (`#promptQueuedHiddenNextTurnMessages`). If that prompt fails, the messages stay parked for the next explicit prompt.
- **Streaming, `triggerTurn` false**: it is parked and nothing is scheduled. This is the only variant that waits for the **next explicit prompt**, which carries the parked messages as context (`#promptWithMessage`).

A session switch clears the queue (`switchSession`). Queues drain one message per boundary by default (`steeringMode`, `followUpMode` = `one-at-a-time`; `interruptMode` = `immediate`; as2 sets none) (`pi-coding-agent@18.8.6 src/modes/settings.ts`). **rpc has no custom-message command**: its only message commands are `prompt`, `steer`, `follow_up` and `abort_and_prompt`, so an rpc host cannot reach `triggerTurn` or `nextTurn`; extensions inside the session can (`pi-coding-agent@18.8.6 src/modes/rpc/rpc-types.ts`). Peer `write agent://<id>` messages go through IRC messaging (`pi-coding-agent@18.8.6 src/internal-urls/agent-protocol.ts` `executeSend`), which wakes an idle session with a turn and queues an aside behind a running one (`agent-session.ts` `#wakeForIrc`).

| Ilex | lane | hand | seat |
|---|---|---|---|
| a message Jo types mid-turn with Enter is a steer (`prompt(text, {streamingBehavior: "steer"})`) and cuts the tool batch; Ctrl+Enter queues a follow-up (`pi-coding-agent@18.8.6 src/modes/controllers/input-controller.ts` `handleFollowUp`). An extension on Ilex that omits `deliverAs` while streaming also steers | the runner sends only `prompt`, so it **cannot steer or follow up** a running turn; a prompt sent while streaming is an error, not a queue | reached by the brief and by peer `agent://` writes (asides) | seat mail must use `{deliverAs: "followUp", triggerTurn: true}` while streaming and `triggerTurn: true` while idle |

## Plugin CLI (install/upgrade, dry-run)

`omp plugin` takes install, uninstall, list, link, doctor, features, config, enable, disable, marketplace, discover and upgrade (`pi-coding-agent@18.8.6 src/cli/plugin-cli.ts`). Every subcommand resolves paths through `getPluginsDir()`, so it reads and writes the registry of the profile it runs under: `OMP_PROFILE=agent-system-2 omp plugin install …` populates the as2 profile, and its extensions would then load in as2 sessions. `--dry-run` is parsed for every subcommand but honoured only by install, uninstall and link: **`handleUpgrade` never reads `flags.dryRun`**, so `omp plugin upgrade --dry-run` performs a real upgrade, of every marketplace plugin when no id is given (`plugin-cli.ts` `handleUpgrade` → `upgradeAllPlugins`). Even `omp plugin list` creates the profile's `logs/` dir (`pi-utils@18.8.6 src/logger.ts`).

| Ilex | lane | hand | seat |
|---|---|---|---|
| Jo only; never `upgrade --dry-run` as a preview | not for as2 | not for as2 | Jo only; it rewrites the registry every default-profile seat reads |

## Logs / diagnostics location

Each OMP process writes `<profile root>/logs/omp.<local day>.<pid>.log`, rotating at 10 MiB × 5; level from `OMP_LOG_LEVEL` (default debug); dead-process logs older than 5 days are pruned (`pi-utils@18.8.6 src/dirs.ts` `getLogsDir`; `pi-utils@18.8.6 src/logger.ts`). For the as2 profile that is `~/.omp/profiles/agent-system-2/logs/`, not `~/.omp/logs` (the default profile's). While the TUI owns the terminal, stderr is redirected into the log (`pi-utils@18.8.6 src/stderr-guard.ts`). Fatal errors write a report to stderr and the log and exit 1 (`pi-utils@18.8.6 src/postmortem.ts`). `/debug` (TUI only) builds a report bundle under the profile's `reports/`. `getCrashLogPath` (`<agentDir>/omp-crash.log`) has no caller in the 18.8.6 sources (`grep -rn getCrashLogPath` over the `@oh-my-pi` packages' `src/` → only its definition), so do not look there for crashes.

| Ilex | lane | hand | seat |
|---|---|---|---|
| its pid's file in the as2 profile's `logs/` | its own pid's file in the same dir; stderr also reaches the runner | the lane's process, so the lane's file | `~/.omp/logs` |

## Session ownership leases

Every persisting session claims an OS-held lease on its session id at its first write, in `~/.omp/run/session-owners`, which **every profile shares** (`pi-coding-agent@18.8.6 src/session/session-manager.ts` `#claimSession`; `src/session/session-storage.ts`; `pi-utils@18.8.6 src/dirs.ts` `getSessionOwnersDir`). The kernel drops it when the owner exits. A second process may open the same session and read it; at its first write, if the owner is alive, it **forks to a sibling file with a new id** whose `parentSession` is the old file, instead of writing the owner's file (`session-manager.ts` `#sessionOwnedElsewhere`). The move is announced: rpc emits `notice {level: "warning", source: "session-persistence"}`. Inspection (`--export`, share) never claims. Moving a live session between dirs is refused (`SessionMoveRefusedError`).

Leases are keyed by **session id**, not by process. `claimSession` keeps one OS lease per id in the process-wide `sessionLeases` map with a `holders` count: session managers for the same id in one process share that id's lease, and the last release drops it (`pi-coding-agent@18.8.6 src/session/session-storage.ts` `claimSession`, `sessionLeases`). A manager that does not persist never claims (`pi-coding-agent@18.8.6 src/session/session-manager.ts` `#claimSession`, the `!this.#persist` return; `SessionManager.inMemory`).

| Ilex | lane | hand | seat |
|---|---|---|---|
| resuming a session a lane or seat still holds forks it on the first write | a relaunch with `--resume` while the old omp still runs forks; the runner ignores the `notice` and keeps the old path | a persisted hand session (`<artifacts dir>/<id>.jsonl`, `SessionManager.open`) claims its own id's lease, not the lane's; an in-memory hand (`SessionManager.inMemory`) claims none (`pi-coding-agent@18.8.6 src/task/executor.ts` `runSubprocess`, the `sessionManagerPromise` choice) | two seats on one session contend the same way, across profiles |
