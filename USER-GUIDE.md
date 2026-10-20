# as2 user guide

A cheat sheet for talking to Ilex, the orchestrator, at the as2 surface. Short words in the tables below are applied by the surface itself before Ilex reads the turn; anything else is ordinary conversation for Ilex.

## 1. Start a workload

Describe the work in plain words. Ilex opens the workload and infers stakes and mode from what was said; either can be changed later with one word (section 3).

| Stakes | Said when the brief contains | Review before merge | Jo's part | Ceiling |
|---|---|---|---|---|
| `throwaway` | throwaway, scratch, experiment, prototype, spike, poc, "try out", "just see"; or a repo under scratch/tmp/sandbox | none | none | $5 / 1h |
| `normal` (default) | nothing pointing either way | a judge slice; merge proceeds on pass | told in one line after the merge | $50 / 6h |
| `production` | production, prod, deploy, release, hotfix, customer(s), live, outage, incident; or a protected branch or reserved target | a judge slice on deep, then Jo | approves the merge; the deploy is a separate reserved action | $150 / 12h |

- A production review's OpenAI reviewer runs on `openai-codex/gpt-6.1-sol` (the strong row), never `gpt-6-astra`, until the review-cost framework workload lands or Jo says otherwise (Jo, 2026-10-12, MIGRATION.md item 110; moved from `gpt-6-sol` to `gpt-6.1-sol` by Jo, 2026-10-14, `migration/items/headroom-guard.md`).
- Hands and reviews skip a lab the quota watcher projects to run out before its reset, at the window's own pace, or whose 5-hour window is over 80 %. A lane model you named on such a lab is refused at spawn; an unnamed lane is moved to the next strong-row model with room (`migration/items/headroom-guard.md`).
- A brief judged a large change gets three times the ceiling.
- **Plan first** is the default at normal stakes: the lane's first slice is a plan, answered `approve` / `revise` / `cancel`, and no change slice starts until it is approved. The plan question shows the plan itself: the file path, one line per slice, the main tradeoffs and the review verdict. The plan is skipped only when the open-time judge answers change-small at 0.9 or higher, or when you say "no plan" (or "no-plan") in the brief, unquoted: a quoted `"no plan"` on its own is read as a mention. Ilex can also pass `plan: none` when it opens the workload. "No plan" works only at open; said later, it does not lift plan-first. Production stakes always plan, and "plan it", "plan first", "plan-first" or "plan this" win over "no plan". Throwaway work plans only when judged a large change.
- **A normal-stakes plan can start on its own.** When the latest review round on the plan passed wholly on labs other than the builder's, the lane raises no plan question: the machinery approves the plan (`plan: approved auto <round>`, a stamp no lane can write), the lane adds its change slices, and you get a notice carrying the plan (section 4, Notices). Its PRs do not merge until 4 h after the first message you type in plain words at the surface once that notice has reached Ilex; a command word (`extend wl-…`, `1 approve`, `halt wl-…`, …) does not start the clock, and until you write they wait. A merge by hand is the only way to skip the wait. `halt wl-…` stops it at any point before the merge (section 3). The plan still comes to you as a question at production stakes, when the passing round ran same-lab or mixed labs, when you answered `accept` at a round limit, when a review was started or routed on the plan after the passing round, on a workload you halted, and for every plan while the `flow-repair` ruling stands (section 2, Standing rulings). An auto-start never opens a workload and never launches a lane.
- **Mode:** a lane runs on its own (`autonomous`) unless the brief says "with me", "step by step", "walk me through", "check with me", "ask me", "together", "pair", "interactive" or "user-driven".

Template:

```
new workload, normal stakes, plan first: <what to build>.
```

## 2. Answer a parked question

A question line under *needs you* reads:
`#3 lane on wl-… is waiting on you (q-…, slice sl-…): <question> — answer with one word: <options> (or withdraw)`.
The `q-…` id sits in the parentheses near the start; the options sit at the end.

| Type | One-word answers | Effect |
|---|---|---|
| Any lane question | the option names the line lists (for example `green` / `red`) | answers it; the parked lane resumes |
| Any lane question | `withdraw` | the slice is replanned, not executed |
| Plan question | `approve` / `revise` / `cancel` | approve unlocks change slices; revise reopens the plan; cancel withdraws and cancels the plan slice |
| Ceiling question left open from before 2026-10-19 | `withdraw` | withdraws it and replans its `sl-ceiling-…` slice like any other question. `cancel-slice sl-ceiling-…` (section 3) withdraws it and cancels that slice, so the slice does not hold up the close. The runner no longer raises a ceiling question; the ceiling sends notices instead (section 4, Notices) |
| Review park (no other lab can review) | `same-lab` / `wait` | same-lab: this one review runs on the builder's lab; wait: the review waits for another lab and the lane asks again if none is back |
| Review round limit | `extend` / `accept` / `stop` | extend: one more block of review rounds for that slice; accept: the review passes with the listed findings left; stop: no further round, the lane reports and holds the slice |
| Round limit question with a pair offer | `pair` | stops like `stop`, then flips the workload to `user-driven` and asks a running autonomous lane to stop; you continue it with `as2 lane wl-…`. Offered only when `as2 pair-suggest` covers the workload and a signal fired. The offer is its own `pair offer on …` line, not one of the options the question line lists (section 3, Pair suggestions). On any other question `pair` is refused and nothing is written |
| Reserved action | `approve` / `deny` | decides the waiting action (for example a push to `main`) |

### Standing rulings: questions already answered

