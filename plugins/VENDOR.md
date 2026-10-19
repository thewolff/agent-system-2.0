# plugins/ — Jo's vendored plugins and their clash check

`plugins/i-have-audhd/`, `plugins/ask-graham/` and `plugins/reminders-review/` are copies of the same directories in Jo's
jo-wolff-plugins repository, taken at the pin below and then owned by this repo, the way `skills/`
is (skills/VENDOR.md). Nothing tracks upstream on its own: a re-pin is a deliberate re-copy and
re-diff. Workload wl-mv8r90k9nci4qo (Jo, 2026-10-14: "add my i-have-audhd and ask-graham plugins
(jo-wolff-plugins main) to the as2 profile"); plan
`/Users/jowolff/agent-scratch/agent-system-2.0/wl-mv8r90k9nci4qo/PLAN.md`.

## Pin

| plugin | version | source | commit | copied |
|---|---|---|---|---|
| i-have-audhd | 1.3.0 | `git@github.com:thewolff/jo-wolff-plugins.git` `plugins/i-have-audhd/` | `8a820c0f91e22e34248980822d7e57bffd0a06da` (main as of 2026-10-15) | 2026-10-15 |
| ask-graham | 0.5.0 | same, `plugins/ask-graham/` | same | 2026-10-15 |
| reminders-review | 0.1.0 | same, `plugins/reminders-review/` | same | 2026-10-15 |

Re-pinned 2026-10-15 from `c923617` (i-have-audhd 1.2.0, ask-graham 0.3.0), at Jo's request.
The orchestrator gains ask-graham's optional comparables research and `stop-check=off` setting,
i-have-audhd's judge setup command and one-time missing-judge notice, and reminders-review for
reviewing chosen Apple Reminders lists one reminder at a time.

**Runtime prerequisite:** reminders-review requires macOS, the `remindctl` CLI and Reminders
access (`remindctl status` must report `Full access`). as2 does not install remindctl or grant
that access. The skill checks status before a review and explains installation or authorization
when needed. Saved lists live in `${XDG_CONFIG_HOME:-$HOME/.config}/reminders-review/config.json`;
as2 does not write that config. i-have-audhd's optional judge setup is upstream's
`node plugins/i-have-audhd/tools/setup.mjs`; as2 does not run it or change Jo's shared settings.

**Delta from upstream: the upstream `*.test.mjs` files are not copied.** They are node:test files
that run in jo-wolff-plugins' own CI; here `bun test` would pick them up. The test-only fixtures
they import (`plugins/ask-graham/fixtures/`, `plugins/i-have-audhd/triggers/fixtures/`) are copied
like every other file, with `test` manifest rows. Every other file is byte-identical to the pin, and
no file here carries an edit.

**Re-pin**, from the repo root:

```
git -C <jo-wolff-plugins checkout> fetch origin
rm -rf plugins/i-have-audhd plugins/ask-graham plugins/reminders-review
git -C <jo-wolff-plugins checkout> archive <sha> plugins/i-have-audhd plugins/ask-graham plugins/reminders-review | tar -x -C .
find plugins/i-have-audhd plugins/ask-graham plugins/reminders-review -name '*.test.mjs' -delete
```

Then update the table above, the manifest rows for added or removed files, re-check the clash table
against the new adapters, and run `bun test plugins/test/loader.test.ts ledger/test/install.test.ts`
and `install/fresh-machine-test.sh`.

## How the profile loads them

- **Adapters.** `plugins/index.ts` is the one `extensions:` entry in profile/config.yml, last in
  the list. It calls the two OMP adapters (`plugins/i-have-audhd/omp/i-have-audhd-omp.ts`,
  `plugins/ask-graham/omp/ask-graham-omp.ts`) only when `AGENT_SYSTEM_ROLE=orchestrator`. That
  is Jo's `as2` session. Lanes (`AGENT_SYSTEM_ROLE=lane`) and hands (no role) load nothing from it.
  reminders-review is skill-only: it has no hooks or OMP adapter and adds no extension.
  Each adapter finds its own files from its location (`omp/..`), so the vendored trees need no
  path edits.
- **Skills.** The plugin skills load in place: `skills.customDirectories` is `<repo>/skills`,
  `<repo>/plugins/ask-graham/skills`, `<repo>/plugins/i-have-audhd/skills` and
  `<repo>/plugins/reminders-review/skills`, and `includeSkills` names `ask-graham`, `i-have-audhd`
  and `reminders-review` beside the 22 in skills/. install/install.sh accepts a
  `skill` row at `plugins/<p>/skills/<n>/SKILL.md`, and refuses a render whose customDirectories
  is not `<repo>/skills` followed by each plugin skills dir that holds a `skill` row, or where two
  skill rows share a name.
- **Not the marketplace copies.** Marketplace registries are per profile
  (`OMP_PROFILE=agent-system-2 omp plugin marketplace list` printed "No marketplaces configured" on
  2026-10-14), but installed plugins are not: `omp plugin install` puts them in OMP's root plugin
  dir, `~/.omp/plugins`, which every profile loads from (pi-utils `dirs.ts` `getPluginsDir`). The
  install smoke on 2026-10-14 showed the agent-system-2 profile loading
  `~/.omp/plugins/node_modules/i-have-audhd/omp/i-have-audhd-omp.ts` and `…/ask-graham/omp/ask-graham-omp.ts`
  before surface/. profile/config.yml's `disabledExtensions` therefore names
  `extension-module:i-have-audhd-omp` and `extension-module:ask-graham-omp`, so as2 sessions run only
  this pinned copy, through `plugins/index.ts` (clash C11). A marketplace update of those two
  plugins does not reach as2: re-pin here instead. Two loaded copies would inject twice and check
  every stop twice (plugins/i-have-audhd/omp/REGISTRATION.md, "Do not combine this with the
  marketplace install").
- **State and settings stay Jo's.** i-have-audhd reads `~/.claude/i-have-audhd.json` and writes
  `~/.claude/.i-have-audhd-state/`. ask-graham reads `.ask-graham` in the working directory or
  any directory above it, then `${XDG_CONFIG_HOME:-~/.config}/ask-graham/config`. All are shared
  with Jo's other harnesses, and as2 writes none of them.

## Clash check

Checked against surface/, gates/, classifier/, voice/VOICE.md, contract/output-types.md and
tiers/orchestrator.md on 2026-10-14, and re-checked against the 8a820c0 adapters on 2026-10-15 (C3, C12 updated; C13 added). Anchors are file plus symbol or heading.

| # | Clash | Evidence | Resolution |
|---|---|---|---|
| C1 | At intensity every-idea, ask-graham nudges every agent start: its `before_agent_start` handler fires once per direct prompt and once per dequeued batch of user messages, rpc prompts included (0.2.0 did the same on `input`). Lanes run as `omp --mode rpc`, so every lane runner prompt (first prompt and continue prompts) would get a "should we build X?" nudge. Jo's intensity is every-idea. | `plugins/ask-graham/omp/ask-graham-omp.ts` `askGrahamOmp` (`before_agent_start` handler); `surface/src/launch.ts` `laneArgv` (`--mode rpc`) | **resolved:** `plugins/index.ts` loads the adapters only in the orchestrator session. |
| C2 | i-have-audhd skips only subagent sessions, so a lane (a top-level session) would get the AuDHD core injected and have its replies to the orchestrator Stop-checked. | `plugins/i-have-audhd/omp/i-have-audhd-omp.ts` `sessionStartHandler` (`agent.kind === "sub"`) | **resolved:** the same role gate. |
| C3 | Order of `session_stop` results. The surface's wake (wake-read owed), gates rows 1, 3 and 7 all return blocks on the orchestrator, and OMP returns the first block. | OMP `extensibility/extensions/runner.ts` (session_stop: `if (stopResult.decision === "block") return`); `surface/extensions/wake.ts` and `gates/extensions/r01-turn-shape.ts`, `r03-receipts.ts`, `r07-wake-read.ts` `session_stop` handlers | **resolved:** `plugins/index.ts` loads last, so as2's blocks are seen first. Unarmed, i-have-audhd never blocks on OMP: the core caps every rule to warn. ask-graham 0.5.0 does block, once per turn (C12). |
| C4 | Arming. `enforcement.armOmp: true` in `~/.claude/i-have-audhd.json` lets i-have-audhd block on OMP. That file is shared by every harness, so arming it for another profile also arms the orchestrator. An armed block after row 1 passed would continue an orchestrator turn. | `plugins/i-have-audhd/omp/REGISTRATION.md` § Environment and profile | **raised to Jo** as a plan tradeoff, approved 2026-10-14: arming stays Jo's switch, and as2 neither sets nor overrides it. At the 2026-10-14 re-pin the file existed and set every rule to `warn` with no `armOmp`, so the plugin is unarmed. |
| C5 | Overlap with as2's message shape. The i-have-audhd core (Needs you first, body, closing ask last, at most two open decisions, commands only when you can't run them) restates voice/VOICE.md and what gates row 1 enforces, with two differences: its "Closing ask" heading is not row 1's single **QUESTION** block, and it says nothing follows the closing ask, while VOICE.md puts the count line after it as a footer. | `plugins/i-have-audhd/skills/i-have-audhd/SKILL.md` inject span, item 3 "**Closing ask**" ("When present, it comes last and nothing follows it"); `voice/VOICE.md` "Message skeleton, same shape every turn" (count line as a footer); `gates/src/rows/r01-turn-shape.ts` (count-line footer exemption) | **resolved, as2 wins:** the order matches otherwise. Where they differ, the as2 rules win: the **QUESTION** block name and the count-line footer after it. The tier files and the contract sit in the system prompt, row 1 refuses a malformed turn whatever the inject says, and the plugin's Stop checks only warn, keyed on its own "Needs you" / "Closing ask" markers. Since 1.2.0 a warn finding reaches the agent's next turn (C7) instead of only the log, so a footer the plugin flags shows up as a notice the agent can ignore; row 1 still decides. |
| C6 | The output-types contract puts a QUESTION at the top of a report, while i-have-audhd puts the choice last. | `contract/output-types.md` § The receipt rule (QUESTION row); inject span "What the user must *know* goes first; what they must *choose* goes last" | **resolved, already settled:** voice/VOICE.md "One closing ask per message, and it goes last" puts the blocker (to know) at the top and the closing ask (to choose) last, which is the split i-have-audhd uses. |
| C7 | Hidden and queued messages against the surface's typed-input FIFO and the `input` handlers of gates rows 1 and 11. ask-graham 0.3.0 returns its nudge from `before_agent_start`; i-have-audhd 1.2.0 queues each warn finding for the next turn (`customType` `i-have-audhd-warning`, `display: true`) and shows a one-line UI notice. | `surface/extensions/surface-input.ts` (`input` handler; `before_agent_start` matches `event.prompt`); `gates/extensions/r11-jo-instruction.ts` `onInput(text, source)`; OMP `extensibility/extensions/runner.ts` `emitBeforeAgentStart` (each handler sees the same `prompt`; returned messages are collected); `plugins/i-have-audhd/omp/i-have-audhd-omp.ts` default export (`deliver`, `sendMessage` with `deliverAs: "nextTurn"`) | **resolved:** neither is an input. The nudge is a returned custom message and the warning is a custom message sent with `deliverAs: "nextTurn"`; neither raises an `input` event nor changes the prompt text `surface-input.ts` matches. |
| C8 | The classifier routes hands, which are subagents. Neither plugin has a `tool_call` or `task` handler. | Handler lists of both adapters | **no clash.** The fence order in profile/config.yml does not change, since the fence is a tool_call concern. |
| C9 | The inject tells the model to "Load the full `i-have-audhd` skill", and the as2 skill allowlist would hide that skill. | `profile/config.yml` `skills.includeSkills` | **resolved:** all three plugin skills are listed and load from their plugin dirs. |
| C10 | Installer and discovery invariant: each includeSkills name must resolve under exactly one listed customDirectory, and discovery must find each skill at its manifest row's file. | `install/install.sh` § 2b (profile render); `install/fresh-machine-test.sh` step 3b (skill listing) | **resolved:** the render maps each `skill` row to its own dir and requires that dir to be listed. fresh-machine-test compares each discovered skill's file with its manifest row. |
| C11 | The marketplace copies Jo installed in the default profile (93c1a75, older than this pin) load into every as2 session, lanes included, because OMP's installed-plugin dir is root-level, not per profile. That makes C1/C2 live already, and with `plugins/index.ts` the orchestrator would load each plugin twice. | pi-utils `dirs.ts` `getPluginsDir` (`rootSubdir("plugins")`); install smoke extension listing (SMOKE.log, 2026-10-14) | **resolved:** profile/config.yml `disabledExtensions` lists both adapters' `extension-module:` names. OMP's `discoverExtensionPaths` skips discovered plugin extensions with those names and never filters configured paths. install/fresh-machine-test.sh step 3c seeds installed copies plus a control plugin and checks that only the control and `plugins/index.ts` load. Found after plan approval and recorded on the workload. |
| C12 | ask-graham 0.5.0's Stop check blocks the orchestrator once per turn when the turn read the ask-graham skill and its final text has no `**Verdict:**` line naming do it now, start now, later or don't build. That block continues an orchestrator turn after as2's rows passed, the C4 concern, but bounded to one continuation per turn and only on a turn that ran the skill. `stop-check=off` disables it; settings-only invocations and a reply ending with the exact comparables question pass without a verdict. The verdict line is bold-prefixed prose, not a bare bold label, so row 1 reads it as body text. | `plugins/ask-graham/omp/ask-graham-omp.ts` `sessionStop` (`blockedOpener`, fail open); `plugins/ask-graham/skills/ask-graham/scripts/verdict.mjs` `checkStop`; `plugins/ask-graham/skills/ask-graham/SKILL.md` § 5 and its output shape (verdict line first); `gates/src/rows/r01-turn-shape.ts` `BLOCK_LABEL`, `plain` | **accepted with the re-pin:** the skill puts the verdict line first, which row 1 allows, and a reply that also carries a **QUESTION** keeps the QUESTION last. Loaded last (C3), so the continuation only runs once as2's own stop checks pass, and it re-enters them. |
| C13 | reminders-review handles reminder text that may contain instructions and can complete reminders. It adds a skill source but no adapter or hook. | `plugins/reminders-review/skills/reminders-review/SKILL.md` Hard rules and steps 1, 4, 5; `plugins/reminders-review/.omp-plugin/plugin.json` | **resolved:** reminder text is data; interpretation and plan each need Jo's yes before acting, and completing needs explicit approval and verification. Runtime prerequisite is documented above. Discovery uses the existing manifest and allowlist path (C10); no additional extension is loaded. |
