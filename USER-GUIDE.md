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
| Ceiling question (raised at 80 %) | `stop` (default) / `extend` / `split` | stop: the lane halts at 100 %; extend: one more ceiling block and a relaunch; split: halts like stop, then Ilex offers a new workload for the rest |
| Ceiling question | `withdraw` | cancels the ceiling slice; the lane still stops at the ceiling |
| Review park (no other lab can review) | `same-lab` / `wait` | same-lab: this one review runs on the builder's lab; wait: the review waits for another lab and the lane asks again if none is back |
| Review round limit | `extend` / `accept` / `stop` | extend: one more block of review rounds for that slice; accept: the review passes with the listed findings left; stop: no further round, the lane reports and holds the slice |
| Round limit or ceiling question that offers `pair` | `pair` | stops like `stop`, then flips the workload to `user-driven` and asks a running autonomous lane to stop; you continue it with `as2 lane wl-…`. Offered only when `as2 pair-suggest` covers the workload and a signal fired (the question's last line reads `pair: <reasons>`). On any other question `pair` is refused and nothing is written |
| Reserved action | `approve` / `deny` | decides the waiting action (for example a push to `main`) |

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
| `ceiling <usd> [<hours>] [wl-…]` | sets an exact ceiling, for example `ceiling 60 8`, `ceiling $60 8h wl-…`. Hours and id in either order; omitted hours keep the current wall time |
| `rounds <n> [wl-…]` | sets the review round limit, for example `rounds 5 wl-…`. Defaults: 3 at throwaway and normal, 5 at production; a stakes word re-sizes it |
| `stop-reviews [wl-… \| sl-…]` | stops review loops: every loop on the workload, or the one on `sl-…`. A review already running finishes and its remaining findings are reported; nothing done is reverted |
| `cancel-slice sl-…` | cancels one open or paused slice of an open workload. It withdraws the slice's open questions, and a lane parked on them is relaunched when none is running. Refused, with the reason and nothing written, for a done or cancelled slice, a closed workload, the standing slice, or a slice whose test run is still live (wait for the run's result) |
| `supersede wl-A wl-B` | records that B supersedes A. A's close then needs no `done-because:` receipt, but it still needs no open slice or question, no open PR, and no unmerged commits on A's branches. Refused when A is not open, B does not exist, or A is B |
| `pending` | shows the paste-ready block of every open answer (section 2). The surface answers; Ilex takes no turn |
| `brb` | holds routine needs-you pushes until `back`; on-fire lines still come at once. Ilex takes no turn |
| `back` | goes to Ilex as your turn: a digest of the held lines plus the complete list, each item written up with its content |
| `test-pr <wl-…> <N> [<N> …]` | lets the workload's lane test those PRs with `lane_full_test` without pushing to them, for example `test-pr wl-… 79 70`. Numbers by spaces or commas; the workload id is always required. Closed, merged and fork PRs are still refused |

With one open workload the word applies to it. With several, add the id: `production wl-…`, `autonomous wl-…`. `pending`, `brb` and `back` are surface words only as the whole message: `back q-…` or `1 back` still answers a question that offers that word.

**Several commands in one paste:** one command per line, as many lines as you like. Each line is read with the rules of a message of its own: `1 approve, 2 deny` on one line, `production wl-…` on the next, `ceiling 120 wl-…` on the next. The paste is checked whole and applied all-or-nothing, in order; one bad line and nothing is applied, and the reply names that line by number and text. A command word with an id that is not an open row (`approve en-nope`, `production wl-nope`, or an id cut short to its prefix, `production wl-`) is a bad line, not an instruction, and a row answered on two lines is too. In a paste a stakes or mode word takes only an id after it: a `wl-…` id flips that workload, and a `q-…` id answers that question (`production ready` is plain words). Lines that are no command go to Ilex as one plain-words instruction (consecutive lines together; a command line between two runs makes two instructions), so `1 approve, 2 deny` followed by "Relaunch the classifier fix now" is one paste. A `pending` block pasted back loses its own heading, the fence around its answer lines and the sentences under it, so the block pasted whole sends Ilex no instruction; a fence you type yourself is kept. Only the command lines are the transaction: Ilex records the plain-words lines on its own turn afterwards, so they are not written with the commands, and nothing is handed to Ilex from a refused paste.

