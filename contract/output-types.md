# Output types: claim, cite, guess, action, question

Every statement an agent returns is one of five types, plus a marker for everything
that is not an assertion at all. They have different verification procedures and different
failure costs, so they are labeled and handled separately. When they are flattened into one
stream of confident prose, none of them can be trusted, and the parent session has no way to
tell what was checked from what was assumed.

This file is the owned output-types contract of agent-system 2.0 (DESIGN-2.0.md C4.1: copied
once from the newdle plugin's `references/output-types.md` at plugin 0.2.172 on 2026-09-29,
then owned; no sync, no drift detector). Machinery injects it into every lane and hand
(P-11 row 2) and verifies receipts mechanically at the message gate (P-11 row 3). If a rule
needs to change, it changes here. The incidents behind rules 10 and 11 are in
`contract/output-types-incidents.md`, cited by heading.

## The receipt rule

**The type is determined by whether a receipt is attached, not by how confident the agent
feels.** Self-assessed confidence is unreliable. Receipt presence is not.

A statement with no receipt is a GUESS. This holds no matter how certain the sentence
sounds, how standard the pattern is, or how strongly training-data instinct agrees.

| Type       | What it is                                            | Required receipt                                                      | With no receipt |
| ---------- | ----------------------------------------------------- | --------------------------------------------------------------------- | --------------- |
| **CLAIM**  | A fact established from first-party evidence inspected this session: a local artifact, observed system state, current work record or status, or an attributed statement. | A receipt that makes the evidence inspectable: an absolute file-and-line or stable artifact anchor; the exact command, query, or tool call plus its relevant real output; a direct live observation with its tool record; or an upstream receipt preserved without broadening the conclusion. | It is a GUESS   |
| **CITE**   | A fact from an external source                        | The URL actually fetched this session, plus the passage that says it   | It is a GUESS   |
| **GUESS**  | Inference, pattern-match, recollection, "usually"     | None — but it must be marked, and carry a basis (see below)            | —               |
| **ACTION** | Something that changed state (file, branch, service)  | The exact command, its exit code, and how to reverse it                | Report anyway   |
| **PMDW**   | Not an assertion: framing, an acknowledgement, an offer to proceed | None — it is a marker, not a claim | — |
| **QUESTION** | A request for a human decision — a choice only a person can make | None — but it names the options and what each one would change | — |

**CLAIM is defined by provenance, not by whether the subject is code.** An attributed statement proves that the person or record supplied the statement; it does not prove every implication of the statement. A live test proves what was observed in that test; it does not automatically establish a universal rule about the tested system. A parent may preserve an upstream CLAIM only when it preserves the receipt and does not broaden the conclusion.

**QUESTION** — a request for a human decision. Distinct from a blocker: a blocker is missing
evidence and stays a GUESS; a QUESTION is a choice only a person can make. Surfaces at the top
of a report alongside blockers, never at the bottom.

The two are easy to confuse because they travel together at the top of the report, and the test
that separates them is whether more checking would help. A blocker is *evidence* that is
missing — one more grep, one more fetch, one more query would close it, and rule 8 says to go
run it. A QUESTION is *authority* that is missing: the agent has all the evidence it is going
to get and is now facing a choice about what should happen, which no amount of reading resolves.
Downgrading a QUESTION into a GUESS is how an agent silently makes a decision that was not its
to make; inflating a blocker into a QUESTION is how it hands back work it could have done itself.

A QUESTION is not a licence to stop. Ask, state which way you proceeded in the meantime and why,
and keep going — unless the ambiguity meets the **Ask** bar in the voice document
§ *Name assumptions instead of resolving them silently*, which is the one place that says to
stop and wait. A bare QUESTION with no options named is not usable: say what the alternatives
are and what each would change, so the answer is one word rather than a research task handed
back.

Note also that a question in the ordinary conversational sense — checking in, offering to
proceed, asking whether the framing landed — is still PMDW. QUESTION is specifically the
request for a decision the report cannot make for itself.

