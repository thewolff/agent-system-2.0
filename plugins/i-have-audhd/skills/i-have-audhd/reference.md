# i-have-audhd — reference

What the plugin's hooks do with the rules in [`SKILL.md`](SKILL.md): the enforcement
scoreboard, every check's and trigger's contract, the judge machinery, the session-start
injection, and the operator-profile schema including `enforcement`. Rule numbers below are
the skill's.

## The scoreboard

**A model-graded check that runs automatically inside a hook is still machinery.** It fires
on a deterministic trigger, it returns pass or fail, and every dispatch failure mode
(timeout, non-zero exit, unparseable output) is deterministic and fail-open. It is a
different instrument with a different error profile, not a non-enforcement.

| Check id | Skill rule | Instrument | Trigger / condition | Default mode |
|---|---|---|---|---|
| `needs-you-first` | 1, Skeleton | Deterministic — `checkNeedsYouFirst` | A needs-you marker exists and substantive prose precedes it | warn |
| `closing-ask-last` | 1, Skeleton | Deterministic — `checkClosingAskLast` | A closing-ask marker exists; more than one, or substantive prose follows the ask section | warn |
| `do-not-batch-by-label` | 1, Skeleton (caveats beside what they qualify) | Judge-in-hook — `findTrailingBatchSection` | A trailing labeled section (Uncertainties, Open questions, Questions, Caveats, Notes — configurable) with substance | warn |
| `conclusion-first` | 1, Skeleton (body, conclusion first) | Judge-in-hook — `conclusionFirstApplicable` | Per labeled section (the whole message when it has no block labels): ≥ 400 substantive chars; the judge reads the section's opening 20 words | warn |
| `plural-back-reference` | 6, References survive without scrolling | Deterministic — `checkPluralBackReference` | A closing-ask marker exists and its ask uses *those, these, both, them, the two, either one* with no referent in the same sentence | warn |
| `restate-resumed-thread` | 8, Resume by restating content | Injector marker + judge | Session source was resume/compact; first substantive message after it | warn |
| `name-the-artifact` | 11, Machinery anchors | Deterministic — `checkNamesArtifact` | Report-shaped (≥ 400 chars + a report verb) and no artifact token anywhere | warn |
| `report-what-you-did-not-do` | 11, Machinery anchors | Todo trigger + judge | The transcript's last todo write has items not completed | warn |
| `bad-news-first` | 11, Machinery anchors | Lexicon gate + judge | Per labeled section (the whole message when it has no block labels): ≥ 200 chars and a negative-lexicon word in substantive lines; the judge reads the section's opening 20 words | warn |

Every warning and block reason names its skill rule, for example
`Needs you first (i-have-audhd rule 1, Skeleton) — …`, so a finding points at text the
model has, or can load.

**The one boundary that stays absolute:** *report what you did not do* is enforced exactly
where a todo list exists. **With no tracked plan the violation is silence and no instrument
sees it** — no check of emitted text can detect an omission with no corresponding plan item.
Likewise no instrument here decides whether a named artifact is the *right* one; that
remains the reader's judgment.

**Measured, not claimed — 2026-09-21, one real corpus.** 304 final assistant messages, 46
sessions, 11 seats, 2026-09-16 → 09-21; every flag hand-adjudicated; judge dispatch via
`codex exec --skip-git-repo-check -` (75 calls, 0 errors, 0 unparseable, median ~10.7s).
These adjudicated false-positive rates are why every default in the table above is `warn`:

| Check | Measured on | Flags / violations | Adjudicated FP | Verdict and the fix that would re-earn block |
|---|---|---|---|---|
| needs-you-first | 45 applicable | 18 flags | **16 (89%)** — a type-label line plus a short opener counted as substantive preceding prose | warn; treat a label line + short opener as non-substantive, or graceChars covering it |
| closing-ask-last | 41 applicable | 18 flags | **17 (94%)** — the ask section ends before the question's paragraphs and the attached recommendation | warn; the ask section must extend through the question, a following fence, and an attached recommendation paragraph |
| name-the-artifact | 198 applicable | 4 flags | **0 (n=4)** — all four genuine artifact-less reports | warn; a second corpus at 0 FP justifies block |
| do-not-batch-by-label | 50 sampled | 0 triggers | unexercised | warn; unmeasured, not proven |
| conclusion-first | 46 judged | 3 violations | **3 (100%)** — receipt-first openers (the command and its result, then the verdict) read as buried conclusions | warn; add the receipt-first shape to the judge question's compliant list |
| bad-news-first | 29 judged | 15 violations | **10 (67%)**, with 5 true positives | warn; raise the judge's bar to present-unresolved-cost |
| restate-resumed-thread, report-what-you-did-not-do | — | — | not measurable retroactively (resume markers are runtime; todo triggers need transcript todo writes) | warn; unmeasured |
| plural-back-reference | — | — | not yet measured (new in 1.0.0) | warn; unmeasured |