### Steer a workload yourself (user-driven)

1. Open it user-driven: put "with me" (or another mode word from section 1) in the brief, or flip an open workload with `user-driven wl-…`. A lane already running on its own is asked to stop at its next poll.
2. Ilex names the workload. In a **separate terminal**, run `as2 lane wl-…`. That terminal becomes the lane's session: you type to the lane there, and it can stop and ask you with its `ask` tool. Autonomous lanes lose that tool (`SPEC-2.0.md` § B13.1).
3. To stop the lane: `as2 lane stop wl-…`. To read its runner log: `as2 lane log wl-…`.

### Trace to Phoenix (on by default)

`as2 install` starts Phoenix on `http://127.0.0.1:6006` (macOS), and every lane, the orchestrator and every OMP seat export their spans to it. A lane's spans, and its hands', land in project `as2-<wl-id>`, the orchestrator's in `as2-orchestrator`, a seat's in `seat-<name>`. Both commands below are typed in a shell, not at the surface:

- `as2 phoenix off|all|<wl-id>` sets `observability.phoenix` in the installed profile's `config.yml` and prints the old and new value. `all` (the default) traces everything and `off` traces nothing. `<wl-id>` adds that workload to a list that traces only the listed workloads' lanes; under `all` it is already covered and the value stays `all`, so go through `off` first to trace just one. Each process reads the setting when it starts, so a running lane changes only when it is relaunched (`relaunch wl-…`), the orchestrator when `as2` starts and a seat when it is launched. A re-install keeps the value, so `off` stays off.
- `bash install/phoenix-agent.sh on|off|status` manages Phoenix itself, a LaunchAgent (`com.agent-system-2.phoenix`) serving loopback only, with its data in `~/.agent-system-2/phoenix/data`. `off` stops it and removes the agent (the data is kept); `on` starts it again; `status` shows whether it runs, its memory and its ports. Phoenix down never affects as2: every process drops its spans silently and carries on.

### Pair suggestions (`as2 pair-suggest`)

- In a terminal: `as2 pair-suggest all` (every workload, the default), `as2 pair-suggest wl-…` (adds one workload), `as2 pair-suggest off`. It sets `pairSuggest` in the installed profile's config and prints the old and new value. The next question reads it; no restart.
- With it on, round-limit and ceiling questions on an autonomous workload above throwaway stakes can offer `pair` (section 2). The offer fires when the review loop stalls, when you have sent three or more long steers, or when jev reads the brief as UI/taste work or as ambiguous. At most 2 offers per workload, 60 minutes apart, and none after you decline one unless a new signal fires.
- Jev answers in the background. A question raised before its answer arrives, or while jev is down, offers on the other signals only; nothing waits for jev.

### Issues projection (`issues on|off`, `tracker`)

Each open workload gets one tracker issue, kept in step with the ledger by the surface. The design, rollout and residuals are in `migration/items/github-issues-projection.md`.

- **Words.** Type each as the whole message, or as one line of a paste.
  - `issues on` / `issues off`: the switch. It is off until the first `issues on`. Off stops every call the projection makes (pushes, the PR scan and footers, the hourly reconcile, intake). It does not stop a close's own branch push and decision-log PR.
  - `tracker <wl-id> github | linear <TEAM> | none`: moves one open workload's issue, for example `tracker wl-… linear ENG`. The old issue is closed `not planned` with a comment naming the new place, and the next tick creates the new one. Refused, with nothing written, for a closed workload, `wl-orchestrator` or a malformed form.