Before a question reaches you, the machinery checks your standing rulings (`gates/src/rulings.ts`). When one of them answers the question, nothing is asked: no question row is written and no needs-you line appears. The asker records `ruling-applied: <ruling> kind <kind> slice <sl-…> answer <answer>` and does what the ruling says. A ruling decides only its own kind of question, only inside its scope. Every other question still comes to you: round limits, merge-train questions, plan questions, production merges and safety among them.

| Ruling | Decides | Answer | Still asks you | Ends |
|---|---|---|---|---|
| `kimi-out` | a review park (no other lab can review) | `same-lab` | Kimi is a builder lab, no builder is recorded, or the builders are unknown; a classifier park whose own Kimi-out checks fail | 2026-11-01 00:00 PDT |
| `flow-repair` | whether to open or launch new work | queue it; Ilex tells you `queued, position N`. A listed flow fix opens without asking | work you already approved, or that already has a lane, keeps running | your `end-ruling flow-repair`, when the noon report shows the five flow signals green three days running |
| `merges` | a lane's merge question on a normal-stakes workload that is not a merge train | the lane reports the PR green and ready for the merge train, then releases | production workloads and merge-train workloads | your word |
| `models` | a lane's model, or a review's OpenAI model | lane: `anthropic/claude-opus-5-5`; review: the review row's OpenAI model (`openai-codex/gpt-6.1-sol`), never `gpt-6-astra` | a lane-model question that cites a provider refusal or does not offer opus-5-5; a review-model question with no `gpt-6-astra` option, or that does not offer the row's model | the review-cost framework workload lands, or your word |
| `gates-stakes` | the stakes of work not yet opened whose question names `gates/` | `production` | a stakes question about a workload already open | item 82 is built |

- `end-ruling <ruling-id>` ends one ruling at once, for example `end-ruling flow-repair` (section 3). From then on its questions come to you again. Ending `flow-repair` also turns plan auto-start on (section 1).
- A new ruling comes only from your words and only through a code change in `gates/src/rulings.ts`.
- A question a ruling covers that reaches you anyway was raised by a path that skipped the check. The invariant report (`bun surface/scripts/invariants.ts`) lists it as `ruling-miss`. A question asked with `now` (below) skips the rulings on purpose and is never listed.
- When two or more active rulings decide one question with different answers, none of them decides: the question comes to you, and the machinery records `ruling-conflict: <q-…> <ruling ids>` beside it.

### Questions you hear at once: `now`

Both question tools, a lane's `lane_raise_question` and Ilex's `orchestrator_raise_question`, take an optional `now` word naming why you must hear the question at once:

| `now` | The asker sees |
|---|---|
| `integrity` | a credible data-integrity risk |
| `security` | a credible security risk |
| `incident` | an urgent service incident |
| `guard` | a change that would weaken a guard |
| `boundary` | a step across a boundary you stated |
| `irreversible` | an irreversible or shared-state effect the plan does not authorize |
| `money` | money or a legal commitment beyond what you approved |

- A question with `now` skips every standing ruling and is always raised. A lane's plan question with `now` also skips auto-start: its review and shape checks still run, and the plan waits for your `approve`.
- The machinery marks it `now: <q-…> <category>` (written by `escalation`, a form no lane can write), and its needs-you line opens `NOW (<category>): `. That line is on fire: it is pushed at once, `brb` or not (section 4).
- Any other word is refused and nothing is asked. Whether a risk is credible or a boundary is crossed is the asker's judgment; no code checks it, but every use leaves a `now:` entry you can count.

Repeats and relays:

- Asking a question that is still open again, with the same workload, slice, body and options (for Ilex, also about the same workload), raises nothing: the tool returns the open `q-…` id and writes nothing. When the repeat carries `now` and the open question has no mark, the open question gains its `now:` mark and becomes NOW. A changed body is a new question. A question whose options are all model ids is never treated as a repeat.
- Ilex's tool refuses a body that names the `q-…` id of another workload's open question (`q-… is already on Jo's needs-you list; do not relay it`): that question is already in front of you. Nothing is written.

Targeting:

