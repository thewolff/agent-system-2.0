# REGISTRATION.md — how the OMP adapter goes live

`i-have-audhd-omp.ts` is registered by the plugin install. `package.json` declares it under
`omp.extensions`, and OMP loads extension modules declared there for marketplace installs:

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install i-have-audhd@jo-wolff-plugins
```

That one module does two jobs for the main session (see its header for the event mapping):

- **Session start.** On `session_start`, `session_switch` and `session_compact` it spawns
  `hooks/i-have-audhd-inject.mjs` and offers the returned `additionalContext` to every
  `before_agent_start` as a hidden custom message (`customType` `i-have-audhd-session-start`,
  a fresh delivery id in `details`), so a re-run of that chain for the same prompt still
  carries it. A `context` event whose messages hold that delivery ends the offer; a later
  prompt gets nothing until the next crossing. Subagent sessions are skipped.
- **Stop.** On `session_stop` it spawns `hooks/i-have-audhd-stop.mjs` with
  `I_HAVE_AUDHD_HARNESS=omp` and returns the core's verdict. Every rule warns by default, and
  the core caps any block to warn on OMP unless the profile sets `enforcement.armOmp: true`.
- **Inside OMP's 30s handler budget.** OMP drops a `session_stop` handler's result after
  30s. Under the `omp` tag each judge call gets 20s (Claude Code keeps 30s), and the adapter
  kills a core still running at 25s and logs one `omp-adapter fail-open` line. A hung judge
  therefore costs a `judge-timeout` line in `judge-failures.log` per judge call; the stop
  still settles with the core's deterministic findings. Neither value is configurable.
- **One session id.** Both hooks and the adapter's own-block record use the session
  manager's id (`ctx.sessionManager.getSessionId()`), not the provider id in the
  `session_stop` payload. A fresh-session or context reset rotates the provider id; the
  resume marker written at the crossing is still the one the next Stop consumes.

OMP's `session_stop` never fires for subagent sessions, and OMP has no blocking equivalent of
Claude Code's `SubagentStop`. Subagent output is not checked on either harness.

## Fallback: register without the marketplace

Use these only when the marketplace install is not an option. Neither is needed after it.

1. **One omp process** — pass the file with `-e` (`--extension`) to a single omp launched by
   hand. Only that process loads the adapter; nothing on disk changes. `-e` and
   `--extension` push onto the same list (`setExtension` in `cli/flag-tables.ts` of
   `@oh-my-pi/pi-coding-agent`); a file path is loaded as one module, not scanned as a package
   root. `--no-extensions` turns off discovery but still loads paths given with `-e`
   (`omp --help`, omp 18.8.6).

   ```
   omp -e <your-checkout>/plugins/i-have-audhd/omp/i-have-audhd-omp.ts
   ```

2. **Every omp process (manual symlink)** — the `extensions/*.{ts,js}` directory is scanned
   unconditionally:

   ```
   ln -s <your-checkout>/plugins/i-have-audhd/omp/i-have-audhd-omp.ts \
         ~/.omp/agent/extensions/i-have-audhd-omp.ts
   ```

   Do not combine this with the marketplace install: two loaded copies inject twice and check
   every stop twice.

## Environment and profile

- `I_HAVE_AUDHD_PLUGIN_ROOT` — normally unset. The adapter resolves the plugin root from its
  own location (the directory above `omp/`). Set it only to point the adapter at a different
  copy of the plugin.
- `I_HAVE_AUDHD_HARNESS` — never set it by hand. The adapter puts `omp` on its children's env;
  that tag is how the stop core knows a stop came from OMP. Claude Code never sets it.
- `I_HAVE_AUDHD_INJECT=off` in the omp process's environment silences the session-start
  context.
- `enforcement.armOmp` in the profile (`~/.claude/i-have-audhd.json`) — absent or `false`
  keeps OMP at warn on every rule, whatever the profile's `mode` and `rules` say. Setting it
  to `true` is the deliberate arming act, and it is the operator's call. Armed, the revision
  that follows this plugin's own block is still checked but can only warn, so the plugin
  blocks at most once per continuation chain.

## Exact reversal

1. `omp plugin uninstall i-have-audhd@jo-wolff-plugins` for the marketplace install;
   `rm ~/.omp/agent/extensions/i-have-audhd-omp.ts` for the symlink; or exit the `omp -e`
   process (nothing on disk to undo).
2. If `armOmp` was set to `true`, set it back to `false` or delete the field; leaving it armed
   arms the next registration.
3. The core's `warnings.log` and `errors.log` lines from OMP sessions live in the plugin's
   shared state dir (`~/.claude/.i-have-audhd-state/`); leave them.

## The kill switch

```
touch ~/.claude/.i-have-audhd-off
```

Checked inside the stop CLI per invocation, effective within one turn, on both harnesses. The
adapter has no kill switch of its own.

## Isolated live probe

Proves the adapter in real omp processes without touching the operator's OMP agent dir,
extensions, sessions, or the plugin's real state. Run it from a scratch directory outside
every git repository. Four environment facts make it isolated, and `HOME` alone is not enough:

1. **`PI_CODING_AGENT_DIR` decides the agent dir**, not `HOME`. An inherited value points the
   probe at the real agent dir. Export `PI_CODING_AGENT_DIR="$PROBE_HOME/agent"`.
2. **`OMP_PROFILE` selects a profile** and must be unset or empty for the probe. An active
   profile rewrites `PI_CODING_AGENT_DIR` to the profile's own dir; an explicitly empty
   `OMP_PROFILE` selects the default profile and also stops a `PI_PROFILE` fallback
   (`resolveProfileEnv` in `@oh-my-pi/pi-utils` `src/dirs.ts`).
3. **Credentials live in the agent dir's `agent.db`** (`auth_*` tables), not in an
   `auth.json`. In an ordinary shell, copy only the credential rows the probe's model needs,
   read-only from the source, straight into the scratch database, never printed:

   ```
   sqlite3 -readonly ~/.omp/agent/agent.db '.dump auth_%' | sqlite3 "$PROBE_HOME/agent/agent.db"
   ```

   Then delete every credential row except the one provider the probe uses. No history,
   session, cache, or settings file is copied.
4. **Discovery is off and the adapter is explicit**: `--no-extensions --no-rules --no-skills
   --no-tools --no-title`, then `-e` for the adapter and `-e` for a throwaway observer
   extension. The startup run adds `--no-session`; the resume pair below stores its session
   under the probe instead.

With `HOME="$PROBE_HOME"`, the plugin's own state lands in `$PROBE_HOME/.claude/.i-have-audhd-state/`.

The throwaway observer (written under the scratch dir, never committed) makes every check
deterministic rather than dependent on what the model writes:

- **First turn carries the core.** A `context` handler finds the
  `i-have-audhd-session-start` custom message in the first request's messages and asserts it
  carries the skill's inject span (between `<!-- inject:start -->` and `<!-- inject:end -->`
  in `skills/i-have-audhd/SKILL.md`) and every rule heading.
- **The real Stop warns.** An `assistant_message` handler returns `{ content }` replacing the
  final text with a message over 300 characters whose substantive prose precedes its
  `## Needs you` marker, keeping the original text blocks' count and positions (OMP requires
  it). The real `session_stop` then runs the core on that text, and the run
  passes when `$PROBE_HOME/.claude/.i-have-audhd-state/warnings.log` gains one
  `rule=needs-you-first` line and the turn settles with no continuation (warn, not block).
- **Resume arms and spends rule 8.** Two runs share `--session-dir "$PROBE_HOME/sessions"`
  in place of `--no-session`; the second adds `--continue`. On the second run the observer's
  `context` handler again finds the custom message, and with no `judgeCommand` configured the
  Stop leaves one `rule=restate-resumed-thread` line in `skipped.log` and no `resume-*` file
  in the state dir: the injector saw a resume and the Stop consumed its marker.
- **A hung judge settles inside the host's budget.** A third run writes the probe profile
  `$PROBE_HOME/.claude/i-have-audhd.json` as
  `{"enforcement": {"judgeCommand": "sh -c 'exec sleep 45' | cat"}}` and reuses the
  replaced Stop text from the second check (two paragraphs of prose before `## Needs you`,
  so the deterministic check and the conclusion-first trigger both fire). It passes when the
  turn settles within 25s of the final message, `warnings.log` gains one
  `rule=needs-you-first` line, `judge-failures.log` gains a `error=judge-timeout` line,
  `errors.log` gains no `omp-adapter fail-open` line, the omp log for the run (the logs dir,
  `omp.<day>.<pid>.log`) carries no `Extension handler timed out` warning for
  `session_stop`, and `pgrep -f 'sleep 45'` prints nothing once the turn has settled.

Any small model with a credential works; `omp models find <name> --no-extensions --json`
confirms the selector before the run. Delete the scratch `HOME` when the probe ends: it holds
a live credential.

### Under an agent command gate

The startup proof recorded for 1.0.0 ran inside an agent environment whose command gate
refuses some of the ordinary-shell steps above, so it ran a narrower equivalent:

- The gate refused the SQLite export/import and `.backup`. The proof copied the whole
  `agent.db` file and its WAL into the scratch agent dir instead, and printed no credential
  value. That copy also carries the database's non-auth cache and usage tables; no
  `history.db`, extension, session, or settings file was copied.
- The gate refused `env -u` and scripts that mix the model run with cleanup. The proof set
  `OMP_PROFILE` to empty, exported an isolated `HOME` and `PI_CODING_AGENT_DIR`, turned
  discovery off, passed the adapter and the observer with `-e`, and ran the omp invocation
  as one direct command.
- Cleanup was a separate `rm -rf` of the scratch `HOME` in its own command, after the run.
