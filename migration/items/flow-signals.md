---
title: The five flow signals from ROOT-CAUSE § 5, written once a day at noon Pacific
status: building
workload: wl-mv654hoqwpfhmo
pr: 248
---
**Built on branch `wl/wl-mv654hoqwpfhmo-flow`, PR #248.** Workload `wl-mv654hoqwpfhmo`, PR-F of PLAN.md § 3a (revision 14, approved by Jo). It carries Plumb's invariant timer (MIGRATION.md item 104, PR #70, `plumb/invariant-timer`) merged with its commits kept; item 104's own line in MIGRATION.md keeps #70's edit, and what is new is here.

Switch: none — observation only; Jo q-mvfl9h64q7ivpc

**What changed.**
- **The five signals** (`surface/src/flow.ts`, pure: `flowSignals(db, asOf, cap)`) are ROOT-CAUSE § 5's queries (`~/agent-scratch/agent-system-2.0/stuck-analysis/ROOT-CAUSE.md`, "## 5. Early warning: five signals to watch daily") at the thresholds written there, Jo's five (in-mvfiyyv2kuha80):
  - open workloads (the standing one excepted), red above 2 × the live lane cap;
  - quiet 24 h (no slice, question, instruction, routing or non-lease workload change), red at or over the cap;
  - dead and not relaunched (a `lane-died` message at or after the last `launch:` entry), red at or over the cap;
  - questions raised in 24 h, red above 20;
  - provider-error messages in 24 h, red on any, or `headroom-skip:` entries in 24 h, red above 5 (both numbers shown).
  Net flow (ROOT-CAUSE query 1) over the previous full Pacific day is shown beside them with no colour and is not counted in `green <k>/5`. Pacific days are computed with the zone database, so a day across a DST change is 23 or 25 hours. The thresholds are constants in `flow.ts`; changing one takes a PR.
- **On the CLI.** `surface/scripts/invariants.ts` reports a red signal as a finding: `flow-open`, `flow-quiet`, `flow-dead`, `flow-questions`, `flow-provider`, keyed `<invariant>:<Pacific date>`. `--cap <n>` sets the cap (default `AGENT_SYSTEM_MAX_LANES`, else 3, as the launcher). The invariant timer never tells these one by one.
- **The noon line.** The orchestrator's invariant timer (item 104), at its first tick at or after 12:00 America/Los_Angeles on a date with no line, writes one entry on `wl-orchestrator` by the new writer `flow-signals`:
  `flow-signals: <date> open <n>/<t> quiet <n>/<t> dead <n>/<t> questions <n>/<t> provider <errors>,<skips>/0,5 net <opened>-<closed> green <k>/5 streak <d> cap <n> cap-source env|default source timer`
  The cap is the orchestrator's own `laneCap(env)`; `cap-source env` means `AGENT_SYSTEM_MAX_LANES` set it. Jo sees the day's line as one needs-you line (`surface/src/errors.ts`, kind `flow`) until Pacific midnight. The silent-orchestrator invariant does not count the entry as the orchestrator speaking.
- **The fallback.** When the orchestrator is down, `surface/scripts/flow-signals.ts`, run by launchd every 30 min (`install/com.agent-system-2.flow-signals.plist`, `StartInterval` 1800), writes the same line with `source fallback`, only past 12:30 Pacific and only when the date has no line. Its cap and `cap-source` are copied from the newest line; with none, `laneCap` of its own env and `cap-source default`. The "no line for this date" check and the insert are one write transaction, so the timer and the fallback racing write one line. `bun surface/scripts/flow-signals.ts --dry-run [--cap <n>]` prints the line now and writes nothing. `AS2_NOW` sets its clock.
- **Streak.** Consecutive Pacific dates ending today whose line says `green 5/5`, today's included: `streak 1` on the first green line, `streak 0` on a red one. A date with no line breaks it. A line written after 13:00 Pacific ends ` late` and still counts. Jo's exit is `streak 3`.
- **Delivery keys survive decoration.** Each invariant line is queued through `tick()` in `surface/extensions/wake.ts`, the one place that adds an open plan question's path beneath a line, and delivery matches a delivered line to its pending key by its first line. A decorated stuck-question line is now recorded as surfaced and not told again after a restart.

**Install.** The timer and the noon line run from the repo in the orchestrator's process, from its next start. The fallback job: `bash install/install.sh --flow-signals` (macOS).

**Rollback.** `bash install/install.sh --flow-signals=off` stops the fallback job. Reverting the PR removes the signals and the noon line; `flow-signals:` entries already written stay in the ledger and are read by nothing else.