- A bare word applies when it fits exactly one line. When it fits several, the surface answers "which one?" and applies nothing.
- Name the row with a second word: `<option> q-…`, `withdraw q-…`, `approve en-…`, `deny en-…`.
- Use the line's number: `1 approve`. Also accepted: `#1 approve`, `1: approve`, `q1: approve`, `1) deny`.
- Batch several, separated by commas or one per line: `1 approve, 2 deny, 3 green`. The batch is checked whole; one bad piece and nothing is applied.
- A number stays with its line for the whole session and is never reused.
- Type `pending` (the whole message) to see every open answer as one fenced block, one answer line per open row: `<option> <id>  # <subject> · <recommendation> · also: <other options> / withdraw`. The first word is the recorded recommendation, and the tail says `recommended (<where it was recorded>)`; with none recorded it is the row's first option, and the tail says `no recommendation recorded`. A reserved action's tail offers only `deny`. Change a line's first word to pick another option. The `# …` tail is dropped when the line is read, so the line is `<option> <id>`. Every line of the block that names an open plan question by its `q-…` id has `plan for q-…: <path>` beneath it. Pasted back inside the block (lines deleted or reordered, so long as one answer line is left), or beneath a line naming that question, it is ignored; anywhere else it goes to Ilex as your words.
- Paste the block back whole, or any of its lines. It is one paste, checked whole and applied all-or-nothing. Pasting it whole also answers every row with no recommendation with its first option; change or delete those lines first if that is not your answer.
- An open plan question's plan file path is printed, uncut, beneath any surface line or Ilex reply that names the question by `#n` or `q-…` id; answered, withdrawn and non-plan questions get none. The plan question's own needs-you and workload line carries the bare path on the line beneath its `q-…` id (the plan body's first line); every other line naming it gets `plan for <ref>: <path>` beneath it.

## 3. Change a running workload

| Word | Effect |
|---|---|
| `throwaway` / `normal` / `production` | sets stakes and re-sizes the ceiling to the new stakes |
| `autonomous` | hands the workload to a lane and requests a launch |
| `user-driven` | Jo steers; a running autonomous lane is asked to stop at its next poll |
| `ceiling <usd> [<hours>] [wl-…]` | sets an exact ceiling, for example `ceiling 60 8`, `ceiling $60 8h wl-…`. Hours and id in either order; omitted hours keep the current wall time. A lane the ceiling stopped is relaunched (section 6, Spend at 100 %) |
| `extend wl-…` | raises the ceiling by one more block of the workload's own size (for example $50 / 6h more at normal stakes, three times that when it was judged a large change), then relaunches a lane the ceiling stopped, as `ceiling` does. The id is always required: `extend` alone, or `extend q-…`, still answers a round-limit question |
| `halt wl-…` | stops a plan: the workload is plan-first and unapproved again, change slices are refused, a lane holding it is asked to stop, and the merge train holds its PRs. The plan never starts on its own again on that workload; your `approve` on its next plan question starts it. The id is always required. Refused, nothing written, when the workload is not open or is already halted |
| `end-ruling <ruling-id>` | ends one standing ruling at once (section 2, Standing rulings): `kimi-out`, `flow-repair`, `merges`, `models` or `gates-stakes`. Refused, nothing written, for any other id or a ruling already ended |
| `rounds <n> [wl-…]` | sets the review round limit, for example `rounds 5 wl-…`. Defaults: 3 at throwaway and normal, 5 at production; a stakes word re-sizes it |
| `deploy-policy <sha12>` or `deploy-policy off` | accepts the installed profile's `deploy:` section as it is now (`<sha12>` is the first 12 hex of the hash of its canonical JSON), or switches routine deploys off. Only your newest such word counts: after any edit to a parsed target's section it escalates until you accept the new hash. A hash mismatch is refused, nothing written, and prints the current hash and acceptance command. Reinstall preserves installed declarations and their hash, never overrides `off` or a newer acceptance. Without a parsed target the original workflow reservation stays in force |
| `as2 deploy settle <dp-…>` | a command, not a word: any lane may run it after `gh run watch`. It binds the deploy's run, checks the shipped commit and the health probe, records `deploy-settled:` and sends you one notice. A run still going leaves the deploy unsettled |
| `stop-reviews [wl-… \| sl-…]` | stops review loops: every loop on the workload, or the one on `sl-…`. A review already running finishes and its remaining findings are reported; nothing done is reverted |
| `cancel-slice sl-…` | cancels one open or paused slice of an open workload. It withdraws the slice's open questions, and a lane parked on them is relaunched when none is running. Refused, with the reason and nothing written, for a done or cancelled slice, a closed workload, the standing slice, or a slice whose test run is still live (wait for the run's result) |
| `supersede wl-A wl-B` | records that B supersedes A. A's close then needs no `done-because:` receipt, but it still needs no open slice or question, no open PR, and no unmerged commits on A's branches. Refused when A is not open, B does not exist, or A is B |
| `pending` | shows the paste-ready block of every open answer (section 2). The surface answers; Ilex takes no turn |
| `brb` | holds routine needs-you pushes until `back`; on-fire lines still come at once. Ilex takes no turn |
| `back` | goes to Ilex as your turn: a digest of the held lines plus the complete list, each item written up with its content |
| `test-pr <wl-…> <N> [<N> …]` | lets the workload's lane test those PRs with `lane_full_test` without pushing to them, for example `test-pr wl-… 79 70`. Numbers by spaces or commas; the workload id is always required. Closed, merged and fork PRs are still refused |
| `waive-pr <wl-…> <N> [<N> …]` | lets the workload close when a merged PR of it has no test-runner green that covers it, for example `waive-pr wl-… 104`. Numbers by spaces or commas; the workload id is always required. It never admits a test run and never passes an open PR |
| `train <N> [<N> …]` | opens a merge train: an autonomous workload whose lane lands those green PRs one at a time. For each PR it merges main in without rebasing, auto-fixes conflicts that touch only MIGRATION.md, `migration/items/` or `install/manifest.tsv`, and runs the full suite. A green, mergeable PR from a normal-stakes workload then merges itself. A production-stakes PR, or any PR not on a same-repo `wl/` branch, asks you merged / skip / stop, and the train moves on while you decide. A red or conflicting PR goes back to the lane of the workload that owns it, as a task with the error attached, and the train moves on; it does not ask you. When every failure also fails on main, the lane files (or finds) a `main-red` issue and the PR still merges. A PR that says `Depends-on: #N` in its body, or is based on another PR's branch, lands after that PR, and the lane shows the chain (`#101 → #106`). `train <wl-…> <N> …` adds PRs to an open train. A PR rides one open train at a time: naming one that is on another open train of the same repo is refused. Every 5 minutes the train tick (`bash install/install.sh --train-tick`; `--train-tick=off` stops it) settles each returned task, relaunches its owner, opens one fix workload when the owner is gone, and wakes the train; an open question never stops it. You hear of a PR only when its fix fails twice (retry / skip / stop) or at a production merge: a needs-you line plus an issue on thewolff/jo-issues labelled `as2-train`. Unacknowledged for 4 h, it is re-sent louder (a comment mentioning you, the `loud` label, a notification with sound, a `LOUD` needs-you line), and at 8 h once more with `critical`. Closing the issue acknowledges it and stops the re-sends; answering the question closes the issue |
| `train <N> [<N> …]` | opens a merge train: an autonomous workload whose lane lands those green PRs one at a time. You no longer need it for a lane's own PR: once an autonomous normal-stakes lane on a repository the test runner serves finishes green at its PR's head with its cross-lab review passed, the surface closes the workload and the train tick boards the PR on a train by itself (`migration/items/merge-train-auto-board.md`). `train <N>` is still how you add any other PR (a skipped one, a production one, one the tick would not board) or resume a train you stopped (`train <wl-…> <N> …`). For each PR it merges main in without rebasing, auto-fixes conflicts that touch only MIGRATION.md, `migration/items/` or `install/manifest.tsv`, and runs the full suite. A green, mergeable PR from a normal-stakes workload then merges itself. A production-stakes PR, or any PR not on a same-repo `wl/` branch, asks you merged / skip / stop, and the train moves on while you decide. A red or conflicting PR goes back to the lane of the workload that owns it, as a task with the error attached, and the train moves on; it does not ask you. When every failure also fails on main, the lane files (or finds) a `main-red` issue and the PR still merges. A PR that says `Depends-on: #N` in its body, or is based on another PR's branch, lands after that PR, and the lane shows the chain (`#101 → #106`). `train <wl-…> <N> …` adds PRs to an open train. A PR rides one open train at a time: naming one that is on another open train of the same repo is refused. Every 5 minutes the train tick (`bash install/install.sh --train-tick`; `--train-tick=off` stops it) settles each returned task, relaunches its owner, opens one fix workload when the owner is gone, and wakes the train; an open question never stops it. You hear of a PR only when its fix fails twice (retry / skip / stop) or at a production merge, and of the train only for a red main (once per `main-red` issue) or a main protection it cannot verify (once per episode): each is a needs-you line plus an issue on thewolff/jo-issues labelled `as2-train`. Unacknowledged for 4 h, it is re-sent louder (a comment mentioning you, the `loud` label, a notification with sound, a `LOUD` needs-you line), and at 8 h once more with `critical`. Closing the issue acknowledges it and stops the re-sends; answering the question closes the issue |