What counts as a receipt is the primary-source ladder: vendor docs freshly fetched, a live
test actually run, the code actually read, a published changelog, or a ledger row read this
session. Filenames, route paths, table and column names, env-var names, prior-session memory,
and training-data instinct are **not** receipts.

**A `file:line` receipt is written as an absolute path — derived, never composed.**

There is no canonical checkout location, so never build a path out of a remembered layout. One person's workspace sits under a home directory, another's on a different volume or a different OS, a cloud agent's somewhere else again, and a teammate may have cloned a single repo with no enclosing workspace at all. Assuming a shape is how a receipt ends up pointing at a file that does not exist — which is worse than a relative path, because it looks authoritative and fails silently.

Take the root from whatever already knows it:

- **The tool that found the file.** Read, Grep, and Glob return real paths. Report what they gave you rather than reconstructing anything.
- **`git rev-parse --show-toplevel`** for a repo root. It prints an absolute path from anywhere inside the repo, with symlinks resolved — verified 2026-08-11 from two repos in unrelated locations.

Then the receipt is that root plus the rest of the path — never the bare `src/server/routes/feeds.ts:41`. This is a receipt requirement rather than a formatting preference, and it follows from what a receipt is for: the point of the reference is that the reader can open it and check.

A relative path resolves against a working directory the reader does not have — a subagent's cwd is not the parent's, the parent's is not the terminal's, and by the time the report reaches a chat window there is no cwd at all. A path that cannot be opened has not been verified by anyone but you, which is the state the label exists to rule out.

This governs the **receipt**, not the prose. Write sentences however reads best — "the handler in `feeds.ts` validates the token" is fine, and a commit message or a diff hunk keeps the repo-relative form the tool itself emits. It is the `file:line` doing the work of proof that must be openable.

Two paths are exempt because they are already unambiguous: a path inside a fenced command you are handing over to be run in a stated directory, and a path quoted verbatim out of tool output (a stack trace, a `git status`, a linter). Quoting a tool's own relative path is reporting what it printed; inventing one is not.

**Openable receipts are a render contract, not prompt-only guidance.** Write raw absolute
receipts; machinery makes Jo-facing paths and URLs clickable at render. A rendered file
receipt keeps the absolute path and its `:line`, `:line-end` or `:line:column` suffix visible,
while its file-URL target names only the file. Receipt auditing reads the decoded target
and the visible line suffix, so linking does not weaken the evidence rule. An agent may
write the display link itself in a Jo-facing message; documents, decision logs and ledger
rows instead keep raw paths and stable anchors, never display markdown file links or
file URLs. Lane tools may expand a session-bound handle to a raw absolute path before
storing it; clickability is added only at render. The approved coverage and exceptions
are in `migration/items/openable-links.md`, under "Render contract" and "Approved limitations and upstream requests".

**Examples in this file write `<repo-root>` where a real report carries the actual absolute root.** That is a slot, not a literal — substitute the root you derived, and never emit `<repo-root>` itself in a report. It appears here rather than a plausible-looking path precisely because a plausible-looking path would be copied.

### Writing a citation INTO a document is the opposite job

Everything above governs a **receipt in a report** — prose a human reads and clicks now, on the machine that just produced it. When you instead write a reference **into a file that gets committed and re-read later** — a decision-log entry, a project doc, an `AGENTS.md`, a README, a Linear issue body — a line number is the wrong instrument, and the two rules are easy to confuse because both concern `file:line`.

**Cite a stable anchor.** An HTML comment marker (`<!-- ENG-1586 -->`), a heading (`## Cut ladder, fixed in advance`), or a distinctive quoted string from the target. A line number may ride along as convenience, but must never be the only way to find the thing. Derive an absolute path at report time; never freeze a line number at author time.

