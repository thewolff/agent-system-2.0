# OMP harness guide (agent-system 2.0)

verified-omp: 18.8.6

Verified 2026-10-14 against the installed `@oh-my-pi/pi-coding-agent` 18.8.6 (`omp --version` → `omp/18.8.6`), with its TypeScript source. Every slash command, launch flag and setting below says what it does, where OMP defines it (`pi-coding-agent@18.8.6 src/<file>` plus a `name:`/`id:` string or symbol), and whether Ilex, a lane and a seat use it. The start card `profile/AGENTS.md` carries the short version; read this file when a harness question comes up.

**Counts** (rerun from any shell where `omp` is on PATH; the first two resolve the installed package from `which omp`):

- **85** built-in slash commands:
  `bun -e 'const p=require("path").resolve(require("fs").realpathSync(Bun.which("omp")),"../..");const m=await import(p+"/src/slash-commands/builtin-registry.ts");console.log(m.BUILTIN_SLASH_COMMANDS_INTERNAL.length+" built-in slash commands")'` → `85 built-in slash commands`
- **541** settings in **37** domains:
  `bun -e 'const p=require("path").resolve(require("fs").realpathSync(Bun.which("omp")),"../..");const m=await import(p+"/src/config/all-settings.ts");const s=await Bun.file(p+"/src/config/all-settings.ts").text();console.log(m.orderedSettings().length+" settings in "+s.match(/^import \* as /gm).length+" domains")'` → `541 settings in 37 domains`
- as2-profile slash commands per source, from a live rpc session (no model call; omp exits when stdin closes after ~15 s):
  `( printf '{"id":"1","type":"get_available_commands"}\n'; sleep 15 ) | OMP_PROFILE=agent-system-2 omp --mode rpc --no-ui --no-session --cwd "$PWD" 2>/dev/null | jq -r 'select(.id=="1") | .data.commands | group_by(.source)[] | "\(.[0].source) \(length)"'` → `builtin 45`, `custom 3`, `extension 1`, `file 1`, `skill 22` (no `mcp_prompt` line: that source is empty). The builtin 45 are the rpc-reachable built-ins; the 27 others are the dynamic instances listed below.

The dynamic lists are a dated snapshot (2026-10-14, this machine, run from the as2 checkout and from the profile directory with the same result). A session sees its own list in slash completion (TUI) or `available_commands` (rpc/ACP); a cwd with its own `.omp/commands` or `.claude/commands`, a plugin install, or a changed skill allowlist changes it.

**Staleness.** The suite guards only major.minor: a test compares this header's `verified-omp` major.minor with `VERIFIED_HOST` in `gates/src/host.ts`. A patch upgrade (18.8.6 → 18.8.x) passes it unnoticed, so re-verify this guide, counts and rows, on any OMP upgrade.

## Verdict key and roles

**Roles.**

- **Ilex**: the as2 orchestrator, an interactive OMP TUI started by `bin/as2` (`omp --cwd <repo> --append-system-prompt <prompt>`, env `OMP_PROFILE=<profile> AGENT_SYSTEM_ROLE=orchestrator`, where `<profile>` is `$AGENT_SYSTEM_PROFILE` or `agent-system-2`). Loads the start card.
- **lane**: `omp --mode rpc --no-ui …` (`surface/src/launch.ts` `laneArgv`), unattended, same profile. Loads the start card. Its runner (`surface/scripts/lane.ts`) sends only the rpc commands `prompt`, `abort` and `get_state`. `as2 lane <wl>` runs a user-driven lane as a TUI instead (`interactiveArgv`); there Jo types and the Ilex column applies.
- **hand**: a `task` subagent of a lane. No slash commands. The card is native user context: OMP reads `AGENTS.md` from the profile's agent dir at level `user` (`pi-coding-agent@18.8.6 src/discovery/builtin.ts` `loadContextFiles`). OMP strips every context file named `agents.md` from a subagent (`pi-coding-agent@18.8.6 src/task/structured-subagent.ts` `buildExecutorOptions`, its `contextFiles` filter), so a hand does not get the card; its tier file names this guide. Hands run under the lane's settings, so they have no column.
- **seat**: a HerdR seat from `~/.omp/agent/seat-launchers/launch-seat`. The `ilex` seat runs `as2`, so it is Ilex (Ilex column, loads the card). Every other seat runs `seat-bin/omp` on Jo's default profile and does not load the card; the seat column is for them.

**Verdicts.**

- `use` (when). For a **slash command** in the Ilex or seat column, `use` means Jo types it and Ilex may suggest it: no agent can type a slash command, because OMP dispatches them only from user prompt text (TUI input, or an rpc `prompt` command), never from model output. A lane never `use`s a slash command, since its runner sends no slash text. For **settings and skills**, `use` keeps its plain meaning: the role acts through it.
- `machinery-owned`: set by `profile/config.yml` or the launcher; never change it by hand. `install/install.sh` section 5 rewrites the profile's `config.yml` from the template on every install, so a `/settings` edit to such a key is lost. Change `profile/config.yml` and re-install.
- `Jo only`: Jo's call in the TUI; an agent does not take it.
- `not for as2` (why).

Lane shorthands: `not for as2 (TUI-only)` = the command has no `handle`, so it does not exist in rpc and a `/x` text goes to the model as text; `not for as2 (no sender)` = rpc would run it, but no lane code sends it and the model cannot type it.

## Launch flags

Every flag as2's launchers pass, plus `--config` and `--add-dir` (which change a session's config or workspace) and the profile env. Anchors are in `pi-coding-agent@18.8.6 src/cli/flag-tables.ts` (`STRING_SETTERS`, `OPTIONAL_FLAGS`), `pi-coding-agent@18.8.6 src/commands/launch-help.ts` and `pi-coding-agent@18.8.6 src/main.ts`; callers are `bin/as2`, `surface/src/launch.ts` (`laneArgv`, `interactiveArgv`, `laneEnv`) and the seat launcher `~/.omp/agent/seat-launchers/launch-seat` (with `seat-bin/omp`).

Exact argv. **Ilex:** `env OMP_PROFILE=<profile> AGENT_SYSTEM_ROLE=orchestrator omp --cwd <repo> --append-system-prompt <prompt> [args…]` (`bin/as2`, last `case` arm). **Autonomous lane:** `omp --mode rpc --no-ui --cwd <worktree> --session-dir <dir> --append-system-prompt <file> --max-time <t> [--model <m>] [--resume <id>]` (`laneArgv`; env from `laneEnv`: `AGENT_SYSTEM_ROLE=lane`, workload and lane ids, `AS2_SCRATCH`; `OMP_PROFILE` passes through). **User-driven lane** (`as2 lane <wl>`): the same without `--mode`, `--no-ui` and `--max-time` (`interactiveArgv`), so it is a TUI and the Ilex column applies to Jo there. **Other seats:** `bun --no-env-file <omp> --cwd … --model … --session-dir … --plugin-dir … --hook … --extension … --no-title [--config <overlay>]` (`launch-seat`); the `ilex` seat runs `as2` plus two `--extension` paths (`launch-seat` `ILEX_EXTENSIONS`).