With one open workload the word applies to it. With several, add the id: `production wl-…`, `autonomous wl-…`. `extend` and `halt` always take the id. `pending`, `brb` and `back` are surface words only as the whole message: `back q-…` or `1 back` still answers a question that offers that word.

**Several commands in one paste:** one command per line, as many lines as you like. Each line is read with the rules of a message of its own: `1 approve, 2 deny` on one line, `production wl-…` on the next, `ceiling 120 wl-…` on the next. The paste is checked whole and applied all-or-nothing, in order; one bad line and nothing is applied, and the reply names that line by number and text. A command word with an id that is not an open row (`approve en-nope`, `production wl-nope`, or an id cut short to its prefix, `production wl-`) is a bad line, not an instruction, and a row answered on two lines is too. In a paste a stakes or mode word takes only an id after it: a `wl-…` id flips that workload, and a `q-…` id answers that question (`production ready` is plain words). Lines that are no command go to Ilex as one plain-words instruction (consecutive lines together; a command line between two runs makes two instructions), so `1 approve, 2 deny` followed by "Relaunch the classifier fix now" is one paste. A `pending` block pasted back loses its own heading, the fence around its answer lines and the sentences under it, so the block pasted whole sends Ilex no instruction; a fence you type yourself is kept. Only the command lines are the transaction: Ilex records the plain-words lines on its own turn afterwards, so they are not written with the commands, and nothing is handed to Ilex from a refused paste.

To read the installed deploy policy hash without accepting anything, run this read-only command from the as2 checkout (it follows the installed profile path, not the template). Inspect the declarations before typing the printed `deploy-policy` word at the surface:

```bash
bun -e 'import {readFileSync} from "node:fs"; import {readPolicySection} from "./gates/src/deploy-risk"; import {installedConfigPath} from "./surface/src/pair-suggest"; const r = readPolicySection(readFileSync(installedConfigPath(process.env), "utf8")); if (!r.ok) throw new Error(r.error); console.log(r.hash, "\\ndeploy-policy " + r.hash.slice(0, 12));'
```


### Steer a workload yourself (user-driven)

1. Open it user-driven: put "with me" (or another mode word from section 1) in the brief, or flip an open workload with `user-driven wl-…`. A lane already running on its own is asked to stop at its next poll.
2. Ilex names the workload. In a **separate terminal**, run `as2 lane wl-…`. That terminal becomes the lane's session: you type to the lane there, and it can stop and ask you with its `ask` tool. Autonomous lanes lose that tool (`SPEC-2.0.md` § B13.1).
3. To stop the lane: `as2 lane stop wl-…`. To read its runner log: `as2 lane log wl-…`.
4. A lane you run by hand is never stopped at its ceiling, and no ceiling notice or question comes from it. A ceiling notice an autonomous lane sent before you took the workload over is hidden while your by-hand lane runs, and shows again once it ends. That lane is told the spend against the ceiling in force at the start of every turn (`spend: $X of $Y ceiling (Z %), N min; paired: not stopped at the ceiling`), so it can tell you when you ask. Each time the dollar spend crosses another 25 % of the workload's original ceiling during the session (for $150: 37.50, 75, 112.50, 150, 187.50 …), one `spend on wl-…` line shows in its pane without your asking, past 100 % too; marks passed before the session started are not shown again. A user-driven workload with no lane running spends nothing, so nothing is shown for it.