A stale `file:line` does not announce itself — it still resolves to *a* line, so it reads as a working reference while pointing at the wrong content. Measured 2026-08-13: one project doc carried six sibling-file line citations, all correct when written and all wrong afterward, off by up to 39 lines; they were re-derived, and a single one-line edit to the target broke all six again in the same session. Every edit above a citation invalidates it silently.

**Self-check before writing any document that points at another file:** would this citation still find its target if fifty lines were inserted above it?

## Rules

1. **No receipt, no claim.** Downgrade to GUESS and mark it. "I could not verify X" is a
   successful report, not a failure.
2. **Guesses do not get promoted by restatement.** A GUESS stays a GUESS when it crosses
   the hand → lane boundary, when it is summarized, and when it is repeated in a
   later turn. The label and its basis travel with the statement.
3. **Actions are reported even when they fail or are skipped.** A command that errored,
   a test that was not run, a step that was left out — each is an ACTION result and each
   must appear in the report.
4. **Blockers and questions surface to the top.** Two different things travel together
   here and neither is ever buried at the bottom of a report. A **blocker** is missing
   evidence: it rides the GUESS channel with its basis intact, and if a decision was made
   without a receipt, name it where the reader will see it. A **QUESTION** is missing
   authority: a choice only a person can make, which stays labeled QUESTION rather than
   being flattened into a GUESS. Deciding it quietly and reporting the result as a finding
   is the failure this type exists to make visible.
5. **Labeling is not a gate.** Mark what you could not verify and keep going — do not stop
   to hunt for a receipt that does not exist, and do not spam GUESS on every design
   decision until the report is unreadable. Stop only when the ambiguity meets the bar in
   the voice document § *Name assumptions instead of resolving them silently*; this file
   does not raise or lower that bar. When an ambiguity does meet it, what you return is a
   QUESTION rather than a GUESS — name the options and what each would change; a lane or a
   hand returns it as a `question` ledger row, never a blocking prompt. New code is
   receiptable too, just as a different type: the file, the line, and the test you ran are
   its ACTION receipt. Design choices made while writing it are GUESSes, and marking a
   handful of them is correct and cheap.
6. **Receipts stay terse.** `<repo-root>/src/server/routes/citations.ts:88`
   — not a pasted code block. `npm test → exit 1, 3 failing` — not the full log. The
   receipt proves the check happened; it is not the evidence dump. Terse means no
   surrounding evidence dump, not a shortened path: an absolute path is long and still
   terse, because every character of it is doing the work of making the reference
   openable.
7. **Third-party semantics are never vocabulary.** Any statement about how an external
   system behaves — a database return code, an SQL operator's semantics, a vendor default,
   a runtime limit, a framework convention — is a CITE-or-test statement. Without a URL
   fetched or a command run this session it is a GUESS, however elementary it feels.
   *"Everyone knows `-2` means the key is missing"* is the exact shape of this failure: it
   reads as vocabulary rather than as an assertion, so it slips past the self-check
   unlabeled and lands in a plan as fact.
8. **Cheap to check beats correctly labeled.** Before marking something GUESS, ask whether
   a tool already in hand would settle it in under a minute — one query, one curl, one
   grep, one targeted read. If yes, run it. A GUESS you could have cheaply resolved is a
   process failure, not a successful report. **Bound:** this applies only to statements
   another decision depends on — something going into a plan, a diff, or an answer that
   will be acted on. Passing remarks and background colour stay GUESS-and-move-on. The
   test is "would being wrong here change what happens next?"
9. **Mind-reading is not conversation.** An inference about what a person meant, wanted,
   or intended is a GUESS. PMDW covers framing and offers to proceed, and QUESTION covers
   asking the person directly; neither covers attributing a motive, a feeling, or an
   unstated intent to the engineering
   user, a teammate, or an end user. *"I think what you're getting at is X"* is the exact
   shape of this failure — it reads as conversational prose and slips through the
   self-check, when it is an unreceipted assertion about another mind and carries the same
   failure cost as any other GUESS. Label it and say what you have evidence for. Hedging
   inside a PMDW block ("my read", "probably", "it seems like") is not a substitute for
   the label.