| Flag | Passed by | What OMP does with it | Source anchor | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `--cwd <dir>` | `bin/as2` (`<repo>`), `laneArgv`/`interactiveArgv` (worktree), `launch-seat` | Sets the session's working directory: `cwd: parsed.cwd ?? getProjectDir()`. Project-scoped discovery (file commands, custom commands, `.omp/agents`) keys off it | `pi-coding-agent@18.8.6 src/cli/flag-tables.ts` `"--cwd"`; `pi-coding-agent@18.8.6 src/main.ts` `buildSessionOptions` | machinery-owned: fixed to the checkout so Jo's shell cwd cannot change it | machinery-owned: the lane worktree | machinery-owned by `launch-seat` (`--cwd "$working_directory"`) |
| `--mode rpc` | `laneArgv` only | Selects the JSON-lines rpc mode (accepted values `text json rpc acp rpc-ui`). In rpc only `handle` slash commands run (see Built-in slash commands); TUI-only commands are absent | `pi-coding-agent@18.8.6 src/cli/flag-tables.ts` `"--mode"`; `pi-coding-agent@18.8.6 src/modes/rpc/rpc-mode.ts` | not for as2: Ilex is the TUI | machinery-owned: every autonomous lane | not for as2 (seats are TUI) |
| `--no-ui` | `laneArgv` only | Boolean; with rpc/rpc-ui runs extensions headless (`headless: parsedArgs.noUi === true`); any other mode exits 1: "Error: --no-ui requires --mode rpc or --mode rpc-ui" | `pi-coding-agent@18.8.6 src/commands/launch-help.ts` `"no-ui"`; `pi-coding-agent@18.8.6 src/main.ts` `rejectNoUiWithoutRpc` | not for as2 (Ilex is the TUI) | machinery-owned: no TUI, so `ctx.ui` selectors and TUI-only commands do not exist | not for as2 (seats are TUI) |
| `--append-system-prompt <text\|file>` | `bin/as2` (`$HOME/.agent-system-2/orchestrator/system.md`), `laneArgv` (`systemPromptPath`), `seat-bin/omp` when `OMP_SEAT_APPEND_SYSTEM_PROMPT` is set | Appends to the system prompt. `resolvePromptInput`: a value with no newline is read as a file if it exists, otherwise **used as literal text**; a multi-line value is literal. `bin/as2` therefore refuses to launch when the prompt file is missing. It is separate from the profile's `AGENTS.md` card, which loads as native context | `pi-coding-agent@18.8.6 src/cli/flag-tables.ts` `"--append-system-prompt"`; `pi-coding-agent@18.8.6 src/system-prompt.ts` `resolvePromptInput`, `composeAppendPrompt`; `pi-coding-agent@18.8.6 src/main.ts` `buildSessionOptions` (`parsed.appendSystemPrompt ?? discoverAppendSystemPromptFile()`) | machinery-owned: the rendered orchestrator prompt | machinery-owned: the lane prompt file | machinery-owned by the seat launcher (`OMP_SEAT_APPEND_SYSTEM_PROMPT`); the `ilex` seat = Ilex |
| `--session-dir <dir>` | `laneArgv`/`interactiveArgv` (`<lane dir>/sessions`), `launch-seat` (`$HOME/.omp/agent/seat-sessions/<seat>`; the `ilex` seat uses OMP's own profile session dir) | Directory for session storage and lookup; also where `--resume <id-prefix>` searches | `pi-coding-agent@18.8.6 src/cli/flag-tables.ts` `"--session-dir"`; `pi-coding-agent@18.8.6 src/main.ts` `resolveResumableSession(sessionArg, cwd, parsed.sessionDir)` | not for as2 (not passed: Ilex uses the profile's own sessions dir) | machinery-owned: per-workload sessions dir (`laneDir`, `launch.ts`) | machinery-owned by `launch-seat` |
| `--resume [<id-prefix\|path>]` (`-r`, `--session`) | `laneArgv`/`interactiveArgv` when `resumePlan` says resume; `launch-seat --resume <seat>` is the launcher's own flag, not OMP's | Optional-value flag. A value containing `/` or `\` or ending `.jsonl` is opened as a file path (`SessionManager.open`, error if missing); any other value is an id prefix resolved by `resolveResumableSession`; a bare flag opens the picker (TUI only) | `pi-coding-agent@18.8.6 src/cli/flag-tables.ts` `OPTIONAL_FLAGS`; `pi-coding-agent@18.8.6 src/main.ts` (`typeof parsed.resume === "string"` branch) | Jo only: `as2 --resume` (extra args pass through) or `/resume` in session | machinery-owned: the runner resumes only when the recorded session ran on the same model (`resumeOf`/`resumePlan`, `surface/scripts/lane.ts`); always passes a value (no picker in rpc) | Jo only |
| `--max-time <n\|5s\|10m\|1h>` | `laneArgv`: `AGENT_SYSTEM_LANE_MAX_TIME` or `2h` (`DEFAULT_LANE_MAX_TIME`), or `ceilingMaxTime(remainingWallMin)` = remaining minutes + 10 | `parseMaxTimeSeconds` (positive number of seconds or `Ns/Nm/Nh`; else exit with `Invalid --max-time value`) sets `options.deadline = Date.now() + seconds*1000`; the agent loop then aborts with a `TimeoutError` ("Deadline exceeded") | `pi-coding-agent@18.8.6 src/cli/flag-tables.ts` `parseMaxTimeSeconds`, `"--max-time"`; `pi-coding-agent@18.8.6 src/main.ts` `buildSessionOptions` (`options.deadline`); `pi-agent-core@18.8.6 src/agent.ts` `#continuationDequeueSignal` | not for as2 (not passed: Ilex has no deadline) | machinery-owned: the wall bound; the runner records `lane-died: … deadline <max-time>` (`laneDiedDeadlineBody`) | not for as2 (not passed) |
| `--model <pattern>` | `laneArgv`/`interactiveArgv` only when Jo named a model (`spec.model != null`); `launch-seat` always (`DEFAULT_MODEL=anthropic/claude-opus-5-5`, or `OMP_SEAT_MODEL`) | Selects the main session's model by pattern. Without it the profile's default model applies. Hand models come from `task.agentModelOverrides`, not from this flag | `pi-coding-agent@18.8.6 src/cli/flag-tables.ts` `"--model"` | Jo only (not passed: the profile's default model applies; Jo may `/model`) | machinery-owned: Jo's `laneModel`, else the profile default | machinery-owned by `launch-seat` |
| `--config <file>` (repeatable) | **as2 passes none**; `launch-seat` adds `--config "$OMP_SEAT_CONFIG"` when that env var is set | Loads an extra `config.yml`-style overlay for this run, layered over the profile's config (overlay carries only changed keys, per the `launch-seat` comment). The as2 profile's config comes from `OMP_PROFILE`, not from `--config` | `pi-coding-agent@18.8.6 src/commands/launch-help.ts` `config`; `pi-coding-agent@18.8.6 src/cli/flag-tables.ts` `"--config"` (`result.config = [...]`) | not for as2: change `profile/config.yml` and re-install instead | not for as2: a lane's config is the profile's | Jo only (the seat launcher's `OMP_SEAT_CONFIG`) |
| `--add-dir <dir>` (repeatable) | **nobody**: not in `bin/as2`, `laneArgv`, `interactiveArgv`, or `launch-seat` (`grep -n "add-dir" ~/.omp/agent/seat-launchers/launch-seat` → no match) | Adds a workspace directory beyond cwd; merged with the setting `workspace.additionalDirectories` into `options.additionalDirectories`. The in-session equivalents are `/add-dir`, `/remove-dir`, `/dirs` (see Built-in slash commands), which persist the root in the session and refresh the system prompt | `pi-coding-agent@18.8.6 src/cli/flag-tables.ts` `"--add-dir"`; `pi-coding-agent@18.8.6 src/main.ts` `buildSessionOptions` (`cliDirs`, `cfgWorkspaceAdditionalDirectories`); `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "add-dir"` | Jo only (`as2 --add-dir <dir>` passes through to omp) | not for as2: the lane argv carries none; a lane's workspace is its worktree | Jo only |
| `OMP_PROFILE` (env, not a flag) | `bin/as2` (`env OMP_PROFILE=$PROFILE_NAME`), `as2 lane`, lane env (passes through) | Selects the isolated profile dir `~/.omp/profiles/<name>/agent` (config.yml, mcp.json, agents/, extensions/, sessions). OMP also has a `--profile <name>` flag (`launch-help.ts` `profile`), which as2 does not use | `pi-coding-agent@18.8.6 src/commands/launch-help.ts` `profile`; `pi-coding-agent@18.8.6 src/cli.ts`, `pi-coding-agent@18.8.6 src/cli/args.ts` (`OMP_PROFILE`) | machinery-owned | machinery-owned (inherited) | Jo only (other seats run Jo's default profile, no `OMP_PROFILE`; the `ilex` seat = Ilex) |
| `-p` / `--print`, `--no-session` | `surface/scripts/chaos.ts`, `scratch-smoke.ts` probes (`omp -p --no-session --model … <prompt>`), not production flows | Non-interactive one-shot, no session file | `pi-coding-agent@18.8.6 src/commands/launch-help.ts` `print`, `no-session`; `surface/scripts/chaos.ts` `this.omp` | not for as2 (probe scripts only) | not for as2 (probe scripts only) | not for as2 |
| `--plugin-dir`, `--hook`, `--extension`/`-e`, `--no-title`, `bun --no-env-file` | `launch-seat` only (newdle plugin/adapter/registry; Ilex seat: HerdR + moshi extensions) | Extra plugin roots, hook files, extension files; title auto-generation off; bun flag (must precede the script path) so a project `.env` is not loaded | `pi-coding-agent@18.8.6 src/cli/flag-tables.ts` `"--plugin-dir"`, `"--hook"`, `"--extension"`, `"--no-title"`; `launch-seat` `exec "$real_bun" --no-env-file "$real_omp"` | not for as2: the extension set is machinery in config.yml `extensions:` | not for as2 | machinery-owned by `launch-seat` (do not edit; out of scope) |

`bin/as2 --print [args]` is the launcher's own flag, not OMP's `-p/--print`: it renders the prompt and prints the omp command line without running it (`bin/as2` usage text and `--print)` arm).

## Built-in slash commands

All 85 specs of `BUILTIN_SLASH_COMMANDS_INTERNAL`, in registry order. The registry (`pi-coding-agent@18.8.6 src/slash-commands/builtin-registry.ts` `BUILTIN_SLASH_COMMAND_REGISTRY`) spreads seven arrays: `BUILTIN_MODE_SLASH_COMMANDS` (builtin-modes.ts, 21), `BUILTIN_COLLABORATION_SLASH_COMMANDS` (builtin-collaboration.ts, 11), `BUILTIN_SESSION_SLASH_COMMANDS` (builtin-session.ts, 19), `BUILTIN_LIFECYCLE_SLASH_COMMANDS` (builtin-lifecycle.ts, 25), `BUILTIN_MARKETPLACE_SLASH_COMMANDS` (builtin-marketplace.ts, 3), `BUILTIN_SKILLS_SLASH_COMMANDS` (builtin-skills.ts, 1), `BUILTIN_CONTROL_SLASH_COMMANDS` (builtin-control.ts, 5). Eight carry aliases; 28 declare subcommands; names plus aliases reserve 93 words.

**Availability.** A spec has `handle` (text handler), `handleTui` (TUI-only), or both (`pi-coding-agent@18.8.6 src/slash-commands/types.ts` `SlashCommandSpec`). 45 specs have `handle`; 40 are TUI-only. The TUI runs all 85: `executeBuiltinSlashCommand` prefers `handleTui`, else adapts `handle`, and passes the text on as a message when the command got arguments it does not allow (`allowArgs`; "no args" in the column). rpc and ACP run only the 45 `handle` specs (`pi-coding-agent@18.8.6 src/slash-commands/acp-builtins.ts` `executeAcpBuiltinSlashCommand`: `if (!command?.handle) return false`); any other `/x` falls through to `session.prompt` and reaches the model as plain text (`pi-coding-agent@18.8.6 src/modes/rpc/rpc-mode.ts` `dispatchOrderedUserInput`). A live `get_available_commands` on an as2-profile rpc session lists 45 builtins. "handle-only" marks the six specs with no TUI override (security, prewalk, pin, add-dir, remove-dir, dirs), which the TUI runs through the adapter. In a `/collab` guest session only `COLLAB_GUEST_ALLOWED_COMMANDS` run.

Anchors give the `name:` string; the `(:N)` line is its position in the installed 18.8.6 copy, convenience only. "What it does" is the spec's `description`, shortened.

| Command | Aliases / subcommands | What it does | TUI / rpc / ACP | Source anchor | Ilex | lane | seat |
|---|---|---|---|---|---|---|---|
| `/security` | sub: plan, scan, status, cancel, scans, show, import, export, validate, compare, disposition | Plan, run, inspect, import, and compare OMP-native security scans | Y / Y / Y (handle-only) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-modes.ts` `name: "security"` (:278) | not for as2: no as2 flow uses OMP's scan workflow; `security-and-hardening` skill covers audits | not for as2 (no sender) | Jo only |
| `/settings` |  | Open settings menu | Y / - / - (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-modes.ts` `name: "settings"` (:299) | machinery-owned: keys live in `profile/config.yml`; change there and re-install, never with `/settings`; Jo may browse | not for as2 (TUI-only) | Jo only (Jo's default profile config, not as2's) |
| `/setup` | aliases `/providers`; sub: providers | Open provider setup | Y / - / - | `pi-coding-agent@18.8.6 src/slash-commands/builtin-modes.ts` `name: "setup"` (:308) | machinery-owned: `setupVersion: 2` in config.yml skips the wizard; `/login` is the provider step | not for as2 (TUI-only) | Jo only |
| `/plan` |  | Toggle plan mode (agent plans before executing) | Y / - / - | `pi-coding-agent@18.8.6 src/slash-commands/builtin-modes.ts` `name: "plan"` (:326) | not for as2: plan-first is a ledger plan slice; OMP plan mode is a separate, ungated mechanism | not for as2 (TUI-only) | Jo only (as2 rule does not bind a seat on Jo's default profile) |
| `/plan-review` |  | Re-open the plan review for the latest plan (plan mode only) | Y / - / - (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-modes.ts` `name: "plan-review"` (:347) | Jo only | not for as2 (TUI-only) | Jo only |
| `/vibe` |  | Toggle vibe mode (direct persistent fast/good worker sessions; read-only toolset) | Y / - / - | `pi-coding-agent@18.8.6 src/slash-commands/builtin-modes.ts` `name: "vibe"` (:358) | not for as2: starts its own worker sessions outside the dispatch gates and classifier | not for as2 (TUI-only) | Jo only (as2 rule does not bind a seat on Jo's default profile) |
| `/goal` | sub: set, show, pause, resume, drop, budget | Toggle goal mode (persistent autonomous objective for this session) | Y / - / - | `pi-coding-agent@18.8.6 src/slash-commands/builtin-modes.ts` `name: "goal"` (:376) | not for as2: a persistent autonomous objective outside the ledger/workload model | not for as2 (TUI-only) | Jo only (as2 rule does not bind a seat on Jo's default profile) |
| `/guided-goal` |  | Have the agent interview you in chat, then set up goal mode | Y / - / - | `pi-coding-agent@18.8.6 src/slash-commands/builtin-modes.ts` `name: "guided-goal"` (:402) | not for as2: sets up goal mode | not for as2 (TUI-only) | Jo only (as2 rule does not bind a seat on Jo's default profile) |
| `/loop` |  | Toggle loop mode: while on, the next prompt re-submits after every yield; bound it with a count/duration or gate it with `--until '<cmd>'` / `--while '<cmd>'`; Esc suspends, `/loop` again disables | Y / - / - | `pi-coding-agent@18.8.6 src/slash-commands/builtin-modes.ts` `name: "loop"` (:414) | not for as2: re-submits after every yield; as2 lanes are bounded by slices and `--max-time` | not for as2 (TUI-only) | Jo only (as2 rule does not bind a seat on Jo's default profile) |
| `/queue` |  | Queue a message for after the agent yields | Y / - / - | `pi-coding-agent@18.8.6 src/slash-commands/builtin-modes.ts` `name: "queue"` (:441) | use: Jo queues a message behind a running Ilex turn | not for as2 (TUI-only) | use (Jo, same trigger) |
| `/model` | aliases `/models` | Switch model for this session | Y / Y / Y (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-modes.ts` `name: "model"` (:454) | Jo only: changes this session's model; defaults are machinery-owned (`modelRoles`, `task.agentModelOverrides` in config.yml) | not for as2 (no sender); lane model is the launcher's `--model`/profile default (machinery-owned) | Jo only |
| `/switch` |  | Switch model for this session (same as Option+P); accepts fuzzy ids, provider/id, @role, :level | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-modes.ts` `name: "switch"` (:498) | Jo only: same effect as `/model`, accepts fuzzy id, `provider/id`, `@role`, `:level` | not for as2 (no sender); machinery-owned | Jo only |
| `/fast` | sub: on, ultra, off, status | Toggle fast service (OpenAI service_tier=priority or ultrafast, Anthropic speed=fast, Google priority) | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-modes.ts` `name: "fast"` (:549) | Jo only: provider service tier for this session | not for as2 (no sender) | Jo only |
| `/slow` | sub: on, off, status | Toggle slow mode: flex tier on OpenAI/Google; on Anthropic, continue at low priority after the Claude session limit | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-modes.ts` `name: "slow"` (:577) | Jo only: flex/low-priority tier for this session | not for as2 (no sender) | Jo only |
| `/skillful` | sub: on, off, status | Toggle listing available skills in the system prompt (session only) | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-modes.ts` `name: "skillful"` (:605) | Jo only: session-only toggle of the skill list in the system prompt; the skill set itself is machinery-owned (`skills.includeSkills`) | not for as2 (no sender) | Jo only |
| `/extended-context` | sub: on, off, status | Toggle extended context windows | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-modes.ts` `name: "extended-context"` (:661) | machinery-owned: `extendedContext: true` in config.yml; a session toggle does not persist | not for as2 (no sender); machinery-owned (config.yml) | Jo only |
| `/computer` | sub: on, off, status | Toggle the native computer-use eval prelude for this session | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-modes.ts` `name: "computer"` (:688) | not for as2: native computer-use prelude | not for as2 (no sender) | Jo only (as2 rule does not bind a seat on Jo's default profile) |
| `/ratchet` |  | Build (or reuse) an eval for an LLM flow, then hillclimb it unattended | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-modes.ts` `name: "ratchet"` (:733) | not for as2: builds an eval and hillclimbs unattended, outside the ledger | not for as2 (no sender) | Jo only (as2 rule does not bind a seat on Jo's default profile) |
| `/prewalk` | sub: restart, off | Arm, restart, or cancel a one-shot model handoff | Y / Y / Y (handle-only) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-modes.ts` `name: "prewalk"` (:767) | not for as2: one-shot handoff to another model mid-run (default the `smol` role, pi-coding-agent@18.8.6 src/session/settings.ts `id: "prewalk.enabled"`), outside the tier table | not for as2 (no sender) | Jo only (as2 rule does not bind a seat on Jo's default profile) |
| `/modelpreset` | sub: list, save, switch, delete | Save and switch model presets (role models + thinking level) | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-modes.ts` `name: "modelpreset"` (:830) | not for as2: role models and tiers are machinery-owned in config.yml / models.yml | not for as2 (no sender) | Jo only (as2 rule does not bind a seat on Jo's default profile) |
| `/effort` | sub: off, minimal, low, medium, high, xhigh, max, auto | Set reasoning effort (thinking level, intelligence) for this session; Shift+Tab cycles levels | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-modes.ts` `name: "effort"` (:880) | Jo only: thinking level for this session; Shift+Tab cycles | not for as2 (no sender) | Jo only |
| `/advisor` | sub: on, off, status, dump, configure | Toggle the advisor (a second model that reviews each turn and injects notes) | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-collaboration.ts` `name: "advisor"` (:63) | Jo only: a second model reviewing each turn; not part of as2's cross-lab review path | not for as2 (no sender) | Jo only |
| `/export` |  | Export session to HTML file | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-collaboration.ts` `name: "export"` (:180) | use: Jo exports the Ilex transcript to HTML | not for as2 (no sender) | use (Jo, same trigger) |
| `/trace` |  | Open this session's trace in the stats dashboard | Y / Y / Y (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-collaboration.ts` `name: "trace"` (:204) | Jo only | not for as2 (no sender) | Jo only |
| `/dump` | sub: all | Copy session transcript to clipboard (and write LLM request JSON to tmp) | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-collaboration.ts` `name: "dump"` (:231); `pi-coding-agent@18.8.6 src/modes/controllers/command-controller.ts` `handleDumpCommand` (the clipboard gets the transcript plus the JSON file's path, not the JSON) | use: Jo copies the transcript (and the path of the LLM request JSON on disk) when diagnosing a prompt | not for as2 (no sender) | use (Jo, same trigger) |
| `/share` |  | Share session via an encrypted link (share server or secret gist) | Y / Y / Y (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-collaboration.ts` `name: "share"` (:285) | not for as2: uploads the session off-machine (share server or secret gist) | not for as2 (no sender) | Jo only (as2 rule does not bind a seat on Jo's default profile) |
| `/collab` | sub: view, list, status, stop | Share this session live via a relay | Y / - / - | `pi-coding-agent@18.8.6 src/slash-commands/builtin-collaboration.ts` `name: "collab"` (:311) | not for as2: a guest's prompts would bypass the surface's Jo-authored input stamp; guests are host-only for mutating commands | not for as2 (TUI-only) | Jo only (as2 rule does not bind a seat on Jo's default profile) |
| `/join` |  | Join a shared collab session | Y / - / - | `pi-coding-agent@18.8.6 src/slash-commands/builtin-collaboration.ts` `name: "join"` (:440) | not for as2: see `/collab` | not for as2 (TUI-only) | Jo only (as2 rule does not bind a seat on Jo's default profile) |
| `/leave` |  | Leave the collab session | Y / - / - (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-collaboration.ts` `name: "leave"` (:472) | not for as2: see `/collab` | not for as2 (TUI-only) | Jo only (as2 rule does not bind a seat on Jo's default profile) |
| `/browser` | sub: headless, visible | Toggle browser eval-prelude headless vs visible mode | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-collaboration.ts` `name: "browser"` (:497) | not for as2: browser eval-prelude mode | not for as2 (no sender) | Jo only (as2 rule does not bind a seat on Jo's default profile) |
| `/copy` |  | Pick text or code from the conversation to copy | Y / - / - | `pi-coding-agent@18.8.6 src/slash-commands/builtin-collaboration.ts` `name: "copy"` (:567) | Jo only | not for as2 (TUI-only) | Jo only |
| `/open` |  | Open the last link from the conversation in your browser (or pick one with /copy) | Y / - / - | `pi-coding-agent@18.8.6 src/slash-commands/builtin-collaboration.ts` `name: "open"` (:619) | Jo only | not for as2 (TUI-only) | Jo only |
| `/todo` | sub: edit, copy, expand, collapse, export, import, append, start, done, drop, rm | View or modify the agent's todo list | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-session.ts` `name: "todo"` (:208) | Jo only: view/edit the agent todo list | not for as2 (no sender) | Jo only |
| `/session` | sub: info, delete, pin | Session management commands | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-session.ts` `name: "session"` (:246) | Jo only: info shows the session; delete and pin change what `--resume` finds | not for as2 (no sender) | Jo only |
| `/jobs` | sub: full | Show async background jobs status | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-session.ts` `name: "jobs"` (:324) | use: Jo inspects background jobs | not for as2 (no sender) | use (Jo, same trigger) |
| `/usage` | sub: show, reset | Show provider usage and limits | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-session.ts` `name: "usage"` (:385) | use: Jo checks provider limits before a long workload | not for as2 (no sender) | use (Jo, same trigger) |
| `/stats` |  | Launch the local stats dashboard | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-session.ts` `name: "stats"` (:432) | Jo only | not for as2 (no sender) | Jo only |
| `/changelog` | sub: full, last | Show changelog entries | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-session.ts` `name: "changelog"` (:467) | Jo only | not for as2 (no sender) | Jo only |
| `/hotkeys` |  | Show all keyboard shortcuts | Y / - / - (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-session.ts` `name: "hotkeys"` (:496) | Jo only | not for as2 (TUI-only) | Jo only |
| `/tools` |  | Show tools currently visible to the agent | Y / Y / Y (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-session.ts` `name: "tools"` (:505) | use: Jo or Ilex-guided check of which tools the agent sees (confirms extension/gate tool surface) | not for as2 (no sender) | use (Jo, same trigger) |
| `/context` |  | Show estimated context usage breakdown | Y / Y / Y (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-session.ts` `name: "context"` (:534) | use: Jo checks context usage against `compaction.thresholdPercent` (25) | not for as2 (no sender) | use (Jo, same trigger) |
| `/extensions` | aliases `/status` | Open Extension Control Center dashboard | Y / - / - (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-session.ts` `name: "extensions"` (:553) | Jo only: dashboard; the extension list is machinery-owned (`extensions:` in config.yml) | not for as2 (TUI-only) | Jo only |
| `/agents` |  | Open the agents hub (per-agent model, prewalk, and advisor) | Y / - / - (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-session.ts` `name: "agents"` (:563) | Jo only: per-agent model hub; tier models are machinery-owned (`task.agentModelOverrides`) | not for as2 (TUI-only) | Jo only |
| `/git` |  | Open the git UI (split diff viewer, staging, commit composer) | Y / - / - | `pi-coding-agent@18.8.6 src/slash-commands/builtin-session.ts` `name: "git"` (:572) | Jo only | not for as2 (TUI-only) | Jo only |
| `/hub` |  | Open the live Agent Hub | Y / - / - (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-session.ts` `name: "hub"` (:583) | Jo only | not for as2 (TUI-only) | Jo only |
| `/branch` | aliases `/rewind` | Rewind to a previous message, keeping the old path as a branch | Y / - / - (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-session.ts` `name: "branch"` (:592) | Jo only: rewind to an earlier message and keep the old path as a branch | not for as2 (TUI-only) | Jo only |
| `/fork` |  | Create a new fork from a previous message | Y / - / - (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-session.ts` `name: "fork"` (:602) | Jo only | not for as2 (TUI-only) | Jo only |
| `/tree` |  | Navigate session tree (switch branches) | Y / - / - (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-session.ts` `name: "tree"` (:611) | Jo only | not for as2 (TUI-only) | Jo only |
| `/login` |  | Login with OAuth provider | Y / - / - | `pi-coding-agent@18.8.6 src/slash-commands/builtin-session.ts` `name: "login"` (:620) | use: Jo, once per profile, per provider (`bin/as2 install` prints which) | not for as2 (TUI-only) | use (Jo, same trigger) |
| `/logout` |  | Logout from OAuth provider | Y / - / - | `pi-coding-agent@18.8.6 src/slash-commands/builtin-session.ts` `name: "logout"` (:673) | Jo only | not for as2 (TUI-only) | Jo only |
| `/mcp` | sub: add, list, remove, test, reauth, unauth, enable, disable, smithery-search, smithery-login, smithery-logout, reconnect, reload, resources, prompts, notifications, help | Manage MCP servers (add, list, remove, test) | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-session.ts` `name: "mcp"` (:696) | machinery-owned: the profile's MCP set is `profile/mcp.json` (server `ctx`); `/mcp` edits and reconnects at run time; Jo may `list`/`reconnect` | not for as2 (no sender); machinery-owned (profile/mcp.json) | Jo only |
| `/ssh` | sub: add, list, remove, help | Manage SSH hosts (add, list, remove) | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "ssh"` (:153) | not for as2: SSH host registry for remote tools | not for as2 (no sender) | Jo only (as2 rule does not bind a seat on Jo's default profile) |
| `/new` |  | Start a new session | Y / - / - (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "new"` (:176) | Jo only: a new Ilex session; the surface re-renders the ledger at wake | not for as2 (TUI-only) | Jo only |
| `/fresh` |  | Reset provider stream state without changing the local transcript | Y / Y / Y (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "fresh"` (:185) | Jo only: reset provider stream state when a stream is stuck; transcript unchanged | not for as2 (no sender) | Jo only |
| `/clear` |  | Clear the conversation context in place, keeping the session | Y / - / - (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "clear"` (:207) | Jo only | not for as2 (TUI-only) | Jo only |
| `/delete` |  | Delete the current session and start a new one | Y / - / - (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "delete"` (:218) | Jo only | not for as2 (TUI-only) | Jo only |
| `/compact` | sub: soft, remote, snapcompact | Manually compact the session context | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "compact"` (:227) | use: Jo may compact by hand; thresholds and `methodOrder` are machinery-owned (config.yml `compaction`) | not for as2 (no sender) | use (Jo, same trigger) |
| `/shake` | sub: elide, images, thinking | Drop heavy content from context (tool results, large blocks) | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "shake"` (:293) | use: drops old tool output for recoverable artifact links, no model call; first in config.yml `compaction.methodOrder` | not for as2 (no sender) | use (Jo, same trigger) |
| `/handoff` |  | Summarize the session into a handoff document and compact in place | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "handoff"` (:322) | Jo only: summarise into a handoff document and compact in place | not for as2 (no sender) | Jo only |
| `/resume` |  | Resume a different session | Y / - / - | `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "resume"` (:389) | Jo only: switch session; at launch use `--resume` | not for as2 (TUI-only) | Jo only |
| `/pin` |  | Pin or unpin a session at the top of the resume list | Y / Y / Y (handle-only) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "pin"` (:425) | Jo only: pin a session in the resume list | not for as2 (no sender) | Jo only |
| `/btw` |  | Ask a side question, or browse this session's BTW history | Y / - / - | `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "btw"` (:456) | Jo only | not for as2 (TUI-only) | Jo only |
| `/tan` |  | Run a full background agent on tangential work | Y / - / - | `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "tan"` (:468) | not for as2: per its description a full background agent started from the TUI, not a classified `task` dispatch through the gates | not for as2 (TUI-only) | Jo only (as2 rule does not bind a seat on Jo's default profile) |
| `/omfg` |  | Forge a TTSR rule from a complaint to stop a recurring behavior | Y / - / - | `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "omfg"` (:480) | not for as2: forges a TTSR rule from a complaint; rules are machinery (voice/contract), not run-time | not for as2 (TUI-only) | Jo only (as2 rule does not bind a seat on Jo's default profile) |
| `/cleanse` |  | Detect and fix project diagnostics with weighted parallel subagents | Y / - / - | `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "cleanse"` (:492) | not for as2: per its description weighted parallel subagents started from the TUI, outside the dispatch classifier | not for as2 (TUI-only) | Jo only (as2 rule does not bind a seat on Jo's default profile) |
| `/retry` |  | Retry the last failed agent turn | Y / Y / Y (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "retry"` (:504) | use: Jo retries a failed Ilex turn | not for as2 (no sender) | use (Jo, same trigger) |
| `/debug` |  | Open debug tools selector | Y / - / - (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "debug"` (:539) | Jo only | not for as2 (TUI-only) | Jo only |
| `/memory` | sub: view, stats, diagnose, queue, sync, clear, reset, enqueue, rebuild, mm list, mm show, mm refresh, mm history, mm seed, mm delete, mm reload | Inspect and operate memory maintenance | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "memory"` (:548) | Jo only | not for as2 (no sender) | Jo only |
| `/rename` |  | Rename the current session (omit title to generate) | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "rename"` (:637) | use: Jo titles the session | not for as2 (no sender) | use (Jo, same trigger) |
| `/move` |  | Move the current session to a different directory | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "move"` (:715) | not for as2: Ilex's cwd is fixed to the checkout by `bin/as2` | not for as2 (no sender); the lane worktree is fixed by the launcher | Jo only |
| `/wt` | aliases `/worktree` | Move this session into a new worktree, changes included | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "wt"` (:745) | not for as2: lane worktrees (`wl/<id>`) are created by the launcher, with ledger bookkeeping | not for as2 (no sender); the launcher owns worktrees | Jo only |
| `/add-dir` |  | Add a workspace directory to this session (multi-root) | Y / Y / Y (handle-only) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "add-dir"` (:780) | Jo only: adds a workspace root to this session (`/dirs` lists the roots); per-mode limits in § Pairing and workspace directories | not for as2 (no sender); the lane argv carries no `--add-dir` | Jo only |
| `/remove-dir` |  | Remove a workspace directory from this session | Y / Y / Y (handle-only) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "remove-dir"` (:812) | Jo only: inverse of `/add-dir` | not for as2 (no sender) | Jo only |
| `/dirs` |  | List this session's workspace directories | Y / Y / Y (handle-only) (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "dirs"` (:841) | use: Jo or Ilex-guided check of this session's workspace roots | not for as2 (no sender) | use (Jo, same trigger) |
| `/exit` |  | Exit the application | Y / - / - (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "exit"` (:850) | Jo only | not for as2 (TUI-only) | Jo only |
| `/restart` |  | Restart omp with the same launch flags, resuming this session | Y / - / - (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "restart"` (:855) | Jo only: re-execs omp with the same launch flags (keeps `--append-system-prompt`), resuming the session | not for as2 (TUI-only) | Jo only |
| `/marketplace` | sub: add, remove, update, list, discover, install, uninstall, installed, upgrade, help | Manage marketplace plugin sources and installed plugins | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-marketplace.ts` `name: "marketplace"` (:45) | not for as2: plugin installs would add commands/skills outside `skills.includeSkills` and `extensions:` | not for as2 (no sender); machinery-owned | Jo only |
| `/plugins` | aliases `/plugin`; sub: list, enable, disable | View and manage installed plugins | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-marketplace.ts` `name: "plugins"` (:425) | not for as2: see `/marketplace` | not for as2 (no sender); machinery-owned | Jo only |
| `/reload-plugins` |  | Reload all plugins (skills, commands, hooks, tools, agents, MCP) | Y / Y / Y (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-marketplace.ts` `name: "reload-plugins"` (:557) | Jo only: reload skills/commands/hooks/tools/MCP after editing the checkout's `skills/` or `profile/mcp.json` | not for as2 (no sender) | Jo only |
| `/skills` | sub: search, install, installed, update | Search, install, and update skills from the skills.omp.sh registry | Y / - / - | `pi-coding-agent@18.8.6 src/slash-commands/builtin-skills.ts` `name: "skills"` (:66) | not for as2: installs from skills.omp.sh bypass the allowlist; the checkout's `skills/` is the only source (config.yml) | not for as2 (TUI-only) | Jo only (as2 rule does not bind a seat on Jo's default profile) |
| `/force` | aliases `/force:` | Force next turn to use a specific tool | Y / Y / Y | `pi-coding-agent@18.8.6 src/slash-commands/builtin-control.ts` `name: "force"` (:9) | Jo only: force the next turn to use a named tool | not for as2 (no sender) | Jo only |
| `/live` |  | Start Codex-backed realtime voice mode | Y / - / - (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-control.ts` `name: "live"` (:59) | not for as2: Codex-backed realtime voice mode | not for as2 (TUI-only) | Jo only (as2 rule does not bind a seat on Jo's default profile) |
| `/record` |  | Start or stop recording this screen to a replayable file (omp play) | Y / - / - (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-control.ts` `name: "record"` (:68) | Jo only | not for as2 (TUI-only) | Jo only |
| `/pause` |  | Freeze all agents (main, subagents, advisor) until resumed | Y / - / - (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-control.ts` `name: "pause"` (:77) | Jo only: freezes main, subagents and advisor until resumed | not for as2 (TUI-only) | Jo only |
| `/quit` | aliases `/q` | Quit the application | Y / - / - (no args) | `pi-coding-agent@18.8.6 src/slash-commands/builtin-control.ts` `name: "quit"` (:86) | Jo only | not for as2 (TUI-only) | Jo only |

## Dynamic slash commands

Built-ins are not the whole slash surface. `buildAvailableSlashCommands` (`pi-coding-agent@18.8.6 src/slash-commands/available-commands.ts`) appends, in this order and **first name wins** (`seenNames`): (1) built-ins with `handle` (their aliases reserved too), (2) skill commands, (3) extension commands, (4) `session.customCommands` (custom TS commands, then MCP prompt commands, tagged `mcp_prompt` when `path` starts with `mcp:`), (5) file commands. The `source` tag is `builtin | skill | extension | custom | mcp_prompt | file` (`AvailableSlashCommandSource`); rpc exposes the list with `get_available_commands` and the `available_commands_update` event (`pi-coding-agent@18.8.6 src/modes/rpc/rpc-mode.ts` `getAvailableCommands`).

The advertised order is not the execution order. For an rpc `prompt` message: skill (`dispatchRpcSkillPrompt`, gated by `skills.enableSkillCommands`) → built-in with `handle` → `session.prompt`: extension command → custom TS command, then MCP prompt command → file command (`expandSlashCommand`, only if the text still starts with `/`). Anchors: `pi-coding-agent@18.8.6 src/modes/rpc/rpc-mode.ts` `dispatchOrderedUserInput`; `pi-coding-agent@18.8.6 src/session/agent-session.ts` `#tryExecuteExtensionCommand`, `#tryExecuteCustomCommand`. `steer` and `follow_up` messages skip the skill and built-in steps. The TUI picker lists built-ins, extension, custom, then skill commands (`pi-coding-agent@18.8.6 src/modes/interactive-mode.ts`), with file commands added by `refreshSlashCommandState`. An extension command whose name collides with a built-in name or alias is dropped and logged (`pi-coding-agent@18.8.6 src/extensibility/extensions/runner.ts` `getRegisteredCommands`).

### Skill commands (`/skill:<name>`): 22

How OMP builds them: each loaded skill becomes `skill:${skill.name}` (`pi-coding-agent@18.8.6 src/extensibility/skills.ts` `getSkillSlashCommandName`) while `skills.enableSkillCommands` is true (default `true`; the as2 profile does not set it). rpc runs one before built-ins and builds the prompt from the skill file (`pi-coding-agent@18.8.6 src/modes/rpc/rpc-mode.ts` `resolveRpcSkillInvocation`, `buildSkillPromptMessage`). Precedence: second in the list, after built-ins; first in rpc execution.

Which skills: `profile/config.yml` «Skills» sets `skills.customDirectories: ["{repo}/skills"]`, turns every other skill provider off, and allowlists 22 names in `skills.includeSkills` (glob match, `pi-coding-agent@18.8.6 src/extensibility/skills.ts`). The checkout's `skills/` holds those 22 directories plus `VENDOR.md`. The rpc probe returned exactly these 22.

A lane's model loads a skill with `read skill://<name>` when its trigger fires (the catalogue is in its system prompt); that is the lane's `use`. The typed `/skill:<name>` form has no sender in a lane.

| Command | What it does (SKILL.md `description`, shortened) | Source anchor | Ilex | lane | seat |
|---|---|---|---|---|---|
| `/skill:accessibility` | WCAG 2.2 AA audit of changed files or a given file; writes a severity-grouped review under `.tmp/` and fixes nothing until the user names the findings to fix | `skills/accessibility/SKILL.md` | use: Jo asks for an accessibility review | use: a slice is a11y work | not for as2 (not loaded: other seats run Jo's own skill set; the `ilex` seat = Ilex column) |
| `/skill:api-and-interface-design` | stable API and interface design, module boundaries, type contracts | `skills/api-and-interface-design/SKILL.md` | use: Jo discusses an interface | use: a slice designs an API | not for as2 (not loaded: other seats run Jo's own skill set; the `ilex` seat = Ilex column) |
| `/skill:code-review-and-quality` | multi-axis review before merge, of own, agent or human code | `skills/code-review-and-quality/SKILL.md` | use: before Jo merges | use: judge slices, pre-merge | not for as2 (not loaded: other seats run Jo's own skill set; the `ilex` seat = Ilex column) |
| `/skill:cross-model-review` | fans a judge slice across Claude, Codex/GPT and Kimi (triad) | `skills/cross-model-review/SKILL.md` | use: a plan or diff needs cross-lab review (the plan-approval question is refused without one) | use: judge slices | not for as2 (not loaded: other seats run Jo's own skill set; the `ilex` seat = Ilex column) |
| `/skill:ctx` | search earlier agent sessions for a decision, diagnosis or attempt | `skills/ctx/SKILL.md` | use: Ilex looks up what an earlier session decided | use: same | not for as2 (not loaded: other seats run Jo's own skill set; the `ilex` seat = Ilex column) |
| `/skill:debugging-and-error-recovery` | systematic root-cause debugging | `skills/debugging-and-error-recovery/SKILL.md` | use: a test/build/behaviour fails | use: same | not for as2 (not loaded: other seats run Jo's own skill set; the `ilex` seat = Ilex column) |
| `/skill:deprecation-and-migration` | removing old systems or migrating users, schemas | `skills/deprecation-and-migration/SKILL.md` | use: a removal/migration is discussed | use: a slice removes or migrates | not for as2 (not loaded: other seats run Jo's own skill set; the `ilex` seat = Ilex column) |
| `/skill:documentation-and-adrs` | decision records and docs for architecture, API, shipped features | `skills/documentation-and-adrs/SKILL.md` | use: a decision needs recording | use: a slice writes ADRs/docs | not for as2 (not loaded: other seats run Jo's own skill set; the `ilex` seat = Ilex column) |
| `/skill:execute-plan` | executes an approved plan end to end with a fresh implementer subagent per task | `skills/execute-plan/SKILL.md` | use: Jo approves a plan | use: a lane executes an approved plan | not for as2 (not loaded: other seats run Jo's own skill set; the `ilex` seat = Ilex column) |
| `/skill:git-workflow-and-versioning` | commits, branches, conflicts, PRs, releases | `skills/git-workflow-and-versioning/SKILL.md` | use: git work, within as2's gate rules | use: any code change | not for as2 (not loaded: other seats run Jo's own skill set; the `ilex` seat = Ilex column) |
| `/skill:humanizer` | rewrites AI-sounding text so it reads like the writer | `skills/humanizer/SKILL.md` | use: Jo asks for prose that reads human | use: a slice writes user-facing text | not for as2 (not loaded: other seats run Jo's own skill set; the `ilex` seat = Ilex column) |
| `/skill:impeccable` | design/redesign/polish/critique frontend interfaces | `skills/impeccable/SKILL.md` | use: Jo wants UI design work | use: UI slices | not for as2 (not loaded: other seats run Jo's own skill set; the `ilex` seat = Ilex column) |
| `/skill:interview-me` | one-question-at-a-time interview to extract real intent | `skills/interview-me/SKILL.md` | use: an ask is underspecified | not for as2: an autonomous lane has no one to interview; it raises a ledger question | not for as2 (not loaded: other seats run Jo's own skill set; the `ilex` seat = Ilex column) |
| `/skill:observability-and-instrumentation` | logging, metrics, tracing, alerting | `skills/observability-and-instrumentation/SKILL.md` | use: Jo discusses production visibility | use: instrumentation slices | not for as2 (not loaded: other seats run Jo's own skill set; the `ilex` seat = Ilex column) |
| `/skill:performance-optimization` | frontend, backend, query performance | `skills/performance-optimization/SKILL.md` | use: a perf problem is on the table | use: perf slices | not for as2 (not loaded: other seats run Jo's own skill set; the `ilex` seat = Ilex column) |
| `/skill:research` | primary-source research that writes a cited findings file | `skills/research/SKILL.md` | use: a decision rests on external behaviour | use: research slices | not for as2 (not loaded: other seats run Jo's own skill set; the `ilex` seat = Ilex column) |
| `/skill:resolving-merge-conflicts` | resolves an in-progress merge/rebase conflict | `skills/resolving-merge-conflicts/SKILL.md` | use: a merge/rebase is conflicted | use: same | not for as2 (not loaded: other seats run Jo's own skill set; the `ilex` seat = Ilex column) |
| `/skill:security-and-hardening` | input validation, auth, storage, integrations, dependencies | `skills/security-and-hardening/SKILL.md` | use: a security review | use: security slices | not for as2 (not loaded: other seats run Jo's own skill set; the `ilex` seat = Ilex column) |
| `/skill:seo-audit` | audit-only SEO / AI-search check of a live URL | `skills/seo-audit/SKILL.md` | use: Jo asks for an SEO audit | use: SEO slices | not for as2 (not loaded: other seats run Jo's own skill set; the `ilex` seat = Ilex column) |
| `/skill:spec-and-plan` | spec, then an ordered sized task plan, before coding | `skills/spec-and-plan/SKILL.md` | use: new feature with no spec | use: plan slices | not for as2 (not loaded: other seats run Jo's own skill set; the `ilex` seat = Ilex column) |
| `/skill:test-driven-development` | red-green-refactor; proves code works | `skills/test-driven-development/SKILL.md` | use: any logic or bug change | use: change slices | not for as2 (not loaded: other seats run Jo's own skill set; the `ilex` seat = Ilex column) |
| `/skill:writing-for-agents` | writing skills, AGENTS.md, CLAUDE.md | `skills/writing-for-agents/SKILL.md` | use: editing skills or the card | use: same | not for as2 (not loaded: other seats run Jo's own skill set; the `ilex` seat = Ilex column) |

### Extension commands (`registerCommand`): 1, from OMP itself

How OMP builds them: an extension calls `api.registerCommand(name, {description, handler, getArgumentCompletions})`; `ExtensionRunner.getRegisteredCommands(reserved)` returns them minus built-in collisions; `session.prompt` runs them first, even while streaming (`pi-coding-agent@18.8.6 src/session/agent-session.ts` `#tryExecuteExtensionCommand`). Precedence: third in the list.

The extensions an as2 session loads are `{repo}/surface/index.ts`, `{repo}/gates/index.ts` and `{repo}/classifier/extension.ts` (`profile/config.yml` `extensions:`), the profile's auto-discovered `agent/extensions/receipts-audit-omp.ts`, and for the `ilex` seat only `herdr-omp-agent-state.ts` and `moshi-hooks.ts` (`launch-seat` `ILEX_EXTENSIONS`). **None registers a command**: a search for `registerCommand|registerSlash|setSlashCommand|slashCommand` over `surface/`, `gates/` and `classifier/` finds nothing, and the receipts-audit, herdr and moshi files have no `registerCommand`. So as2's own extension source is empty. The one extension command an as2 session shows comes from OMP: the SDK loads `createAutoresearchExtension` unconditionally (`pi-coding-agent@18.8.6 src/sdk.ts`).

| Command | What it does | Source anchor | Ilex | lane | seat |
|---|---|---|---|---|---|
| `/autoresearch [off\|clear\|<goal>]` | Toggles OMP's builtin autoresearch mode: creates an `autoresearch/*` git branch (needs a clean tree), activates `init_experiment`/`run_experiment`/`log_experiment`/`update_notes`, commits kept runs; registers a `ctrl+x` dashboard toggle | `pi-coding-agent@18.8.6 src/autoresearch/index.ts` `api.registerCommand("autoresearch"`; `pi-coding-agent@18.8.6 src/autoresearch/git.ts` `ensureAutoresearchBranch` | not for as2: it makes branches and commits itself, outside the lane/worktree and push gates | not for as2: reachable in rpc as an extension command, no sender; it would branch off `wl/<id>` | Jo only (builtin to every OMP, any profile) |

### Custom (TypeScript) commands: 3, all OMP-bundled

How OMP builds them: `loadCustomCommands` (`pi-coding-agent@18.8.6 src/extensibility/custom-commands/loader.ts`) loads the bundled commands first (`loadBundledCommands`: `bundled:green`, `bundled:review`, `bundled:annotate`), then `index.ts|js|mjs|cjs` in each subdirectory of `<agentDir>/commands` and of the project/user config `commands` dirs (`discoverCustomCommands`). Precedence: fourth in the list; a user or project command may override a bundled one of the same name; two user/project commands with one name conflict and the later is an error.

No custom command directory exists for the as2 profile (`~/.omp/profiles/<profile>/agent/commands`, checked for the default `agent-system-2`, and `~/.omp/agent/commands` absent; the checkout's `.omp/` holds only `agents/`), so the source is exactly the three bundled commands.

| Command | What it does | Source anchor | Ilex | lane | seat |
|---|---|---|---|---|---|
| `/green` | Renders a prompt that iterates on CI failures until the branch is green (uses HEAD tag, branch, remote) | `pi-coding-agent@18.8.6 src/extensibility/custom-commands/loader.ts` `path: "bundled:green"`; `pi-coding-agent@18.8.6 src/extensibility/custom-commands/bundled/ci-green/index.ts` `class GreenCommand` (`name = "green"`) | not for as2: CI/test runs go through `lane_full_test` outside the fence; a free-form "iterate until green" loop is not a slice | not for as2: reachable in rpc (returns a prompt), no sender | Jo only |
| `/review [PR ref] [instructions]` | Interactive code-review launcher (target pickers); headless (`!ctx.hasUI`) it returns a review prompt | `pi-coding-agent@18.8.6 src/extensibility/custom-commands/loader.ts` `path: "bundled:review"`; `pi-coding-agent@18.8.6 src/extensibility/custom-commands/bundled/review/index.ts` `class ReviewCommand` (`name = "review"`; `if (!ctx.hasUI) return buildHeadlessReviewPrompt`) | not for as2: reviews are cross-lab judge slices (`cross-model-review` skill, SPEC § B4), which a same-session `/review` does not satisfy | not for as2: judge slices run on a different lab via `task`; `/review` is not sent | Jo only |
| `/annotate` | Annotate the latest reply, a message/code block, a diff or PR, a file, or literal text; pastes the annotations into the editor | `pi-coding-agent@18.8.6 src/extensibility/custom-commands/loader.ts` `path: "bundled:annotate"`; `pi-coding-agent@18.8.6 src/extensibility/custom-commands/bundled/annotate/index.ts` `class AnnotateCommand` (`name = "annotate"`) | Jo only: needs the editor (`ctx.ui.pasteToEditor`) | not for as2 (no sender; it needs a UI: `ctx.ui.pasteToEditor`) | Jo only |

### MCP prompt commands: 0 (empty)

How OMP builds them: for every connected MCP server, each `prompts/list` entry becomes `<server>:<prompt>` with `path: "mcp:<server>:<prompt>"` (`pi-coding-agent@18.8.6 src/sdk.ts` `buildMCPPromptCommands`); arguments are `key=value` tokens passed to `prompts/get`; the list is rebuilt when prompts change (`setOnPromptsChanged`). Precedence: appended to `session.customCommands` after the TS commands, so a TS command of the same name wins.

The as2 profile has one MCP server, `ctx` (`profile/mcp.json`: `type: stdio`, `command: ctx`, `args: ["mcp","serve"]`). **The source is empty.** The rpc count command in the header prints no `mcp_prompt` line, and a direct stdio probe of `ctx mcp serve` (`initialize`, `notifications/initialized`, `prompts/list`) answered `initialize` with `capabilities: {"tools":{"listChanged":false}}` (ctx 2.2.8) and `prompts/list` with `{"code":-32601,"message":"Method not found"}`: the server advertises tools only.

### File commands (markdown command files): 1, OMP-embedded

How OMP builds them: `loadSlashCommands` (`pi-coding-agent@18.8.6 src/extensibility/slash-commands.ts`) loads the `slash-commands` capability from every registered discovery provider (`pi-coding-agent@18.8.6 src/discovery/`: native `.omp` dirs, `~/.claude/commands` and `<cwd>/.claude/commands`, `~/.codex/commands` and `.codex/commands`, agents, opencode, Claude and OMP plugins), keyed by name with the capability's priority dedup, then appends OMP's embedded templates (`EMBEDDED_COMMAND_TEMPLATES`, `pi-coding-agent@18.8.6 src/task/commands.ts`) unless a file command of that name exists. Files are markdown with optional frontmatter (`description`, `argument-hint`); `expandSlashCommand` substitutes `$ARGUMENTS` and positional placeholders. Precedence: last in the list. The `skills.enable*` keys gate skills only; the as2 profile sets no `disabledProviders`, so every command provider is active.

On this machine no on-disk command file exists (`~/.claude/commands`, `~/.codex/commands`, `~/.omp/agent/commands`, `~/.agents/commands`, `~/.config/opencode/commands` and the profile's `agent/commands` are absent; the checkout has no `.claude`, `.agents` or `.omp/commands`). The one file command is the embedded `init`. Another repo's worktree may add its own `.omp/commands` or `.claude/commands`; those are per-repo and not listed here.

| Command | What it does | Source anchor | Ilex | lane | seat |
|---|---|---|---|---|---|
| `/init` | Embedded template (frontmatter `description: Generate AGENTS.md for current codebase`): tells the agent to run parallel `task` research agents over source, tests, configs and docs and synthesise one AGENTS.md | `pi-coding-agent@18.8.6 src/prompts/agents/init.md` (`name: init`); registered by `pi-coding-agent@18.8.6 src/task/commands.ts` `EMBEDDED_COMMANDS` and appended in `pi-coding-agent@18.8.6 src/extensibility/slash-commands.ts` `loadSlashCommands` (`source: "bundled"`) | not for as2: the card `AGENTS.md` is rendered by the installer from `profile/AGENTS.md`; `/init` would write a repo AGENTS.md instead | not for as2: reachable in rpc (file commands expand inside `session.prompt`), no sender | Jo only |

## Pairing and workspace directories

Graham's note, relayed by Jo on 2026-10-14: "in paired mode you cannot add a dir after start." Verified against the OMP 18.8.6 source and six live runs (RPC, print, ACP, `/collab` host, `/collab` guest, the paired-coding gate in both phases). The note names no single mode, and Jo accepted (2026-10-15) recording the verdict for each candidate mode, as below.

**Workspace directories never gate file access.** `--add-dir`, `/add-dir` and `workspace.additionalDirectories` only add roots to the system prompt (context files and a workspace tree for each root) and to the list a non-isolated subagent inherits. No OMP tool reads that list. In the live RPC, print and `/collab` runs, an agent read and wrote a directory that was never added, including one whose `/add-dir` had just been refused for a `/collab` guest. So "cannot add a dir" in OMP means "cannot register it as a workspace root". It never means "cannot read or write it". What can limit access is a write policy that ignores the root list and treats added and unadded dirs alike: OMP plan mode's write guard, the paired-coding gate, or a Seatbelt fence (rows below).

How OMP adds a directory:

- **At start.** `--add-dir` (repeatable) is merged with `workspace.additionalDirectories` and with the roots a resumed session's header restores (`pi-coding-agent@18.8.6 src/sdk.ts`, `getAdditionalDirectories`; `pi-coding-agent@18.8.6 src/session/session-manager.ts` `setAdditionalDirectories`).
- **After start.** `/add-dir <path>` (`pi-coding-agent@18.8.6 src/slash-commands/builtin-lifecycle.ts` `name: "add-dir"`) refuses only in these cases:
  - while the session is streaming ("Cannot add a directory while streaming.");
  - with no argument;
  - for a path that is not an existing directory;
  - for the cwd itself (`addWorkspaceDirectory`).

  It has no mode, plan, collab or pairing check. It persists the root to the session header and rebuilds the system prompt. One exception: while the session file is in fallback (a resumed session whose recorded cwd could not be entered, or a cwd change made without relocation, so the transcript still sits in its old bucket), `addWorkspaceDirectory` (`pi-coding-agent@18.8.6 src/session/session-manager.ts`, the `#fallbackRuntimeOnly` branch) keeps the root runtime-only and does not write the header.
- **Editing `workspace.additionalDirectories` live.** This adds or removes only the roots that setting seeded (`pi-coding-agent@18.8.6 src/session/agent-session.ts` `#syncSettingsWorkspaceDirectories`). It leaves `--add-dir` and `/add-dir` roots alone.

| Mode | Add a dir after start? | Source and live evidence |
|---|---|---|
| Interactive TUI (Ilex, seats, `/collab` host) | **yes** | The handler has no mode check. Live: "Added …" in the `/collab` host TUI and the paired-coding TUI, and read and write followed. Refused only while a turn streams (source only). |
| RPC (`--mode rpc`, every as2 lane) | **between turns only** | A `prompt` command runs built-ins through `executeAcpBuiltinSlashCommand` (`pi-coding-agent@18.8.6 src/modes/rpc/rpc-mode.ts` `dispatchOrderedUserInput`). Live: it worked when idle, and "Cannot add a directory while streaming." came back mid-turn. As `steer` or `follow_up` the text goes to the model. as2's lane runner sends no `/add-dir` and passes no `--add-dir`. |
| Print (`omp -p`) | **no, silently** | Each message goes straight to `session.prompt` with no slash dispatch (`pi-coding-agent@18.8.6 src/modes/print-mode.ts`). Live: the model got the text and falsely claimed the dir was added. Access was not limited. Not a paired mode. |
| ACP (`omp --mode acp`) | **yes** | The same handler runs (`pi-coding-agent@18.8.6 src/slash-commands/acp-builtins.ts` `executeAcpBuiltinSlashCommand`). A client's `additionalDirectories` in `session/new` is ignored (`pi-coding-agent@18.8.6 src/modes/acp/acp-agent.ts` `newSession`). An fs-capable client that refuses paths outside its own roots could deny writes there (`pi-coding-agent@18.8.6 src/tools/acp-bridge.ts` `routeWriteThroughBridge`). Not run: no such client here. |
| `/collab` guest | **no** (the one mode where the note holds) | Every built-in off the 12-entry guest allowlist is refused (`pi-coding-agent@18.8.6 src/collab/guest.ts` `COLLAB_GUEST_ALLOWED_COMMANDS`; `pi-coding-agent@18.8.6 src/slash-commands/builtin-registry.ts` `executeBuiltinSlashCommand`). `add-dir`, `remove-dir` and `dirs` are not on the list. Live: "/add-dir is host-only during a collab session". This limits registration only: the guest's prompts still read and wrote the unregistered dir on the host, and the host can add dirs for the guest. |
| Plan mode | **yes** (source only) | `/add-dir` has no plan check. `enforcePlanModeWrite` (`pi-coding-agent@18.8.6 src/tools/plan-mode-guard.ts`) refuses working-tree writes in every dir alike. |
| `task` subagents (hands) | **n/a** | Hands cannot type `/add-dir`. A worktree-isolated subagent gets no extra roots. A non-isolated one copies the parent's list at spawn (`pi-coding-agent@18.8.6 src/task/structured-subagent.ts`), so a root added later does not reach a running hand (inference, not run live). |
| paired-coding gate (plugin 1.3.2) | **yes, but no writes there** | `/add-dir` registers the dir and reads work, in both phases. Writes there are refused exactly as for a dir passed with `--add-dir` before start. Host `write` is refused while pairing (`paired-coding@1.3.2 core/gate.mjs` `toolVerdict`, list `HOST_MUTATING_TOOLS`). `pair_write` is refused outside the agreed worktree-relative boundary ("outside the agreed boundary; reopen": `paired-coding@1.3.2 core/gate.mjs` `checkWrite` via `targetProblem`, called from `paired-coding@1.3.2 lib/verbs.mjs` `writeVerb`). An absolute boundary entry is refused at `pair_propose` (`paired-coding@1.3.2 core/gate.mjs` `pairPropose` via `boundaryProblem`, dispatched by `paired-coding@1.3.2 lib/verbs.mjs` `executeVerb`). `pair_run` runs under a Seatbelt profile that allows writes only to temp paths, a few `/dev` files and, while open, the boundary (`paired-coding@1.3.2 core/gate.mjs` `pairRunProfile` via `profileFor`; run by `paired-coding@1.3.2 lib/host-io.mjs` `runCommand`). So the limit is "no writes outside the agreed change set", not "no dir after start". |
| as2 `paired` mode | **unresolved** | Not built: `ledger/schema.sql` allows only `autonomous` and `user-driven`. It is planned on the paired-coding gate core, so the gate's row is the best preview. |
| Plumb seat fence | **unresolved** | The probe was refused by P-11 row 6. Inference from source: the Seatbelt profile is fixed at exec and denies writes only under the ledger dir, so a dir added before or after start would be treated the same. |

Per role:

- **Ilex.** `/add-dir` and `/remove-dir` are Jo's to type. `/dirs` is safe to suggest.
- **Lane.** as2 adds no dirs, and a lane needs none: file access is not gated by roots, and the fence decides what a lane may write.
- **Seat.** In a `/collab` session, a guest asks the host to add the dir.

## Settings

All 541 ids of `orderedSettings()` (`pi-coding-agent@18.8.6 src/config/all-settings.ts`), grouped under the 37 domain modules all-settings.ts imports: domains in order of their first id, rows in `orderedSettings()` order within a domain (the panel order interleaves a few domains, so the grouped order differs from the flat list). Each domain states one group verdict; a cell reading `= group` shares it, `= Ilex` repeats the Ilex cell. "rpc-pinned" in the type column is the definition's `protocolDefault`: an rpc or ACP host starts from OMP's default, not the persisted preference, unless the host configures the key itself (`pi-coding-agent@18.8.6 src/config/registry.ts` `DefinitionBase.protocolDefault`); lanes are rpc. Descriptions are the setting's own `ui.description` or definition `description` unless a source is named in italics.

Facts behind the verdicts:

- An agent writes settings only from the top-level TUI session and only with Jo's approval: `cfg://<setting>` (session override) and `cfg://<setting>/save` (persist to the profile's config.yml). Subagents, print, rpc and ACP sessions never see the scheme (`pi-coding-agent@18.8.6 src/internal-urls/cfg-protocol.ts` header comment, "Only a session created with `settingsApproval` (the top-level TUI session) may write"). So a lane or hand changes no setting; Ilex changes one only with Jo's approval.
- `install/install.sh` section 5 (`# ---- 5. the OMP profile`) writes the rendered `profile/config.yml` over `~/.omp/profiles/<profile>/agent/config.yml` on every install, so a `/settings` or `cfg://…/save` edit to a machinery-owned key is lost at the next install. Change `profile/config.yml` and re-install.
- `--mode rpc` (lanes) and `--no-title` (seat-bin/omp) both set `PI_NO_TITLE` (`pi-coding-agent@18.8.6 src/main.ts`, `parsedArgs.noTitle || parsedArgs.mode === "rpc"`), so the title domain is inert there.
- as2 code reads two settings through OMP's handles: `bash.autoBackground.enabled` (the M4b fence refuses bash while it is false) and `disabledProviders` (the classifier drops those providers from a tier row): `gates/src/host.ts` `HOST_SETTING_IDS`, `gates/src/fence.ts`, `classifier/extension.ts` `disabledProviders`.
- The gates rely on extension and MCP tools mounted as xd:// devices (`tools.xdev`, default `true`; `gates/src/session.ts`) and drop `ask` from a lane unless its workload is user-driven (`gates/src/rows/r14-ask-policy.ts` `askAllowed`).
- `find.enabled` `auto` turns `find` on only when the judge role is a native TypeSafe jev model; the profile pins `modelRoles.judge: typesafe/jev-1.13.0` (`profile/config.yml` «Judge role»).
- The as2 checkout's `.omp/` holds only `agents/` (no `config.yml`), so no project settings layer applies to Ilex or lanes.
- `profile/config.yml` also sets three keys OMP does not register, so they are not among the rows: `gates` (`gates.fence.enabled: true`, «M4b OS fence», read by `gates/src/fence.ts`), `testRunner` («Test runner outside the fence», read by `surface/src/test-run.ts`) and `pairSuggest` (`off`; set with `as2 pair-suggest`). Every role: machinery-owned. The «BEGIN/END M4 TOOL-POLICY SLOT» is empty.

### `config/model-settings.ts` (12)

Anchor `pi-coding-agent@18.8.6 src/config/model-settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: config file only; model / Prompt.

Group verdict: **Ilex** Jo only (model routing is Jo's: `/model`, `/login`, or a `profile/config.yml` change). **Lane** not for as2 (a lane's model is the profile default or Jo's laneModel via `--model`; hands get `task.agentModelOverrides`). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay); launch-seat also passes `--model`.

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `auth.broker.url` | string; env `OMP_AUTH_BROKER_URL` | `unset` | Auth-broker URL. The actual credential connection uses env then the main global config, not project/config-overlay values. *(omp://settings.md)* | not for as2 (credentials are per-profile `/login` in agent.db; config.yml «First-launch setup wizard») | not for as2 (credentials are per-profile `/login` in agent.db) | = group |
| `auth.broker.token` | string; env `OMP_AUTH_BROKER_TOKEN`; credential | `unset` | Auth-broker token. `OMP_AUTH_BROKER_TOKEN` wins over the main global config; the broker token file is a fallback. Project/config-overlay values do not redirect credentials. *(omp://settings.md)* | not for as2 (credentials are per-profile `/login` in agent.db; config.yml «First-launch setup wizard») | not for as2 (credentials are per-profile `/login` in agent.db) | = group |
| `auth.accountPolicies` | array | `[]` | Per-account OAuth routing rules: provider, identity selector (email, accountId, projectId, optional orgId), optional priority and reservePct (0–100). *(omp://auth-broker-gateway.md)* | not for as2 (credentials are per-profile `/login` in agent.db; config.yml «First-launch setup wizard») | not for as2 (credentials are per-profile `/login` in agent.db) | = group |
| `enabledModels` | array | `[]` | Allow-list of models; supports path-scoped entries. Empty means all available models. *(omp://settings.md)* | = group | = group | = group |
| `enabledProviders` | array | `[]` | Foreign user-level discovery sources to load; supports path-scoped entries. See omp://settings.md. *(omp://settings.md)* | = group | = group | Jo only (set in Jo's default profile) |
| `disabledProviders` | array | `[]` | Disabled model/discovery providers; supports path-scoped entries. See omp://settings.md. *(omp://settings.md)* | Jo only (never set by as2; it changes which tier-row entries the classifier may use) | use (read only): the classifier drops these providers from a tier row at every hand spawn (classifier/extension.ts `disabledProviders`; gates/src/host.ts `HOST_SETTING_IDS`) | = group |
| `modelRoleStorage` | enum(global \| project) | `"global"` | Where model selector role assignments are saved | = group | = group | = group |
| `modelRoles` | record | `{}` | Map of role name to primary selector or ordered primary candidates. Custom chat roles can be introduced through assignments, `modelTags`, or `cycleOrder`. `--smol`/`--slow`/`--plan` and their `PI_*_MODEL` vars override those roles for a run; `--model` selects the active chat model. *(omp://settings.md)* | machinery-owned: `{"judge":"typesafe/jev-1.13.0"}` (config.yml «Judge role»: the classifier's 0.55 threshold was measured on this judge only) | = Ilex | Jo only (set in Jo's default profile) |
| `modelPresets` | record | `{}` | Named model presets, each `{ modelRoles, defaultThinkingLevel }`. Written by `/modelpreset save` and the `/models` Roles view (`s`); applied by `/modelpreset switch`. Saves write only the named entry to the global config; project-defined presets are listed and applied but never copied globally. See Model presets. *(omp://settings.md)* | = group | = group | = group |
| `modelTags` | record | `{}` | Custom role/tag metadata; can introduce additional chat roles. *(omp://settings.md)* | = group | = group | = group |
| `modelProviderOrder` | array | `[]` | Preferred provider order when a model id is ambiguous. *(omp://settings.md)* | = group | = group | = group |
| `cycleOrder` | array | `["smol","default","slow"]` | Chat roles cycled by the model switcher. *(omp://settings.md)* | = group | = group | = group |

### `modes/settings.ts` (85)

Anchor `pi-coding-agent@18.8.6 src/modes/settings.ts` plus the row's `id: "<id>"`. The four per-keyword ids `magicKeywords.ultrathink`, `.orchestrate`, `.workflow` and `.jevify` come from one templated registration, `` id: `magicKeywords.${keyword.id}` ``, one per registered keyword. Settings-panel tab / section: config file only; interaction / Startup & Updates; interaction / Git; appearance / Theme; appearance / Composer; appearance / Status Line; appearance / Images; appearance / Display; interaction / Input; interaction / Magic Keywords; interaction / Notifications.

Group verdict: **Ilex** Jo only (Jo's TUI preference, set in the Ilex TUI `/settings`). **Lane** not for as2 (`--mode rpc --no-ui` renders no TUI). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `setupVersion` | number | `0` | Setup-wizard version this profile has completed; scenes with a higher minVersion run at launch (listed among the ungrouped keys). *(omp://settings.md (ungrouped keys) + as2 profile/config.yml setupVersion comment)* | machinery-owned: `2` (config.yml «First-launch setup wizard»: keeps the wizard from re-running after every render) | = Ilex | Jo only (set in Jo's default profile) |
| `autoResume` | boolean | `false` | Automatically resume the most recent session in the current directory | = group | not for as2 (the launcher passes `--resume` itself, laneArgv) | = group |
| `git.enabled` | boolean | `true` | Show git branch, status, and PR information in the TUI and watch repository metadata. | = group | = group | = group |
| `theme.dark` | string | `"titanium"` | Theme used when the terminal has a dark background | machinery-owned: `"titanium"` (config.yml «Look and feel»: Jo's daily-omp look, display only) | = Ilex; inert in a lane (no TUI) | Jo only (set in Jo's default profile) |
| `theme.light` | string | `"light"` | Theme used when the terminal has a light background | machinery-owned: `"light"` (config.yml «Look and feel»: Jo's daily-omp look, display only) | = Ilex; inert in a lane (no TUI) | Jo only (set in Jo's default profile) |
| `symbolPreset` | enum(unicode \| nerd \| ascii) | `"unicode"` | Glyph set for icons and symbols (Unicode, Nerd Font, or ASCII) | machinery-owned: `"unicode"` (config.yml «Look and feel»: Jo's daily-omp look, display only) | = Ilex; inert in a lane (no TUI) | Jo only (set in Jo's default profile) |
| `colorBlindMode` | boolean | `false` | Use blue instead of green for diff additions | = group | = group | = group |
| `composer.shape` | string | `"band"` | Visual layout of the input editor and status line | machinery-owned: `"field"` (config.yml «Look and feel»: Jo's daily-omp look, display only) | = Ilex; inert in a lane (no TUI) | Jo only (set in Jo's default profile) |
| `composer.tokenRate` | boolean | `false` | Show a live generation tok/s readout: on the working row next to the session title, or in the native composer bar right after the thinking level, where the last reading stays between turns. Estimated from streamed deltas and corrected by the provider's billed output count as each message completes. | = group | = group | = group |
| `statusLine.preset` | enum(default \| minimal \| compact \| full \| nerd \| ascii \| custom) | `"default"` | Pre-built status line configurations | = group | = group | = group |
| `statusLine.separator` | enum(powerline \| powerline-thin \| slash \| pipe \| block \| none \| ascii) | `"powerline-thin"` | Style of separators between segments | = group | = group | = group |
| `statusLine.contextLine` | enum(off \| percentage \| annotated \| embedded) | `"embedded"` | How the line between the left and right segments reflects context usage (box composer only) | = group | = group | = group |
| `statusLine.sessionAccent` | boolean | `true` | Use the session name color for the editor border and status line gap | = group | = group | = group |
| `statusLine.transparent` | boolean | `false` | Use the terminal's default background for the status line instead of the theme's `statusLineBg`. Powerline end caps are dropped because they need a contrasting fill to bridge into the surrounding terminal. | = group | = group | = group |
| `statusLine.compactThinkingLevel` | boolean | `true` | Show the thinking level as a single icon on the model name instead of a separate ` · <level>` suffix; in Tern's composer, as the model chip's icon instead of a separate chip (click the icon to cycle it). | = group | = group | = group |
| `statusLine.showHookStatus` | boolean | `true` | Display hook status messages below the status line | = group | = group | = group |
| `statusLine.leftSegments` | array of {pi, status, model, mode, path, git, pr, subagents, token_in, token_out, token_total, token_rate, cost, context_pct, context_total, time_spent, time, session, hostname, cache_read, cache_write, cache_hit, session_name, usage, collab, stream, vim} | `["vim","model","mode","path","git","pr"]` | Left status-line segments used when statusLine.preset is custom. *(omp://settings.md (custom status line prose))* | = group | = group | = group |
| `statusLine.rightSegments` | array of {pi, status, model, mode, path, git, pr, subagents, token_in, token_out, token_total, token_rate, cost, context_pct, context_total, time_spent, time, session, hostname, cache_read, cache_write, cache_hit, session_name, usage, collab, stream, vim} | `["session_name","token_total","cost","context_pct"]` | Right status-line segments used when statusLine.preset is custom. *(omp://settings.md (custom status line prose))* | = group | = group | = group |
| `statusLine.segmentOptions` | record | `{}` | Per-segment options for a custom status line. *(omp://settings.md (custom status line prose))* | = group | = group | = group |
| `terminal.showImages` | boolean | `true` | Render images inline in the terminal | = group | = group | = group |
| `images.autoResize` | boolean | `true` | Resize large images to 2000x2000 max for better model compatibility | = group | = group | = group |
| `images.blockImages` | boolean | `false` | Prevent images from being sent to LLM providers | = group | = group | = group |
| `tui.maxInlineImageColumns` | number | `100` | Maximum width in terminal columns for inline images (default 100). Set to 0 for unlimited (bounded only by terminal width). | = group | = group | = group |
| `tui.maxInlineImageRows` | number | `20` | Maximum height in terminal rows for inline images (default 20). Set to 0 to use only the viewport-based limit (60% of terminal height). | = group | = group | = group |
| `tui.maxInlineImages` | number | `8` | Maximum number of inline images kept as live terminal graphics (default 8). Older images fall back to a text placeholder via a full redraw once the limit is exceeded. Set to 0 to keep every image (no limit). | = group | = group | = group |
| `tui.resizeScrollback` | enum(append \| rebuild \| preserve) | `"rebuild"` | How a settled terminal resize refreshes transcript rows retained in terminal scrollback | machinery-owned: `"rebuild"` (config.yml display key after the «Compaction point» block, named by «Look and feel»; display only) | = Ilex; inert in a lane (no TUI) | Jo only (set in Jo's default profile) |
| `terminal.showProgress` | boolean | `false` | Emit OSC 9;4 indeterminate progress while the agent or context maintenance is running (always on in Tern) | = group | = group | = group |
| `tui.textSizing` | boolean | `false` | Render Markdown H1 headings at 2x scale using Kitty's OSC 66 text-sizing protocol. Only takes effect on Kitty terminals; ignored everywhere else. Off by default. | = group | = group | = group |
| `tui.renderMermaid` | boolean | `true` | Render Mermaid fenced code blocks as ASCII diagrams | = group | = group | = group |
| `tui.renderSvg` | boolean | `true` | Invite the agent to draw diagrams and charts as SVG, rendered inline as images on terminals that show graphics | = group | = group | = group |
| `tui.autoGraph` | enum(smart \| always \| off) | `"always"` | Draw a chart under numeric tables in the agent's answers, in your theme's colors, on terminals that show graphics | = group | = group | = group |
| `tui.reactions` | boolean | `true` | Invite the agent to react to your message with an emoji badge on its bubble | = group | = group | = group |
| `tui.codexResetFireworks` | boolean | `false` | Celebrate unscheduled Codex weekly usage resets and newly banked saved resets with a top-third fireworks overlay that remains until Esc | = group | = group | = group |
| `tui.titleState` | boolean | `true` | Show the agent run state in the terminal title's separator — an animated spinner while working (a static ':' under WSL), '>' when it's your turn, '!' when the agent is waiting on you | = group | = group | = group |
| `tui.titleSpinner` | enum(braille \| pulse \| dots \| line) | `"braille"` | Glyph set for the working-state spinner in the terminal title — braille sweep, filling moon, single-dot cycle, or ASCII-safe line | = group | = group | = group |
| `tui.hyperlinks` | enum(off \| auto \| always) | `"auto"` | Wrap paths and URLs in OSC 8 hyperlinks for terminal-native click-to-open (auto: detect support; off: never; always: unconditional) | machinery-owned: `"always"` (config.yml display key after the «Compaction point» block, named by «Look and feel»; display only) | = Ilex; inert in a lane (no TUI) | Jo only (set in Jo's default profile) |
| `tui.mouse` | boolean | `false` | Capture mouse clicks in the main session so live subagent cards and HUD rows focus on click, with a hover highlight on the target. Native text selection becomes Shift+drag and wheel scroll becomes Shift+wheel while on | = group | = group | = group |
| `tui.tight` | boolean | `false` | Remove the 1-character horizontal padding from the left and right of the terminal output | = group | = group | = group |
| `display.shimmer` | enum(classic \| kitt \| disabled) | `"classic"` | Animation style for working/loading messages | machinery-owned: `"kitt"` (config.yml display key after the «Compaction point» block, named by «Look and feel»; display only) | = Ilex; inert in a lane (no TUI) | Jo only (set in Jo's default profile) |
| `display.pinnedAgents` | enum(off \| collapsed \| full) | `"collapsed"` | Pinned live-agent jump list above the editor (off hides it; collapsed shows a few rows with an expander; full lists all) | = group | = group | = group |
| `display.subagentLivePreview` | boolean | `false` | Show each pinned subagent's current (or most recent) tool call beneath its row | = group | = group | = group |
| `display.smoothStreaming` | boolean | `true` | Reveal assistant text and streamed tool input smoothly while chunks arrive | = group | = group | = group |
| `display.hideToolActivity` | boolean | `false` | Hide model-initiated tool calls and results from the transcript | machinery-owned: `true` (config.yml display key after the «Compaction point» block, named by «Look and feel»; display only) | = Ilex; inert in a lane (no TUI) | Jo only (set in Jo's default profile) |
| `display.showTokenUsage` | boolean | `false` | Show per-turn token usage on assistant messages | machinery-owned: `true` (config.yml display key after the «Compaction point» block, named by «Look and feel»; display only) | = Ilex; inert in a lane (no TUI) | Jo only (set in Jo's default profile) |
| `display.showTurnTime` | boolean | `false` | Show the total prompt-to-yield time (including tool calls) on assistant message usage rows | machinery-owned: `true` (config.yml display key after the «Compaction point» block, named by «Look and feel»; display only) | = Ilex; inert in a lane (no TUI) | Jo only (set in Jo's default profile) |
| `display.cacheMissMarker` | boolean | `false` | Show a divider after an assistant turn whose request lost (missed) the prompt cache | = group | = group | = group |
| `display.collapseCompacted` | boolean | `true` | Collapse pre-compaction history behind the summary divider on the live transcript; disable to keep the full transcript inline with dividers at each compaction point | = group | = group | = group |
| `showHardwareCursor` | boolean | `true` | Show terminal cursor for IME support | = group | = group | = group |
| `tui.imeSafeCursor` | boolean | `false` | Move the prompt's bottom border to a separate row so macOS IME preedit cannot displace it | = group | = group | = group |
| `steeringMode` | enum(all \| one-at-a-time) | `"one-at-a-time"` | How to process queued messages while agent is working | Jo only: surface/extensions/surface-input.ts matches queued prompts and warns when `all` joins them; keep the default `one-at-a-time` | = group | = group |
| `followUpMode` | enum(all \| one-at-a-time) | `"one-at-a-time"` | How to drain follow-up messages after a turn completes | = group | = group | = group |
| `interruptMode` | enum(immediate \| wait) | `"immediate"` | When steering messages interrupt tool execution | = group | = group | = group |
| `tui.vimMode` | boolean | `false` | Modal prompt editing. Esc leaves Insert mode; Normal mode has hjkl, 0, $, ^, w, b, e, gg, G, counts, x/D/C, dd/yy, p and u; operators take motions or text objects (diw, ca(, dap); v/V start a Visual selection that y copies and d deletes | = group | = group | = group |
| `tui.vimModeDisplay` | enum(text \| icon \| none) | `"text"` | How the current Vim mode appears in the status line | = group | = group | = group |
| `loop.mode` | enum(prompt \| compact \| reset) | `"prompt"` | What happens between /loop iterations before re-submitting the prompt | = group | = group | = group |
| `loop.conditionTimeoutMs` | number | `30000` | Max wait for a `/loop --while` / `--until` condition command before treating it as broken and stopping the loop. Set to 0 to wait indefinitely | = group | = group | = group |
| `composer.recallClearedDrafts` | boolean | `true` | Keep drafts cleared with Ctrl+C in local Up/Down history until exit; disabling affects future clears | = group | = group | = group |
| `doubleEscapeAction` | enum(rewind \| tree \| none) | `"rewind"` | What pressing Esc twice with an empty editor does: open the transcript rewind selector, open the session tree, or nothing | = group | = group | = group |
| `input.bareExitOnEmptySession` | boolean | `true` | Submitting exactly `exit`, `quit`, or `q` (any case) before the first message quits instead of prompting the model | = group | = group | = group |
| `input.bareSlashCommands` | boolean | `false` | Submitting exactly a command name without the leading `/` (e.g. `model`, `compact`) runs that slash command; once the session has messages, press Enter twice to confirm | = group | = group | = group |
| `treeFilterMode` | enum(default \| no-tools \| user-only \| labeled-only \| all) | `"default"` | Default filter mode when opening the session tree | = group | = group | = group |
| `autocompleteMaxVisible` | number | `10` | Max visible items in autocomplete dropdown (3-20) | = group | = group | = group |
| `spelling.typoDetection` | boolean | `true` | Mark misspelled prompt words with the active macOS dictionaries | = group | = group | = group |
| `spelling.autocomplete` | enum(off \| auto \| ngram \| smollm \| apple) | `"auto"` | Show predicted word completions as inline hints: Tab accepts with a space, Right without | = group | = group | = group |
| `spelling.autocorrect` | boolean | `false` | Apply confident macOS spelling corrections after completed words | = group | = group | = group |
| `emojiAutocomplete` | boolean | `true` | Suggest emojis from `:name:` shortcodes and expand text emoticons like `:D` or `:-)` | = group | = group | = group |
| `paste.largeMenuThreshold` | number | `100` | When a paste reaches this many lines, offer a menu to wrap it in a code block, wrap it in XML tags, or save it to a file. 0 disables the menu (large pastes still collapse to a [Paste] marker). | = group | = group | = group |
| `startup.quiet` | boolean | `false` | Skip welcome screen and startup status messages | = group | = group | = group |
| `startup.showSplash` | boolean | `false` | Show the full animated setup splash on normal interactive startup without rerunning setup. Quiet Startup still suppresses it. | = group | = group | = group |
| `startup.setupWizard` | boolean | `true` | Show newly added onboarding steps once per setup version | Jo only (`setupVersion` is machinery-owned so the wizard stays quiet) | = group | = group |
| `startup.checkUpdate` | boolean | `true` | Check for omp updates on startup | Jo only (OMP must stay on 18.8 until the gates re-verify: gates/src/host.ts `VERIFIED_HOST`) | = group | = group |
| `update.channel` | enum(stable \| canary) | `"stable"` | Update channel used by omp update and the startup update check | Jo only (OMP must stay on 18.8 until the gates re-verify: gates/src/host.ts `VERIFIED_HOST`) | = group | = group |
| `marketplace.autoUpdate` | enum(off \| notify \| auto) | `"notify"` | Check for plugin updates on startup | = group | = group | = group |
| `startup.changelogMode` | enum(summary \| expanded \| hidden) | `"summary"` | Choose whether update notes start as a summary, full details, or stay hidden | = group | = group | = group |
| `magicKeywords.enabled` | boolean | `true` | Enable hidden notices for standalone ultrathink, orchestrate, workflowz, jevify keywords | = group | = group | = group |
| `magicKeywords.ultrathink` | boolean | `true` | Let standalone ultrathink request maximum automatic thinking and append its hidden notice | = group | = group | = group |
| `magicKeywords.orchestrate` | boolean | `true` | Let standalone orchestrate append its hidden multi-agent orchestration notice | = group | = group | = group |
| `magicKeywords.workflow` | boolean | `true` | Let standalone workflowz append its hidden eval workflow notice | = group | = group | = group |
| `magicKeywords.jevify` | boolean | `true` | Let standalone jevify append its hidden bulk-judge classification notice | = group | = group | = group |
| `completion.notify` | enum(on \| off) | `"on"` | Notify when the agent finishes a turn | = group | = group | = group |
| `error.notify` | enum(on \| off) | `"off"` | Notify when the agent stops with an error | = group | = group | = group |
| `ask.timeout` | number | `0` | Auto-select the recommended ask option after this many seconds (0 disables) | Jo only (a non-zero value would auto-answer Ilex's questions to Jo) | = group | = group |
| `ask.notify` | enum(on \| off) | `"on"` | Notify when the ask tool is waiting for input | = group | = group | = group |
| `recap.enabled` | boolean | `true` | Generate a brief LLM recap of where things stand after the terminal has been idle | = group | = group | = group |
| `recap.idleSeconds` | number | `240` | Seconds to wait while idle before showing the recap | = group | = group | = group |

### `session/settings.ts` (81)

Anchor `pi-coding-agent@18.8.6 src/session/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: interaction / Power; model / Prewalk; providers / Services; model / Vision; model / Thinking; model / Prompt; model / Sampling; config file only; model / Retry & Fallback; providers / Fireworks; providers / Tiny Model; interaction / Agent; providers / Protocol; providers / Timeouts.

Group verdict: **Ilex** Jo only (as2 sets it only through `profile/config.yml` + re-install; Jo may flip it in the Ilex TUI `/settings`). **Lane** not for as2 (OMP default in force; a lane cannot change settings and the profile leaves it unset). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `power.sleepPrevention` | enum(off \| idle \| display \| system) | `"idle"` | Prevent the system sleeping during active sessions. Each level is cumulative — it adds the flags of all lower levels. | = group | = group | = group |
| `prewalk.enabled` | boolean | `false` | Start on the active model, then switch to a fast/cheap model (default the 'smol' role) at the first edit/write after the plan nudge's todo list exists — the strong model plans, commits the todos, and starts the implementation before handing off. Overridable per session with --prewalk / --no-prewalk. | not for as2 (it hands work to the smol role mid-run, a model the tier table did not pick; config.yml «Tier → model table») | not for as2 (it hands work to the smol role mid-run, a model the tier table did not pick; config.yml «Tier → model table») | = group |
| `providers.maxInFlightRequests` | record | `{}` | Maximum concurrent LLM requests per provider id (for example "openai" or "anthropic"), shared across local OMP processes with this config root. Omitted providers are unlimited. | = group | = group | = group |
| `providers.openai-codex.codeMode` | enum(off \| on \| auto) | `"off"` | Route Codex code_mode_only models (GPT-5.6) through eval. The direct tools are eval, ask, todo, yield, think, checkpoint, and rewind. Use eval cells for other session tools. Mirrors codex-rs Code Mode. 'auto' follows the model catalog flag. | = group | = group | = group |
| `providers.openai-codex.codeModeDirectTools` | array | `[]` | Extra direct tools for Codex Code Mode. The standard direct tools are eval, ask, todo, yield, think, checkpoint, and rewind. | = group | = group | = group |
| `images.describeForTextModels` | boolean | `true` | When an image is attached to a model without vision support, save it under local:// and inject a description from a vision-capable model instead of dropping it | = group | = group | = group |
| `defaultThinkingLevel` | enum(minimal \| low \| medium \| high \| xhigh \| max \| auto) | `"high"` | Reasoning depth for thinking-capable models | = group | = group | = group |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in assistant responses | machinery-owned: `true` (config.yml «Look and feel»: as2 never renders thinking blocks) | = Ilex; inert in a lane (no TUI) | Jo only (set in Jo's default profile) |
| `expandThinkingBlocks` | boolean | `false` | Keep finished thinking blocks expanded instead of collapsing them when the turn ends | = group | = group | = group |
| `proseOnlyThinking` | boolean | `true` | Omit code blocks from thinking summaries and replace them with an ellipsis | = group | = group | = group |
| `omitThinking` | boolean | `false` | Instruct upstream providers to completely omit thinking summaries from responses (where supported) | = group | = group | = group |
| `externalThinking` | boolean | `false` | Private scratchpad; not shown to user. Disables supported GPT, Claude, and Gemini reasoning Warning: At your own risk: providers have flagged this request shape as abuse, up to account-level enforcement | = group | = group | = group |
| `model.loopGuard.enabled` | boolean; env `PI_NO_THINKING_LOOP_GUARD` | `true` | Enable automatic stream loop detection for model reasoning and prose | = group | = group | = group |
| `model.loopGuard.checkAssistantContent` | boolean | `true` | Apply loop guard to assistant prose messages in addition to thinking logs | = group | = group | = group |
| `model.loopGuard.toolCallReminder` | boolean | `true` | When a Gemini reasoning stream emits many consecutive planning headers without calling a tool, interrupt it and inject a reminder to issue a tool call (requires Loop Guard) | = group | = group | = group |
| `model.toolCallLoopGuard.enabled` | boolean | `true` | Detect consecutive identical tool calls across turns and inject a corrective steer | = group | = group | = group |
| `model.toolCallLoopGuard.threshold` | number | `5` | Consecutive identical tool calls required before the corrective steer is injected | = group | = group | = group |
| `model.toolCallLoopGuard.exemptTools` | array | `["wait"]` | Tool names that may repeat consecutively without triggering the cross-turn loop guard | = group | = group | = group |
| `inlineToolDescriptors` | enum(auto \| on \| off) | `"auto"` | Render full tool descriptors in the system prompt and strip top-level/nested descriptions from provider tool schemas so descriptor text is sent once. Auto enables this for Gemini models and disables it otherwise | = group | = group | = group |
| `includeModelInPrompt` | boolean | `true` | Surface the active model identifier in the system prompt so the agent knows which model it is | = group | = group | = group |
| `includeWorkspaceTree` | boolean | `false` | Render the workspace directory tree in the system prompt. WARNING: This can bust prompt caching across sessions when files are modified. | = group | = group | = group |
| `skillful` | boolean | `true` | List available skills in the system prompt; disable to save context and toggle per-session with /skillful | = group | = group | = group |
| `personality` | enum(default \| friendly \| pragmatic \| none) | `"default"` | Communication style rendered into the system prompt's personality block | = group | = group | = group |
| `temperature` | number | `-1` | Sampling temperature (0 = deterministic, 1 = creative, -1 = provider default) | = group | = group | = group |
| `topP` | number | `-1` | Nucleus sampling cutoff (0-1, -1 = provider default) | = group | = group | = group |
| `topK` | number | `-1` | Sample from top-K tokens (-1 = provider default) | = group | = group | = group |
| `minP` | number | `-1` | Minimum probability threshold (0-1, -1 = provider default) | = group | = group | = group |
| `presencePenalty` | number | `-1` | Penalty for introducing already-present tokens (-1 = provider default) | = group | = group | = group |
| `repetitionPenalty` | number | `-1` | Penalty for repeated tokens (-1 = provider default) | = group | = group | = group |
| `textVerbosity` | enum(low \| medium \| high) | `"medium"` | OpenAI Responses and Codex response verbosity (low, medium, or high) | = group | = group | = group |
| `tier.openai` | enum(none \| auto \| default \| flex \| scale \| priority \| ultrafast) | `"none"` | Processing tier for OpenAI / OpenAI-Codex requests, and OpenAI-family models routed via OpenRouter (none = omit). Sent as `service_tier`. | = group | = group | = group |
| `tier.anthropic` | enum(none \| priority) | `"none"` | Processing tier for Claude requests. `priority` realizes fast mode (`speed: "fast"`) on supported direct Anthropic models; ignored on Bedrock/Vertex Claude and via OpenRouter. | = group | = group | = group |
| `tier.google` | enum(none \| flex \| priority) | `"none"` | Processing tier for Gemini (Google AI Studio + Vertex) requests, and Google-family models routed via OpenRouter (none = omit). Sent as the top-level `serviceTier` field. | = group | = group | = group |
| `tier.subagent` | enum(inherit \| none \| auto \| default \| flex \| scale \| priority \| ultrafast) | `"inherit"` | Service Tier for spawned task/eval subagents. Inherit = match the main agent's live per-family tiers (tracks /fast); pick a value to apply it to whichever family the subagent's model belongs to. | = group | = group | = group |
| `tier.advisor` | enum(inherit \| none \| auto \| default \| flex \| scale \| priority \| ultrafast); rpc-pinned (rpc, acp) | `"none"` | Service Tier for the advisor model. None = standard processing; Inherit = match the main agent's live per-family tiers; pick a value to apply it to the advisor model's family. | = group | not for as2 (rpc-pinned OMP default; no advisor runs in a lane) | = group |
| `retry.enabled` | boolean | `true` | Retry transient provider errors. *(omp://settings.md)* | = group | = group | = group |
| `retry.maxRetries` | number | `10` | Maximum retry attempts on API errors | = group | = group | = group |
| `retry.baseDelayMs` | number | `500` | Initial backoff. *(omp://settings.md)* | = group | = group | = group |
| `retry.maxDelayMs` | number | `300000` | Maximum wait between retries, in ms. When the provider asks us to wait longer than this and no credential or model fallback succeeds, the request fails fast instead of sleeping (e.g. 3-hour Anthropic rate-limit windows). 0 disables the ceiling — to let the session auto-resume through provider-stated quota resets. | = group | = group | = group |
| `retry.waitForUsageReset` | boolean | `false` | When a provider reports usage-limit exhaustion with a reset time (5-hour or weekly quota windows on any provider), sleep until the reset instead of failing fast past retry.maxDelayMs. Waits are abortable (Esc) but also hold subagents, so leave off for unattended runs. | = group | = group | = group |
| `retry.modelFallback` | boolean | `true` | Allow retry recovery to switch to configured fallback models | = group | = group | = group |
| `retry.usageAwareFallback` | boolean | `false` | Use reliable coding-plan quota reports to prefer same-provider accounts, then configured fallback models, before a hard usage limit. Ordinary configured API keys are excluded. | = group | = group | = group |
| `retry.usageReservePct` | number | `10` | Treat a coding-plan model as near its limit below this remaining percentage. Unknown or unmapped usage keeps the primary model. | = group | = group | = group |
| `retry.usageReservePolicy` | enum(confirm \| auto \| fail-closed) | `"confirm"` | What to do when every same-provider coding-plan account is inside the reserve margin. | = group | = group | = group |
| `retry.fallbackChains` | record | `{}` | JSON object mapping model roles, model selectors ("provider/model-id"), or provider wildcards ("provider/*") to ordered fallback selectors, e.g. {"default":["openai/gpt-4o-mini"],"google-antigravity/*":["google/*","google-vertex/*"]}. Model-oriented keys apply whenever that model/provider is active, regardless of role; a "provider/*" entry keeps the failing model's id and swaps the provider. An id-prefixed wildcard ("openrouter/google/*") re-prefixes the failing model's bare id (google-antigravity/gemini-x -> openrouter/google/gemini-x) and, used as a key, matches only that provider's ids under the prefix. A fallback entry may carry an explicit thinking suffix ("provider/model:low", ":high", ":max", ":off"); a bare entry inherits the failing turn's effort, and "provider/*" entries always inherit. | machinery-owned: `{"judge":[]}` (config.yml «Judge role»: empty judge chain, so OMP never falls back to `jev-latest`) | = Ilex | Jo only (set in Jo's default profile) |
| `retry.fallbackRevertPolicy` | enum(cooldown-expiry \| never) | `"cooldown-expiry"` | When to return to the primary model after a fallback | = group | = group | = group |
| `providers.anthropic.serverSideFallback` | boolean | `false` | When a Claude Fable 5 / Mythos 5 request is blocked by Anthropic's safety classifier, retry it on Claude Opus 5 server-side (Anthropic `server-side-fallback-2026-06-01` beta). Opt-in — leaving this off preserves the pre-fallback behavior for every request. | = group | = group | = group |
| `providers.anthropic.slowMode` | enum(off \| auto) | `"off"` | `off`, `auto`. Anthropic subscription low-priority recovery when a 5-hour limit is reached and the lane is offered; `/slow on` enables it. *(omp://settings.md)* | = group | = group | = group |
| `providers.ollama-cloud.maxConcurrency` | number | `3` | Maximum concurrent Ollama Cloud subagent runs per process; 0 disables the provider-specific limit | = group | = group | = group |
| `providers.webSearchTimeoutSeconds` | number | `60` | Hard timeout for each provider's search transport before web_search advances to the next fallback, in seconds (maximum 300) | = group | = group | = group |
| `providers.antigravityEndpoint` | enum(auto \| production \| sandbox) | `"auto"` | Endpoint routing strategy for google-antigravity providers (chat, search, image, discovery) | = group | = group | = group |
| `providers.fireworksTier` | enum(standard \| priority) | `"standard"` | Serving path for Fireworks requests. Priority sends `service_tier: "priority"` for higher reliability during peak traffic at a higher price; Standard omits it. Fast (`-fast`) models ignore this — Fast is its own serving path. | = group | = group | = group |
| `providers.tinyModelDevice` | enum(default \| gpu \| cpu \| mlx \| metal \| webgpu \| cuda \| dml \| coreml \| auto \| wasm \| webnn \| webnn-gpu \| webnn-cpu \| webnn-npu); env `PI_TINY_DEVICE` | `"default"` | Inference backend for local tiny models (titles + memory): an ONNX execution provider, or `mlx` to download MLX weights and run them through mlx-lm on Apple silicon. Default uses CPU-only ONNX. The PI_TINY_DEVICE env var overrides this. | = group | = group | = group |
| `providers.tinyModelDtype` | enum(default \| q4 \| q4f16 \| q8 \| fp16 \| fp32 \| int8 \| uint8 \| bnb4 \| q2 \| q2f16 \| q1 \| q1f16 \| auto); env `PI_TINY_DTYPE` | `"default"` | ONNX quantization/precision for local tiny models. Default uses each model's shipped dtype (q4); lower precision is faster, higher is more faithful. Ignored by the MLX backend (its repos are pre-quantized 4-bit). The PI_TINY_DTYPE env var overrides this. | = group | = group | = group |
| `providers.autoThinkingMaxEffort` | enum(xhigh \| max) | `"xhigh"` | Highest effort the `auto` classifier may resolve. `xhigh` keeps the classifier one tier below the top, so only an explicit `ultrathink` reaches `max`; `max` lets a turn the classifier judges exceptional bill the top tier on models that expose it. | = group | = group | = group |
| `features.unexpectedStopDetection` | enum(none \| mechanical \| smart) | `"mechanical"` | Automatically recover when the assistant stops without a visible message. Smart also classifies text-only stops with a small model. | = group | = group | = group |
| `providers.kimiApiFormat` | enum(auto \| openai \| anthropic) | `"auto"` | API format for Kimi Code provider (auto follows live model metadata) | = group | = group | = group |
| `providers.openaiWebsockets` | enum(auto \| off \| on) | `"auto"` | Websocket policy for OpenAI Codex models (auto uses model defaults, on forces, off disables) | = group | = group | = group |
| `providers.openaiLiveSteering` | boolean | `true` | Deliver messages typed while a GPT-6 response streams into that response over the Codex WebSocket, instead of waiting for the next tool boundary | = group | = group | = group |
| `providers.muse-code.storeResponses` | boolean; env `PI_MUSE_STORE_RESPONSES` | `false` | Store Muse Code results on Meta's servers so a turn whose connection drops is recovered instead of re-run. Stored runs keep prompts and outputs on Meta's side. | = group | = group | = group |
| `providers.cacheRetention` | enum(auto \| short \| long \| none) | `"auto"` | Prompt-cache retention forwarded to providers that support it (Anthropic, Bedrock, OpenRouter, OpenAI) | = group | = group | = group |
| `providers.cacheWarming` | enum(off \| streaming \| idle) | `"idle"` | Re-send the last request with a one-token output budget shortly before its prompt-cache entry expires | = group | = group | = group |
| `providers.streamFirstEventTimeoutSeconds` | number | `-1` | Seconds to wait for the first model stream event; -1 uses provider/env defaults, 0 disables the watchdog | = group | = group | = group |
| `providers.streamIdleTimeoutSeconds` | number | `-1` | Seconds a model stream may stay silent between events; -1 uses provider/env defaults, 0 disables the watchdog | = group | = group | = group |
| `providers.openrouterVariant` | enum(default \| nitro \| floor \| online \| exacto) | `"default"` | Default routing-variant suffix appended to OpenRouter model IDs (overridden when the selector already names a variant) | = group | = group | = group |
| `providers.fetch` | enum(auto \| native \| trafilatura \| lynx \| parallel \| firecrawl \| jina) | `"auto"` | Reader backend priority for the fetch/read URL tool | = group | = group | = group |
| `codexResets.autoRedeem` | enum(unset \| yes \| no) | `"unset"` | Spend saved Codex rate-limit resets automatically: restore an account blocked by an exhausted 5h or weekly window when a turn is stuck and no other account can take over, and salvage credits that are about to expire. unset asks before the first spend, yes spends without prompting, and no disables both checks. | = group | = group | Jo only (set in Jo's default profile) |
| `codexResets.minBlockedMinutes` | number | `60` | Only auto-redeem when the natural unblock — the latest reset among the exhausted 5h/weekly windows — is at least this many minutes away (don't spend a scarce credit to save a short wait). Raise it (e.g. 360) to ignore 5h-only blocks. | = group | = group | = group |
| `codexResets.keepCredits` | number | `0` | Never auto-spend below this many saved resets (0 = the last credit may be spent automatically). Credits about to expire are exempt — a reserved credit that expires preserves nothing. | = group | = group | = group |
| `codexResets.salvageHorizonHours` | number | `12` | With auto-redeem enabled, spend a saved Codex reset within this many hours of expiry when either chat window has meaningful usage. 0 disables early salvage; credits expiring within 5 minutes are still attempted regardless of usage. | = group | = group | = group |
| `claudeResets.autoRedeem` | enum(unset \| yes \| no) | `"unset"` | Spend eligible Claude Cedar or Juniper resets automatically. Cedar is spent only for covered limits; Juniper can only recover a sole 5-hour block. unset asks before the first spend, yes spends without prompting, and no disables blocked recovery and expiry salvage. | = group | = group | = group |
| `claudeResets.minBlockedMinutes` | number | `60` | Only auto-redeem when the natural unblock — the latest reset among the exhausted covered windows — is at least this many minutes away. A 5-hour-only reset is never used for a weekly or model-scoped block. | = group | = group | = group |
| `claudeResets.keepCredits` | number | `0` | Keep at least this many Claude resets banked (0 allows the last eligible reset to be spent automatically). The reserve applies to early salvage, but not to eligible resets expiring within 5 minutes. | = group | = group | = group |
| `claudeResets.salvageHorizonHours` | number | `12` | With auto-redeem enabled, use a server-selected Cedar reset within this many hours of expiry when its covered windows have meaningful usage. 0 disables early salvage; eligible Cedar or Juniper resets expiring within 5 minutes are still attempted regardless of usage or reserve. Provider limit requirements still apply. | = group | = group | = group |
| `provider.appendOnlyContext` | enum(auto \| on \| off) | `"auto"` | Cache system prompt + tool specs and keep an append-only message log so provider prefix caches (DeepSeek, Xiaomi/SGLang, Anthropic) hit at maximum rate. Auto enables for known prefix-cache providers. | = group | = group | = group |
| `thinkingBudgets.minimal` | number | `1024` | Token budget for the `minimal` level. *(omp://settings.md)* | = group | = group | = group |
| `thinkingBudgets.low` | number | `2048` | Token budget for `low`. *(omp://settings.md)* | = group | = group | = group |
| `thinkingBudgets.medium` | number | `8192` | Token budget for `medium`. *(omp://settings.md)* | = group | = group | = group |
| `thinkingBudgets.high` | number | `16384` | Token budget for `high`. *(omp://settings.md)* | = group | = group | = group |
| `thinkingBudgets.xhigh` | number | `32768` | Token budget for `xhigh`. *(omp://settings.md)* | = group | = group | = group |
| `thinkingBudgets.max` | number | `32768` | Token budget for `max`. *(omp://settings.md)* | = group | = group | = group |

### `live/settings.ts` (1)

Anchor `pi-coding-agent@18.8.6 src/live/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: providers / Services.

Group verdict: **Ilex** Jo only (realtime voice is Jo's TUI feature). **Lane** not for as2 (no audio in an unattended rpc lane). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `live.voice` | enum(arbor \| breeze \| cove \| ember \| juniper \| maple \| sol \| spruce \| vale) | `"sol"` | Voice used by Codex-backed realtime voice sessions | = group | = group | = group |

### `tts/settings.ts` (5)

Anchor `pi-coding-agent@18.8.6 src/tts/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: providers / Services.

Group verdict: **Ilex** Jo only (voice output is Jo's TUI feature). **Lane** not for as2 (no audio in an unattended rpc lane). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `tts.localVoice` | enum(af_heart \| af_bella \| af_nicole \| af_aoede \| af_kore \| af_sarah \| am_michael \| am_fenrir \| am_puck \| bf_emma \| bm_george \| bm_fable) | `"af_heart"` | Kokoro voice used by the local TTS backend (American/British, female/male) | = group | = group | = group |
| `speech.enabled` | boolean | `false` | Speak the assistant's output aloud through the speakers as it streams | = group | = group | = group |
| `speech.mode` | enum(all \| assistant \| yield) | `"assistant"` | What to speak: all = assistant messages + thinking; assistant = messages only; yield = only the final message at turn end | = group | = group | = group |
| `speech.enhanced` | boolean | `false` | Rewrite assistant output into natural spoken prose with the tiny/smol model before synthesis (describes code, drops links and markdown). Falls back to mechanical cleanup on failure | = group | = group | = group |
| `speech.voice` | enum(af_heart \| af_bella \| af_nicole \| af_aoede \| af_kore \| af_sarah \| am_michael \| am_fenrir \| am_puck \| bf_emma \| bm_george \| bm_fable) | `"af_heart"` | Kokoro voice used when speaking the assistant's output aloud | = group | = group | = group |

### `telemetry-settings.ts` (1)

Anchor `pi-coding-agent@18.8.6 src/telemetry-settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: providers / Privacy.

Group verdict: **Ilex** Jo only (as2 sets it only through `profile/config.yml` + re-install; Jo may flip it in the Ilex TUI `/settings`). **Lane** not for as2 (OMP default in force; a lane cannot change settings and the profile leaves it unset). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `telemetry.otlpExportEnabled` | boolean | `true` | Allow OMP to export traces, logs, and metrics using OTEL_* endpoints. Changes take effect on the next launch. | = group | = group | = group |

### `advisor/settings.ts` (7)

Anchor `pi-coding-agent@18.8.6 src/advisor/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: model / Advisor.

Group verdict: **Ilex** not for as2 (as2 reviews through cross-lab judge slices, SPEC-2.0.md § B4, not an OMP advisor). **Lane** not for as2 (rpc-pinned: OMP re-applies its default under `--mode rpc` unless the profile configures it, and it does not). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `advisor.enabled` | boolean; rpc-pinned (rpc, acp) | `false` | Pair a second model (assigned to the 'advisor' role) that passively reviews each turn and injects notes. | = group | = group | = group |
| `advisor.syncBacklog` | enum(off \| 1 \| 3 \| 5 \| strict); rpc-pinned (rpc, acp) | `"off"` | Pause main agent until advisor backlog falls below threshold. Numeric values cap wait at 30 seconds; strict waits for all scheduled reviews without a wall-clock cap. Off disables catch-up delays. Abort, failure, and disposal release waits. | = group | = group | = group |
| `advisor.immuneTurns` | number; rpc-pinned (rpc, acp) | `3` | After an advisor concern or blocker interrupts, route further concerns as non-interrupting asides for this many primary turns. Blockers are exempt from the cooldown. | = group | = group | = group |
| `advisor.reviewMode` | enum(turn \| agent-end); rpc-pinned (rpc, acp) | `"turn"` | Default advisor cadence when no WATCHDOG.yml roster is present. turn reviews every primary turn; agent-end reviews only final yields. | = group | = group | = group |
| `advisor.reviewInterval` | number; rpc-pinned (rpc, acp) | `1` | Default advisor cadence when no WATCHDOG.yml roster is present: review every Nth eligible primary update. 1 = every update. Skipped updates are sent with the next scheduled review. | = group | = group | = group |
| `advisor.maxNotesPerUpdate` | number; rpc-pinned (rpc, acp) | `4` | Maximum non-blocker advice notes accepted per advisor prompt update (1–32; UI offers 1–5 quick picks). Blockers are exempt. | = group | = group | = group |
| `advisor.evictStaleResults` | boolean; rpc-pinned (rpc, acp) | `true` | Before each review, replace the advisor's read/grep/glob output from older reviews with a short placeholder. The latest review is kept. | = group | = group | = group |

### `session/context-settings.ts` (30)

Anchor `pi-coding-agent@18.8.6 src/session/context-settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: context / General; context / Compaction; config file only; context / Experimental.

Group verdict: **Ilex** Jo only (context tuning lives in `profile/config.yml`'s compaction block; change it there). **Lane** not for as2 (OMP default in force; a lane cannot change settings and the profile leaves it unset). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `workspace.additionalDirectories` | array | `[]` | Extra workspace directories added to every session as additional roots (multi-root workspace). Managed live via /add-dir and /remove-dir. Paths resolve relative to cwd; absolute paths recommended. The agent is told these roots exist and can read/grep/glob them. | Jo only (`/add-dir` and `/remove-dir` manage the roots live from the TUI) | not for as2 (a lane's root is its worktree, `laneArgv --cwd`; no extra roots are passed) | = group |
| `contextPromotion.enabled` | boolean | `false` | Promote to a larger-context model on context overflow instead of compacting | = group | = group | = group |
| `extendedContext` | boolean | `false` | Use larger context windows where supported; may incur premium pricing. Off keeps default or standard-pricing windows | machinery-owned: `true` (config.yml «Compaction point», extendedContext line: gpt-6-* run their extended window) | = Ilex | = group |
| `compaction.enabled` | boolean | `true` | Automatically compact context when it gets too large | = group | = group | = group |
| `compaction.experimentalContextManagement` | boolean | `false` | Keep persistent notes and searchable raw history across context windows. | = group | = group | = group |
| `compaction.midTurnEnabled` | boolean | `true` | Check thresholds at safe mid-turn tool-loop boundaries before the next provider request; subagents always check, since their whole assignment is one turn | = group | = group | = group |
| `compaction.methodOrder` | array | `["remote","snapcompact","handoff","shake","soft"]` | Preferred fallback order for automatic context maintenance; unavailable or failed methods advance to the next choice | machinery-owned: `["shake","remote","snapcompact","handoff","soft"]` (config.yml «Compaction point»: zero-token `shake` first, then the model-backed methods) | = Ilex | Jo only (set in Jo's default profile) |
| `compaction.thresholdPercent` | number | `-1` | Percent threshold for context maintenance; set to Default to use legacy reserve-based behavior | machinery-owned: `25` (config.yml «Compaction point»: Ilex and lanes compact at 25% like Jo's default profile) | = Ilex | Jo only (set in Jo's default profile) |
| `compaction.thresholdTokens` | number | `-1` | Fixed token limit for context maintenance; overrides percentage if set | = group | = group | = group |
| `compaction.modelThresholds` | record | `{}` | Per-model compaction trigger keyed by `provider/model-id` or a `*`-terminated prefix (`deepseek/*`): a token count (`90000`) or a percentage (`"80%"`). See below. *(omp://settings.md)* | machinery-owned: `{"moonshot/kimi-k2.*":180000}` (config.yml «Compaction point»: kimi-k2.* (262K window) compacts at 180000 tokens) | = Ilex | Jo only (set in Jo's default profile) |
| `compaction.modelThresholdsEnabled` | boolean | `true` | Whether `compaction.modelThresholds` applies. Subagents with a `task.agentCompactionThresholdOverrides` entry run with it off. *(omp://settings.md)* | = group | = group | = group |
| `compaction.handoffSaveToDisk` | boolean | `false` | Save generated handoff documents to markdown files for the auto-handoff flow | = group | = group | = group |
| `compaction.remoteStreamingV2Enabled` | boolean | `true` | Use Responses streaming compaction for compatible remote compaction models | = group | = group | = group |
| `compaction.asyncEnabled` | boolean | `true` | Speculatively summarize in the background as context nears the compaction threshold, then splice the ready result in when the threshold is crossed | = group | = group | = group |
| `compaction.reserveTokens` | number | `unset` | Absolute reserve floor. When unset, the effective reserve is the larger of `16384` and 15% of the context window; if that default would leave no practical small-window budget, it falls back to the 15% reserve. *(omp://settings.md)* | = group | = group | = group |
| `compaction.keepRecentTokens` | number | `20000` | Recent-history token budget for summary compaction. *(omp://settings.md)* | = group | = group | = group |
| `compaction.autoContinue` | boolean | `true` | Continue automatically after compaction. *(omp://settings.md)* | = group | = group | = group |
| `compaction.remoteEndpoint` | string | `unset` | Custom remote compaction endpoint: when set and remote compaction is on, local summary generation POSTs to it. *(omp://compaction.md)* | = group | = group | = group |
| `compaction.v2RetainedMessageBudget` | number | `64000` | Token budget of recent messages retained by V2 streaming Responses compaction (default 64000). *(omp://compaction.md)* | = group | = group | = group |
| `compaction.idleEnabled` | boolean | `false` | Compact context while idle when token count exceeds threshold | = group | = group | = group |
| `compaction.idleThresholdTokens` | number | `200000` | Token count above which idle compaction triggers | = group | = group | = group |
| `compaction.idleTimeoutSeconds` | number | `300` | Seconds to wait while idle before compacting | = group | = group | = group |
| `compaction.supersedeReads` | boolean | `true` | Prune older read results when the same file is read again (cache-aware, runs every turn) | = group | = group | = group |
| `compaction.dropUseless` | boolean | `true` | Prune tool results flagged contextually useless (no matches, timed-out waits) once consumed (cache-aware) | = group | = group | = group |
| `snapcompact.systemPrompt` | enum(none \| agents-md \| all) | `"none"` | Experimental: render selected system prompt text as dense PNG image(s) and attach to the first user message (vision models only). Saves tokens; loses prompt caching for imaged text. | = group | = group | = group |
| `snapcompact.toolResults` | boolean | `false` | Experimental: render large historical tool results as dense PNG image(s) instead of text (vision models only). Saves tokens on accumulated read/search output. | = group | = group | = group |
| `tools.format` | enum(auto \| native \| glm \| hermes \| kimi \| xml \| anthropic \| deepseek \| harmony \| qwen3 \| gemini \| gemma \| minimax) | `"auto"` | Controls how tools are exposed to the model. Auto uses provider-native tool calls unless the selected model is marked as not supporting them, then falls back to the GLM owned dialect. Native forces provider-native tools; the other values force the named owned dialect. | = group | = group | = group |
| `snapcompact.shape` | enum(auto \| 8x8r-bw \| 8x8r-sent \| 8x8u-bw \| 8x8u-sent \| 6x6u-bw \| 6x6u-sent \| 5x8-bw \| 5x8-sent \| 6x12-dim \| 8x13-bw \| 8on16-bw \| 8on22-bw \| 11on16-bw \| silver16-bw \| doc-8on16-bw \| doc-8on16-sent \| doc-8on16-sent-dim) | `"auto"` | Frame shape snapcompact prints text with (compaction archive and inline imaging). Auto picks a shape tuned for the current model. | = group | = group | = group |
| `branchSummary.enabled` | boolean | `false` | Prompt to summarize when leaving a branch | = group | = group | = group |
| `branchSummary.reserveTokens` | number | `16384` | Token reserve for branch summaries (default 16384). *(omp://compaction.md)* | = group | = group | = group |

### `memory-backend/settings.ts` (1)

Anchor `pi-coding-agent@18.8.6 src/memory-backend/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: memory / General.

Group verdict: **Ilex** not for as2 (as2 keeps memory in its ledger and decision log; `memory.backend` stays at OMP's `off`). **Lane** not for as2 (`memory.backend` is rpc-pinned to OMP's `off`, so no backend runs in a lane). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `memory.backend` | enum(off \| local \| hindsight \| mnemopi \| sharpshooter); rpc-pinned (rpc, acp) | `"off"` | Off, local summary pipeline, Mnemopi SQLite, Hindsight remote memory, or Sharpshooter | = group | not for as2 (rpc-pinned to OMP's default `off`) | = group |

### `memories/settings.ts` (16)

Anchor `pi-coding-agent@18.8.6 src/memories/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: config file only.

Group verdict: **Ilex** not for as2 (as2 keeps memory in its ledger and decision log; `memory.backend` stays at OMP's `off`). **Lane** not for as2 (`memory.backend` is rpc-pinned to OMP's `off`, so no backend runs in a lane). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `memories.enabled` | boolean; rpc-pinned (rpc, acp) | `false` | Legacy local-memory flag, kept for back-compat migration only (true migrates to memory.backend: local); hidden from the UI. *(source comment, memories/settings.ts; omp://memory.md)* | = group | not for as2 (rpc-pinned to OMP's default `false`) | = group |
| `memories.maxRolloutsPerStartup` | number | `64` | Cap on sessions processed in a single startup. *(omp://memory.md)* | = group | = group | = group |
| `memories.maxRolloutAgeDays` | number | `30` | Sessions older than this are not processed. *(omp://memory.md)* | = group | = group | = group |
| `memories.minRolloutIdleHours` | number | `12` | Sessions active more recently than this are skipped. *(omp://memory.md)* | = group | = group | = group |
| `memories.threadScanLimit` | number | `300` | Maximum recent session records scanned at startup. *(omp://memory.md)* | = group | = group | = group |
| `memories.maxRawMemoriesForGlobal` | number | `200` | Maximum per-session extractions supplied to global consolidation. *(omp://memory.md)* | = group | = group | = group |
| `memories.stage1Concurrency` | number | `8` | Concurrent per-session extraction jobs. *(omp://memory.md)* | = group | = group | = group |
| `memories.stage1LeaseSeconds` | number | `120` | Extraction job lease duration. *(omp://memory.md)* | = group | = group | = group |
| `memories.stage1RetryDelaySeconds` | number | `120` | Delay before a failed extraction becomes claimable again. *(omp://memory.md)* | = group | = group | = group |
| `memories.phase2LeaseSeconds` | number | `180` | Consolidation lease duration. *(omp://memory.md)* | = group | = group | = group |
| `memories.phase2RetryDelaySeconds` | number | `180` | Delay before failed consolidation is retried. *(omp://memory.md)* | = group | = group | = group |
| `memories.phase2HeartbeatSeconds` | number | `30` | Consolidation lease heartbeat interval. *(omp://memory.md)* | = group | = group | = group |
| `memories.rolloutPayloadPercent` | number | `0.7` | Fraction of the selected model's context budget available to rollout payloads. *(omp://memory.md)* | = group | = group | = group |
| `memories.phase1InputTokenLimit` | number | `4000` | Per-session extraction input cap. *(omp://memory.md)* | = group | = group | = group |
| `memories.fallbackTokenLimit` | number | `16000` | Model token budget used when the model has no finite declared context window. *(omp://memory.md)* | = group | = group | = group |
| `memories.summaryInjectionTokenLimit` | number | `5000` | Shared approximate token cap for the summary and captured lessons injected into the system prompt. *(omp://memory.md)* | = group | = group | = group |

### `sharpshooter/settings.ts` (3)

Anchor `pi-coding-agent@18.8.6 src/sharpshooter/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: memory / Sharpshooter; config file only.

Group verdict: **Ilex** not for as2 (as2 keeps memory in its ledger and decision log; `memory.backend` stays at OMP's `off`). **Lane** not for as2 (`memory.backend` is rpc-pinned to OMP's `off`, so no backend runs in a lane). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `sharpshooter.model` | string | `unset` | Model selector for extraction/consolidation, empty = smol role | = group | = group | = group |
| `sharpshooter.intervalMinutes` | number | `5` | Minutes between Sharpshooter extraction/consolidation runs (read by its scheduler and consolidator). *(source: sharpshooter/scheduler.ts, sharpshooter/consolidate.ts cfgSharpshooterIntervalMinutes)* | = group | = group | = group |
| `sharpshooter.injectionTokenLimit` | number | `15000` | Approximate token cap on the Sharpshooter memory block injected into the prompt. *(source: sharpshooter/backend.ts truncateApproxTokens(…cfgSharpshooterInjectionTokenLimit))* | = group | = group | = group |

### `autolearn/settings.ts` (3)

Anchor `pi-coding-agent@18.8.6 src/autolearn/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: memory / Auto-Learn; config file only.

Group verdict: **Ilex** not for as2 (it creates managed skills, but `skills.includeSkills` pins the 22 manifest skills). **Lane** not for as2 (it creates managed skills, but `skills.includeSkills` pins the 22 manifest skills). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `autolearn.enabled` | boolean | `false` | After the agent stops, nudge it to capture lessons to memory and create/enhance isolated managed skills | = group | = group | = group |
| `autolearn.autoContinue` | boolean | `false` | When on, auto-run one private capture turn at stop (uses extra tokens). When off, only standing auto-learn guidance remains. | = group | = group | = group |
| `autolearn.minToolCalls` | number | `5` | Minimum completed tool calls in a primary turn before automatic capture is eligible. *(omp://settings.md)* | = group | = group | = group |

### `mnemopi/settings.ts` (23)

Anchor `pi-coding-agent@18.8.6 src/mnemopi/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: memory / Mnemopi; config file only.

Group verdict: **Ilex** not for as2 (as2 keeps memory in its ledger and decision log; `memory.backend` stays at OMP's `off`). **Lane** not for as2 (`memory.backend` is rpc-pinned to OMP's `off`, so no backend runs in a lane). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `mnemopi.dbPath` | string | `unset` | Optional SQLite DB path. Defaults to the agent memories directory. | = group | = group | = group |
| `mnemopi.bank` | string | `unset` | Optional shared bank base name. Per-project modes derive project-local banks from it. | = group | = group | = group |
| `mnemopi.scoping` | enum(global \| per-project \| per-project-tagged) | `"per-project"` | global = one shared bank; per-project = isolated bank per cwd; per-project-tagged = project-local writes plus global recall visibility | = group | = group | = group |
| `mnemopi.embeddingVariant` | enum(en \| multilingual) | `"en"` | Local embedding model family. en = stronger English model; multilingual = cross-language model. Changing this rebuilds existing memory embeddings on next start. | = group | = group | = group |
| `mnemopi.autoRecall` | boolean | `true` | Recall local memories into the first turn of each session | = group | = group | = group |
| `mnemopi.autoRetain` | boolean | `true` | Retain completed conversation turns into local Mnemopi memory | = group | = group | = group |
| `mnemopi.polyphonicRecall` | boolean | `false` | Fuse recall with graph, fact, vector and temporal voices so linked memories surface without a keyword match | = group | = group | = group |
| `mnemopi.enhancedRecall` | boolean | `false` | Cache recall results for repeated and similar queries with identical options; any memory write clears it | = group | = group | = group |
| `mnemopi.proactiveLinking` | boolean | `false` | Ingest new memories into the episodic graph as they are stored, linking them to related entities and memories | = group | = group | = group |
| `mnemopi.noEmbeddings` | boolean | `false` | Force deterministic FTS-only recall instead of vector embeddings | = group | = group | = group |
| `mnemopi.embeddingModel` | string; env `MNEMOPI_EMBEDDING_MODEL` | `unset` | Advanced: explicit embedding model id that overrides the variant. Leave empty to use mnemopi.embeddingVariant. | = group | = group | = group |
| `mnemopi.embeddingApiUrl` | string | `unset` | Optional OpenAI-compatible embedding endpoint passed to Mnemopi | = group | = group | = group |
| `mnemopi.embeddingApiKey` | string; credential | `unset` | Optional embedding API key passed to Mnemopi | = group | = group | = group |
| `mnemopi.llmMode` | enum(none \| smol \| remote) | `"smol"` | Use no LLM, the online tiny model (the TINY role from /models, else @smol), or a remote OpenAI-compatible endpoint | = group | = group | = group |
| `mnemopi.llmBaseUrl` | string | `unset` | Optional OpenAI-compatible LLM endpoint for Mnemopi remote mode | = group | = group | = group |
| `mnemopi.llmApiKey` | string; credential | `unset` | Optional LLM API key for Mnemopi remote mode | = group | = group | = group |
| `mnemopi.llmModel` | string | `unset` | Optional LLM model name for Mnemopi remote mode | = group | = group | = group |
| `mnemopi.retainEveryNTurns` | number | `4` | Minimum user turns between automatic retain writes. *(omp://mnemosyne-memory-backend.md)* | = group | = group | = group |
| `mnemopi.recallLimit` | number | `8` | Maximum recalled memories in the prompt block (runtime-clamped to at least 1). *(omp://mnemosyne-memory-backend.md)* | = group | = group | = group |
| `mnemopi.recallContextTurns` | number | `3` | Prior user-bounded turns included in recall queries. *(omp://mnemosyne-memory-backend.md)* | = group | = group | = group |
| `mnemopi.recallMaxQueryChars` | number | `4000` | Maximum composed recall query length. *(omp://mnemosyne-memory-backend.md)* | = group | = group | = group |
| `mnemopi.injectionTokenLimit` | number | `5000` | Approximate token budget for memory prompt injection. *(omp://mnemosyne-memory-backend.md)* | = group | = group | = group |
| `mnemopi.debug` | boolean | `false` | Enable debug logging for backend failures. *(omp://mnemosyne-memory-backend.md)* | = group | = group | = group |

### `hindsight/settings.ts` (26)

Anchor `pi-coding-agent@18.8.6 src/hindsight/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: memory / Hindsight; config file only.

Group verdict: **Ilex** not for as2 (as2 keeps memory in its ledger and decision log; `memory.backend` stays at OMP's `off`). **Lane** not for as2 (`memory.backend` is rpc-pinned to OMP's `off`, so no backend runs in a lane). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `hindsight.apiUrl` | string; env `HINDSIGHT_API_URL` | `"http://localhost:8888"` | Hindsight server URL (Cloud or self-hosted) | = group | = group | = group |
| `hindsight.apiToken` | string; env `HINDSIGHT_API_TOKEN`; credential | `unset` | Bearer token for authenticated Hindsight servers | = group | = group | = group |
| `hindsight.bankId` | string; env `HINDSIGHT_BANK_ID` | `unset` | Memory bank identifier (default: project name) | = group | = group | = group |
| `hindsight.bankIdPrefix` | string | `unset` | Prefix joined to the bank id as `<prefix>-<bankId>` (empty = no prefix). *(source: hindsight/bank.ts (base bank id comment), hindsight/config.ts)* | = group | = group | = group |
| `hindsight.scoping` | enum(global \| per-project \| per-project-tagged); env `HINDSIGHT_SCOPING` | `"per-project-tagged"` | global = one shared bank; per-project = isolated bank per cwd; per-project-tagged = shared bank with project tags so global + project memories merge on recall | = group | = group | = group |
| `hindsight.bankMission` | string; env `HINDSIGHT_BANK_MISSION` | `unset` | Reflect mission sent when the Hindsight bank is created (env HINDSIGHT_BANK_MISSION). *(omp://environment-variables.md; source: hindsight/bank.ts createBank reflectMission)* | = group | = group | = group |
| `hindsight.retainMission` | string | `unset` | Retain mission sent when the Hindsight bank is created. *(source: hindsight/bank.ts createBank retainMission)* | = group | = group | = group |
| `hindsight.autoRecall` | boolean; env `HINDSIGHT_AUTO_RECALL` | `true` | Recall memories on the first turn of each session | = group | = group | = group |
| `hindsight.autoRetain` | boolean; env `HINDSIGHT_AUTO_RETAIN` | `true` | Retain transcript every N turns and at session boundaries | = group | = group | = group |
| `hindsight.retainMode` | enum(full-session \| last-turn); env `HINDSIGHT_RETAIN_MODE` | `"full-session"` | full-session = upsert one document per session, last-turn = chunked | = group | = group | = group |
| `hindsight.retainEveryNTurns` | number; env `HINDSIGHT_RETAIN_EVERY_N_TURNS` | `3` | Turns between automatic retain writes (default 3). *(omp://tools/retain.md; omp://environment-variables.md)* | = group | = group | = group |
| `hindsight.retainOverlapTurns` | number | `2` | Turns of overlap carried between consecutive retain batches (default 2). *(omp://tools/retain.md)* | = group | = group | = group |
| `hindsight.retainContext` | string | `"omp"` | Context label attached to retained items (default "omp"). *(omp://tools/retain.md)* | = group | = group | = group |
| `hindsight.recallBudget` | enum(low \| mid \| high); env `HINDSIGHT_RECALL_BUDGET` | `"mid"` | Hindsight recall/reflect budget: low, mid or high. *(omp://tools/recall.md; omp://environment-variables.md)* | = group | = group | = group |
| `hindsight.recallMaxTokens` | number; env `HINDSIGHT_RECALL_MAX_TOKENS` | `1024` | Token cap on recalled content (default 1024). *(omp://tools/recall.md)* | = group | = group | = group |
| `hindsight.recallContextTurns` | number; env `HINDSIGHT_RECALL_CONTEXT_TURNS` | `1` | Prior turns included in auto-recall query composition (not the explicit recall tool). *(omp://tools/recall.md; omp://environment-variables.md)* | = group | = group | = group |
| `hindsight.recallMaxQueryChars` | number; env `HINDSIGHT_RECALL_MAX_QUERY_CHARS` | `800` | Maximum auto-recall query length (not the explicit recall tool). *(omp://tools/recall.md; omp://environment-variables.md)* | = group | = group | = group |
| `hindsight.recallTypes` | array | `["world","experience"]` | Memory types recalled (default world, experience). *(omp://tools/recall.md)* | = group | = group | = group |
| `hindsight.debug` | boolean; env `HINDSIGHT_DEBUG` | `false` | Debug logging for the Hindsight backend. *(omp://environment-variables.md)* | = group | = group | = group |
| `hindsight.requestTimeoutMs` | number; env `HINDSIGHT_REQUEST_TIMEOUT_MS` | `30000` | Default Hindsight request timeout in ms. *(omp://environment-variables.md)* | = group | = group | = group |
| `hindsight.reflectTimeoutMs` | number; env `HINDSIGHT_REFLECT_TIMEOUT_MS` | `120000` | Deadline for Hindsight reflect requests in ms. *(omp://tools/reflect.md)* | = group | = group | = group |
| `hindsight.recallTimeoutMs` | number; env `HINDSIGHT_RECALL_TIMEOUT_MS` | `30000` | Deadline for Hindsight recall requests in ms. *(omp://tools/recall.md)* | = group | = group | = group |
| `hindsight.retainTimeoutMs` | number; env `HINDSIGHT_RETAIN_TIMEOUT_MS` | `60000` | Client timeout for queued Hindsight retain writes in ms (does not wait for server consolidation). *(omp://tools/retain.md)* | = group | = group | = group |
| `hindsight.mentalModelsEnabled` | boolean | `true` | Read curated reflect summaries (mental models) into developer instructions at boot. Loads existing models on the bank — does not write. Pair with hindsight.mentalModelAutoSeed to also auto-create the built-in seed set. | = group | = group | = group |
| `hindsight.mentalModelAutoSeed` | boolean | `true` | At session start, create any built-in mental models (project-conventions, project-decisions, user-preferences) that do not yet exist on the bank. | = group | = group | = group |
| `hindsight.mentalModelMaxRenderChars` | number | `16000` | Character cap on the rendered <mental_models> block. *(omp://tools/retain.md)* | = group | = group | = group |

### `export/ttsr-settings.ts` (8)

Anchor `pi-coding-agent@18.8.6 src/export/ttsr-settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: context / Rules (TTSR).

Group verdict: **Ilex** Jo only (as2 sets it only through `profile/config.yml` + re-install; Jo may flip it in the Ilex TUI `/settings`). **Lane** not for as2 (OMP default in force; a lane cannot change settings and the profile leaves it unset). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `ttsr.enabled` | boolean | `true` | Interrupt the agent mid-stream when output matches rule patterns (Time-Traveling Stream Rules) | = group | = group | = group |
| `ttsr.judge` | enum(auto \| on \| off) | `"auto"` | Ask the judge model role each `question` rule about completed replies, reasoning, and tool calls; a yes injects the rule as a warning | = group | = group | = group |
| `ttsr.contextMode` | enum(discard \| keep) | `"discard"` | What to do with partial output when TTSR triggers | = group | = group | = group |
| `ttsr.interruptMode` | enum(never \| prose-only \| tool-only \| always) | `"always"` | When to interrupt mid-stream vs inject warning after completion | = group | = group | = group |
| `ttsr.repeatMode` | enum(once \| after-gap) | `"once"` | How rules can repeat: once per session or after a message gap | = group | = group | = group |
| `ttsr.repeatGap` | number | `10` | Messages before a rule can trigger again | = group | = group | = group |
| `ttsr.builtinRules` | boolean | `true` | Load the default rules shipped with the agent (override individually with ttsr.disabledRules) | = group | = group | = group |
| `ttsr.disabledRules` | array | `[]` | Rule names to ignore entirely (applies to bundled defaults and your own rules) | = group | = group | = group |

### `edit/settings.ts` (10)

Anchor `pi-coding-agent@18.8.6 src/edit/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: files / Editing; config file only.

Group verdict: **Ilex** Jo only (as2 sets it only through `profile/config.yml` + re-install; Jo may flip it in the Ilex TUI `/settings`). **Lane** not for as2 (OMP default in force; a lane cannot change settings and the profile leaves it unset). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `edit.mode` | enum(apply_patch \| hashline \| patch \| replace \| sloppy); env `PI_EDIT_VARIANT` | `"hashline"` | Select the edit tool variant (replace, patch, hashline, or apply_patch) | = group | = group | = group |
| `edit.modelVariants` | record | `{}` | Ordered, case-insensitive model-selector substring → edit mode; the first matching entry wins. *(omp://settings.md)* | = group | = group | = group |
| `edit.fuzzyMatch` | boolean; env `PI_EDIT_FUZZY` | `true` | Accept high-confidence fuzzy matches for whitespace differences | = group | = group | = group |
| `edit.fuzzyThreshold` | number; env `PI_EDIT_FUZZY_THRESHOLD` | `0.95` | Similarity threshold (0-1) for accepting fuzzy matches | = group | = group | = group |
| `edit.streamingAbort` | boolean | `false` | Abort streaming edit tool calls when patch preview fails | = group | = group | = group |
| `edit.recoverInlineEdits` | boolean | `true` | Execute edit payloads the model emits as plain text by converting them into edit tool calls | = group | = group | = group |
| `edit.blockAutoGenerated` | boolean | `true` | Prevent editing of files that appear to be auto-generated (protoc, sqlc, swagger, etc.) | = group | = group | = group |
| `edit.enforceSeenLines` | boolean | `true` | Reject edits anchored on lines a prior read/search never displayed in full | = group | = group | = group |
| `edit.blackbox.enabled` | boolean | `false` | Append full before/after source when an edit introduces an AST parse failure | = group | = group | = group |
| `edit.autoRepair.enabled` | boolean | `false` | When an edit breaks a file's AST parse, ask the smol model to fix the broken region (validated by re-parse; falls back to a warning) | = group | = group | = group |

### `tools/settings.ts` (66)

Anchor `pi-coding-agent@18.8.6 src/tools/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: tools / Output Limits; files / Reading; files / Read Summaries; interaction / Approvals; tools / Available Tools; tools / Todos; tools / Grep & Browser; tools / Computer; tools / Execution; tools / GitHub; config file only; tools / Discovery & MCP; tools / Developer.

Group verdict: **Ilex** Jo only (as2 sets it only through `profile/config.yml` + re-install; Jo may flip it in the Ilex TUI `/settings`). **Lane** not for as2 (OMP default in force; a lane cannot change settings and the profile leaves it unset). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `tools.artifactSpillThreshold` | number | `50` | Tool output above this size is saved as an artifact; tail is kept inline | = group | = group | = group |
| `tools.artifactTailBytes` | number | `20` | Amount of tail content kept inline when output spills to artifact | = group | = group | = group |
| `tools.artifactHeadBytes` | number | `20` | Amount of head content kept inline alongside the tail when output spills to artifact (middle elision). 0 disables — keep tail only. | = group | = group | = group |
| `tools.outputMaxColumns` | number | `768` | Per-line byte cap for streaming tool outputs (bash, python, js eval) and `read`. Lines wider than this are ellipsis-truncated; remaining bytes up to the next newline are dropped. 0 disables. | = group | = group | = group |
| `tools.artifactTailLines` | number | `500` | Maximum lines of tail content kept inline when output spills to artifact | = group | = group | = group |
| `tools.artifactMaxBytes` | number | `16` | Maximum size of the artifact file saved for streaming tool output (bash, python, js eval). Larger output keeps its beginning (up to 3 MB) and its most recent remainder, with a truncation notice between them. 0 = unlimited. | = group | = group | = group |
| `readLineNumbers` | boolean | `false` | Prepend line numbers to read tool output by default | = group | = group | = group |
| `read.defaultLimit` | number | `300` | Default number of lines returned when agent calls read without a limit | = group | = group | = group |
| `read.renderMarkdown` | boolean | `false` | Render Markdown read results as formatted terminal Markdown previews instead of raw source | = group | = group | = group |
| `read.summarize.enabled` | boolean | `true` | Return structural code summaries when read is called without an explicit selector | = group | = group | = group |
| `read.summarize.prose` | boolean | `false` | Return structural summaries for Markdown and plain text reads | = group | = group | = group |
| `read.summarize.minBodyLines` | number | `4` | Minimum multiline body or literal length before read summaries collapse it | = group | = group | = group |
| `read.summarize.minCommentLines` | number | `6` | Minimum multiline block comment length before read summaries collapse it | = group | = group | = group |
| `read.summarize.minTotalLines` | number | `100` | Files with fewer total lines are read verbatim instead of structurally summarized | = group | = group | = group |
| `read.summarize.unfoldUntil` | number | `50` | BFS-unfold elidable spans until the summary is at least this many visible lines. 0 keeps only the outermost elisions. | = group | = group | = group |
| `read.summarize.unfoldLimit` | number | `100` | Hard ceiling on summary size while BFS-unfolding. An unfold whose revealed lines would exceed this is skipped (that span stays folded) and unfolding continues with the remaining spans. | = group | = group | = group |
| `read.toolResultPreview` | boolean | `false` | Render read tool results inline in the transcript instead of summary rows | = group | = group | = group |
| `tools.approval` | record | `{}` | Per-tool approval policies. Set to 'allow' to auto-approve, 'prompt' to require confirmation, or 'deny' to block. Overrides are honored in every approval mode. | machinery-owned (unset → `{}`): config.yml «BEGIN M4 TOOL-POLICY SLOT» owns per-tool policy and is empty | = Ilex | = group |
| `tools.approvalMode` | enum(always-ask \| write \| yolo) | `"yolo"` | Default approval behavior for tool calls. 'Always ask' auto-approves read-only tools only. 'Write' auto-approves read and workspace-write tools. 'Yolo' auto-approves all tiers; user policy may still prompt or block. | machinery-owned (unset → OMP default `yolo`): config.yml «BEGIN M4 TOOL-POLICY SLOT» owns it and is empty | = Ilex | = group |
| `todo.enabled` | boolean | `true` | Enable the todo tool for task tracking | = group | = group | = group |
| `todo.reminders` | boolean | `true` | Remind the agent to complete todos before stopping | = group | = group | = group |
| `todo.remindersMax` | number | `3` | Maximum number of todo reminders before giving up | = group | = group | = group |
| `todo.eager` | enum(default \| preferred \| always) | `"default"` | How strongly to push automatic todo-list creation after the first message | = group | = group | = group |
| `tasks.todoClearDelay` | number | `60` | Delay before completed or abandoned todos are removed from the todo widget | = group | = group | = group |
| `glob.enabled` | boolean | `true` | Enable the glob tool for glob-based file lookup | = group | = group | = group |
| `grep.enabled` | boolean | `true` | Enable the grep tool for regex content search | = group | = group | = group |
| `grep.contextBefore` | number | `1` | Lines of context before each grep match | = group | = group | = group |
| `grep.contextAfter` | number | `3` | Lines of context after each grep match | = group | = group | = group |
| `astGrep.enabled` | boolean | `false` | Enable the ast_grep tool for structural AST search | = group | = group | = group |
| `astEdit.enabled` | boolean | `true` | Enable the ast_edit tool for structural AST rewrites | = group | = group | = group |
| `find.enabled` | enum(auto \| on \| off) | `"auto"` | Enable the find tool: natural-language search for files and line ranges, judged by the judge model role. Auto enables it only when the judge role resolves to a native TypeSafe jev model | use (default `auto` turns `find` on because the machinery-owned `modelRoles.judge` is a TypeSafe jev model) | = Ilex | = group |
| `debug.enabled` | boolean | `true` | Enable the debug tool for DAP-based debugging | = group | = group | = group |
| `launch.enabled` | boolean | `true` | Enable named bash services and proc:// supervision for shared long-running project processes | = group | = group | = group |
| `speechgen.enabled` | boolean | `false` | Enable the tts tool for on-device (Kokoro) or xAI Grok Voice speech-file synthesis | = group | = group | = group |
| `generate_image.enabled` | boolean | `false` | Enable the generate_image tool (text-to-image generation and editing). Exposed as an xd:// device when tools.xdev is on. | = group | = group | = group |
| `computer.enabled` | boolean | `false` | Enable the scriptable host-desktop eval prelude (screenshots, input, accessibility) | = group | = group | = group |
| `ratchet.enabled` | boolean | `false` | Enable the ratchet eval/hillclimb prelude; /ratchet turns it on for the current session | = group | = group | = group |
| `archive.enabled` | boolean | `true` | Enable the read-only archive eval prelude: prompt history, recent projects, past sessions and recaps | = group | = group | = group |
| `computer.display` | string | `"active"` | Active window's display (active), all displays (all), or a native display id | = group | = group | = group |
| `computer.maxWidth` | number | `3840` | Maximum screenshot width in pixels | = group | = group | = group |
| `computer.maxHeight` | number | `2400` | Maximum screenshot height in pixels | = group | = group | = group |
| `images.questionTimeoutMs` | number | `300000` | Per-request timeout for the vision-model call behind read's ?q= image questions, in milliseconds. A stalled provider fails fast with a timeout error instead of blocking until manual abort. Set to 0 to disable the timeout. | = group | = group | = group |
| `checkpoint.enabled` | boolean | `false` | Enable the checkpoint and rewind tools for context checkpointing | = group | = group | = group |
| `fetch.enabled` | boolean | `true` | Allow the read tool to fetch and process URLs | = group | = group | = group |
| `vault.enabled` | boolean | `false` | Enable the vault:// internal URL for reading and editing Obsidian vault content via the Obsidian CLI. When disabled, vault:// resolution is refused and the vault:// entry is omitted from the system prompt. | = group | = group | = group |
| `github.enabled` | boolean | `false` | Enable the github tool (op-based dispatch for repository, issue, pull request, diff, search, checkout, push, and Actions watch workflows) | = group | = group | = group |
| `github.cache.enabled` | boolean | `true` | Cache rendered issue/PR view output in ~/.omp/cache/github-cache.db so repeated reads are free | = group | = group | = group |
| `github.cache.softTtlSec` | number | `300` | Within this window, cached issue/PR view rows are returned directly (seconds; default 5 minutes) | = group | = group | = group |
| `github.cache.hardTtlSec` | number | `604800` | Past the soft TTL the cached row is returned and refreshed in the background; past the hard TTL it is dropped (seconds; default 7 days) | = group | = group | = group |
| `web_search.enabled` | boolean | `true` | Enable the web_search tool for live web results | = group | = group | = group |
| `security.enabled` | boolean | `false` | Enable OMP-native security scan planning, execution, and the read-only security:// resource namespace | = group | = group | = group |
| `ask.enabled` | boolean | `true` | Enable the ask tool for interactive user questions | use: Ilex asks Jo through `ask` (gates row 14 allows the orchestrator; gates/src/rows/r14-ask-policy.ts `askAllowed`) | machinery-owned: gates row 14 drops `ask` unless the workload is user-driven, and with no UI OMP never registers it (gates/src/rows/r14-ask-policy.ts) | = group |
| `tools.intentTracing` | boolean; env `PI_INTENT_TRACING` | `true` | Ask the agent to describe the intent of each tool call before executing it | = group | = group | = group |
| `tools.abortOnFabricatedResult` | boolean | `true` | With in-band tool calls, stop the model immediately when it starts hallucinating a tool result mid-turn. Disable to let the model finish generating and discard the fabricated continuation instead. | = group | = group | = group |
| `tools.speculativeExecution.enabled` | boolean | `false` | Enable the discard-safe first slice: validated local reads through direct read calls and nested eval. Network requests, provider completions, and live filesystem writes are not part of this baseline. | = group | = group | = group |
| `tools.speculativeExecution.maxInFlight` | number | `2` | Maximum number of validated local reads allowed to run before normal dispatch. | = group | = group | = group |
| `tools.maxTimeout` | number | `0` | Maximum timeout in seconds the agent can set for any tool (0 = no limit) | = group | = group | = group |
| `async.enabled` | boolean; rpc-pinned (rpc) | `true` | Enable async bash commands and background task execution | = group | not for as2 (rpc-pinned OMP default `true`) | = group |
| `async.maxJobs` | number; rpc-pinned (rpc) | `100` | Running background-job cap, floored to at least 1; parked/queued jobs do not consume execution slots. *(omp://settings.md)* | = group | not for as2 (rpc-pinned OMP default `100`) | = group |
| `tools.xdev` | boolean | `true` | Mount rarely-used (discoverable) tools under xd:// device URLs driven via read/write instead of shipping their schemas on every request. Sessions whose explicit tool list grants read but omits write mount devices through a device-only write transport (filesystem writes stay rejected). Disable to expose every enabled tool top-level. | machinery-owned (unset, default `true`): the gates expect extension and MCP tools mounted as xd:// devices (gates/src/session.ts) | = Ilex | = group |
| `tools.xdevDocs` | enum(inline \| builtins \| catalog) | `"catalog"` | Choose which mounted-device docs and schemas are inlined in the system prompt. Built-ins keeps core tools inline while MCP and extension tools stay on-demand. | = group | = group | = group |
| `tools.xdevInlineDevices` | array | `[]` | When xd:// Prompt Docs is Built-ins Only, inline dynamic devices whose names match these glob patterns (for example mcp__context_mode_*). Catalog Only ignores this setting. | = group | = group | = group |
| `dev.autoqa` | boolean; env `PI_AUTO_QA` | `true` | Automated tool issue reporting (xd://report_issue). On by default; the first report asks for consent, and denying it disables reporting until re-enabled explicitly | Jo only (the first report opens a consent dialog in the TUI) | = group | = group |
| `dev.autoqaPush.endpoint` | string | `"https://qa.omp.sh/v1/grievances"` | Full URL receiving Auto QA JSON reports (default https://qa.omp.sh/v1/grievances) | = group | = group | = group |
| `dev.autoqaPush.token` | string; credential | `unset` | Bearer token for the auto-QA grievance push (PI_AUTO_QA_PUSH_TOKEN wins over it). *(omp://environment-variables.md)* | = group | = group | = group |
| `dev.autoqaConsent` | enum(unset \| granted \| denied) | `"unset"` | Stored answer to the report_tool_issue consent dialog: unset (ask on first report), granted, or denied (every report is a silent no-op). *(source comment, tools/settings.ts dev.autoqaConsent)* | Jo only (answer to the TUI consent dialog) | = group | Jo only (set in Jo's default profile) |

### `lsp/settings.ts` (7)

Anchor `pi-coding-agent@18.8.6 src/lsp/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: files / LSP.

Group verdict: **Ilex** Jo only (as2 sets it only through `profile/config.yml` + re-install; Jo may flip it in the Ilex TUI `/settings`). **Lane** not for as2 (OMP default in force; a lane cannot change settings and the profile leaves it unset). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `lsp.enabled` | boolean | `true` | Enable the lsp tool for code intelligence (definitions, references, diagnostics, rename) | = group | = group | = group |
| `lsp.lazy` | boolean | `true` | Start language servers on first use (lsp tool or editing a matching file type) instead of at session startup | = group | = group | = group |
| `lsp.shared` | boolean | `true` | Share one language server per project across omp instances via the daemon broker (falls back to private servers when unavailable) | = group | = group | = group |
| `lsp.formatOnWrite` | boolean | `false` | Automatically format code files using LSP after writing | = group | = group | = group |
| `lsp.diagnosticsOnWrite` | boolean | `true` | Return LSP diagnostics after writing code files | = group | = group | = group |
| `lsp.diagnosticsOnEdit` | boolean | `false` | Return LSP diagnostics after editing code files | = group | = group | = group |
| `lsp.diagnosticsDeduplicate` | boolean | `true` | Suppress post-edit LSP diagnostics already shown for a file; only surface new or changed ones | = group | = group | = group |

### `exec/settings.ts` (17)

Anchor `pi-coding-agent@18.8.6 src/exec/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: config file only; shell / Bash.

Group verdict: **Ilex** Jo only (as2 sets it only through `profile/config.yml` + re-install; Jo may flip it in the Ilex TUI `/settings`). **Lane** not for as2 (OMP default in force; a lane cannot change settings and the profile leaves it unset). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `shellPath` | string | `unset` | External shell for services, terminals, and `!`; plain bash tool calls use embedded brush. *(omp://settings.md)* | = group | = group | = group |
| `bash.enabled` | boolean | `true` | Enable the bash tool for shell command execution | = group | = group | = group |
| `bash.allowCompoundCommands` | boolean | `false` | Evaluate literal && chains per command; unmatched commands use normal bash approval policy and mode | = group | = group | = group |
| `bash.autoBackground.enabled` | boolean; rpc-pinned (rpc) | `true` | Automatically background long-running bash commands and deliver the result later | machinery-owned (unset, default `true`): config.yml «M4b OS fence» says leave it unset; the fence refuses every bash call while it is false (gates/src/fence.ts) | machinery-owned (unset, default `true`, rpc-pinned): config.yml «M4b OS fence» says leave it unset; the fence refuses every bash call while it is false (gates/src/fence.ts) | = group |
| `bash.patterns` | array | `[]` | Ordered bash command approval rules. Each item has match and approval fields; only '*' wildcards are supported. | = group | = group | = group |
| `bashInterceptor.enabled` | boolean | `false` | Block shell commands that have dedicated tools | = group | = group | = group |
| `bashInterceptor.patterns` | array | `` [{"pattern":"^\\s*(cat\|head\|tail\|less\|more)\\s+","tool":"read","message":"Use the `read… (full value in profile/config.yml or the source) `` | Regex → dedicated-tool routing rules used when bashInterceptor.enabled is on: a matching bash command is refused with a message naming the tool to use instead. *(omp://tools/bash.md; omp://settings.md (Bash interceptor patterns))* | = group | = group | = group |
| `bash.direnv` | enum(auto \| off) | `"auto"` | Auto-load a repo's direnv/devenv `.envrc` into the bash session so devenv tools and env vars are present without manual `direnv exec`. Honors direnv's allow list: an `.envrc` you haven't `direnv allow`ed is never executed | = group | = group | = group |
| `bash.direnvLoadTimeoutMs` | number | `30000` | Max wait for the first `direnv export` (a cold devenv shell can be slow); on timeout the session runs without the direnv env | = group | = group | = group |
| `shellMinimizer.enabled` | boolean | `true` | Compress verbose shell output (git, npm, cargo, etc.) before returning it to the agent | = group | = group | = group |
| `shellMinimizer.settingsPath` | string | `unset` | Path to a minimizer settings file passed to the shell output minimizer (unset = built-in). *(source: exec/bash-executor.ts buildMinimizerOptions settingsPath)* | = group | = group | = group |
| `shellMinimizer.only` | array | `[]` | Restrict the output minimizer to these filters (empty = all). *(source: exec/bash-executor.ts buildMinimizerOptions only)* | = group | = group | = group |
| `shellMinimizer.except` | array | `[]` | Filters the output minimizer must skip. *(source: exec/bash-executor.ts buildMinimizerOptions except)* | = group | = group | = group |
| `shellMinimizer.maxCaptureBytes` | number | `4194304` | Most bytes of shell output the minimizer captures (default 4 MiB). *(source: exec/bash-executor.ts buildMinimizerOptions maxCaptureBytes)* | = group | = group | = group |
| `shellMinimizer.sourceOutlineLevel` | enum(default \| aggressive) | `"default"` | Source outline mode for cat/read of source files: default or aggressive | = group | = group | = group |
| `shellMinimizer.legacyFilters` | boolean | `unset` | Use the minimizer's legacy filter set (unset = minimizer default). *(source: exec/bash-executor.ts buildMinimizerOptions legacyFilters)* | = group | = group | = group |
| `bash.autoBackground.thresholdMs` | number; rpc-pinned (rpc) | `60000` | Threshold before auto-backgrounding. *(omp://settings.md)* | = group | not for as2 (rpc-pinned OMP default `60000`) | = group |

### `eval/settings.ts` (9)

Anchor `pi-coding-agent@18.8.6 src/eval/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: shell / Eval & Runtimes; config file only.

Group verdict: **Ilex** Jo only (as2 sets it only through `profile/config.yml` + re-install; Jo may flip it in the Ilex TUI `/settings`). **Lane** not for as2 (OMP default in force; a lane cannot change settings and the profile leaves it unset). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `eval.py` | boolean; env `PI_PY` | `true` | Allow the eval tool to dispatch Python cells to the IPython kernel | = group | = group | = group |
| `eval.js` | boolean; env `PI_JS` | `true` | Allow the eval tool to dispatch JavaScript cells to the in-process runtime | = group | = group | = group |
| `eval.autoProvision` | boolean | `true` | Automatically create the managed JavaScript eval package environment on first install | = group | = group | = group |
| `eval.tools.enabled` | boolean | `true` | Let eval cells define tools (@tool in Python, tool(fn) in JS) that task, agent(), and workpool() subagents can call | = group | = group | = group |
| `eval.workpool.freshAgents` | boolean | `false` | Spawn a new subagent for every workpool item instead of reusing workers or batching queued items | = group | = group | = group |
| `eval.autoBackground.enabled` | boolean; rpc-pinned (rpc) | `false` | Automatically background long-running eval cells and deliver the result later | = group | not for as2 (rpc-pinned OMP default `false`) | = group |
| `eval.autoBackground.thresholdMs` | number; rpc-pinned (rpc) | `60000` | How long an eval cell runs before it becomes a managed async job, when eval.autoBackground.enabled is on (default 60000 ms). *(omp://tools/eval.md)* | = group | not for as2 (rpc-pinned OMP default `60000`) | = group |
| `python.kernelMode` | enum(session \| per-call) | `"session"` | Keep the IPython kernel alive across eval calls or start fresh each time | = group | = group | = group |
| `python.interpreter` | string | `""` | Optional path to an exact Python executable. When set, automatic Python runtime discovery is skipped. | = group | = group | = group |

### `task/settings.ts` (32)

Anchor `pi-coding-agent@18.8.6 src/task/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: tasks / Isolation; tasks / Subagents; config file only; appearance / Display.

Group verdict: **Ilex** Jo only (as2 sets it only through `profile/config.yml` + re-install; Jo may flip it in the Ilex TUI `/settings`). **Lane** use (OMP default in force): it governs the hands a lane spawns; change it only in `profile/config.yml`'s `task:` mapping. **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `task.isolation.enabled` | boolean; rpc-pinned (rpc, acp) | `false` | Run subagents in an isolated copy of the checkout and integrate their changes afterwards | = group | not for as2 (a lane already works in its own worktree, `laneArgv --cwd <worktree>`; hand isolation stays at OMP's default) | = group |
| `isolation.backend` | enum(auto \| apfs \| btrfs \| zfs \| reflink \| overlayfs \| projfs \| block-clone \| rcopy); rpc-pinned (rpc, acp) | `"auto"` | Backend used for subagent isolation and worktree cloning | = group | not for as2 (a lane already works in its own worktree, `laneArgv --cwd <worktree>`; hand isolation stays at OMP's default) | = group |
| `worktree.clone` | boolean; rpc-pinned (rpc, acp) | `true` | New worktrees from `github pr_checkout` and `git worktree add` in bash start as a copy-on-write clone of the current checkout so ignored build artifacts (node_modules, target) carry over; falls back to a plain checkout when the filesystem cannot clone | = group | not for as2 (a lane already works in its own worktree, `laneArgv --cwd <worktree>`; hand isolation stays at OMP's default) | = group |
| `worktree.cleanSource` | boolean; rpc-pinned (rpc, acp) | `false` | When creating a worktree with `/wt`, reset tracked changes and remove untracked files from the original checkout after carrying them over | = group | not for as2 (a lane already works in its own worktree, `laneArgv --cwd <worktree>`; hand isolation stays at OMP's default) | = group |
| `worktree.onStart` | enum(off \| ask \| create); rpc-pinned (rpc, acp) | `"off"` | Whether fresh interactive sessions start in a new linked worktree | = group | not for as2 (a lane already works in its own worktree, `laneArgv --cwd <worktree>`; hand isolation stays at OMP's default) | = group |
| `worktree.onExit` | enum(keep \| ask \| remove); rpc-pinned (rpc, acp) | `"keep"` | What to do on exit with worktrees created since omp started (on start or with `/wt`) | = group | not for as2 (a lane already works in its own worktree, `laneArgv --cwd <worktree>`; hand isolation stays at OMP's default) | = group |
| `task.isolation.apply` | boolean; rpc-pinned (rpc, acp) | `true` | Automatically apply successful isolated task changes to the parent checkout; disable to retain patch or branch artifacts | = group | not for as2 (a lane already works in its own worktree, `laneArgv --cwd <worktree>`; hand isolation stays at OMP's default) | = group |
| `task.isolation.merge` | enum(patch \| branch); rpc-pinned (rpc, acp) | `"patch"` | How isolated task changes are integrated (patch apply or branch merge) | = group | not for as2 (a lane already works in its own worktree, `laneArgv --cwd <worktree>`; hand isolation stays at OMP's default) | = group |
| `task.isolation.commits` | enum(generic \| ai); rpc-pinned (rpc, acp) | `"generic"` | Commit message style for nested repo changes (generic or AI-generated) | = group | not for as2 (a lane already works in its own worktree, `laneArgv --cwd <worktree>`; hand isolation stays at OMP's default) | = group |
| `worktree.base` | string | `unset` | Base directory for agent-managed worktrees — task-isolation copies, `github` PR checkouts, and `omp worktree` cleanup all live here. Unset uses ~/.omp/wt. Must be an absolute or ~-relative path; relative paths are ignored. The OMP_WORKTREE_DIR env var overrides this. | = group | not for as2 (a lane already works in its own worktree, `laneArgv --cwd <worktree>`; hand isolation stays at OMP's default) | = group |
| `task.eager` | enum(default \| preferred \| always); rpc-pinned (rpc, acp) | `"default"` | How strongly to push delegating work to subagents | = group | = group | = group |
| `task.batch` | boolean; rpc-pinned (rpc, acp) | `true` | Switch the task tool to its batch shape: one call carries { context, tasks[] } — one subagent per item, with an optional per-item agent (defaulting to the session spawn-policy agent), per-item isolation, and a required shared context prepended to every assignment. With async.enabled=true, each spawn runs as an independent background agent with the normal idle/parked lifecycle; otherwise the call blocks for merged results. Disable to restore the flat single-spawn schema. | = group | = group | = group |
| `task.speculativeLaunch` | boolean | `true` | Start each batch subagent as soon as its tasks[] item finishes streaming instead of waiting for the whole task call. Launched agents are aborted if the finished call fails validation, is blocked, or its arguments change. Requires auto-allowed task approval and no extension tool lifecycle handlers. | = group | = group | = group |
| `task.enableEffort` | boolean | `false` | Expose the optional effort parameter on task spawns, allowing callers to override each subagent's thinking level | = group | = group | = group |
| `task.maxConcurrency` | number; rpc-pinned (rpc, acp) | `32` | Maximum number of subagents running concurrently | = group | = group | = group |
| `task.enableLsp` | boolean | `false` | Allow subagents spawned via the task tool to use the lsp tool. Off by default to keep subagents cheap; enable when LSP-aware delegation is worth the extra tokens. | = group | = group | = group |
| `task.maxRecursionDepth` | number; rpc-pinned (rpc, acp) | `2` | How many levels deep subagents can spawn their own subagents | = group | = group | = group |
| `task.maxRuntimeMs` | number | `0` | Hard wall-clock limit per subagent (ms). 0 disables it. Defense-in-depth against provider-side stream hangs that escape the inference-layer watchdog; triggers a normal subagent abort with a 'timed out' reason. | = group | = group | = group |
| `task.completionProbe` | boolean | `true` | Ask a working subagent, through a cached side request like /btw, to estimate how complete its task is: after 2, 5, 10 and 30 more minutes, then hourly. The estimate shows next to the subagent in wait and task views. Only subagents spawned by the main agent of an interactive session are asked; print, RPC, ACP and SDK runs never probe. | = group | = group | = group |
| `task.agentIdleTtlMs` | number | `420000` | How long an idle subagent stays live in memory before being parked to disk (ms). Parked agents are revived automatically when messaged or resumed. 0 keeps idle agents live until exit. | = group | = group | = group |
| `task.softRequestBudget` | number | `200` | Soft per-subagent request budget (assistant requests per run). Crossing it injects a wrap-up steering notice (see task.softRequestBudgetNotice); at 1.5x the budget the run is force-stopped and the agent must yield its partial findings. 0 disables the guard. Bundled scout/sonic agents cap out at a lower built-in budget, so a value below that cap still applies to them. | = group | = group | = group |
| `task.softRequestBudgetNotice` | boolean | `true` | Inject one steering notice when a subagent crosses its soft request budget, asking it to wrap up before the 1.5x forced-yield stop. | = group | = group | = group |
| `task.maxEffort` | enum(minimal \| low \| medium \| high \| xhigh \| max) | `"max"` | Maximum reasoning effort allowed for the task tool's per-spawn effort hint. Lower values prevent callers from escalating subagents above this ceiling; the default preserves the model's full range. | = group | = group | = group |
| `task.disabledAgents` | array; rpc-pinned (rpc, acp) | `[]` | Agent names the task tool refuses at preflight (lists enabled alternatives). *(omp://task-agent-discovery.md)* | = group | = group | = group |
| `task.agentModelOverrides` | record; rpc-pinned (rpc, acp) | `{}` | Agent name → model (or ordered models) for task spawns; first in model priority, before agent frontmatter and the task role. *(omp://tools/task.md; omp://task-agent-discovery.md)* | machinery-owned: `{"fast":["anthropic/claude-haiku-4-5","openai-codex/gpt-5.6-luna","moonshot/kimi-k2.7-c… (full value in profile/config.yml or the source)` (config.yml «Tier → model table»: the only place a tier's model is named) | = Ilex | = group |
| `task.agentServiceTierOverrides` | record; rpc-pinned (rpc, acp) | `{}` | Sparse exact-name overrides for agents spawned by task/eval dispatch (Vibe workers keep `tier.subagent`). Values: `inherit`, `none`, `auto`, `default`, `flex`, `scale`, `priority`, `ultrafast`. An entry overrides `tier.subagent`; concrete values apply only when supported by the resolved model's provider family. A non-mapping value fails settings load. *(omp://settings.md)* | = group | = group | = group |
| `task.agentCompactionThresholdOverrides` | record; rpc-pinned (rpc, acp) | `{}` | Exact-name task/eval agent → compaction trigger: a positive token count (`90000`) or a percentage string (`"80%"`). See below. *(omp://settings.md)* | = group | = group | = group |
| `task.agentAccountPools` | record; rpc-pinned (rpc, acp) | `{}` | Exact-name task/eval agent → provider id → OAuth identity keys (the `identityKey` values of client account pools, e.g. `email:<address>\|org:<id>` for Anthropic; `omp usage accounts` lists them). The agent authenticates for each listed provider only with those accounts, never another account or an API key, and fails when none can serve; an empty list allows no account. A malformed entry fails settings load. See Task agent discovery. *(omp://settings.md)* | = group | = group | = group |
| `task.agentPrewalk` | record; rpc-pinned (rpc, acp) | `{}` | Per-agent prewalk override: agent name → on / off / target pattern; set from /agents. *(omp://task-agent-discovery.md)* | not for as2 (it hands work to the smol role mid-run, a model the tier table did not pick; config.yml «Tier → model table») | not for as2 (it hands work to the smol role mid-run, a model the tier table did not pick; config.yml «Tier → model table») | = group |
| `task.agentAdvisor` | record; rpc-pinned (rpc, acp) | `{}` | Per-agent subagent advisor: agent name → `"on"` / `"off"` / advisor model pattern. Overrides agent frontmatter `advisor`; configured from the `/agents` hub. *(omp://settings.md)* | not for as2 (no OMP advisor in as2) | not for as2 (no OMP advisor in as2) | = group |
| `task.prewalk` | boolean | `false` | Arm prewalk for the bundled generic `task` subagent: it starts on its resolved model, plans and begins the implementation, then hands off to the 'smol' role at its first edit/write. Per-agent overrides (task.agentPrewalk, configured from the /agents hub) and user agent `prewalk` frontmatter apply regardless of this toggle. | not for as2 (it hands work to the smol role mid-run, a model the tier table did not pick; config.yml «Tier → model table») | not for as2 (it hands work to the smol role mid-run, a model the tier table did not pick; config.yml «Tier → model table») | = group |
| `task.showResolvedModelBadge` | boolean | `false` | Display the actual model ID used by each subagent in the task widget status line | = group | not for as2 (`--mode rpc --no-ui` renders no TUI) | = group |

### `plan-mode/settings.ts` (4)

Anchor `pi-coding-agent@18.8.6 src/plan-mode/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: tasks / Modes.

Group verdict: **Ilex** Jo only (`/plan` is a TUI action; an as2 plan is a plan slice in the ledger). **Lane** not for as2 (as2's plan-first is a judge slice with a plan file, not OMP plan mode). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `plan.enabled` | boolean | `true` | Enable plan mode for read-only exploration and planning before execution | = group | = group | = group |
| `plan.defaultOnStartup` | boolean | `false` | Automatically enter plan mode at the start of every new session | = group | = group | = group |
| `plan.autosave` | boolean | `false` | Automatically save approved plans to disk when plan mode completes | = group | = group | = group |
| `plan.autosaveDir` | string | `unset` | Directory for autosaved plans. Supports ~, absolute, and cwd-relative paths. Empty uses <project>/.omp/plans/. | = group | = group | = group |

### `goals/settings.ts` (3)

Anchor `pi-coding-agent@18.8.6 src/goals/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: tasks / Modes.

Group verdict: **Ilex** Jo only (goal mode is Jo's TUI feature). **Lane** not for as2 (`goal.continuationModes` defaults to interactive only, so no goal auto-continues in rpc). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `goal.enabled` | boolean | `true` | Enable per-session goal mode and the hidden goal tool | = group | = group | = group |
| `goal.statusInFooter` | boolean | `true` | Show token budget alongside the goal indicator in the status line | = group | = group | = group |
| `goal.continuationModes` | array | `["interactive"]` | Run modes where active goals may auto-continue between turns ("interactive", "rpc") | = group | = group | = group |

### `utils/title-settings.ts` (3)

Anchor `pi-coding-agent@18.8.6 src/utils/title-settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: appearance / Display; tasks / Modes.

Group verdict: **Ilex** Jo only (session-title preference). **Lane** not for as2 (`--mode rpc` sets `PI_NO_TITLE`; pi-coding-agent@18.8.6 src/main.ts `parsedArgs.mode === "rpc"`). **Seat** not for as2 (seat-bin/omp passes `--no-title`, which sets `PI_NO_TITLE`).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `title.icons` | enum(nf+emoji \| emoji \| boring) | `"nf+emoji"` | Icon and short code that head new generated session titles | = group | = group | = group |
| `title.generator` | enum(fork \| tiny) | `"fork"` | What names an untitled session from the user's messages | = group | = group | = group |
| `title.refreshOnReplan` | boolean | `true` | Refresh generated session titles after todo init replans unless the title was set by the user | = group | = group | = group |

### `extensibility/settings.ts` (20)

Anchor `pi-coding-agent@18.8.6 src/extensibility/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: config file only; interaction / Skills; tasks / Commands & Skills; tools / Extensions.

Group verdict: **Ilex** Jo only. **Lane** not for as2 (OMP default in force). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `extensions` | array | `[]` | Explicit extension paths to load, in order (array; replaces lower layers wholesale). *(omp://settings.md (merge rules); omp://extension-loading.md)* | machinery-owned: `["{repo}/surface/index.ts","{repo}/gates/index.ts","{repo}/classifier/extension.ts"]` (config.yml «Extensions»: surface, then gates, then classifier, in that order) | = Ilex | Jo only (Jo's default profile sets none; launch-seat adds `--hook`/`--extension` paths; the `ilex` seat adds herdr and moshi extensions) |
| `disabledExtensions` | array | `[]` | Extension/capability entries to omit from normal loads, e.g. skill:<name>, slash-command:<name>. *(omp://slash-command-internals.md; omp://skills.md)* | Jo only (never set in the as2 profile: its entries can omit skills and commands as2 ships) | = group | = group |
| `skills.registryUrl` | string | `"https://skills.omp.sh"` | Skillshare registry used by `omp skill` to install, search, and publish skills (https://host[:port]) | not for as2 (as2 vendors its skills in the checkout; skills/VENDOR.md) | not for as2 (as2 vendors its skills in the checkout) | = group |
| `skills.enabled` | boolean | `true` | Master switch for skills; false makes discovery return no skills. *(omp://skills.md)* | machinery-owned: `true` (config.yml «Skills»: the checkout's `skills/` is the only source) | = Ilex | = group |
| `skills.enableSkillCommands` | boolean | `true` | Register skills as /skill:name commands | = group | = group | = group |
| `skills.enableCodexUser` | boolean | `false` | Load skills from the Codex user root (~/.codex). *(source: discovery/codex.ts cfgSkillsEnableCodexUser; as2 config.yml Skills comment)* | machinery-owned: `false` (config.yml «Skills»: provider off, so the checkout's `skills/` is the only source) | = Ilex | = group |
| `skills.enableClaudeUser` | boolean | `false` | Load skills from the Claude user root (~/.claude). *(source: discovery/claude.ts cfgSkillsEnableClaudeUser; as2 config.yml Skills comment)* | machinery-owned: `false` (config.yml «Skills»: provider off, so the checkout's `skills/` is the only source) | = Ilex | Jo only (set in Jo's default profile) |
| `skills.enableClaudeProject` | boolean | `true` | Load skills from the project's .claude directory. *(source: extensibility/settings.ts cfgSkills group; as2 config.yml Skills comment)* | machinery-owned: `false` (config.yml «Skills»: provider off, so the checkout's `skills/` is the only source) | = Ilex | = group |
| `skills.enablePiUser` | boolean | `true` | Legacy-named gate for the native user skill source (~/.omp profile agent/skills). *(omp://config-usage.md)* | machinery-owned: `false` (config.yml «Skills»: provider off, so the checkout's `skills/` is the only source) | = Ilex | = group |
| `skills.enablePiProject` | boolean | `true` | Legacy-named gate for the native project skill source (.omp/skills). *(omp://config-usage.md)* | machinery-owned: `false` (config.yml «Skills»: provider off, so the checkout's `skills/` is the only source) | = Ilex | = group |
| `skills.enableAgentsUser` | boolean | `true` | Load skills from the ~/.agents user root. *(source: extensibility/settings.ts cfgSkills group; as2 config.yml Skills comment)* | machinery-owned: `false` (config.yml «Skills»: provider off, so the checkout's `skills/` is the only source) | = Ilex | = group |
| `skills.enableAgentsProject` | boolean | `true` | Load skills from the project's .agents directory. *(source: extensibility/settings.ts cfgSkills group; as2 config.yml Skills comment)* | machinery-owned: `false` (config.yml «Skills»: provider off, so the checkout's `skills/` is the only source) | = Ilex | = group |
| `skills.customDirectories` | array | `[]` | Extra skill directories scanned non-recursively for */SKILL.md; a custom-directory skill outranks a provider skill. *(omp://skills.md)* | machinery-owned: `["{repo}/skills"]` (config.yml «Skills»: rendered with the checkout path) | = Ilex | = group |
| `skills.ignoredSkills` | array | `[]` | Skill names excluded from the listing (applied to raw and final names). *(omp://skills.md)* | Jo only (the skill set is pinned by `skills.includeSkills`) | = group | = group |
| `skills.includeSkills` | array | `[]` | Allowlist of skill names for the final listing; empty means all. *(omp://skills.md)* | machinery-owned: `22 names` (config.yml «Skills»: allowlist of the 22 manifest rows; the installer refuses a list that differs) | = Ilex | = group |
| `commands.enableClaudeUser` | boolean | `false` | Load commands from ~/.claude/commands/ | = group | = group | = group |
| `commands.enableClaudeProject` | boolean | `true` | Load commands from .claude/commands/ | = group | = group | = group |
| `commands.enableOpencodeUser` | boolean | `false` | Load commands from ~/.config/opencode/commands/ | = group | = group | = group |
| `commands.enableOpencodeProject` | boolean | `true` | Load commands from .opencode/commands/ | = group | = group | = group |
| `extensionHandlers.toolCallTimeoutMs` | number | `30000` | Positive finite active-work timeout for extension tool_call handlers; invalid values use 30000ms, and time awaiting OMP-owned dialogs does not count | machinery-owned (unset → 30000 ms): the as2 extensions' `tool_call` handlers, the classifier's judge call among them, run under it (classifier/test/review-round2.test.ts) | = Ilex | = group |

### `web/settings.ts` (10)

Anchor `pi-coding-agent@18.8.6 src/web/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: providers / Services; config file only.

Group verdict: **Ilex** Jo only (as2 sets it only through `profile/config.yml` + re-install; Jo may flip it in the Ilex TUI `/settings`). **Lane** not for as2 (OMP default in force; a lane cannot change settings and the profile leaves it unset). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `exa.enabled` | boolean | `true` | Enable the Exa web search provider | = group | = group | = group |
| `exa.searchDelayMs` | number | `1000` | Minimum delay between Exa web search requests in milliseconds; set 0 to disable pacing | = group | = group | = group |
| `searxng.endpoint` | string; env `SEARXNG_ENDPOINT` | `unset` | Base URL of a self-hosted SearXNG instance used for web search | = group | = group | = group |
| `searxng.token` | string; env `SEARXNG_TOKEN`; credential | `unset` | SearXNG token; also `searxng.basicUsername`/`searxng.basicPassword`/`searxng.categories`/`searxng.language`/`searxng.engines` (comma-separated engine names or bang shortcuts, e.g. `ddg, br, startpage`, sent as the API's `engines=` parameter)/`searxng.safesearch`. *(omp://settings.md)* | = group | = group | = group |
| `searxng.basicUsername` | string; env `SEARXNG_BASIC_USERNAME` | `unset` | SearXNG basic-auth user (fallback env SEARXNG_BASIC_USERNAME); basic auth wins over the bearer token. *(omp://settings.md; omp://tools/web_search.md)* | = group | = group | = group |
| `searxng.basicPassword` | string; env `SEARXNG_BASIC_PASSWORD`; credential | `unset` | SearXNG basic-auth password (fallback env SEARXNG_BASIC_PASSWORD). *(omp://settings.md; omp://tools/web_search.md)* | = group | = group | = group |
| `searxng.categories` | string | `unset` | SearXNG categories parameter. *(omp://settings.md (searxng.token row))* | = group | = group | = group |
| `searxng.engines` | string | `unset` | Comma-separated SearXNG engine names or bang shortcuts, sent as engines=. *(omp://settings.md (searxng.token row))* | = group | = group | = group |
| `searxng.language` | string | `unset` | SearXNG language parameter. *(omp://settings.md (searxng.token row))* | = group | = group | = group |
| `searxng.safesearch` | number | `unset` | SearXNG safesearch level. *(omp://settings.md (searxng.token row))* | = group | = group | = group |

### `tools/browser/settings.ts` (10)

Anchor `pi-coding-agent@18.8.6 src/tools/browser/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: tools / Available Tools; tools / Grep & Browser.

Group verdict: **Ilex** Jo only (as2 sets it only through `profile/config.yml` + re-install; Jo may flip it in the Ilex TUI `/settings`). **Lane** not for as2 (OMP default in force; a lane cannot change settings and the profile leaves it unset). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `browser.enabled` | boolean | `true` | Enable the browser eval prelude for scripted Chromium automation (Puppeteer) | = group | = group | = group |
| `browser.cdpUrl` | string | `unset` | Default HTTP CDP discovery endpoint (for example http://127.0.0.1:9222) to attach to instead of launching a browser. Explicit app.cdp_url or app.path on the tool call take precedence. | = group | = group | = group |
| `browser.relay` | boolean | `false` | Drive your own Chrome tabs through the omp browser relay. Install the extension once (`omp browser-relay install`); the relay server auto-starts when the browser prelude needs it. Takes precedence over Browser CDP URL; set PI_BROWSER_RELAY=0 or PI_BROWSER_RELAY=1 to override. | = group | = group | = group |
| `browser.relayUrl` | string | `unset` | omp browser relay endpoint (default http://127.0.0.1:9224). | = group | = group | = group |
| `browser.headless` | boolean | `true` | Launch browser in headless mode (disable to show browser UI) | = group | = group | = group |
| `browser.cmux` | boolean | `true` | Use cmux WKWebView surfaces for browser automation when a cmux socket is available. Set PI_BROWSER_CMUX=0 or PI_BROWSER_CMUX=1 to override. | = group | = group | = group |
| `browser.tern` | boolean | `true` | Inside a Tern pane, open browser tabs as picture-in-pictures over omp's pane (native web view) instead of headless Chromium; falls back to Chromium when no Tern window can host them. Explicit app options, the relay and Browser CDP URL take precedence; app.tern:false opts one open out. Set PI_BROWSER_TERN=0 or PI_BROWSER_TERN=1 to override. | = group | = group | = group |
| `browser.freezeOnTurnEnd` | boolean | `true` | Freeze OMP-owned headless browser tabs when a turn settles so animated pages stop burning CPU/GPU while idle. Tabs unfreeze automatically on next use; pass persist:true on open to opt a tab out. | = group | = group | = group |
| `browser.idleCloseSec` | number | `1800` | Close OMP-owned headless browser tabs and Tern browser picture-in-pictures idle longer than this many seconds (0 = never; session dispose still reaps). Never touches relay/CDP/spawned browsers or other sessions' tabs. | = group | = group | = group |
| `browser.screenshotDir` | string | `unset` | Directory to save screenshots. If unset, screenshots go to a temp file. Supports ~. Examples: ~/Downloads, ~/Desktop, /sdcard/Download (Android) | = group | = group | = group |

### `ida/settings.ts` (5)

Anchor `pi-coding-agent@18.8.6 src/ida/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: tools / Available Tools; tools / IDA Pro.

Group verdict: **Ilex** not for as2 (no binary analysis in as2 work). **Lane** not for as2 (no binary analysis in as2 work). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `ida.enabled` | boolean | `true` | Open executables read with `read` in IDA Pro (idalib) and enable the `ida` tool; inert when no IDA install is found | = group | = group | = group |
| `ida.python` | string | `""` | Python interpreter that can import ida_domain and idapro; empty auto-detects | = group | = group | = group |
| `ida.installDir` | string | `""` | Directory containing libidalib, exported as IDADIR; empty auto-detects ($IDADIR, ida-config.json, standard install paths) | = group | = group | = group |
| `ida.maxOpen` | number | `4` | Most IDA databases (omp.ida.* daemons in omp ps) open at once per project; opening another saves and closes the least recently used idle one | = group | = group | = group |
| `ida.idleCloseSec` | number | `900` | Save and close IDA databases idle longer than this many seconds (0 = never); the exec namespace resets on reopen | = group | = group | = group |

### `mcp/settings.ts` (5)

Anchor `pi-coding-agent@18.8.6 src/mcp/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: tools / Discovery & MCP.

Group verdict: **Ilex** Jo only (as2's MCP servers come from `profile/mcp.json`, not a setting). **Lane** not for as2 (OMP default in force; a lane cannot change settings and the profile leaves it unset). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `mcp.enableProjectConfig` | boolean | `true` | Load .mcp.json/mcp.json from project root | = group | = group | = group |
| `mcp.startupTimeoutMs` | number | `250` | Wait this many milliseconds for initial MCP tool discovery; 0 waits until connections settle | = group | = group | = group |
| `mcp.renderMarkdownResults` | boolean | `true` | Render non-JSON MCP text results as Markdown in the transcript | = group | = group | = group |
| `mcp.notifications` | boolean | `false` | Inject MCP resource updates into the agent conversation | = group | = group | = group |
| `mcp.notificationDebounceMs` | number | `500` | Debounce window in milliseconds for MCP resource updates before injecting them into the conversation | = group | = group | = group |

### `blob-broker/settings.ts` (10)

Anchor `pi-coding-agent@18.8.6 src/blob-broker/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: model / Vision; config file only.

Group verdict: **Ilex** Jo only (as2 sets it only through `profile/config.yml` + re-install; Jo may flip it in the Ilex TUI `/settings`). **Lane** not for as2 (OMP default in force; a lane cannot change settings and the profile leaves it unset). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `images.urls.enabled` | boolean | `false` | Publish outgoing images through the configured backend chain and send URL-fetching providers short URLs instead of inline base64. Falls back to inline automatically when every backend or a provider fetch fails | = group | = group | = group |
| `images.urls.backends` | array | `["provider-files","tailscale","cloudflared","litterbox"]` | Ordered destinations tried when publishing images for provider access | = group | = group | = group |
| `images.urls.options` | record | `{}` | Per-destination option overrides for image URL publishing (command, publicBaseUrl, bindHost, sshTarget, sshRemotePort). *(source: blob-broker/service.ts resolveBlobBrokerConfigs optionsByDestination)* | = group | = group | = group |
| `images.urls.credentials` | record; credential | `{}` | Per-destination credentials for image URL publishing (credential: redacted). *(source: blob-broker/service.ts credentialsByDestination; credential: true)* | = group | = group | = group |
| `images.urls.command` | string | `unset` | Argv template for the command backend; {file} is the image path, {mime}/{ext} optional. The last URL printed on stdout is used (e.g. pasta -b -f {file}) | = group | = group | = group |
| `images.urls.publicBaseUrl` | string | `unset` | Externally reachable base URL fronting the blob server (required for ssh, optional for direct) | = group | = group | = group |
| `images.urls.ttlHours` | number | `72` | Serving window for locally hosted image URLs, measured from the last time a conversation sent them; resuming a conversation re-arms the window at the same link. 0 keeps links alive while the broker runs | = group | = group | = group |
| `images.urls.bindHost` | string | `"127.0.0.1"` | Host the blob server binds to; loopback for tunnels, 0.0.0.0 for direct serving | = group | = group | = group |
| `images.urls.sshTarget` | string | `unset` | user@host destination for the ssh reverse forward | = group | = group | = group |
| `images.urls.sshRemotePort` | number | `8787` | Remote listen port of the ssh reverse forward that your web server proxies to | = group | = group | = group |

### `secrets/settings.ts` (1)

Anchor `pi-coding-agent@18.8.6 src/secrets/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: providers / Privacy.

Group verdict: **Ilex** Jo only (as2 sets it only through `profile/config.yml` + re-install; Jo may flip it in the Ilex TUI `/settings`). **Lane** not for as2 (OMP default in force; a lane cannot change settings and the profile leaves it unset). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `secrets.enabled` | boolean | `false` | Obfuscate configured secrets and redact credential-shaped tokens before sending to AI providers | = group | = group | = group |

### `stt/settings.ts` (3)

Anchor `pi-coding-agent@18.8.6 src/stt/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: interaction / Speech; config file only.

Group verdict: **Ilex** Jo only (dictation is Jo's TUI input). **Lane** not for as2 (no audio in an unattended rpc lane). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `stt.enabled` | boolean | `false` | Enable speech-to-text input via microphone | = group | = group | = group |
| `stt.language` | string | `"en"` | Source language hint for speech-to-text. *(omp://settings.md)* | = group | = group | = group |
| `stt.submitTrigger` | enum(never \| release \| release-complete \| say-submit) | `"never"` | Choose when speech dictation automatically submits: Never, Release (2+ words), Release with complete sentence, or When I Say Submit. | = group | = group | = group |

### `collab/settings.ts` (4)

Anchor `pi-coding-agent@18.8.6 src/collab/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: interaction / Collab.

Group verdict: **Ilex** Jo only (`/collab` is Jo's). **Lane** not for as2 (collab hosts interactive sessions; a lane is `--mode rpc --no-ui`). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `collab.relayUrl` | string | `"wss://my.omp.sh"` | Relay used by /collab (wss://host[:port]) | = group | = group | = group |
| `collab.webUrl` | string | `""` | Browser UI used by /collab links; empty derives from collab.relayUrl; explicit http:// is localhost-only | = group | = group | = group |
| `collab.displayName` | string | `""` | Name shown to other collab participants (default: OS username) | = group | = group | = group |
| `collab.autoStart` | enum(off \| view \| control) | `"off"` | Host every interactive session via collab.relayUrl as it starts and publish it to the local registry (omp collab list); rooms rotate on session switch | Jo only (on, it hosts every interactive session, the Ilex TUI included, via `collab.relayUrl`) | = group | = group |

### `commands/settings.ts` (3)

Anchor `pi-coding-agent@18.8.6 src/commands/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: interaction / Collab.

Group verdict: **Ilex** Jo only (`/share` is a TUI command). **Lane** not for as2 (`/share` has no sender in a lane). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `share.serverUrl` | string | `"https://my.omp.sh/s"` | Share viewer/upload base used by /share (encrypted blob upload + viewer; links are <base>/<id>#<key>) | = group | = group | = group |
| `share.store` | enum(blob \| gist) | `"blob"` | Where /share uploads the encrypted session blob | = group | = group | = group |
| `share.redactSecrets` | boolean | `true` | Run the secret obfuscator over /share snapshots before upload (uses the secrets.* config) | = group | = group | = group |

### `stream/settings.ts` (2)

Anchor `pi-coding-agent@18.8.6 src/stream/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: interaction / Stream.

Group verdict: **Ilex** Jo only (`omp stream` is Jo's CLI). **Lane** not for as2 (lanes are never streamed). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `stream.serverUrl` | string | `"https://live.omp.sh"` | Live stream server used by `omp stream` (https://host[:port]); viewers watch at <base>/<your Stencil username> | = group | = group | = group |
| `stream.redactPatterns` | array | `[]` | Additional regular expressions redacted from every streamed row, on top of env/secrets.yml values and built-in credential shapes | = group | = group | = group |

### `commit/settings.ts` (6)

Anchor `pi-coding-agent@18.8.6 src/commit/settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: config file only.

Group verdict: **Ilex** not for as2 (as2 commits with git; nothing in tiers/, surface/src, gates/src or bin/ runs `omp commit`). **Lane** not for as2 (as2 commits with git; nothing in tiers/, surface/src, gates/src or bin/ runs `omp commit`). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `commit.mapReduceEnabled` | boolean | `true` | Let `omp commit` split a large diff into map-reduce batches. *(source: commit/conventional/map-reduce.ts shouldUseMapReduce)* | = group | = group | = group |
| `commit.mapReduceThreshold` | number | `5000` | Diff token count at which `omp commit` switches to map-reduce. *(source: commit/conventional/map-reduce.ts shouldUseMapReduce)* | = group | = group | = group |
| `commit.mapBatchTokenBudget` | number | `16000` | Token budget per map batch in `omp commit` map-reduce. *(source: commit/conventional/map-reduce.ts effectiveMapBudget)* | = group | = group | = group |
| `commit.cacheEnabled` | boolean | `true` | Cache `omp commit` inference results. *(source: commit/conventional/service.ts CommitInferenceCache.open)* | = group | = group | = group |
| `commit.cacheTtlDays` | number | `14` | Days a cached `omp commit` inference stays valid. *(source: commit/conventional/service.ts CommitInferenceCache.open)* | = group | = group | = group |
| `commit.changelogMaxDiffChars` | number | `120000` | Character cap on the diff given to changelog generation. *(source: commit/pipeline.ts maxDiffChars)* | = group | = group | = group |

### `cli/gc-settings.ts` (9)

Anchor `pi-coding-agent@18.8.6 src/cli/gc-settings.ts` plus the row's `id: "<id>"`. Settings-panel tab / section: config file only.

Group verdict: **Ilex** Jo only (`omp gc` is a maintenance CLI Jo runs). **Lane** not for as2 (lanes never run `omp gc`). **Seat** Jo only (Jo's default profile `~/.omp/agent/config.yml`, or a one-launch `OMP_SEAT_CONFIG` overlay).

| id | type | default | what it does | Ilex | lane | seat |
|---|---|---|---|---|---|---|
| `gc.blobs` | boolean | `true` | `omp gc` runs the blob phase when no phase flag is given. *(source: cli/gc-cli.ts runBlobs)* | = group | = group | = group |
| `gc.archive` | boolean | `true` | `omp gc` runs the session-archive phase when no phase flag is given. *(source: cli/gc-cli.ts runArchive)* | = group | = group | = group |
| `gc.wal` | boolean | `true` | `omp gc` runs the WAL phase when no phase flag is given. *(source: cli/gc-cli.ts runWal)* | = group | = group | = group |
| `gc.coldArchiveAfterDays` | number | `30` | Days before `omp gc` cold-archives a session (flag --cold-archive-after-days wins). *(source: cli/gc-cli.ts, commands/gc.ts)* | = group | = group | = group |
| `gc.retainNewestGlobal` | number | `20` | Newest sessions `omp gc` keeps unarchived globally (flag --retain-newest-global wins). *(source: cli/gc-cli.ts, commands/gc.ts)* | = group | = group | = group |
| `gc.retainNewestPerCwd` | number | `10` | Newest sessions `omp gc` keeps unarchived per cwd (flag --retain-newest-per-cwd wins). *(source: cli/gc-cli.ts, commands/gc.ts)* | = group | = group | = group |
| `gc.stale` | boolean | `false` | Opt-in stale-state phase of `omp gc` (deletes debug reports, collab replicas, stale markers); off by default. *(source comment, cli/gc-settings.ts; omp://session.md)* | = group | = group | = group |
| `gc.staleRetainNewest` | number | `20` | Newest stale-state items the stale phase keeps. *(omp://session.md; source: cli/gc-cli.ts)* | = group | = group | = group |
| `gc.staleRetainDays` | number | `30` | Age in days before stale-state items are removed by the stale phase. *(omp://session.md; source: cli/gc-cli.ts)* | = group | = group | = group |

## Seats

The `ilex` seat runs `as2` (`launch-seat`), so it is Ilex: the as2 profile, the start card, the 22 skills, and the Ilex column everywhere. It adds two extensions, `herdr-omp-agent-state.ts` and `moshi-hooks.ts` (`launch-seat` `ILEX_EXTENSIONS`), neither of which registers a slash command.

Every other seat runs `seat-bin/omp` on Jo's default profile (`~/.omp/agent`, no `OMP_PROFILE`), interactive, with `--no-title`, `--model`, `--session-dir`, `--plugin-dir`, `--hook` and `--extension` from the launcher, and an optional `--config "$OMP_SEAT_CONFIG"` overlay. Those seats do not load the card, and their dynamic command lists (skills, plugins, extensions) are Jo's default profile's, which this guide does not enumerate. Their column is therefore mostly `Jo only`: an as2 ruling such as "not for as2" does not bind a session on Jo's own profile. Whoever maintains the seat launcher can point a seat at this guide; editing `launch-seat` or Jo's default profile is outside this repo.