### Trace to Phoenix (on by default)

`as2 install` starts Phoenix on `http://127.0.0.1:6006` (macOS), and every lane, the orchestrator and every OMP seat export their spans to it. A lane's spans, and its hands', land in project `as2-<wl-id>`, the orchestrator's in `as2-orchestrator`, a seat's in `seat-<name>`. Both commands below are typed in a shell, not at the surface:

- `as2 phoenix off|all|<wl-id>` sets `observability.phoenix` in the installed profile's `config.yml` and prints the old and new value. `all` (the default) traces everything and `off` traces nothing. `<wl-id>` adds that workload to a list that traces only the listed workloads' lanes; under `all` it is already covered and the value stays `all`, so go through `off` first to trace just one. Each process reads the setting when it starts, so a running lane changes only when it is relaunched (`relaunch wl-…`), the orchestrator when `as2` starts and a seat when it is launched. A re-install keeps the value, so `off` stays off.
- `bash install/phoenix-agent.sh on|off|status` manages Phoenix itself, a LaunchAgent (`com.agent-system-2.phoenix`) serving loopback only, with its data in `~/.agent-system-2/phoenix/data`. `off` stops it and removes the agent (the data is kept); `on` starts it again; `status` shows whether it runs, its memory and its ports. Phoenix down never affects as2: every process drops its spans silently and carries on.

### Pair suggestions (`as2 pair-suggest`)

- In a terminal: `as2 pair-suggest all` (every workload, the default), `as2 pair-suggest wl-…` (adds one workload), `as2 pair-suggest off`. It sets `pairSuggest` in the installed profile's config and prints the old and new value. The next question reads it; no restart.
- With it on, round-limit questions on an autonomous workload above throwaway stakes can offer `pair` (section 2). The offer fires when the review loop stalls, when you have sent three or more long steers, or when jev reads the brief as UI/taste work or as ambiguous. At most 2 offers per workload, 60 minutes apart, and none after you decline one unless a new signal fires.
- Jev answers in the background. A question raised before its answer arrives, or while jev is down, offers on the other signals only; nothing waits for jev.
- The offer is its own line. The question keeps its own text and options, and `pair` is not shown among them. Under *needs you* the offer sits on the line just above its question, with no `#n`:
  `pair offer on <workload> (q-…): <reasons>. Answer pair q-… to stop the lane and drive it yourself (as2 lane wl-…).`
  The reasons are one phrase per signal: "the review loop is not converging", "you sent several long steers", "no slice done yet", "the brief reads as ambiguous", "the plan was revised more than once", "it reads as UI or taste work". `pending` shows the offer indented beneath the question's answer line (`  ↳ pair offer: …`), and pasting the block back skips that line. The workload block shows it beneath the open question.
- Answer `pair q-…`, or `pair` with the question's number. The receipt ends with `in another terminal:` (`when the lane has stopped (a few seconds), in another terminal:` when a lane was asked to stop), then a line that is exactly `as2 lane wl-…`, then `(copied to the clipboard)` or `(not copied: <why>)`. The copy is tried on macOS in a local session only, never over SSH. A failed copy never undoes the answer. In a batch or a paste the pair receipt comes last.
- Until a lane starts on the workload again, *needs you* shows `you took pair on <workload> (q-…); its lane has ended. Continue it in another terminal:` with `as2 lane wl-…` on the next line.

### Jev ranking (`as2 rank`, `as2 rank-mode`)

- Jev ranks the open workloads (all but the standing one and scheduled `due:` rows). It answers small factual questions about each one (does it serve your goals, unblock you, cut spend, fix breakage, have a deadline, is it irreversible); fixed weights, printed with every table, turn those into a score. Every agent's order of work comes from this one ranking, through the `as2_rank` tool.
- Where you see it: one `Rank (Jev, show-only): 1 … · 2 … · 3 …` line under *needs you* at each wake; the full table when you ask Ilex for `rank`; `as2 rank [--top N]` in a terminal, which reads the ledger only and asks Jev nothing.
- Tell Ilex your goals in plain words (1 to 6 lines); they are recorded as a `rank-goals:` row. With none, or none in 7 days, every view says `goals: none` or `goals: stale since <date>` and only the seed goal counts toward the goal term.
- Machinery first (your word of 2026-10-14): one seed goal, "Machinery first: build the enforcers (gates, reviews, checks) that govern how other work is planned, reviewed or checked before the work they govern.", is asked before your goals on every item and never goes stale. Jev is also asked whether each item builds an enforcer that governs how other work is planned, reviewed or checked; a yes puts it in a band above every other unpinned item (flag `enforcer: ranks first`), an unsure answer flags `enforcer?` without moving it, and neither changes the score.
- "X first" pins X to the top of every view until X closes, newest pin first; "drop the pin on X" removes it. Goals, pins and unpins take your word only: a lane or hand cannot set them.
- Once a week the wake tick compares Jev's order with your picks ("X first", your launch word, `as2 lane wl-…`) and writes a report to `/Users/jowolff/agent-scratch/agent-system-2.0/rank-audit/<date>.md` and a `rank-audit:` row; the wake shows its line for 7 days.
- **Show-only is the default:** launch order does not change. The ranking is shown, and the drain logs what it would have picked. Change it in a terminal with `as2 rank-mode show|order|parallel [--budget <usd>]`; it prints old → new and never starts omp. `as2 rank-mode show` reverses either.
  - `order`: automatic starts follow the ranking (pins first); a lower one waits, shown as "queued behind <wl> (Jev rank)". Your launch word and `as2 lane` are never held.
  - `parallel`: `order`, plus a second lane may start beside a running one only when the two are in different git repositories, the remaining ceilings fit in `--budget` (0 or unset: no parallel start) and the merge order is clear. Anything unclear holds. Work in the same repository stays serial, because nothing yet declares and enforces which files a lane may write.