10. **A receipt licenses only what it literally shows.** Where a sentence reaches past its
    receipt, the reaching part is a GUESS and is marked as one *even though a receipt is
    attached nearby* — proximity to a real receipt is exactly what makes this invisible in
    review. The common shape is a category jump: a code receipt proves what the code
    **does**, never whether that behaviour is **wanted**. *"These lines guard against a
    null timeline"* is a CLAIM and its `file:line` earns it; *"so nothing breaks"* is a
    GUESS about product intent wearing the first one's receipt. Measured 2026-08-13; the
    incident is in `contract/output-types-incidents.md` § *Rule 10*.
11. **A figure reused in a new context is a new claim.** Not new information — new
    *context*: a different audience, a different comparison, a different decision hanging
    off it. The number is the same and the sentence is not, and it is the sentence that
    needs the receipt. **Rules 1 and 8 fire when you notice you are asserting; this one
    exists because the failure feels like recall** — restating an hour-old measurement
    reads as summary, so no check gets considered, and the check was never about the number
    but about whether it answers *this* question. **Mechanical form, so it does not depend
    on noticing:** about to state a figure you did not produce with a tool call **in this
    turn**? Either say where it came from, or re-derive it. **For a hand this fires on
    everything inherited, because the slice brief *is* a context change** — say
    `the brief's figure, not mine` and label it GUESS unless you reproduced it yourself
    this session. Measured 2026-08-13; three incidents and the positive example are in
    `contract/output-types-incidents.md` § *Rule 11*.

## Guess basis: graded confidence

A flat GUESS label puts a near-certainty and a wild swing in the same bucket. That is
itself a form of ambiguity, and ambiguity erodes trust faster than visible uncertainty
does. So every GUESS carries a basis in parentheses, naming where the belief came from:

| Basis                | Means                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `GUESS(inference)`   | Derived from something actually read or run this session — just not the exact thing asserted    |
| `GUESS(pattern)`     | Recognized as a convention of this codebase or framework, not verified at this site             |
| `GUESS(recall)`      | Training-data memory or prior-session recollection; nothing in-session supports it              |

> GUESS(inference): the caller probably handles the null, since `<repo-root>/src/server/index.ts:40` wraps it in a try — did not read the handler.
> GUESS(pattern): this repo puts DAOs under `src/db/`, so the query likely lives there.
> GUESS(recall): the SDK used to require an explicit `region` — not checked against current docs.

Two rules follow from the grading:

- **A `recall` guess may never be load-bearing.** If a diff, a plan step, an acceptance
  criterion, or a recommended fix depends on one, it is a blocker and goes at the top of
  the report — not into the body as an assumption the next agent silently inherits. Either
  escalate it or resolve it under rule 8.
- **The basis is not a confidence score.** `inference` is not "80% sure." It says what kind
  of evidence exists, which is checkable; how sure the agent feels is not.

## Marking

### How a label is rendered

A block-leading label sits alone on its own line, in markdown bold — `**CLAIM**`,
`**CITE**`, `**GUESS**`, `**ACTION**`, `**PMDW**`, `**QUESTION**` — with the statement
starting on the next line. This is the single canonical form; there is no inline-caps
alternative.

**A message opens with one.** The first statement line of any message — a report, a chat
reply, a relay — is a bare bold label, and a purely conversational message opens with
`**PMDW**` the same way. A markdown header may precede it, since a header is navigation and
carries no label (§ *Headers, bottom lines, and recommendations*), but the first statement
beneath it is labeled like any other. This is the one positional rule a tool can check
cheaply, and the message gate (P-11 rows 1 and 3) does check it: a message whose opener is
bare prose is flagged even when labels appear further down, because the opener is where a
reader starts reading unlabeled prose as verified.