**Arming block is one explicit config flip** — `enforcement.mode: "block"`, or per-rule —
and the re-arming criteria are the recalibration directions above plus a second corpus. A
check whose measured rate is ~90% FP must not stop turns by default. The same measurement
says the machinery catches real violations — 2 + 1 + 4 deterministic true positives and 5
judge true positives, including bad news buried behind "nothing is broken" — so the
instrument is live, not parked. The adjudications, with per-flag pointers, are kept in a
private file on the measuring machine (mode 0700) and are not published, because they
contain real message bodies.

**Second corpus — 2026-10-14, the 1.1.0 checks.** 469 final assistant messages (410 OMP seat,
59 Claude Code), 2026-10-07 → 10-15, every rule at warn, the 1.1.0 Stop CLI unchanged, judge
`anthropic/claude-haiku-5-5` (881 calls, $0.19 total, $0.0004 per message, p50 2.2s, p95
4.3s, 0 failures). Every flag got three independent votes: `claude-opus-5-5`, `codex exec`
(gpt-6-astra) and `gpt-5.6-sol`; the FP rate below is the majority of three. The bar for
block was FP ≤ 10% on ≥ 15 flags.

| Check | Gate fired | Flags | FP, majority of 3 | Verdict |
|---|---|---|---|---|
| needs-you-first | 62 | 12 | 4 (33%) | warn |
| closing-ask-last | 39 | 6 | 3 (50%) | warn |
| plural-back-reference | 39 | 5 | 2 (40%) | warn |
| name-the-artifact | 271 | 2 | 0 (n=2) | warn; too few flags |
| do-not-batch-by-label | 0 | 0 | unexercised | warn |
| conclusion-first | 329 | 13 | 3 (23%) | warn |
| bad-news-first | 186 | 19 | 2 (11%) | warn; just over the bar, and opus-5-5 alone called 37% FP |
| report-what-you-did-not-do | 45 | 39 | 1 (3%) | warn: the 39 flags come from two sessions (32 and 7) re-checking the same unfinished todo lists, so they are two observations, not 39; opus-5-5 alone called 21% FP, mostly "the todo list is stale and the message implies each status" |
| restate-resumed-thread | 15 | 0 | — | warn |

No check earned block on independent evidence. The measurement scripts, corpus and votes
stay on the measuring machine for the same reason as the first corpus.

## The session-start injection

`hooks/i-have-audhd-inject.mjs`. stdin: the SessionStart payload (`session_id`, `source`,
optionally `reason`). stdout: one `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}`
object. Exit 0 on every path.

`additionalContext` is, in order: one hook-owned line saying the person in this session
installed these rules and that they apply to every message to that person; the span of
`SKILL.md` between `<!-- inject:start -->` and `<!-- inject:end -->` (the first-turn core
and every rule heading); the profile's `reader` and `traits`, when set; and one line
pointing at this file and the kill switch. The span is read from the skill file each time,
so there is one copy of the core and it cannot drift. `I_HAVE_AUDHD_INJECT=off` silences the
emission (the resume marker below is still written).

When `source` is `resume` or `compact` (or `clear` with a reason mentioning compact, an
assumed shape), the injector writes the one-shot resume marker the Stop hook consumes for
rule 8.

**Delivery per host.** Claude Code runs the hook from `hooks/hooks.json` on every
SessionStart source (startup, resume, clear, compact). OMP does not run `hooks.json`; the
plugin's OMP extension, `omp/i-have-audhd-omp.ts`, spawns the same hook on the main
session's `session_start` (source `startup`, or `resume` when the session already holds
messages), on `session_switch` (`new` → `clear`, `resume`/`fork` → `resume`) and on
`session_compact` (`compact`). It offers the returned `additionalContext` to every
`before_agent_start` as a hidden custom message tagged with a per-crossing delivery id, so a
re-run of the preparation chain for the same prompt keeps it, and stops offering it once a
`context` event shows a model request carried that delivery. Subagent sessions get neither
the injection nor the Stop hook.