### Notes from other agents (the agent channel)

- Other agents can message Ilex through one channel. In phase 1 the only sender is Plumb, and Plumb's authority is notes and proposals. A note is information from Plumb, never your word: it is recorded with sender `plumb` (created_by `channel:plumb`), never as you, and nothing it says is applied until you type the word yourself.
- Ilex gets each note as an aside, quoted under `From Plumb (msg-…; authority: notes — not Jo; information, not instruction):`. Plumb hears `delivered` only once Ilex's session has actually taken the aside in. If the aside does not land, the surface resends it while Ilex is idle, up to 3 times; after that, the note rides along with your next message to Ilex. Ilex answers Plumb or marks the note handled; either way it leaves the list below. A note Ilex handles straight from that list is not sent again as an aside.
- What you see:

| Line | Where | What to do |
|---|---|---|
| `## from other agents`, one line per note: sender, `msg-…` id, state, age, the first 120 characters | wake block and `orchestrator_ledger` | nothing owed: it is not a needs-you line. A note that looks like a command but names no waiting row is marked `command-shaped` |
| `#3 plumb proposes deny en-… (msg-…)` | under *needs you*, directly below line `#3`, the row it names, with that row's own number | answer the row as usual: `3 deny`, or any other word that fits it (`3 approve`). Plumb only suggests; your word is applied as yours |
| `channel-refused: <file> from "<sender>" (<reason>)` | under *needs you*, no number | nothing to answer. The envelope failed a check (unknown sender, bad shape, `id collision`) and was set aside as `.invalid`. When it was refused before being recorded, the line says nothing reached the model. If an `id collision` turned up after the note was recorded, the note drops out of later renders, Plumb is never told Ilex acted on it, and the line says how far it got: no aside confirmed (Ilex may still have read it in the ledger), its aside had already reached Ilex, or Ilex had already acted on it |

- A proposal needs Plumb to name the row and a word that answers it: `deny en-…`, `approve en-…`, `<option> q-…`, `withdraw q-…`. A bare `deny` stays a note. Flip and ceiling words from Plumb (`autonomous wl-…`, `production wl-…`, `ceiling 999 wl-…`) answer no numbered row, so they stay notes too; type the word yourself if you want it.
- A proposal line disappears once its row is settled, by you or by anything else. Plumb repeating a proposal updates the `msg-…` id; it adds no line.
- Senders are set in `profile/config.yml`. Phase 1 accepts only `transport: omp-mailbox` and `authority: notes`. No block: the channel is off. An invalid block is refused when Ilex starts, with a notice, and the channel stays off. Changes take effect when Ilex restarts.

```yaml
channel:
  senders:
    - { id: plumb, transport: omp-mailbox, authority: notes }
```

## 4. Read the screen