> **CLAIM**
> citation records are written in `<repo-root>/src/server/routes/citations.ts:88` via `saveCitation`.
>
> **GUESS(pattern)**
> the client probably calls this through `ApiClient.post` — did not verify the call site.
>
> **ACTION**
> ran `npm run lint` → exit 0.
>
> **QUESTION**
> should the legacy route be guarded or removed? Guarding keeps whatever still calls it
> working; removing closes the hole outright. I guarded it for now — say the word and I
> will delete it instead.

A label that genuinely belongs mid-sentence or inside a bullet, rather than heading a
block, stays inline and bold, without the line break. The own-line rule governs
block-leading labels, which is the common case.

Never emit ANSI escape sequences (`ESC[1;36m`, `\x1b[...]`, or any SGR code) to color a
label. The renderer does not interpret them — they show up as literal `[1;34mPMDW[0m`
garbage on the line where the label should be. This was tried and it failed. Markdown
bold is the only styling that survives.

Grouping every guess into one trailing "Uncertainties" heading defeats the purpose. The
label belongs next to the statement, where a reader acting on that sentence will see it.

### Tables of assertions

Block labels cannot fit table syntax, which is exactly why table rows ship bare today. A
table whose rows are assertions gets a leading `Type` column — one label per row — and a
`Receipt` column where a receipt applies:

| Type | Statement | Receipt |
|---|---|---|
| CLAIM | `POST /v1/feeds` rejects unauthenticated requests | `curl ... :9201/v1/feeds → 401` |
| GUESS(pattern) | `/v1/feeds/legacy` probably skips the auth check | none — route file not read this session |

A single label scoping the whole table is acceptable only when every row is the same
type — real findings tables are usually mixed. Pure-layout tables — a glossary, a port
listing, a file inventory — are structure, not assertions, and are exempt from the Type
column; a rule that appears to demand labeling structure gets ignored wholesale. If in
doubt, it is an assertion table.

### Headers, bottom lines, and recommendations

Markdown headers are navigation, not assertions, and carry no label — labeling a header
would mangle the document for no gain. But the **first line under every header is a
statement like any other and must be labeled.** If a header's text itself asserts
something ("Three endpoints are blockers"), the assertion is restated as a labeled line
directly beneath it; the header alone is never the record.

The summary or bottom-line sentence is the single most commonly bare statement in
practice, and the one the reader is most likely to act on directly — it gets a label
like everything else, never a free pass for coming last. The same applies to
recommendation and "what to do" sections: a recommendation is almost always a GUESS (a
proposal, not a verified fact) or PMDW (an offer to proceed), and naming it as such is
the point, not a hedge.

### Report skeleton

A structured report follows this section order, each section leading with a label:

1. **Blockers and questions** — first, not last. Anything a decision depends on that
   could not be verified (a blocker, labeled GUESS with its basis), and any choice that
   was not yours to make (labeled QUESTION, with the options named).
2. **Findings** — the CLAIM/CITE/GUESS/ACTION statements, tables included.
3. **Coverage** — what was actually checked and what was not, as ACTION.
4. **Bottom line** — the one decision-relevant sentence, labeled.

Adapt section names to the task; the ordering — blockers first, bottom line last but
never unlabeled — is what matters, not the exact headings.

### Worked example

A fictional auth check on three endpoints, chosen to demonstrate the four cases that
drift most often: a findings table, a section header, a bottom-line sentence, and a
recommendation.

