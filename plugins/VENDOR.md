# plugins/ — Jo's vendored plugins and their clash check

`plugins/i-have-audhd/`, `plugins/ask-graham/` and `plugins/paired-coding/` are copies of the same
directories in Jo's jo-wolff-plugins repository, taken at the one pin below and then owned by this
repo, the way `skills/` is (skills/VENDOR.md). Nothing tracks upstream on its own: a re-pin is a
deliberate re-copy and re-diff. First pin: workload wl-mv8r90k9nci4qo (Jo, 2026-10-14: "add my
i-have-audhd and ask-graham plugins (jo-wolff-plugins main) to the as2 profile"). This pin: workload
wl-mvb9mw00ycfjeo, Jo's amendments in-mvfn25k1yesl4w and in-mvfnbo3ofundvk (current upstream, the
paired-coding plugin added, AuDHD and Graham loaded for lanes too); plan
`/Users/jowolff/agent-scratch/agent-system-2.0/wl-mvb9mw00ycfjeo/PLAN-2.md` § 2 D3 and D4.

## Pin

| plugin | version | source | commit | copied | source digest |
|---|---|---|---|---|---|
| i-have-audhd | 1.3.0 | `https://github.com/thewolff/jo-wolff-plugins.git` `plugins/i-have-audhd/` | `8a820c0f91e22e34248980822d7e57bffd0a06da` (origin/main) | 2026-10-19 | `e3003fe4f547ff99412fffeb476259a6b724d26934fbe804f6c629214223cfd4` |
| ask-graham | 0.5.0 | same, `plugins/ask-graham/` | `8a820c0f91e22e34248980822d7e57bffd0a06da` (origin/main) | 2026-10-19 | `f5c50845c69532eb32904eba754325d6ae4d77d26f22c26deb59e212ba380575` |
| paired-coding | 1.3.2 | same, `plugins/paired-coding/` | `8a820c0f91e22e34248980822d7e57bffd0a06da` (origin/main) | 2026-10-19 | `146220813cf4a937d42974ab3b6a3c1d1a3891eb1c12c1e7522fc876abcef287` |

The commit is origin/main of a fresh clone of the source URL on 2026-10-19 (commit date
2026-10-15, "ask-graham 0.5.0: apply review"). The versions are each plugin's `package.json` at that
commit. All three trees come from that one commit, archived together.

**Source digest**, per plugin, taken right after the copy and before any local edit, from the repo
root (each `.test.mjs` already removed):

```
(cd plugins/<p> && find . -type f ! -name '*.test.mjs' | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256)
```

It covers file contents and paths, not modes. plugins/test/paired-coding.test.ts recomputes it and
checks the versions, the single commit and the executable files below, so a vendored file edited in
place fails there. Executable at the pin (mode 100755 upstream, kept by the archive):

- i-have-audhd: `checks/closing-ask-last.mjs`, `checks/name-the-artifact.mjs`, `checks/needs-you-first.mjs`, `checks/plural-back-reference.mjs`, `hooks/i-have-audhd-inject.mjs`, `hooks/i-have-audhd-prompt.mjs`, `hooks/i-have-audhd-stop.mjs`, `tools/setup.mjs`, `tools/upgrade-from-communication-rules.mjs`
- ask-graham: `hooks/ask-graham-hook.mjs`, `hooks/ask-graham-stop.mjs`, `skills/ask-graham/scripts/intensity.mjs`
- paired-coding: `hooks/paired-coding-hook.mjs`, `landlock/bin/pair-landlock-aarch64-linux`, `landlock/bin/pair-landlock-x86_64-linux`, `landlock/build.sh`, `landlock/test/docker.sh`, `landlock/test/live.sh`, `server/pair-server.mjs`

**Delta from upstream: the upstream `*.test.mjs` files are not copied.** They are node:test files
that run in jo-wolff-plugins' own CI; here `bun test` would pick them up. Every other file is
byte-identical to the pin, and no file here carries an edit. Non-test fixtures the upstream tests
import (`ask-graham/fixtures/`, `i-have-audhd/triggers/fixtures/`) and paired-coding's landlock
sources, build scripts and Linux helper binaries are kept as shipped: the recipe drops only
`*.test.mjs`, and paired-coding's `lib/landlock.mjs` runs those binaries on Linux.