- **Where issues live.** It goes by the workload's repo origin (`issues.trackers` in `profile/config.yml`). `thewolff/agent-system-2.0` uses GitHub issues on that repo. `ContextPress/*` uses Linear team ENG, through `LINEAR_API_KEY`. Any other repo gets none. `issues.overrides` sends wl-mv5jz4vewt8mbk (the SEO audit) to Linear ENG. A `tracker` word beats both.
- **What you see.**
  - Each issue is titled `wl-<id> — <first line of the brief>`. A machine block between `<!-- as2:begin -->` / `<!-- as2:end -->` gives stakes, mode, holder, ceiling, slices, open questions and PRs. Your text outside it is kept.
  - The labels are `as2`, `running` / `waiting`, `question`, `awaiting-merge` and `unmerged`. On Linear, In Progress / In Review / Done / Canceled stand in for the states.
  - A PR into `main` gets a machine-added `<!-- as2 -->` `Closes #N`. A closed workload's issue waits with `awaiting-merge` and closes when its PR merges. A workload with no PR closes its issue at the ledger close.
  - An issue you file on `thewolff/jo-issues` after `issues on` (as `thewolff`, and edited or renamed by no one else) becomes your input on `wl-orchestrator` (`issues.intakeRepo`; without it, intake reads the first exact GitHub repo in `issues.trackers`). Ilex is told `Jo filed issue #N → input in-…`, and the issue gets the `intake` label and a comment. An issue labelled `plumb` or `as2-train` is skipped: Plumb and the merge train's alerts file there as `thewolff` too. It stays as it is, with no label or comment, and is counted as ignored in the hourly drift entry (`issues.intakeSkipLabels`, default `plumb`, `as2-train`). An issue on jo-issues is never a workload's issue: a workload opened from your input gets its own. Linear has no intake and no PR footer.
  - Problems arrive as `tick: issues: …` lines. Examples: `issue for wl-… not updated after turn …`, two drifting reconciles in a row, a parked link. Every hour an `issues-drift: <N>` entry is recorded on `wl-orchestrator`.
- **Check.** `bun surface/scripts/issues.ts check` prints `drift: <N>` (or `drift: unknown (…)`) and one line per difference. It writes nothing to the ledger or a tracker, and nothing to the sidecar but its call count: its tracker reads count against the same 300-per-hour budget as the projector, capped at 20 per run, and at either cap it stops with `drift: unknown (budget)`. Exit 0 means no drift, 1 means drift or unknown, and 2 means no `issues:` block or no sidecar yet.

## 4. Read the screen