- **Wake block:** `# Ledger at <time> (wake: <why>)`, then `you are <name> (<pronouns>)`, then `## needs you`, then the `Rank (Jev, show-only): …` line (section 3, Jev ranking), then `## open workloads` with one line per open workload: id, the brief's first line, the one-liner, the lane, slice counts, its `#n` needs-you numbers, open question ids and unread message count. A workload's full block comes from `orchestrator_ledger` with `workload: wl-…` (with no workload it renders every block).
- **Needs you** lists, in order: reserved actions waiting; anything held 4 hours or more; a slice that failed its artifact twice; a full-suite run with a failing test under `gates/test/` (`security tests red on <workload>: run … has <n> failing under gates/test/, first <test> — a lane asks you before it changes such a test`), one line per run, shown whoever holds the workload, until it has reached Ilex once; a dead lane; a lane that ended on purpose (parked, completed, released) leaving open slices with no holder and no question, or, after you took `pair`, the taken line in its place (`you took pair on … (q-…); its lane has ended. Continue it in another terminal:`, then `as2 lane wl-…` on its own line); a lane waiting on a question or stuck on a prompt, with a question's `pair offer on …` line just above it when it offers pair; scheduled work past due; and last, the notices. Answerable lines carry `#n`; the offer, taken and notice lines do not. "nothing: …" means nothing is owed.
- **Notices:** things you are told and do not answer: a workload's spend at 80 % of its ceiling, a lane stopped at 100 %, a plan that started on its own. Each shows as `notice on <workload> (nothing to answer): <text>`, with no `#n`, until it has reached Ilex once (in a push or in your turn); after that it is gone from the list. A notice is never a question, so it is not counted in `open answer lines:` and `pending` does not show it. The two ceiling notices name your words: `extend wl-…` and `ceiling <usd> [<hours>] wl-…`, and at 100 % also `user-driven wl-…`.
- **Reserved actions waiting:** a request that repeats an earlier call on the same workload says so (`same call as en-…, approved 18:00`, UTC). A request leaves the list without your word when the lane that raised it stops holding the workload, when a repeat replaces it, or when the running lane withdraws it (`lane_withdraw_reserved`) after moving past it. A request that bypasses a guard (the `--admin` merge, a push that reaches a protected branch) opens `NOW (guard): `, and one with an irreversible or shared-state effect (destructive SQL, a production database client, infrastructure teardown, secret rotation, deploy, publish, a workflow run, a release, remote ref deletion, a history rewrite) opens `NOW (irreversible): `; both are on fire. Every other request (a command not known until it runs, `rm`, a local discard, a local branch or tag deletion) waits for the window.
- **Between wakes:** at launch, restart and compaction Ilex opens with the wake block and its read without your typing (if you type first, the wake rides your turn). New lines arrive as `## needs you (new since your last turn)`. Tick results (a workload closed, a lane launched, "finished but cannot close") arrive on their own under `## Applied from the surface since your last turn`; words you typed are confirmed under the same heading in your next turn.
- **Batched pushes:** new lines between your turns are held, not pushed one by one. The first one opens a 5-minute window (`AGENT_SYSTEM_SURFACE_BATCH_MS`, in milliseconds, default 300000) that runs from that line and does not slide; when it ends, the lines still standing go out together as one push and one Ilex turn, and lines settled meanwhile (a question answered, a request decided) drop out. Typing anything takes the held lines into your turn sooner, except after `brb`, when only `back` releases them. On fire goes at once, `brb` or not: a lane death with work still open, the ceiling notices (at 80 % and at the stop at 100 %), a lane that stopped at its ceiling, a red or errored full-suite run, a `security tests red` line, a NOW question or NOW reserved action, the daily scratch sweep's `scratch disk:` line, and the taken-pair line. Every other notice, a plan that started on its own among them, waits for the window. A pair offer line goes whenever its question does.
- **Count line:** every push and every turn carries `open answer lines: N`, and Ilex ends each message with ``N others waiting: `pending` shows them all`` (or `nothing else waiting`) instead of re-listing older items. After 30 minutes without typing, your next turn gets the complete list once.
- **Workload block:** `brief:`, `done:`, then the one-liner
  `stakes: normal · mode: autonomous · plan first: <why> — flip either with one word: … · ceiling $50 / 6h`,
  then `spent $12.4 of $50 · 95.2 of 360 min`, the lane and its lease, `slices:`, `open questions:`, and the last 8 ledger entries.
- **Openable links:** render machinery makes settled agent paths and URLs clickable in OMP → herdr → kitty (including Plumb); stored docs/ledger stay raw. Unresolved session-local handles such as `local://PLAN.md` in ledger-derived wakes, reads, relays/questions and Applied lines stay plain text: Ilex never substitutes its own same-named file or reconstructs the old session. New lane bodies still expand locatable handles to raw absolute paths using the original caller before storage; current-session model replies and non-ledger custom messages keep their own local resolution. File clicks explicitly text-open safe documents, reveal directories/unknown formats/scripts/executables/symlink paths, and refuse app/bundle paths rather than launch them. The streaming/handle exceptions and upstream requests are in `migration/items/openable-links.md`, "Approved limitations and upstream requests".

## 5. Who does what

| Who | Does | Does not |
|---|---|---|
| Ilex | routes, opens and closes workloads, records Jo's answers | close slices, dispatch hands, raise a ceiling, run commands for Jo |
| Lane | builds inside the fence; adds and completes slices; raises questions | run the full test suite; push past gate refusals |
| Plumb | pushes what a lane cannot; sends Ilex notes and proposals through the agent channel (section 3) | speak as Jo, or get anything applied without Jo's typed word |
| Test runner | runs the full test suite, then each changed test file alone, outside the fence at a PR's head, when a lane calls `lane_full_test`; records the result in the ledger and completes the full-suite slice on a green | merge, push, or run anything a lane did not request |
| Jo | answers questions, merges PRs, pushes `main` | |

The test runner runs lane-written code outside the fence, so it narrows what that code can reach instead of sandboxing it: tests run as a separate user, `_as2test`, with an empty environment (no tokens, keys or SSH agent), a throwaway home, git without a credential helper, and a preflight that refuses the run when `_as2test` can open a known credential path, the ledger or the runner's lock. What stays open: a test can reach the network; it can read any file every user can read, other repositories' source included, though nothing of Jo's is writable to it; it writes its own junit, so it can lie about its own result; it can defeat its own time caps, which are not containment; and a lane chaining long runs delays everyone else's (a queued run ends in error after 60 minutes). Separately, a lane can still forge a green `test-run:` through the ledger module, because the ledger accepts a caller-supplied writer; that gap is MIGRATION.md's follow-up "Writer identity for machinery prefixes", not closed by the runner.

Before the first run, Jo runs `install/as2test-setup.sh` once. It uses `sudo` to create the `_as2test` user and its directories, root-owned copies of bun and the runner's wrapper, and the refresh helper `<libexec>/refresh` (`<libexec>` is `/usr/local/libexec/as2test`). It writes two sudoers lines: `<jo> ALL=(_as2test) NOPASSWD: <libexec>/exec`, which runs the tests, and `<jo> ALL=(root) NOPASSWD: <libexec>/refresh ""`, which lets Jo's user run the helper as root with no arguments and nothing else. Setup refuses a dirty checkout or a foreign `origin`, previews every change (the checkout's HEAD, the helper's full text and sha-256, both sudoers lines, every sudo step) and asks first. Its last step runs the helper through the new rule, which builds the bundle from origin/main. Before that step it installs a provisional SOURCE that records what it created, so when the last step fails (the fetch, say) nothing is lost: `--undo` still reverses everything, a re-run of setup takes over the account it created, and the runner's next preflight finds the bundle unbuilt and runs the helper again. `--undo` reverses all of it, helper and rule included.

