# Output types: claim and cite

Label receipted facts, and only those. A fact you checked carries **CLAIM** and its
receipt; a fact from an outside source carries **CITE** and its source. Everything else is
plain, unlabeled prose, and **unlabeled means not backed by a receipt**: inferences,
recollections, framing, recommendations, questions, and reports of what you did. The reader
trusts a label and weighs everything else themselves, so a label on an unreceipted
sentence is the one failure that costs them.

This file is the single source of truth for the contract. The `output-types` skill points
here, and the plugin's session-start hook injects the span between the `inject:start` and
`inject:end` markers below, read out of this file. Editing that span edits what every session
receives. If a rule changes, it changes here.

<!-- inject:start -->
Output types: label receipted facts, and only those. A fact you checked carries **CLAIM**
and its receipt; a fact from an outside source carries **CITE** and its source. Everything
else is plain, unlabeled prose, and **unlabeled means not backed by a receipt**: inferences,
recollections, framing, recommendations, questions, and reports of what you did.

**The label is set by whether a receipt is attached, not by how confident you feel.** A
statement with no receipt stays unlabeled, however certain it sounds.

- **CLAIM**: a fact from first-party evidence inspected this session. Receipt: an absolute
  file-and-line or stable artifact anchor, or the exact command or tool call plus its
  relevant output.
- **CITE**: a fact from an external source, including how any third-party system behaves.
  Receipt: the URL actually fetched this session plus the passage that says it, or a live
  test run this session.

A label that leads a block sits alone on its own line in markdown bold (`**CLAIM**`), with
the statement on the next line; a label inside a sentence stays inline. Never use ANSI
escape codes; they render as literal garbage. Actions are reported in plain prose with the
command, its result, and how to undo it.
<!-- inject:end -->

## The two labels

**The label is set by whether a receipt is attached, not by how confident you feel.** A
statement with no receipt stays unlabeled, however certain it sounds.

| Label     | What it is | Required receipt |
| --------- | ---------- | ---------------- |
| **CLAIM** | A fact established from first-party evidence inspected this session: a local artifact, observed system state, a current work record, or an attributed statement. | Something that makes the evidence inspectable: an absolute file-and-line or stable artifact anchor; the exact command, query, or tool call plus its relevant output; a live observation with its tool record; or an upstream receipt preserved without broadening the conclusion. |
| **CITE**  | A fact from an external source, **including how any third-party system behaves**. | The URL actually fetched this session plus the passage that says it, or a live test run this session. |

**CLAIM is defined by provenance, not by subject.** An attributed statement proves that the
person or record said it, not every implication of it. A live test proves what the test
observed, not a universal rule about the system tested.

What counts as a receipt: vendor docs freshly fetched, a live test actually run, code
actually read, a published changelog. Filenames, route paths, table and column names,
env-var names, prior-session memory, and training-data instinct are **not** receipts.

### Unreceipted statements

Write them as plain prose, and let the wording carry the hedge where it matters ("probably",
"did not read the call site"). When a diff, a plan step, or a recommended fix rests on
something you only remember, say so at the top of the report as a blocker.

## Receipts

**A `file:line` receipt is an absolute path, derived and never composed.** There is no
canonical checkout location, so take the root from what already knows it: the path a
read, search, or glob tool returned, or `git rev-parse --show-toplevel`. A relative path
resolves against a working directory the reader does not have, and a path that cannot be
opened has been verified by nobody but its author.

Examples in this file write `<repo-root>` where a real report carries the actual absolute
root. It is a slot; never emit it literally.

This governs the receipt, not the prose. Sentences may say "the handler in `feeds.ts`", and
commit messages and diff hunks keep the repo-relative form their tools emit. Two paths are
exempt because they are already unambiguous: a path inside a fenced command with a stated
working directory, and a path quoted verbatim from tool output.

Keep receipts terse: `<repo-root>/src/server/routes/citations.ts:88`, `npm test → exit 1,
3 failing`. The receipt proves the check happened; it is not an evidence dump.

### Citations written INTO a document

A reference written into a committed file (a decision log, a project doc, an `AGENTS.md`, an
issue body) uses a **stable anchor**: a heading, an HTML comment marker, or a distinctive
quoted string. A line number may ride along, never alone. A stale `file:line` still
resolves to *a* line, so it fails silently; every edit above it moves the target.
Self-check: would this citation still find its target if fifty lines were inserted above it?

## Rules

1. **No receipt, no label.** "I could not verify X" is a successful report.
2. **Restating never adds a label.** An unreceipted statement stays unlabeled across the
   subagent-to-parent boundary, through summaries, and into later turns. A parent labels it
   CLAIM only after checking it.
3. **Third-party semantics are never vocabulary.** How an external system behaves (a
   database return code, an SQL operator, a vendor default, a runtime limit, a framework
   convention) is a CITE-or-test statement. Without a fetched URL or a command run this
   session it stays unlabeled, however elementary it feels. *"Everyone knows `-2` means the
   key is missing"* is the shape of this failure: it reads as vocabulary, slips past the
   self-check, and lands in a plan as fact. Proper nouns are the same: an unfamiliar name,
   product, or reference is unverified until the person who used it says what it is.
4. **Cheap to check beats leaving it unlabeled.** Before leaving a statement another
   decision depends on unreceipted, ask whether a tool in hand settles it in under a minute
   (one query, one curl, one grep, one read). If so, run it. Passing remarks stay unlabeled;
   the test is "would being wrong here change what happens next?" A check that cannot
   disconfirm is not a check: state what a null result would rule out before running it.
5. **Mind-reading is never a CLAIM.** An inference about what a person meant, wanted, or
   intended stays unlabeled and says what evidence it rests on.
