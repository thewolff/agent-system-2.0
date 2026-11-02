# plugins/ — Jo's vendored plugins and their clash check

`plugins/i-have-audhd/`, `plugins/ask-graham/`, `plugins/paired-coding/` and `plugins/output-types/` are
copies of the same directories in Jo's jo-wolff-plugins repository, taken at the one pin below and then owned by this
repo, the way `skills/` is (skills/VENDOR.md). Nothing tracks upstream on its own: a re-pin is a
deliberate re-copy and re-diff. First pin: workload wl-mv8r90k9nci4qo (Jo, 2026-10-14: "add my
i-have-audhd and ask-graham plugins (jo-wolff-plugins main) to the as2 profile"). Second pin (8a820c0,
2026-10-19): workload wl-mvb9mw00ycfjeo, Jo's amendments in-mvfn25k1yesl4w and in-mvfnbo3ofundvk
(current upstream, the paired-coding plugin added, AuDHD and Graham loaded for lanes too); plan
`/Users/jowolff/agent-scratch/agent-system-2.0/wl-mvb9mw00ycfjeo/PLAN-2.md` § 2 D3 and D4. Third pin
(2481402, 2026-10-27): Jo, "I honestly would love love love all my plugins to be updated in as2", at
the merge commit of jo-wolff-plugins PR #35 (i-have-audhd 1.4.0, fail loud). This pin: Jo, 2026-10-28
("we don't need to label EVERYTHING. just the claims", then "condense all that into just being the
plugin"), at the merge commit of jo-wolff-plugins PR #36: the output-types contract slimmed to two
labels, CLAIM and CITE, i-have-audhd 1.5.0 reading only those, and the output-types plugin vendored
here for the first time as the one source of as2's contract (below). The same commit carries
ask-graham 0.7.0 (structure check) from jo-wolff-plugins PR #37, whose merge commit 175f6cb is an
ancestor of this pin and is as2 PR #388's ask-graham-only pin, with the same ask-graham bytes.

## Pin

| plugin | version | source | commit | copied | source digest |
|---|---|---|---|---|---|
| i-have-audhd | 1.5.0 | `https://github.com/thewolff/jo-wolff-plugins.git` `plugins/i-have-audhd/` | `c1c26c8d54ecba039dcc2fcdf9f7f551a0b5848a` (origin/main) | 2026-10-28 | `86b38f5553df07e754e0b7d59373c3959b8f757d2e69b18e57a98178f9a1100a` |
| ask-graham | 0.7.0 | same, `plugins/ask-graham/` | `c1c26c8d54ecba039dcc2fcdf9f7f551a0b5848a` (origin/main) | 2026-10-28 | `5f102668eda6982568c48c495c5820d2e68df110cb8f4c8bd413212d49dacd5c` |
| paired-coding | 1.4.0 | same, `plugins/paired-coding/` | `c1c26c8d54ecba039dcc2fcdf9f7f551a0b5848a` (origin/main) | 2026-10-28 | `3f5f15fb42affd939125a54a069add8c0bf7ab0c286ddd75cc1ee1adb01d67e0` |
| output-types | 0.2.0 | same, `plugins/output-types/` | `c1c26c8d54ecba039dcc2fcdf9f7f551a0b5848a` (origin/main) | 2026-10-28 | `e1bcef50e8d9b85c29ff40e7da04035895b6742ba424b5d73ee67f70ea25acbd` |

The commit is the merge commit of jo-wolff-plugins PR #36 (`gh pr view 36 -R
thewolff/jo-wolff-plugins --json mergeCommit`, merged 2026-10-28T22:09:15Z, "output-types 0.2.0,
i-have-audhd 1.5.0: label only assertions of fact"), which was also origin/main of a fresh clone of
the source URL on 2026-10-28. The versions are each plugin's `package.json` at that commit;
output-types ships no `package.json` and no OMP adapter, so its version is its
`.claude-plugin/plugin.json`. All four trees come from that one commit, archived together. Same
digests as earlier copies: i-have-audhd and output-types as PR #36's branch tip 37d100e (this
branch's first pin), ask-graham as 175f6cb (PR #37's merge commit, as2 PR #388), paired-coding as
the 2481402 pin.

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
- output-types: none

**Delta from upstream: the upstream `*.test.mjs` files are not copied.** They are node:test files
that run in jo-wolff-plugins' own CI; here `bun test` would pick them up. Every other file is
byte-identical to the pin, and no file here carries an edit. Non-test fixtures the upstream tests
import (`ask-graham/fixtures/`, `i-have-audhd/triggers/fixtures/`) and paired-coding's landlock
sources, build scripts and Linux helper binaries are kept as shipped: the recipe drops only
`*.test.mjs`, and paired-coding's `lib/landlock.mjs` runs those binaries on Linux.

**Integration delta**, all outside the vendored trees:

- `plugins/index.ts` binds the three adapters per role and session (below). output-types has no
  adapter and is not bound: as2 reads one file of it (next section).
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
git rm -rq plugins/i-have-audhd plugins/ask-graham plugins/paired-coding plugins/output-types
git -C <scratch>/jwp archive <sha> plugins/i-have-audhd plugins/ask-graham plugins/paired-coding plugins/output-types | tar -x -C .
find plugins/i-have-audhd plugins/ask-graham plugins/paired-coding plugins/output-types -name '*.test.mjs' -print   # then rm each
```

Then update the table above (versions from each `package.json`, the digest per the command above,
the executable list), the manifest rows for added or removed files (one `skill` row per SKILL.md),
re-check the clash table against the new adapters, and run `bun test plugins/test/loader.test.ts
plugins/test/paired-coding.test.ts ledger/test/install.test.ts` and `install/fresh-machine-test.sh`.

## output-types: the one source of as2's contract

as2 keeps no output-types contract of its own. Until this pin it carried `contract/output-types.md`,
an owned fork of the newdle plugin's reference that had drifted from both plugins. That copy and its
incidents supplement are gone. P-11 row 2 (`gates/src/rows/r02-contract.ts`, `CONTRACT_RELATIVE`)
and the orchestrator's base prompt (`surface/scripts/orchestrator-prompt.ts`) now read
`plugins/output-types/skills/output-types/reference.md` in place, the whole file, so every as2
session gets the public plugin's contract byte for byte. `AGENT_SYSTEM_CONTRACT` still overrides
the path.

The vendored copy rather than a pointer to Jo's marketplace install, because as2 already pins every
plugin it runs to a commit and checks its digest (above): a pointer outside the repo would make the
contract change under a running as2 whenever the marketplace updated, with no re-pin and no test.
A change to the contract is therefore a change in jo-wolff-plugins and a re-pin here, never an edit
in this repo.

as2 runs none of the plugin's own machinery: its `hooks/hooks.json` and
`hooks/output-types-inject.mjs` are Claude Code session-start hooks, and the plugin has no
`.omp-plugin` manifest, so OMP loads nothing from it. Its skill is not in `includeSkills` (the
contract is already in every system prompt). The gates read the contract's two labels (rows 1 and 3;
P-11 row 3 flags a working turn's reply carrying no CLAIM or CITE, the contract's "Parent-side"
rule, unless the reply holds only actions and proposals, which the contract leaves unlabeled).

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
plugins/output-types/skills/output-types/reference.md and tiers/orchestrator.md on 2026-10-28
(earlier checks 2026-10-14, 2026-10-19 and 2026-10-27). Anchors are file plus symbol or heading.
Changed at the c1c26c8 pin: C3 (ask-graham's stop check also accepts a declared structure check's
own two opening lines in place of a verdict line, and still blocks at most once per turn), C5 (row
1's ask is now i-have-audhd's own "Closing ask" marker), C6 (the contract's QUESTION label is gone)
and C11 (lock re-read). ask-graham 0.7.0 changes its OMP adapter only in a header comment; its nudge
text is longer (it names the structure check) but still one hidden message per `before_agent_start`
(C1 unchanged). Changed at the 2481402 pin: C2 (a dead judge is now a warn finding plus a UI alert,
and hooks run under an absolute node), C4 (config re-read), C7 (i-have-audhd now also raises UI
notices) and C11 (lock re-read). paired-coding 1.4.0 adds only an optional `proposedCode` field to
pair_propose, which no gate judges (C8, C12 unchanged).

| # | Clash | Evidence | Resolution |
|---|---|---|---|
| C1 | At intensity every-idea, ask-graham returns a hidden "should we build X?" message from every `before_agent_start`: once per direct prompt and once per dequeued batch. In a lane that is every runner prompt (first prompt and continue prompts). Jo's intensity is every-idea. | `plugins/ask-graham/omp/ask-graham-omp.ts` header "THE NUDGE" and `askGrahamOmp` (`before_agent_start`); `surface/src/launch.ts` `laneArgv` (`--mode rpc`) | **accepted, Jo's amendment (PLAN-2 D4):** ask-graham now loads in lanes, autonomous ones included, and the nudge reaches runner prompts. as2 does not lower Jo's intensity to keep the old orchestrator-only policy; `.ask-graham` in a worktree or the user config is Jo's switch. |
| C2 | i-have-audhd injects its core at each session crossing (start, switch, compact) of a top-level session and Stop-checks its replies, so a lane gets the core and its replies to the orchestrator are checked. Each check runs the core's judge when `judgeCommand` is set; Jo's `~/.claude/i-have-audhd.json` sets one, so every lane stop spends a judge call (each bounded to 20 s, warn only). Since 1.4.0 a judge that times out, exits non-zero, cannot start or answers unparseably is a "Judge unavailable" finding in the rule's own mode (all warn in Jo's config), delivered next turn like any warning, and the person also gets a UI `systemMessage` once per rule and error, then hourly. The adapter now spawns each hook under an absolute node (`I_HAVE_AUDHD_NODE`, else the first `node` on PATH, else `$HOME/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`) instead of `sh -lc node`, and with none found it fails open and raises an error notice in the UI. | `plugins/i-have-audhd/omp/i-have-audhd-omp.ts` header "DELIVERY", "TIMEOUT", "FAIL-OPEN CONTRACT", "WHICH NODE", `iHaveAudhdOmp`; `plugins/i-have-audhd/hooks/i-have-audhd-stop.mjs` header "JUDGE UNAVAILABLE"; `plugins/i-have-audhd/lib/alerts.mjs`; `~/.claude/i-have-audhd.json` `enforcement.judgeCommand` (read 2026-10-28) | **accepted, Jo's amendment (PLAN-2 D4).** Subagent sessions are skipped twice: the adapter's own `agent.kind === "sub"` check and the loader's session gate. A rpc lane has no UI, so its alerts stay unspent (adapter `createAlarm`); the orchestrator shows them. |
| C3 | Order of `session_stop` results, and of `tool_call` verdicts. The surface's wake, gates rows 1, 3 and 7 return stop blocks; ask-graham can block a stop once per turn that read its skill without a verdict line (or, for a turn that read its `structure-check.md`, without the `**Structure check:**` and `**Found:**`/`**No similar:**` opening lines); paired-coding refuses tools while pairing. OMP returns the first stop block and stops at the first tool_call block. | OMP `extensibility/extensions/runner.ts` (`emit`: session_stop `if (stopResult.decision === "block") return`; `emitToolCall`); `surface/extensions/wake.ts`, `gates/extensions/r01-turn-shape.ts`, `r03-receipts.ts`, `r07-wake-read.ts`; ask-graham header "THE STOP CHECK" | **resolved:** `plugins/index.ts` loads last, so as2's stop blocks and tool_call refusals are seen first. Unarmed, i-have-audhd never blocks on OMP: the core caps every rule to warn. An ask-graham block continues a turn once, after as2's checks passed. |
| C4 | Arming. `enforcement.armOmp: true` in `~/.claude/i-have-audhd.json` lets i-have-audhd block on OMP. That file is shared by every harness, so arming it for another profile also arms the orchestrator and now every lane. An armed block after row 1 passed would continue a turn. | `plugins/i-have-audhd/omp/i-have-audhd-omp.ts` header "WARN UNLESS ARMED"; `plugins/i-have-audhd/lib/config.mjs` (`armOmp`) | **raised to Jo** as a plan tradeoff, approved 2026-10-14, and kept by PLAN-2 D4: arming stays Jo's switch, and as2 neither sets nor overrides it. The file exists now and does not set `armOmp` (read 2026-10-28), so the plugin is unarmed. |
| C5 | Overlap with as2's message shape. The i-have-audhd core (Needs you first, body, closing ask last, at most two open decisions, commands only when you can't run them) restates voice/VOICE.md and what gates row 1 enforces. Row 1 reads the same "Closing ask" marker i-have-audhd's closing-ask-last check reads, with one difference: i-have-audhd says nothing follows the closing ask, while VOICE.md puts the count line after it as a footer. | `plugins/i-have-audhd/skills/i-have-audhd/SKILL.md` inject span ("When present, it comes last and nothing follows it"); `plugins/i-have-audhd/checks/closing-ask-last.mjs` (marker "Closing ask"); `voice/VOICE.md` "Message skeleton, same shape every turn" (count line as a footer); `gates/src/rows/r01-turn-shape.ts` `CLOSING_ASK` (count-line footer exemption) | **resolved, as2 wins on the footer:** the order and the marker match. Where they differ, the as2 rule wins: the count-line footer after the closing ask. The tier files and the contract sit in the system prompt, row 1 refuses a malformed turn whatever the inject says, and the plugin's Stop checks only warn. |
| C6 | The output-types contract once carried a QUESTION label that went at the top of a report, while i-have-audhd puts the choice last. | `plugins/output-types/skills/output-types/reference.md` § What stays unlabeled, and what it still owes ("Decisions for a person go last … A blocker … goes at the top"); i-have-audhd inject span "What the user must *know* goes first; what they must *choose* goes last" | **resolved, no longer a clash:** the contract has no QUESTION label at this pin and states the same split: a blocker (to know) at the top, a decision (to choose) last, which is voice/VOICE.md's "One closing ask per message, and it goes last". |
| C7 | Hidden messages against the surface's typed-input FIFO and the `input` handlers of gates rows 1 and 11. ask-graham and i-have-audhd return custom messages from `before_agent_start`; i-have-audhd queues a warning with `sendMessage` `deliverAs: "nextTurn"`, and since 1.4.0 also calls `ctx.ui.notify` for its failure alarms and the stop core's `systemMessage` (UI sessions only); paired-coding's `input` handler records the typed text and ends pairing on an exact `pair stop`. | `surface/extensions/surface-input.ts` (`input` handler; `before_agent_start` matches `event.prompt`); `gates/extensions/r11-jo-instruction.ts` `onInput(text, source)`; `plugins/paired-coding/omp/paired-coding-omp.ts` (`input` handler); `plugins/i-have-audhd/omp/i-have-audhd-omp.ts` `createAlarm`, `safeNotify` | **resolved:** no adapter raises an `input` event or revises the prompt text (each handler returns nothing from `input`, a `before_agent_start` message is added beside the prompt, and a `notify` call sends no prompt), so the FIFO match and rows 1 and 11 see Jo's words unchanged. |
| C8 | paired-coding has a `tool_call` handler. While pairing it refuses the host's write, edit, bash, eval and task tools and every tool not on its allowlist, as2's ledger and lifecycle tools included; outside pairing it allows everything. | `plugins/paired-coding/core/gate.mjs` `toolVerdict` ("anything unknown is refused"; `opts.allow`); `plugins/paired-coding/omp/paired-coding-omp.ts` (`tool_call` handler passes no `allow`) | **resolved (PLAN-2 D5):** `plugins/paired-as2.ts` asks the core's verdict with the exact names in `PAIR_LIFECYCLE_TOOLS` (`gates/src/pair-call.ts`) as `allow`, so a pairing lane keeps its lane tools, `slice_artifact` and `ledger_wake_read`, each with its own as2 checks. No prefix, dispatch, eval or host-mutation name is allowed (the core never re-allows those), and any other tool stays refused while pairing. i-have-audhd and ask-graham have no `tool_call` or `task` handler. `gates/test/paired-coding.test.ts`. |
| C9 | The inject tells the model to "Load the full `i-have-audhd` skill", and paired-coding's tools point at its skill; the as2 skill allowlist would hide them. | `profile/config.yml` `skills.includeSkills` | **resolved:** all three plugin skills are listed and load from their plugin dirs. |
| C10 | Installer and discovery invariant: each includeSkills name must resolve under exactly one listed customDirectory, and discovery must find each skill at its manifest row's file. | `install/install.sh` § 2b (profile render); `install/fresh-machine-test.sh` step 3c (skill listing) | **resolved:** the render maps each `skill` row to its own dir and requires that dir to be listed. fresh-machine-test compares each discovered skill's file with its manifest row. |
| C11 | Marketplace copies Jo installed (`omp plugin install`; `~/.omp/plugins/omp-plugins.lock.json` enables i-have-audhd 1.4.0, ask-graham 0.7.0 and paired-coding 1.4.0, read 2026-10-28) live in OMP's root-level plugin dir and would load into every as2 session, hands included, beside `plugins/index.ts`. | pi-utils `dirs.ts` `getPluginsDir` (`rootSubdir("plugins")`); OMP `extensibility/extensions/loader.ts` `discoverExtensionPaths` (`isDisabledName`) | **resolved:** profile/config.yml `disabledExtensions` lists all three adapters' `extension-module:` names; configured paths are never filtered by it. plugins/test/loader.test.ts and install/fresh-machine-test.sh step 3c seed installed copies of all three plus a control plugin and check that only the control and `plugins/index.ts` load. |
| C12 | pair_write, pair_edit and pair_run write and run directly inside their tools, not as host write, edit or bash calls, so the gates' tool_call checks keyed on those names (reserved targets, protected paths, fence, artifact observers) never see them. | `plugins/paired-coding/omp/paired-coding-omp.ts` (registerTool `execute` → `executeVerb`); `gates/src/gates.ts`, `gates/src/targets.ts` | **resolved (PLAN-2 D5):** `gates/src/pair-call.ts` judges pair_write, pair_edit and pair_run as the write, edit and bash at the pairing root they execute as, in rows 3, 6, 8, 9, 10 and 18, the row composition and the lane's artifact observers; it authorizes a call every row allowed, and `plugins/paired-as2.ts` runs only that call with those arguments. pair_run runs under one Seatbelt profile that also carries the fence's deny targets (no nested sandbox-exec), refuses a scratch-only exemption, and follows the clean-shell rule for the env its `/bin/sh` gets. A pair_run's real exit feeds the artifact outcomes and tree. `gates/test/paired-coding.test.ts`. |
| C13 | A hand inherits the parent's `AGENT_SYSTEM_ROLE` and `AGENT_SYSTEM_BY_HAND`, because OMP re-binds the parent's prepared extension factories into the child session, so a role check alone would load all three adapters into a by-hand lane's hands. paired-coding registers its eight tools inside its factory. | OMP `src/task/executor.ts` and `src/sdk.ts` (`preloadedPreparedExtensions` → `bindPreparedExtensions`); `plugins/paired-coding/omp/paired-coding-omp.ts` (registerTool loop) | **resolved:** `plugins/index.ts` gates every adapter on the session it is bound to and holds tool registration until that session is enabled (How the profile loads them). plugins/test/loader.test.ts binds the parent's prepared factory into a persisted child and a headerless child and sees no adapter callback and no pair_* tool. |