## The Stop hook

`hooks/i-have-audhd-stop.mjs`. stdin: the Stop payload (`session_id`,
`transcript_path`, `stop_hook_active`; OMP payloads additionally `last_assistant_message`).
stdout: one `{"decision":"block","reason":"…"}` object when a block-mode rule fired,
nothing otherwise. Exit 0 on every path.

Order of operations, each early return silent:

1. **Kill switch** — `~/.claude/.i-have-audhd-off`, `existsSync` per invocation
   (never a module-scope env read; env is frozen for the host process's lifetime).
   `I_HAVE_AUDHD_ENFORCE=off` is the secondary switch and costs a host relaunch.
2. Payload parse — unparseable stdin → `errors.log`.
3. Text extraction — `last_assistant_message` when a non-empty string, else the transcript
   JSONL scanned backwards for the last `type:"assistant"` entry with text content
   (tool-call-only entries are skipped).
4. **Loop guard** — with `stop_hook_active`, a text hash equal to the recorded one passes:
   never block the same message twice. This runs before any check, on both harnesses.
5. **Master floor** — under 200 substantive chars, nothing runs.
6. Deterministic checks per their modes.
7. Judge jobs where triggers fired; a fired trigger with no judge command → `skipped.log`.
8. **Harness cap** — only when the env carries `I_HAVE_AUDHD_HARNESS=omp` (the OMP
   adapter sets it on its child; Claude Code never does). Every block-mode finding becomes
   warn when `enforcement.armOmp` is not `true`, or when it is and the payload carries
   `stop_hook_active`: a revision after a block is re-checked but never blocked twice. On
   OMP that payload flag is the adapter's, not the host's: OMP sets its own flag after any
   extension's continuation, so the adapter sends `true` only when the host flag is set and
   its previous result for the session was a block.
9. One block-mode finding emits the block and records the hash; warn findings, capped ones
   included, → `warnings.log` with their real rule id, and replace the session's
   `pending-warn-<session>.json` (a stop with none removes it). Reasons name the check and its
   skill rule and say what to move or add. A block also asks for corrected lines only — never
   a resend of the whole message; a warn does not, because its message has already gone out.
10. **Warn delivery, next turn.** `lib/pending.mjs` turns the warn findings into a short
   notice for the agent ("warning only; it was sent unchanged; apply each fix from your next
   message on", one capped line per finding) and a one-line summary for the person. Claude
   Code: `hooks/i-have-audhd-prompt.mjs` on `UserPromptSubmit` consumes the file and returns
   the notice as `additionalContext` and the summary as `systemMessage`. OMP: the adapter
   spawns the same CLI right after the stop and queues the notice with `sendMessage`
   (`deliverAs: "nextTurn"`, no `triggerTurn`), which OMP adds to the next prompt; the
   summary is a UI warning notice. Consumption deletes the file, so a notice arrives once.

Fail-open everywhere with `errors.log` as the single failure channel.

On OMP the hook runs only for the main session: OMP's `session_stop` never fires for
subagent sessions, and OMP has no blocking equivalent of Claude Code's `SubagentStop`. The
plugin registers no `SubagentStop` hook on Claude Code either.

## The checks (deterministic)

All four: plain-object results, never throw, options as a second argument, `markers`
supplied by the caller REPLACE the default, and a stdin-or-file CLI that prints one JSON
object and exits 0. Line semantics are shared (`checks/lines.mjs`): headings are
navigation; fences, HTML-comment envelopes, blockquotes, and blank/structural lines carry
nothing (a comment opened mid-line runs to its `-->`, the text before the `<!--` still
counting; a fence marker inside a comment is comment text; a `<!--` in inline code is text);
markers are line-anchored and matched after stripping hashes, bullets, emphasis,
and a trailing colon — so `## Needs you`, `**Needs you**`, and `Needs you:` are one marker,
while `Needs you: two things` (content on the marker's own line) is not one.

### needs-you-first

`checkNeedsYouFirst(text, options)` → `{applicable, flagged, reason, markerLine,
prosePrecedingChars, proseChars}`; `reason` ∈ `below-floor | no-marker | marker-first |
prose-precedes-marker`. Options: `markers` `["Needs you"]`, `minProseChars` `200`,
`graceChars` `0`. Flags misordering only, never absence — the anti-ceremony argument the
README carries. Judged on the FIRST marker, so an interleaved message is not punished.

### closing-ask-last

`checkClosingAskLast(text, options)` → `{applicable, flagged, reason, markerLine,
markerCount, proseAfterChars, proseChars}`; `reason` ∈ `below-floor | no-marker |
single-ask-last | multiple-markers | prose-after-ask`. Options: `markers`
`["Closing ask"]`, `minProseChars` `200`, `graceChars` `0`. The ask SECTION is the marker
line plus the one paragraph after it (blanks skipped; a heading or fence directly after the
marker ends it empty). That paragraph is the ask itself; substantive prose in any later
paragraph or under any later heading is the overtime finding. Counts every marker — two is
the `multiple-markers` finding.

### plural-back-reference

`checkPluralBackReference(text, options)` → `{applicable, flagged, reason, markerLine,
askText, hits}`; `reason` ∈ `no-marker | empty-ask | no-plural-reference | referent-in-sentence |
referent-outside-sentence`; each hit is `{word, line, sentence}`. Options: `markers`
`["Closing ask"]`, `lexicon` `["those", "these", "both", "them", "the two", "either one"]`
(whole word, case-insensitive). The ask is the first marker's section, exactly as
`closing-ask-last` defines it. No length floor of its own: the Stop hook's 200-char master
floor gates it. Inline code is never searched for lexicon words.

A hit is acquitted when its sentence names the referents itself:

- a correlative — `both A and B`, `either one of A or B` — where A is not `of`, `and` or
  `or`, so `both of the files named above` stays a hit;
- an apposition — the word, at most one noun after it, then `:`, `(` or a dash and a list
  joined by `and`, `or` or commas (`merge the two branches: the auth fix and the cache fix`);
  or a `,` followed by two or more named items (``merge the two, `a.ts` and `b.ts` ``), so a
  following clause (`merge them, or leave them`) stays a hit;
- a named antecedent — `them`, `those`, `these` or `both` preceded in the same sentence by
  two or more named items (inline code spans or double-quoted strings).

Everything else is flagged, because the referent is outside the sentence:
`Should I merge those?` and `Should I merge both of the files named above?` flag;
``Should I merge both `foo.ts` and `bar.ts`?`` does not. Warn by default and unmeasured.

### name-the-artifact

`checkNamesArtifact(text, options)` → `{applicable, flagged, reason, proseChars,
matchedVerb}`; `reason` ∈ `below-floor | no-report-verb | artifact-named |
no-artifact-named`. Options: `minProseChars` `400`, `reportVerbs` `[fixed, added, updated,
changed, removed, built, shipped, ran, verified, wrote, refactored, installed, committed,
pushed]` (whole-word, case-insensitive). Applicable only when report-shaped. Satisfied by
any of: an absolute / home / relative path, a `file.ext:NN[:MM]` token, a fenced block, an
inline code span, a URL, or a line whose first word (after an optional prompt) is a common
command. **A vocabulary check, labeled as one** — hence warn by default.

## The triggers (deterministic halves of judge rules)

- **`triggers/batch-heading.mjs`** — `findTrailingBatchSection(text, {headings})` →
  `{applicable, heading, headingLine, sectionText, sectionProseChars}`. The matched heading
  must be the last heading in the text; bold pseudo-headings (`**Notes**`) count; the
  section must contain prose. `batchJudgeContext(text, section)` marks the section for the
  judge.
- **`checks/sections.mjs`** — the units `conclusion-first` and `bad-news-first` judge.
  `splitLabeledSections(text)` → `[{label, line, text}]`. A label line is a prose line
  (never fenced, commented or quoted) that is exactly one bold label from `PMDW`, `CLAIM`,
  `CITE`, `GUESS`, `ACTION`, `QUESTION`, optionally with a basis inside the bold
  (`**GUESS(inference)**`) and a trailing colon; an inline or bulleted bold label is not.
  No label line → one unit, the whole text, judged as before 1.1.0. Otherwise the text before
  the first label is a preamble unit and each label line opens a unit running to the next;
  the label line is dropped from the unit, and a heading, blank or rule run directly above a
  label belongs to the section that label opens. `openingWords(text, 20)` is a unit's
  opening window: the first 20 words of its heading and prose lines (markup stripped,
  crossing line and sentence breaks). The label set and the window size are constants, not
  profile settings.
- **Per-section judging** — the Stop hook runs each gate on each unit and sends one judge
  job per qualifying unit, its `contextText` the unit's text only. The question carries the
  unit's window (`The reader's first 20 words here are: "…"`) and, for a unit of a labeled
  message, one framing sentence naming the section (`**CLAIM**, line 12`) and telling the
  judge to judge it alone; both sit outside the judged message. Each rule yields one finding
  naming every violating section in line order (`**CLAIM** at line 12 — judge: …`); an
  unlabeled message keeps the whole-message wording. A judge error on one section fails open
  for that section only.
- **`triggers/conclusion-first.mjs`** — `conclusionFirstApplicable(text, {minProseChars})`
  → `{applicable, proseChars}`. Default 400, per unit. The two-paragraph minimum it carried
  until 1.1.0 is gone: with "at the start" meaning the first 20 words, a single 400-char
  paragraph can bury its point at word 40.
- **`triggers/todo-unfinished.mjs`** — `lastIncompleteTodos(jsonl)` → `{applicable,
  incomplete, total}`. Scans backwards; the first todo snapshot decides. Claude Code:
  a `tool_use` whose name mentions `todo` (TodoWrite / todo), items from `input.todos`.
  OMP: the state is read exactly the way OMP rehydrates it (`canonicalTodoPhases`). A
  snapshot is a `custom` `user_todo_edit` entry (written by the eval bridge, `/todo` and the
  HUD editor) or a `toolResult` with `toolName` exactly `todo` that is not `isError` and whose
  `details.op` is not `view`; each carries the full list as `phases[].tasks[]`. Error and
  view results, and entries without a `phases` array, are passed over as OMP passes over them,
  and their calls do not end the scan; a todo call met before its own result (result
  missing) is a miss. A snapshot that fails OMP's `isTodoPhase` shape (string phase `name`,
  `tasks` array, string task `content`, status one of `pending`, `in_progress`, `completed`,
  `abandoned`, `blocked`) is unreadable, never an `[unknown]` item. Claude items are read
  defensively (`content|subject|text|title`, case-insensitive statuses); `completed`/`done`
  are complete, everything else is unfinished, including OMP's `blocked` and `abandoned`
  (dropped). It **skips on any parse miss** — a false "unfinished item" would be a false
  accusation in a block reason. `todoJudgeContext(text, todos)` appends the unfinished list,
  each item with its exact status and, for OMP, its phase (`- [abandoned] (Ship) Open PR`).
- **`triggers/bad-news-lexicon.mjs`** — `badNewsGate(text, {lexicon, minProseChars})` →
  `{applicable, proseChars, hits}`, per unit. Lexicon `[failed, failure, error, broke, broken,
  blocker, regression, cannot, can't, rejected, lost, missed, wrong]`, matched at word
  start (so "errors" matches, "terror" does not) over SUBSTANTIVE lines only. Deliberately
  over-inclusive: "fixed the error" trips the gate and is exactly the message the judge
  must acquit.
- **The rule 8 trigger is split across the hooks**: the injector writes
  `state/resume-<session_id>` when the SessionStart source is `resume` or `compact` (or
  `clear` with a reason mentioning compact — an assumed shape, documented); the Stop hook
  consumes the marker on the first substantive message after it. Consumption precedes
  dispatch, so the judgment is one-shot even with no judge configured. On OMP the adapter
  sends both hooks the session manager's id rather than the provider id in the
  `session_stop` payload, which a fresh-session or context reset rotates (that payload id
  stands in only when the manager id is unreadable); the marker it writes is the one its
  Stop consumes.

## The judge machinery

`judge/ask.mjs` — `askJudge(rule, question, contextText, config, options?)`; options
`{timeoutMs, stateDir}` exist for the test suite. Never throws.

- **Command** from `enforcement.judgeCommand`: with a `{prompt}` placeholder, the prompt is
  shell-escaped into the command; without one, the prompt is piped to the command's stdin.
  `null`/absent = judge rules inactive (the hook logs fired triggers to `skipped.log`).
- **Output**: STDOUT ONLY is captured (judges print banners on stderr; merging the streams
  puts noise in front of the JSON). The LAST JSON object on stdout is the verdict; a
  `{"type":"result","result":"…"}` envelope is unwrapped one level. The verdict must be
  strictly `{"violation": <boolean>, "reason": <string>}`.
- **Failures** — timeout, non-zero exit, unparseable output — return
  `{violation: false, error: …}` plus a `judge-failures.log` line. Fail-open, fail-loud-
  in-log. Failures are never cached.
- **Timeout** — 30s on Claude Code; 20s when the stop core runs under the OMP adapter's
  `I_HAVE_AUDHD_HARNESS=omp` tag, because OMP drops a `session_stop` handler's result at 30s
  and the adapter kills the core at 25s. Nothing in the profile changes either value.
- **Cleanup** — the judge runs in a process group of its own; when it answers, fails, or
  times out, the whole group is killed and its pipes are released: a pipeline stage or a
  child still in the group does not outlive the stop, and a process that left the group
  cannot hold the hook open.
- **Cache** — `sha256(prompt)` → `state/cache/<hash>.json`, written only on a successful
  verdict. The key is the whole prompt (rule, question, message), because the
  `conclusion-first` and `bad-news-first` questions vary per unit (window and section
  framing). Same prompt, same verdict, one bill; cache files from before 1.1.0 stop matching.
- **Example command** (stdin form): `codex exec --skip-git-repo-check -`. Any command that
  prints the verdict object on stdout and exits 0 inside the timeout works; run the one you
  configure once by hand, with a short prompt on stdin, before relying on it.

## Operator profile schema

JSON at `$I_HAVE_AUDHD_PROFILE` or `~/.claude/i-have-audhd.json`. Every field optional; an
empty object is valid and yields the defaults.

```json
{
  "reader": "the person you are reporting to",
  "traits": ["reads the first two lines of any message and skims the rest"],
  "enforcement": {
    "mode": "block",
    "judgeCommand": "codex exec --skip-git-repo-check -",
    "rules": { "name-the-artifact": "warn", "bad-news-first": "warn" },
    "armOmp": false
  }
}
```

- **`reader`** — short noun phrase, emitted verbatim at session start.
- **`traits`** — plain sentences about how that person reads, emitted verbatim after the
  skill's core. The plugin ships none.
- **`enforcement.mode`** — `block | warn | off`. Unset = each rule's built-in default (warn
  for every rule — the measured default above); set = overrides built-ins both ways.
- **`enforcement.judgeCommand`** — see the judge section.
- **`enforcement.rules`** — per-rule mode overrides, keyed by check id; beat the global
  mode and built-ins.
- **`enforcement.armOmp`** — boolean, default `false`. Read only under the OMP harness tag
  (stop-hook step 8): `true` lets OMP seats block on a first stop; anything else keeps them
  at warn. Under the tag a non-boolean is one `errors.log` line and reads as `false`;
  without the tag the field is never read, so a malformed value logs nothing.
- Precedence: kill-switch file > `rules[rule]` > explicit `mode` > built-in default, then
  the OMP harness cap last (OMP seats only: unarmed → warn; armed + a revision after this
  plugin's own block → warn). The same-text loop guard precedes all of it.

A missing file or field is silent defaults. An unparseable file, or a value of the wrong
shape, is defaults plus one `errors.log` line — a config failure reads exactly like a
working config otherwise.

**Check options are not profile fields.** `markers`, `minProseChars`, `graceChars`,
`headings`, `lexicon`, `reportVerbs` are call-site arguments; the hook calls every check on
its defaults.

**Keep the profile out of version control if it describes a real person.** A trait sentence
is attributable to whoever owns the repository it sits in, and a pushed commit survives in
forks and caches after any later deletion.

## State files

All under `~/.claude/.i-have-audhd-state/`:

| File | What it holds |
|---|---|
| `warnings.log` | Warn-mode findings, one line each, rule named — the record |
| `pending-warn-<session>.json` | The latest checked stop's warn findings, waiting for the next turn — the delivery; deleted when consumed |
| `skipped.log` | Judge-rule triggers that fired with no judge command — a skipped check must be inspectable |
| `judge-failures.log` | Judge dispatch failures (timeout, exit, unparseable), rule and error named |
| `errors.log` | Every fail-open path: payload parse, config parse, hook exceptions, OMP adapter fail-opens |
| `last-blocked-<session>.json` | The loop guard's recorded text hash and rules |
| `resume-<session>` | The one-shot rule 8 marker (timestamped) |
| `cache/<hash>.json` | Judge verdicts |