6. **A receipt licenses only what it literally shows.** Where a sentence reaches past its
   receipt, the reaching part is unreceipted, *even with a real receipt right beside it*:
   keep it out of the labeled block. The common shape is a category jump: a code receipt
   proves what the code **does**, never whether that behaviour is **wanted**. *"These lines
   guard against a null timeline"* is a CLAIM; *"so nothing breaks"* is an unreceipted guess
   about intent wearing the first one's receipt. The lesson from the case behind this rule:
   true receipts, a wrong conclusion, a passing test that encoded the error, several reviews
   that cleared it, and a feature silently lost, because each review checked that a receipt
   was present and none checked that it covered the conclusion.
7. **A figure reused in a new context is a new claim.** Same number, new audience,
   comparison, or decision: the sentence needs its own receipt. This failure feels like
   recall, so it never triggers a check. Mechanical form: about to state a figure you did
   not produce with a tool call **in this turn**? Say where it came from or re-derive it.
   For a subagent, every figure in the delegation prompt is inherited: say "the brief's
   figure, not mine" and leave it unlabeled unless you reproduced it. The lesson from the
   cases behind this rule: a measurement restated an hour later reads as a summary, so
   nobody asks whether it answers the new question, and it often does not.

## What stays unlabeled, and what it still owes

Labels are for receipted facts. These obligations hold in plain prose:

- **Actions** state the command, its result (exit code or outcome), and how to reverse it,
  inline. Failed and skipped steps are reported too.
- **Decisions for a person** go last in the message, restate their subject in full so the
  sentence survives being read alone, name the options and what each changes, and carry a
  recommendation. A blocker (missing evidence another check could close) goes at the top.
- **Recommendations** are proposals; say so in the sentence rather than presenting them as
  findings.
- **The person's own reports** are starting constraints, not unverified claims. Never label
  or discount what they tell you; investigate it.

## Rendering

A label that leads a block sits alone on its own line in markdown bold, with the statement
on the next line. A label inside a sentence or bullet stays inline and bold.

> **CLAIM**
> citation records are written in `<repo-root>/src/server/routes/citations.ts:88` via `saveCitation`.
>
> The client probably calls this through `ApiClient.post`; I did not read the call site.
>
> Ran `npm run lint` → exit 0. Nothing to undo.

Markdown bold is the only styling. ANSI escape sequences render as literal garbage.

A table whose rows are assertions gets a `Type` column (CLAIM, CITE, or blank for
unreceipted) and a `Receipt` column. Layout tables (a glossary, a port list, a file
inventory) carry no Type column.

## Degraded reports

A report that could not meet the contract says so at the top, in prose:

- **Degraded verification**: receipts were unobtainable (no network, blocked tool, service
  down). Most of the report is unlabeled, and it names what would have been checked and what
  prevented it.
- **Degraded coverage**: only part of the ask was reachable. State what was covered and what
  was never opened, so the covered part does not imply completeness.
- **Structural failure**: return what was attempted and how it failed. A smooth unlabeled
  report is worse than an error, because the parent treats subagent output as
  authoritative.

**Parent-side:** a substantial subagent report of findings with no CLAIM or CITE labels at
all is unverified; do not act on it, re-delegate or verify directly. Carry any degradation
forward when relaying, and relay unlabeled statements unlabeled.

## Commands handed over for a person to run

**Rule zero: hand over only what you cannot run yourself**: another machine, credentials you
lack, an operation the person must gate, or a genuine permission boundary. Everything else
you run and report as an action. A handed-over command is a proposed action: it carries the
command, what it does, and its undo, and it survives being read alone hours later.

1. **Every correction reissues the whole thing, runnable from cold.** Never "same as before
   but with X."
2. **More than one command, or any interactive input, means a script file** in a scratch
   directory outside every git repository and anything a repo's tooling cleans (for example
   `~/agent-scratch/<repo-name>/`): a worktree-isolated session cannot write into a
   checkout, and a cleaned scratchpad takes the undo path with it. The person types one
   unchanging line, the interpreter matching the shebang plus the path; corrections edit the
   file.
3. **Every script is safe to run from the top, every time.** No step depends on a previous
   run.
4. **Prose never sits between pasteable blocks.**
5. **Test the syntax against the shell the person actually runs** (`echo $SHELL`). Prefer
   forms that work in bash and zsh: `printf 'Type MOVE to proceed: '` then `read -r REPLY`.
   `read -p` is bash-only and fails in zsh with `read: -p: no coprocess`; `read -rs
   "VAR?prompt: "` is zsh-only and hides input.
6. **Scripts announce each step, stop on the first failure, and log themselves** to a fixed
   path beside the script (`exec > >(tee "$LOG") 2>&1` in bash or zsh; under POSIX `sh`,
   pipe the body to `tee`). Then the failure message is one sentence naming the log path,
   and the agent reads the log itself. Never ask the person to diagnose or paste output
   back.
7. **Destructive steps preview, confirm, and print their undo.** Prefer a reversible staging
   step (move to quarantine) over an irreversible one.

## Weighting by role

- **Searching and reading**: nearly all CLAIM with receipts. An empty search is reported as
  empty, not reasoned about.
- **Research**: CITE-heavy; an unfetchable source is said to be unfetched, unlabeled.
- **Implementation and debugging**: mostly action reports (command, result, undo), with
  CLAIMs for what tests and reads showed.
- **Planning and narrative**: mostly unlabeled; a plan is a proposal.
- **Review and audit**: every finding is a CLAIM with a receipt, or an unlabeled concern
  ranked below those that have one.

## Propagating this contract

Subagents do not see this file unless told to. A delegation prompt to a substantial agent
names the `output-types` skill or restates the two labels, the receipt rule, and rules 3, 6
and 7 in substance, on the first dispatch and every follow-up.