- **Wake block:** `# Ledger at <time> (wake: <why>)`, then `you are <name> (<pronouns>)`, then `## needs you`, then `## open workloads` with one line per open workload: id, the brief's first line, the one-liner, the lane, slice counts, its `#n` needs-you numbers, open question ids and unread message count. A workload's full block comes from `orchestrator_ledger` with `workload: wl-…` (with no workload it renders every block).
- **Needs you** lists, in order: reserved actions waiting; anything held 4 hours or more; a slice that failed its artifact twice; a dead lane; a lane that ended on purpose (parked, completed, released) leaving open slices with no holder and no question; a lane waiting on a question or stuck on a prompt; scheduled work past due. Answerable lines carry `#n`. "nothing: …" means nothing is owed.
- **Reserved actions waiting:** a request that repeats an earlier call on the same workload says so (`same call as en-…, approved 18:00`, UTC). A request leaves the list without your word when the lane that raised it stops holding the workload, when a repeat replaces it, or when the running lane withdraws it (`lane_withdraw_reserved`) after moving past it.
- **Between wakes:** at launch, restart and compaction Ilex opens with the wake block and its read without your typing (if you type first, the wake rides your turn). New lines arrive as `## needs you (new since your last turn)`. Tick results (a workload closed, a lane launched, "finished but cannot close") arrive on their own under `## Applied from the surface since your last turn`; words you typed are confirmed under the same heading in your next turn.
- **Batched pushes:** new lines between your turns are held, not pushed one by one. The first one opens a 5-minute window (`AGENT_SYSTEM_SURFACE_BATCH_MS`, in milliseconds, default 300000) that runs from that line and does not slide; when it ends, the lines still standing go out together as one push and one Ilex turn, and lines settled meanwhile (a question answered, a request decided) drop out. Typing anything takes the held lines into your turn sooner, except after `brb`, when only `back` releases them. On fire goes at once, `brb` or not: a lane death with work still open, the ceiling question (at 80 %, and again when the lane stops at 100 %), a lane that stopped at its ceiling, and a red or errored full-suite run.
- **Count line:** every push and every turn carries `open answer lines: N`, and Ilex ends each message with ``N others waiting: `pending` shows them all`` (or `nothing else waiting`) instead of re-listing older items. After 30 minutes without typing, your next turn gets the complete list once.
- **Workload block:** `brief:`, `done:`, then the one-liner
  `stakes: normal · mode: autonomous · plan first: <why> — flip either with one word: … · ceiling $50 / 6h`,
  then `spent $12.4 of $50 · 95.2 of 360 min`, the lane and its lease, `slices:`, `open questions:`, and the last 8 ledger entries.

## 5. Who does what

| Who | Does | Does not |
|---|---|---|
| Ilex | routes, opens and closes workloads, records Jo's answers | close slices, dispatch hands, raise a ceiling, run commands for Jo |
| Lane | builds inside the fence; adds and completes slices; raises questions | run the full test suite; push past gate refusals |
| Plumb | pushes what a lane cannot | |
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
- **Spend at 100 %:** the lane has stopped. Answer `extend`, or set `ceiling <usd> [<hours>] wl-…`.
- **Lane died:** the line names the lane. `as2 lane log <wl>` tails the runner log.
- **Lane ended with work open:** `lane … ended (parked) with 2 open slice(s) and no question`. Tell Ilex to relaunch it (`relaunch wl-…`), close it, or what to do instead; the line is pushed once per ending, between wakes.
- **Held 4h:** a workload with no lane and no activity. Flip to `autonomous`, or run it by hand with `as2 lane <wl>`.
- **Blocked on a prompt:** answer it in that lane's session, or end the session.
- **Cannot close:** open slices, paused slices or open questions remain, or a lane still holds the lease (`as2 lane stop <wl>`).
- **"which one?":** the word fit several lines or, for a stakes, mode or `ceiling` word, several open workloads. Answer by number, or add the `wl-…` id it lists.
- **A word did nothing:** a bare stakes, mode or `ceiling` word with several open workloads gets "which one?" instead. It does nothing only when its `wl-…` id is not an open workload, or the `ceiling` figures do not parse. Check the id or the figures.
- **Stakes raised mid-run:** a review slice is not added automatically. Ask Ilex for one.

## Doc vs parser

- The q-id is inside the parentheses near the start of the question line, not at its end.
- `tiers/orchestrator.md` gives the ceiling word as `ceiling <usd> [<hours>]`; the parser also takes a `wl-…` id.
- `user driven` (two words) is not accepted at the surface; type `user-driven`.
- A comment in `surface/src/stakes.ts` lists "plan it" as user-driven; the code treats it as plan-first only and leaves mode alone.
- `tiers/orchestrator.md` says `withdraw` replans a slice; on the ceiling question it cancels instead.
- `green` / `red` and similar are options a lane chooses for its question, not fixed words in the parser.
- A stakes or mode word followed by a `q-…` id answers that question (`autonomous q-…`) in a single message and in a paste, and flips nothing; a bare `autonomous` still flips mode. Followed by an `en-…` id it is refused: a reserved action takes only `approve` or `deny`.