After that the runner keeps the bundle current itself. When its preflight finds drift, it runs `sudo -n <libexec>/refresh` once, before anything runs the installed wrapper, then checks again. Drift is either an installed `exec` or `test-exec.js` that is missing or no longer matches the bundle's SOURCE, or a bundle input in the runner's checkout that differs from the bundle. The helper takes no arguments and reads nothing from its caller (no environment, checkout or branch). It fetches `main` from the fixed URL `https://github.com/thewolff/agent-system-2.0.git`, builds as `nobody`, and installs the result, so it only ever installs origin/main. It stops itself after 14 minutes, and on a signal, ending what it was running and installing nothing; the runner stops waiting for it at 15 minutes. A refreshed run carries on, and its summary says `refreshed <old12>..<new12>`. Drift never asks Jo and never needs setup. Jo runs setup again only for an install-kind error (the `_as2test` account, the SOURCE file, an owner or mode under `<libexec>`, or the `bun` or `refresh` hash), whose reason still says "re-run install/as2test-setup.sh", or to install a newer bun or helper. Two typed errors end a run as its `error` verdict, without a question to Jo:

- **`bundle-refresh-failed`**: the helper failed, and the reason names its exit code. 64: it was given arguments. 69: another refresh held the lock for 10 minutes. 70: the fetch of origin/main failed (GitHub unreachable). 71: the build or a check of its output failed, or a signal or its own 14-minute cap stopped it; main's `surface/scripts/test-exec.ts` does not compile, or main changed the `render-exec` or `bundle-inputs` command the helper calls, which needs a setup run. 72: installing the built files failed. 77: it did not run as root. A helper still running at the runner's 15-minute cap is named with `after the runner's 15 min cap`. The same code is used when the helper exited 0 but an installed file still does not match SOURCE.
- **`checkout-drift`**: the refresh worked, but a bundle input in the runner's checkout (Jo's main checkout) still differs, because the checkout is not at origin/main: behind, ahead, on another branch, or carrying local edits. The reason names the file, the checkout, its HEAD and origin/main's sha. Bring the checkout to origin/main (a clean `main`, pulled); the helper builds only origin/main, so another refresh cannot fix it.

Restart as2 after merges that change surface or lane code; a running session keeps the old code.

## 6. When something looks stuck

- **Lane parked:** a question waits under *needs you*. Answer it or `withdraw` it.
- **Spend at 80 %:** a notice; nothing is asked and the lane goes on. For more room before it stops: `extend wl-…` or `ceiling <usd> [<hours>] wl-…`.
- **Spend at 100 %:** the lane has stopped and a notice says so; nothing extends on its own, at any stakes. Type `extend wl-…` (one more block) or `ceiling <usd> [<hours>] wl-…`; either relaunches the stopped lane when the workload is autonomous, the new ceiling is above its spend in both dollars and hours, and no relaunch is already waiting. The receipt says which case it was. To drive it yourself instead: `user-driven wl-…`, then `as2 lane wl-…` (a lane run by hand is never stopped at its ceiling).
- **A plan started on its own:** a notice with the plan. Nothing to do if it looks right: the merge train may merge its PRs from 4 h after your next plain-words message at the surface (command words do not count). `halt wl-…` stops it.
- **Lane died:** the line names the lane. `as2 lane log <wl>` tails the runner log.
- **Lane ended with work open:** `lane … ended (parked) with 2 open slice(s) and no question; relaunch, close, or instruct`. Tell Ilex to relaunch it (`relaunch wl-…`), close it, or what to do instead; the line is pushed once per ending, between wakes. On a user-driven workload the line ends `continue it with as2 lane wl-…, close, or instruct` instead: run `as2 lane wl-…` in another terminal, or tell Ilex to close it or what to do instead.
- **You took pair:** the lane stops and the workload is user-driven. Run the `as2 lane wl-…` line from the receipt or from *needs you* in another terminal.
- **Held 4h:** a workload with no lane and no activity. Flip to `autonomous`, or run it by hand with `as2 lane <wl>`.
- **Blocked on a prompt:** answer it in that lane's session, or end the session.
- **Cannot close:** open slices, paused slices or open questions remain, or a lane still holds the lease (`as2 lane stop <wl>`).
- **"which one?":** the word fit several lines or, for a stakes, mode or `ceiling` word, several open workloads. Answer by number, or add the `wl-…` id it lists.
- **A word did nothing:** a bare stakes, mode or `ceiling` word with several open workloads gets "which one?" instead. It does nothing only when its `wl-…` id is not an open workload, or the `ceiling` figures do not parse. Check the id or the figures.
- **Stakes raised mid-run:** a review slice is not added automatically. Ask Ilex for one.

## Doc vs parser

- The q-id is inside the parentheses near the start of the question line, not at its end.
- `user driven` (two words) is not accepted at the surface; type `user-driven`.
- A comment in `surface/src/stakes.ts` lists "plan it" as user-driven; the code treats it as plan-first only and leaves mode alone.
- `green` / `red` and similar are options a lane chooses for its question, not fixed words in the parser.
- A stakes or mode word followed by a `q-…` id answers that question (`autonomous q-…`) in a single message and in a paste, and flips nothing; a bare `autonomous` still flips mode. Followed by an `en-…` id it is refused: a reserved action takes only `approve` or `deny`.