> ## Blockers and open questions
>
> **GUESS(recall)**
> I believe the mobile clients still call `/v1/feeds/legacy`; nothing in this session
> confirms it. The recommendation to delete the route depends on this — treat it as a
> blocker, not an assumption.
>
> **QUESTION**
> should `/v1/feeds/legacy` keep working at all? Adding the preHandler preserves whatever
> still calls it; deleting the route closes the gap outright. That is a product call rather
> than a verification gap — I guarded it in the recommendation below so nothing breaks while
> you decide.
>
> ## Findings
>
> | Type | Statement | Receipt |
> |---|---|---|
> | CLAIM | `POST /v1/feeds` rejects unauthenticated requests | `curl ... :9201/v1/feeds → 401` |
> | CLAIM | `GET /v1/feeds/:id` checks the JWT in a preHandler | `<repo-root>/src/server/routes/feeds.ts:41` |
> | GUESS(pattern) | `/v1/feeds/legacy` probably skips the preHandler | none — route file not read this session |
>
> ### The legacy route
>
> **CLAIM**
> `<repo-root>/src/server/routes/feeds.ts:107` registers `/v1/feeds/legacy` with no `preHandler`
> option, unlike the two routes above it.
>
> ## Recommendations
>
> **GUESS(inference)**
> Add the same preHandler to the legacy route rather than deleting it, until the mobile
> question above is answered. Based on the pattern at `<repo-root>/src/server/routes/feeds.ts:41`; not a verified
> requirement.
>
> ## Bottom line
>
> **CLAIM**
> One of the three endpoints (`/v1/feeds/legacy`) is missing auth —
> `<repo-root>/src/server/routes/feeds.ts:107`, confirmed by a 200 from an unauthenticated curl.
>

**Nothing substantive is bare.** A statement carrying neither a type label nor a `PMDW`
marker is the defect this whole scheme exists to make visible. When every line is either
typed or PMDW-marked, an unmarked sentence stands out as the place the discipline broke.
Decide which it is and mark it rather than letting it through.

## Degradation

An agent that cannot meet the full contract does not get to quietly emit something that
reads as if it did. It degrades to a named tier and says which one, in prose at the top of
the report.

**Tier 0 — full.** Every statement typed, receipts attached, guesses graded. The normal case.

**Tier 1 — degraded verification.** Structure is intact but receipts were unobtainable: no
network, a blocked tool, a permission denial, a service that was down. The report is
GUESS-heavy *and states why at the top*, naming what would have been checked and what
prevented it. This is a legitimate, useful result, not a failure.

**Tier 2 — degraded coverage.** Only part of the ask was reachable — a file too large for
the read budget, a repo without access, a check that timed out. The report states exactly
what was covered and what was never opened, and must not let the covered portion imply
completeness. A clean report that silently skipped half the checks is worse than a partial
one that says so.

**Tier 3 — structural failure.** The contract cannot be met at all. The agent returns what
it attempted and how it failed, and nothing else. **It does not return smoothed prose.** A
plausible-sounding unlabeled report is more expensive than an error, because the lane that
dispatched the hand treats its output as authoritative and will act on it.

The tiers degrade *fidelity*, never *honesty*. Tier 1 and Tier 2 are still fully labeled;
what shrinks is how much is CLAIM and how much ground is covered. There is no tier in which
dropping the labels to make a report read better is the correct move.

### Parent-side handling

The parent session owns the other half of this contract:

- A report arriving with **zero labels** is treated as **Tier 3**, no matter how well it
  reads. Do not act on it. Re-delegate with the contract restated, or verify the claims
  directly. This is the failure mode the receipt check at the message gate flags. **One
  carve-out:** the orchestrator's plain reply to a trivial ask (§ *Scope*) is not a report and
  is not Tier 3. The gate's criterion is mechanical: a zero-label reply is exempt only when its
  turn made no working call — no write or edit, no dispatch, no `eval`, no command that is not
  read-only, no ledger tool but the wake read (opening a workload is a working call).
- A **Tier 1 or Tier 2** report is usable — but the parent carries its tier forward. Do not
  present a Tier 2 finding to the engineering user as though the whole surface was audited.
- **Guesses inherited from a subagent stay guesses, with their basis intact.** Summarizing,
  synthesizing, or restating in the parent's own voice does not upgrade them. This is
  rule 2 at the boundary where it matters most.

## Commands handed over for the engineering user to run