**Integration delta**, all outside the vendored trees:

- `plugins/index.ts` binds the three adapters per role and session (below).
- `plugins/paired-as2.ts` is as2's one seam to the paired adapter: `bindPairedCoding(pi, { env })`
  binds it through the two inputs the adapter already takes, its `pi` and its `execute` (AdapterDeps),
  and carries the P-11 bridge of PLAN-2 D5 with `gates/src/pair-call.ts` (C8 and C12 below). No
  vendored file is changed for it, so the source digest above stays the upstream one.
  - The adapter's `tool_call` handler is wrapped: for an exact name in `PAIR_LIFECYCLE_TOOLS`
    (`gates/src/pair-call.ts`: the lane tools, `slice_artifact`, `ledger_wake_read`) the core's
    `verdict` is asked with that list as `allow`; every other name reaches the adapter's handler
    unchanged.
  - `execute` is executeVerb behind the bridge: pair_start adds the M4b fence's subpath deny targets
    to `protect`; pair_write, pair_edit and pair_run run only with the authorization the gates gave
    their tool call id, with the arguments and pairing root it was judged at; pair_run is also
    refused when a fence target of its command would be writable under the pairing profile, or,
    where the clean shell is on, when the env its `/bin/sh` starts with carries a start hook.

**Re-pin**, from the repo root, in a writable clone (never the marketplace cache's HEAD):

```
git clone https://github.com/thewolff/jo-wolff-plugins.git <scratch>/jwp
git -C <scratch>/jwp log -1 --format=%H origin/main         # the <sha> to pin
git rm -rq plugins/i-have-audhd plugins/ask-graham plugins/paired-coding
git -C <scratch>/jwp archive <sha> plugins/i-have-audhd plugins/ask-graham plugins/paired-coding | tar -x -C .
find plugins/i-have-audhd plugins/ask-graham plugins/paired-coding -name '*.test.mjs' -print   # then rm each
```

Then update the table above (versions from each `package.json`, the digest per the command above,
the executable list), the manifest rows for added or removed files (one `skill` row per SKILL.md),
re-check the clash table against the new adapters, and run `bun test plugins/test/loader.test.ts
plugins/test/paired-coding.test.ts ledger/test/install.test.ts` and `install/fresh-machine-test.sh`.

## How the profile loads them

- **Adapters.** `plugins/index.ts` is the one `extensions:` entry for them in profile/config.yml,
  last in the list. Who runs what (PLAN-2 D4):

  | session | i-have-audhd | ask-graham | paired-coding |
  |---|---|---|---|
  | orchestrator (`AGENT_SYSTEM_ROLE=orchestrator`, bin/as2) | yes | yes | no |
  | autonomous lane (`AGENT_SYSTEM_ROLE=lane`) | yes | yes | no |
  | by-hand lane (`AGENT_SYSTEM_ROLE=lane`, `AGENT_SYSTEM_BY_HAND=1`, `as2 lane`) | yes | yes | yes |
  | hand (any subagent), or no role | no | no | no |

  Paired-coding needs a person: agreement to a card and the typed `pair stop` come only from the
  interactive editor's `input` (omp/REGISTRATION.md), which an rpc lane does not have, and the
  orchestrator does not implement changes. Loading never calls pair_start.

  Hands are found by session context, not environment: OMP re-binds the parent's prepared
  factories into a subagent with the parent's env still set, and a factory gets no session context.
  So each adapter is bound inert: its handlers are trampolines that run only once the loader's own
  session_start handler, registered first, has classified the session as not a child
  (`ctx.agent.kind === "sub"`, or no UI and a header `parentSession`, the gates' test in
  gates/src/session.ts). Its registerTool and other register* calls are held and replayed once, at
  that first enabling session_start; OMP installs tools registered from session_start into the live
  registry. A repeated session_start replays nothing and appends no handler.

  Each adapter finds its own files from its location (`omp/..`), so the vendored trees need no
  path edits.
- **Skills.** The plugin skills load in place: `skills.customDirectories` is `<repo>/skills`,
  `<repo>/plugins/ask-graham/skills`, `<repo>/plugins/i-have-audhd/skills` and
  `<repo>/plugins/paired-coding/skills`, and `includeSkills` names `ask-graham`, `i-have-audhd` and
  `paired-coding` beside the 22 in skills/. install/install.sh accepts a `skill` row at
  `plugins/<p>/skills/<n>/SKILL.md`, and refuses a render whose customDirectories is not
  `<repo>/skills` followed by each plugin skills dir that holds a `skill` row (sorted), or where
  two skill rows share a name.
- **Not the marketplace copies.** Marketplace registries are per profile
  (`OMP_PROFILE=agent-system-2 omp plugin marketplace list` printed "No marketplaces configured" on
  2026-10-14), but installed plugins are not: `omp plugin install` puts them in OMP's root plugin
  dir, `~/.omp/plugins`, which every profile loads from (pi-utils `dirs.ts` `getPluginsDir`).
  profile/config.yml's `disabledExtensions` therefore names `extension-module:i-have-audhd-omp`,
  `extension-module:ask-graham-omp` and `extension-module:paired-coding-omp`, so as2 sessions run
  only this pinned copy, through `plugins/index.ts` (clash C11). A marketplace update of these
  plugins does not reach as2: re-pin here instead. Two loaded copies would inject twice, check every
  stop twice, and run two pairing gates (plugins/i-have-audhd/omp/REGISTRATION.md, "Do not combine
  this with the marketplace install"; paired-coding's "one write gate per session").
- **State and settings stay Jo's.** i-have-audhd reads `~/.claude/i-have-audhd.json` and writes
  `~/.claude/.i-have-audhd-state/`. ask-graham reads `.ask-graham` in the working directory or
  any directory above it, then `${XDG_CONFIG_HOME:-~/.config}/ask-graham/config`. paired-coding keeps
  each session's pairing state under `${PAIRED_CODING_STATE_DIR:-~/.local/state/paired-coding}` and
  refuses a state dir inside the worktree. All are shared with Jo's other harnesses, and as2 writes
  none of their settings.

## Clash check

Re-checked against the adapters at the pin above, surface/, gates/, classifier/, voice/VOICE.md,
contract/output-types.md and tiers/orchestrator.md on 2026-10-19 (first check 2026-10-14). Anchors
are file plus symbol or heading.

| # | Clash | Evidence | Resolution |
|---|---|---|---|
| C1 | At intensity every-idea, ask-graham returns a hidden "should we build X?" message from every `before_agent_start`: once per direct prompt and once per dequeued batch. In a lane that is every runner prompt (first prompt and continue prompts). Jo's intensity is every-idea. | `plugins/ask-graham/omp/ask-graham-omp.ts` header "THE NUDGE" and `askGrahamOmp` (`before_agent_start`); `surface/src/launch.ts` `laneArgv` (`--mode rpc`) | **accepted, Jo's amendment (PLAN-2 D4):** ask-graham now loads in lanes, autonomous ones included, and the nudge reaches runner prompts. as2 does not lower Jo's intensity to keep the old orchestrator-only policy; `.ask-graham` in a worktree or the user config is Jo's switch. |
| C2 | i-have-audhd injects its core at each session crossing (start, switch, compact) of a top-level session and Stop-checks its replies, so a lane gets the core and its replies to the orchestrator are checked. Each check runs the core's judge when `judgeCommand` is set; Jo's `~/.claude/i-have-audhd.json` sets one, so every lane stop spends a judge call (each bounded to 20 s, warn only). | `plugins/i-have-audhd/omp/i-have-audhd-omp.ts` header "DELIVERY", "TIMEOUT", `iHaveAudhdOmp`; `~/.claude/i-have-audhd.json` `enforcement.judgeCommand` (read 2026-10-19) | **accepted, Jo's amendment (PLAN-2 D4).** Subagent sessions are skipped twice: the adapter's own `agent.kind === "sub"` check and the loader's session gate. |
| C3 | Order of `session_stop` results, and of `tool_call` verdicts. The surface's wake, gates rows 1, 3 and 7 return stop blocks; ask-graham can block a stop once per turn that read its skill without a verdict line; paired-coding refuses tools while pairing. OMP returns the first stop block and stops at the first tool_call block. | OMP `extensibility/extensions/runner.ts` (`emit`: session_stop `if (stopResult.decision === "block") return`; `emitToolCall`); `surface/extensions/wake.ts`, `gates/extensions/r01-turn-shape.ts`, `r03-receipts.ts`, `r07-wake-read.ts`; ask-graham header "THE STOP CHECK" | **resolved:** `plugins/index.ts` loads last, so as2's stop blocks and tool_call refusals are seen first. Unarmed, i-have-audhd never blocks on OMP: the core caps every rule to warn. An ask-graham block continues a turn once, after as2's checks passed. |
| C4 | Arming. `enforcement.armOmp: true` in `~/.claude/i-have-audhd.json` lets i-have-audhd block on OMP. That file is shared by every harness, so arming it for another profile also arms the orchestrator and now every lane. An armed block after row 1 passed would continue a turn. | `plugins/i-have-audhd/omp/i-have-audhd-omp.ts` header "WARN UNLESS ARMED"; `plugins/i-have-audhd/lib/config.mjs` (`armOmp`) | **raised to Jo** as a plan tradeoff, approved 2026-10-14, and kept by PLAN-2 D4: arming stays Jo's switch, and as2 neither sets nor overrides it. The file exists now and does not set `armOmp` (read 2026-10-19), so the plugin is unarmed. |
| C5 | Overlap with as2's message shape. The i-have-audhd core (Needs you first, body, closing ask last, at most two open decisions, commands only when you can't run them) restates voice/VOICE.md and what gates row 1 enforces, with two differences: its "Closing ask" heading is not row 1's single **QUESTION** block, and it says nothing follows the closing ask, while VOICE.md puts the count line after it as a footer. | `plugins/i-have-audhd/skills/i-have-audhd/SKILL.md` inject span ("When present, it comes last and nothing follows it"); `voice/VOICE.md` "Message skeleton, same shape every turn" (count line as a footer); `gates/src/rows/r01-turn-shape.ts` (count-line footer exemption) | **resolved, as2 wins:** the order matches otherwise. Where they differ, the as2 rules win: the **QUESTION** block name and the count-line footer after it. The tier files and the contract sit in the system prompt, row 1 refuses a malformed turn whatever the inject says, and the plugin's Stop checks only warn. |
| C6 | The output-types contract puts a QUESTION at the top of a report, while i-have-audhd puts the choice last. | `contract/output-types.md` § The receipt rule (QUESTION row); inject span "What the user must *know* goes first; what they must *choose* goes last" | **resolved, already settled:** voice/VOICE.md "One closing ask per message, and it goes last" puts the blocker (to know) at the top and the closing ask (to choose) last, which is the split i-have-audhd uses. |
| C7 | Hidden messages against the surface's typed-input FIFO and the `input` handlers of gates rows 1 and 11. ask-graham and i-have-audhd return custom messages from `before_agent_start`; i-have-audhd queues a warning with `sendMessage` `deliverAs: "nextTurn"`; paired-coding's `input` handler records the typed text and ends pairing on an exact `pair stop`. | `surface/extensions/surface-input.ts` (`input` handler; `before_agent_start` matches `event.prompt`); `gates/extensions/r11-jo-instruction.ts` `onInput(text, source)`; `plugins/paired-coding/omp/paired-coding-omp.ts` (`input` handler) | **resolved:** no adapter raises an `input` event or revises the prompt text (each handler returns nothing from `input`, and a `before_agent_start` message is added beside the prompt), so the FIFO match and rows 1 and 11 see Jo's words unchanged. |
| C8 | paired-coding has a `tool_call` handler. While pairing it refuses the host's write, edit, bash, eval and task tools and every tool not on its allowlist, as2's ledger and lifecycle tools included; outside pairing it allows everything. | `plugins/paired-coding/core/gate.mjs` `toolVerdict` ("anything unknown is refused"; `opts.allow`); `plugins/paired-coding/omp/paired-coding-omp.ts` (`tool_call` handler passes no `allow`) | **resolved (PLAN-2 D5):** `plugins/paired-as2.ts` asks the core's verdict with the exact names in `PAIR_LIFECYCLE_TOOLS` (`gates/src/pair-call.ts`) as `allow`, so a pairing lane keeps its lane tools, `slice_artifact` and `ledger_wake_read`, each with its own as2 checks. No prefix, dispatch, eval or host-mutation name is allowed (the core never re-allows those), and any other tool stays refused while pairing. i-have-audhd and ask-graham have no `tool_call` or `task` handler. `gates/test/paired-coding.test.ts`. |
| C9 | The inject tells the model to "Load the full `i-have-audhd` skill", and paired-coding's tools point at its skill; the as2 skill allowlist would hide them. | `profile/config.yml` `skills.includeSkills` | **resolved:** all three plugin skills are listed and load from their plugin dirs. |
| C10 | Installer and discovery invariant: each includeSkills name must resolve under exactly one listed customDirectory, and discovery must find each skill at its manifest row's file. | `install/install.sh` § 2b (profile render); `install/fresh-machine-test.sh` step 3c (skill listing) | **resolved:** the render maps each `skill` row to its own dir and requires that dir to be listed. fresh-machine-test compares each discovered skill's file with its manifest row. |
| C11 | Marketplace copies Jo installed (`omp plugin install`; paired-coding 1.3.2 is enabled in `~/.omp/plugins/omp-plugins.lock.json`) live in OMP's root-level plugin dir and would load into every as2 session, hands included, beside `plugins/index.ts`. | pi-utils `dirs.ts` `getPluginsDir` (`rootSubdir("plugins")`); OMP `extensibility/extensions/loader.ts` `discoverExtensionPaths` (`isDisabledName`) | **resolved:** profile/config.yml `disabledExtensions` lists all three adapters' `extension-module:` names; configured paths are never filtered by it. plugins/test/loader.test.ts and install/fresh-machine-test.sh step 3c seed installed copies of all three plus a control plugin and check that only the control and `plugins/index.ts` load. |
| C12 | pair_write, pair_edit and pair_run write and run directly inside their tools, not as host write, edit or bash calls, so the gates' tool_call checks keyed on those names (reserved targets, protected paths, fence, artifact observers) never see them. | `plugins/paired-coding/omp/paired-coding-omp.ts` (registerTool `execute` → `executeVerb`); `gates/src/gates.ts`, `gates/src/targets.ts` | **resolved (PLAN-2 D5):** `gates/src/pair-call.ts` judges pair_write, pair_edit and pair_run as the write, edit and bash at the pairing root they execute as, in rows 3, 6, 8, 9, 10 and 18, the row composition and the lane's artifact observers; it authorizes a call every row allowed, and `plugins/paired-as2.ts` runs only that call with those arguments. pair_run runs under one Seatbelt profile that also carries the fence's deny targets (no nested sandbox-exec), refuses a scratch-only exemption, and follows the clean-shell rule for the env its `/bin/sh` gets. A pair_run's real exit feeds the artifact outcomes and tree. `gates/test/paired-coding.test.ts`. |
| C13 | A hand inherits the parent's `AGENT_SYSTEM_ROLE` and `AGENT_SYSTEM_BY_HAND`, because OMP re-binds the parent's prepared extension factories into the child session, so a role check alone would load all three adapters into a by-hand lane's hands. paired-coding registers its eight tools inside its factory. | OMP `src/task/executor.ts` and `src/sdk.ts` (`preloadedPreparedExtensions` → `bindPreparedExtensions`); `plugins/paired-coding/omp/paired-coding-omp.ts` (registerTool loop) | **resolved:** `plugins/index.ts` gates every adapter on the session it is bound to and holds tool registration until that session is enabled (How the profile loads them). plugins/test/loader.test.ts binds the parent's prepared factory into a persisted child and a headerless child and sees no adapter callback and no pair_* tool. |