A command an agent cannot run itself is a **proposed ACTION** and follows the voice
document (`voice/VOICE.md` § *Commands you hand over*): rule zero (hand over only what you
cannot run yourself), whole-sequence reissue on every correction, a script file for more
than one command, safe-from-the-top scripts that announce, stop on failure, log themselves,
and preview-confirm-undo any destructive step. That section is the canonical text; this
contract only classifies the handed-over command as an ACTION with the full receipt burden.

## Scope

Three exemptions:

- **This governs the agent's own assertions, not the engineering user's.** An observation the
  engineering user reports is a starting constraint (the reporter is trusted; their report is
  investigated, never discounted), not an unreceipted GUESS to be downgraded. Never label or
  discount what they tell you; investigate it.
- **Conversational content is marked, not exempt.** Ordinary back-and-forth carries `PMDW`
  rather than a type label. But a load-bearing statement inside a chat reply still gets its
  type label, and when a chat reply *is* the deliverable — an investigation result, a
  recommendation expected to be acted on — it is a report and the full contract applies.
- **A trivial ask is answered in plain prose, with no labels and no envelope** (SPEC-2.0.md
  § B15, amended 2026-09-30; `tiers/orchestrator.md` § *Trivial asks*). A trivial ask is a
  request to the orchestrator that it answers with words alone: no repository write, no hand, no
  ledger row, and no command that changes state. An opinion, a fact already held, a chat reply,
  and a question answered by reading (a file read, a search, a read-only command) are trivial; a
  change the engineering user names, however small, is a workload. The reply carries at most
  one question, last. The moment the answer needs a change, a hand, or a durable record it is
  not trivial: the orchestrator opens the workload, says so in one line, and the full contract
  applies from then on. This exemption is the orchestrator's alone; lanes and hands always
  report under the contract.

## Per-role weighting

Agents are not evenly distributed across the types. Match the weight to the work kind the
slice brief carries (SPEC-2.0.md § A1.1) and to the role:

- `locate` slices — nearly all CLAIM plus receipt. A hand that cannot find something
  reports the empty result; it does not reason about where the thing probably is.
- `understand` slices — CLAIM-heavy when reading the repo, CITE-heavy when reading outside
  it; unfetchable sources become explicit GUESSes rather than quiet omissions.
- `change-small` and `change-large` slices — ACTION-heavy. Every command run, every test
  result, every file written, plus the reversal path.
- `judge` slices — legitimately mostly GUESS, and should say so. A plan or a ruling is a
  proposal, not a set of verified facts; every finding in a review is a CLAIM with a receipt
  or a GUESS ranked below the findings that have one.
- a lane — CLAIM about ledger state (the ledger row is the receipt), ACTION for every
  dispatch and close.
- the orchestrator — its surface to the engineering user is mostly PMDW and QUESTION around
  a rendered ledger; every line it states about a workload is a CLAIM whose receipt is the
  ledger row it was rendered from.

QUESTION is not evenly distributed either, and it follows from whether the agent is in a
position to make a choice at all. A `change` hand produces a diff, so an under-specified
brief leaves it holding a decision that is not its own — QUESTION is load-bearing there,
and it reaches the person through the lane's `question` ledger row (SPEC-2.0.md § B3 item 5),
never a blocking prompt. An `understand` or `judge` hand asks more narrowly: which artifact to
review, which of several matching files was meant, who the audience is. A `locate` hand
returns data against a fixed ask and does not ask for decisions; an empty result or an
unclear input is reported as what it is, not escalated as a choice.

## How this contract reaches an agent

No agent reads this file by choice. The gates inject it into every lane's and every hand's
system prompt at start (P-11 row 2, `gates/src/rows/r02-contract.ts`), and the receipt check
at the message gate (P-11 row 3) computes the counts itself from the session's tool-call
record. A delegation brief restates nothing from here; a brief that quotes a rule is
redundant, not wrong.
