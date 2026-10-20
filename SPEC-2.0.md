# SPEC-2.0 — the agent system 2.0, as ruled by Jo

Phase 5 opened by Jo 2026-09-23 (*"next"*). Built by interview, one question per message, per
`briefs/phase5.md`; every ruling is appended here as it is given, in Jo's words where Jo gave
them. `REQUIREMENTS.md` (P-1 … P-20 from Phase 3; P-21 … P-24 coined here) is the input; this file records what each open column
resolved to. Vocabulary: `REQUIREMENTS.md` § Vocabulary (workload / lane / hand / slice).

Status legend per clause: **ruled** (Jo's word, dated) · **carried** (a default from
`PREFERENCES.md` or the triple-check, not re-asked) · **open** (QUESTION, not yet ruled).

## Prerequisite tests (handed to Lintel → Tinker 2026-09-23)

Results 2026-09-23 from Tinker (receipts: `/Users/jowolff/agent-scratch/tinker/phase5-prereq-tests/TINKER-REPORT.md`; Tinker's decision-log entry `28941e9` in `~/.claude`). Tinker's receipts, preserved without broadening.

| Test | Gates | Result |
|---|---|---|
| T1 ctx as `pi`-root index | P-13 index half | **works.** `ctx sources add --provider pi --root ~/.omp/agent/seat-sessions omp-seat-sessions` → seat-session hits found that were absent before; `--source-root` filters to them. Caveats: keyword-only (0 / 15,252 embedded), daemon "partially healthy", coverage of the 182 seat files unmeasured. ctx can be the index half of P-13. |
| T2 Phoenix / OMP OTel export | P-4, P-7c, P-8b, P-16 observation layer | **OMP exports.** Env-only switch (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, http/protobuf; content off unless `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`), source `pi-coding-agent/src/telemetry-export.ts:94-145`. One throwaway run → 1 trace, 4 spans (invoke_agent root, 2× chat, 1× tool) with `gen_ai.*` usage/latency/model attributes and OMP's `pi.gen_ai.*` step/tool fields; Phoenix maps to OpenInference and fills cost. The "no export → observation layer is build step one" branch does **not** fire. Carried default: OMP → Phoenix on 6006 directly (Tinker's recommendation; the Docker `otel-collector` holding 4317/4318 is an unproven hop). |
| T3 TypeSafe `judge()` latency/cost | whether Q1's classifier runs per dispatch or on a sample | **per dispatch.** Synthetic 1,112-char slice, one choice question: 0.20–0.47 s wall, `typesafe/jev-1.13.0`, $0.0000286 per call, choice stable across five runs, confidence 0.98–1. Accuracy unmeasured (one synthetic item). Ran in the default profile — see OQ-2. |

Also from T3: **a 2.0 OMP profile now exists**, `agent-system-2` at `/Users/jowolff/.omp/profiles/agent-system-2/`, created by Tinker, holding the TypeSafe key only (no chat-model credential). Undo: `rm -r` that directory.

## Session A — load-bearing decisions

### A1 · Work-kind taxonomy and ceiling source (P-9)

**A1.1 Taxonomy — ruled 2026-09-23.** Jo: *"yes to your recommendation of shape-keyed with 5
kinds"* (after asking for the alternative and trade-offs; Jo: *"i like your recommendation, what
would be a reasonable alternative and what are the trade offs of each?"*).

The work-kind rule is keyed on the **shape of the task**, read off the slice brief, five kinds:

| Kind | What the slice does | Tier (to be named in A1.3) |
|---|---|---|
| locate | find where something is; no interpretation | lowest |
| understand | read and report on a surface; no repository writes (a smoke run or check that writes only scratch files and its report is understand) | mid |
| change-small | write a change the brief already specifies, carried out rather than worked out: one module and its own tests, a new uncalled pure function in its own file with its test, a mechanical mirror of an existing pattern, or a docs-only edit of any size whose content is dictated | mid |
| change-large | write code whose design or correctness the worker must work out: new behaviour across modules, a shared format and its readers, interface-fixing tests, end-to-end tests of real programs, or any concurrency, timing, process, security or authority, performance or replay/identity fix, however few files | mid-high |
| judge | design, review, decide; anything whose output is a ruling rather than an artifact | top |

Consequence (blast radius, reversibility) is **not** in the taxonomy: it is carried by the
workload ceiling (P-9) and the reserved list (P-7b). Rejected alternatives, recorded so they are
not re-proposed: consequence-keyed (classifier needs repo context the brief lacks; duplicates the
ceiling; not gateable as a single tool call) and hybrid shape-plus-raise-only-flag (flag is
redundant with the P-7b gate). Tier names per kind are A1.3; the kind→tier column above is
Plumb's carried default, not ruled.

**A1.2 Ceiling source — ruled 2026-09-23.** Jo: *"we're going with your recco - stakes
inferred"*. The orchestrator **infers** a workload's stakes from what Jo said in the surface plus
the target (production vs personal repo, protected vs scratch branch, whether a reserved-list
target is touched), writes it into the workload brief as one of **throwaway / normal /
production**, and shows the result in the surface as a one-liner Jo can override in one word.
Default **normal**. Jo writes no brief and promises none (Jo: *"i don't think i will reliably be
able to promise that there will be a workload brief for each workload"*; P-5 already makes the
brief orchestrator-written). The brief records the inferred value and any override (P-4 audit).
Rejected: default-to-top-cap (spends top tier on scratch work until noticed; the reserved-list
case is already forced to top by the *judge* kind and the P-7b gate). Stakes → tier-cap mapping
is A1.3.
Worked example confirmed by Jo 2026-09-23 (*"that does, at least as far as we are using opus at
the moment"*): a mobile CSS fix in `newdle-web` on a feature branch → *normal*, cap = the
mid-high rung; locate → lowest rung, understand / change-small → mid, judge → wants top, capped
to mid-high and recorded as capped. Jo's caveat is the reason A1.3 names **tiers, not models**:
the ladder is whatever the profile maps each tier to at the time (today haiku / opus / fable per
`.omp/agents/*.md:4`), and the spec never hard-codes a model name.

**A1.4 Workload granularity — ruled 2026-09-23** (pulled forward from Session B). Jo: *"task
size and the tags do not really matter"*. A workload is **task-sized**: one job with an end
(a fix, a feature, a rework, the 2.0 redesign), closed when done; Newdle has many at once, each
with its own ceiling and memory key. No repo-sized, never-ending workloads — that shape is a 1.x
seat, ruled out as a tier under P-5. Per-repo knowledge lives in the P-13 store keyed by repo,
not in a workload. **Group tags** (Newdle / personal) are not part of the model; P-1's "two
workloads" sentence reads as two *sources of work*, not two workload objects. Stakes levels
mean the same thing regardless of repo or source (Jo's clarifying question, answered same turn).

**A1.3 Classifier, tiers, routing chain — ruled 2026-09-23.** Jo: *"cool i thought so, lets go
with your recco"* (four tiers), after *"i would push back on change-large-deep spending top-tier
on every multi file. i feel depending on the complexity that could be an opus-5-5 task and not
necessarily a fable task."*

**Four tiers: fast / standard / strong / deep.** Names, not models; the tier→model table lives in
the 2.0 profile only (today fast=haiku-4-5, standard=sonnet-5-5, strong=opus-5-5, deep=fable-5-1;
standard was opus-5 until Jo re-ruled it on 2026-09-29 when Sonnet 5.5 entered OMP's live model
cache — cheaper than either opus row with the same 1M context — and ruled that no artifact here
names bare opus-5 any more). Kind→tier is fixed in the spec:

| Kind | Tier |
|---|---|
| locate | fast |
| understand | standard |
| change-small | standard |
| change-large | strong |
| judge | deep — the only kind that reaches deep |

**Routing chain per dispatch:** brief → classifier → kind → tier → cap → model.
1. Classifier: OMP's native `judge` role (TypeSafe when credentialed; T3: 0.2–0.5 s, $0.00003,
   runs on every dispatch), one choice question over the five kinds, returning kind + confidence.
   It names the kind of work only; it never picks a model.
2. Kind→tier: the table above.
3. Cap: the workload's stakes tier (A1.2) pulls a higher tier down; the pull-down is recorded.
4. Tier→model: the profile table; the hand spawns on that model.
Build constraint (`briefs/phase5.md:63-67`): OMP's `task` tool has no model/tier parameter and
nothing calls the judge today, so step 1 is a pre-dispatch hook or extension and step 4 is one
agent file per tier or an input rewrite — a `DESIGN-2.0.md` choice.

**Amended 2026-10-14 — build hands follow the lane's lab** (`migration/items/build-hands-follow-lane-lab.md`;
Jo, ledger inputs `in-mv7hm58386f2o0` and `in-mv7hmuk0u600e8`, plan approved in `in-mv8cbrm3igai2o`;
built in wl-mv7hiabx2ozy80). A permanent rule for every lane, not an override for named
workloads. Steps 1–3 are unchanged: kind, tier and stakes cap are chosen exactly as above. Step 4,
for every dispatch that is not a review, then keeps only the tier row's entries whose lab is the
spawning lane's lab, in row order with their thinking suffixes; labs come from the provider map in
`classifier/src/lab.ts` (`labOf`), so two providers mapped to one lab both count as that lab. The
lane's lab is read at each spawn from the calling session's current OMP model (`provider/id`): a
lane launched on a named model has had that model checked against OMP at launch, a default lane
uses whatever model it runs on, and a lane that switches models changes later spawns only. Tier
for tier, not model for model: a build hand runs the same-lab entry of its own tier, which need not
be the lane's exact model. Fallback stays inside the kept entries — same lab, same tier, never up
a tier and never another lab. The dispatch is refused before any hand runs when the lane's current
model is missing or its provider has no lab, when the tier row holds no entry of that lab, or when
every same-lab entry is unusable (absent from the registry, a disabled provider, no credentials, a
provider refusal); nothing falls back to another lab's entry, to OMP's native row, or to the lane's
own model. The kept entries are the hand's row everywhere the row is used — the candidates returned
at spawn, the `hand-spawn:` row, and the settle allowlist — so a hand that answered on another lab
has its output withheld as out of row. A hand keeps the row pinned at its spawn when the lane later
switches models or the result is recovered after a restart. A tier spawn with no classification
gets the same restriction. **Reviews are not narrowed:** a review dispatch (a judge slice, or a
low-confidence brief with judge among its two likeliest kinds) still plans on the cross-lab row
and rules of § B4 (*Amended 2026-10-01 — cross-lab review*): builder provenance, effective stakes,
production fan-out, `same-lab` / `wait` parks and grants, and the Kimi-out standing rule are
unchanged. The profile's tier→model table is unchanged and stays the only place a model is
named. This supersedes B11's sideways fallback to another provider for build hands (§ B11,
*Amended 2026-10-14*).

**Low-confidence rule — shape ruled 2026-09-23, threshold under measurement.** Jo: *"recommended,
i can spend the hour"* (after *"so the .80 number is grounded in real data?"* — it was not: T3
measured one synthetic brief, confidence 0.98–1.0, accuracy never measured). The rule: below
the threshold, dispatch at the **higher tier of the top two kinds** by the classifier's own
probabilities (never lower; the B4 stakes cap still applies); record the pull-up on the slice's
ledger row; count pull-ups as a P-16 signal about the brief or the question. Above the
threshold, route as classified. **The threshold is measured, not chosen:** a hand is classifying
~30 real briefs from this repo's own history (Jo-owned sources only, per OQ-2), hand-labelled
first, three batches of ten with per-brief on-disk output and a 20-minute cap, so a failure
part-way is visible and resumable (`/Users/jowolff/agent-scratch/agent-system-2.0/classifier-sample/`).
The number goes here when `REPORT.md` lands, with the accuracy figure beside it. Rejected: "one
tier up" (ignores the probabilities `judge()` already returns); 0.80 as an unmeasured
placeholder (Jo).
**Measured 2026-09-23** (`research/classifier-sample.md`; raw rows in
`/Users/jowolff/agent-scratch/agent-system-2.0/classifier-sample/`): 30 real briefs, hand-labelled
first, `typesafe/jev-1.13.0`, $0.00097 total. Agreement 23/30 (76.7%). **Threshold: 0.55** — the
knee of the sweep: flags 5 of 30, catches 4 of 7 disagreements, one false flag; 0.80 would flag
10 of 30 for the same 4. Two disagreements at 0.98–0.99 are vocabulary-driven (the brief contains
`judge()`; "report whether…") and are a classifier-instruction fix, not a threshold. The
classifier chose change-large 0 times in 30 (the one hand-labelled change-large scored judge
0.62 / change-large 0.24) — the higher-of-top-two rule over-serves that case rather than
under-serving it. Caveats: n=30, one change-large and four judge examples; hand labels are a
model's reading, not Jo's; 1.x-style prompts, not B9 six-field briefs (production confidence
expected higher, so 0.55 errs safe). Re-measured after the first real month from ledger pull-ups
versus gate failures (P-16).
**Re-measured 2026-09-28** with the S1-corrected question (sha256 `5a72c35c…`; `research/classifier-sample.md` § Re-measurement 2026-09-28): the same 30 briefs plus two review additions, `typesafe/jev-1.13.0`, $0.00101 total. Agreement 21/30 (70.0%) on the original thirty against the unchanged 09-23 hand labels, 2/2 on the additions (both change-large); two of the nine misses are two-file edits the old labels call change-small and the ruled taxonomy calls change-large. **Threshold stays 0.55, inclusive** (ruled 2026-09-29 after the M3 gate run, Jo: *"let's follow your recco"* — a brief answered at exactly 0.55 was under-served in one of two live draws; the sweeps below were computed strictly-below, the code flags at or below): it is the lowest value that routes no brief below its hand label's tier (0.50 leaves a judge brief on standard); the count knee is 0.60, which routes all 32 identically. The corrected question costs precision — 7 of 32 flagged, 5 of them false flags, over-served briefs 3 → 10 of 30 — because it lowers confidence on correct locate and change-small answers.
**Re-measured 2026-10-20** with the right-sizing question (`questionSha256` `2c0d0886…`, file sha256 `5b74aa66…`; `research/classifier-sample.md` § Re-measurement 2026-10-20), `typesafe/jev-1.13.0`, after the 2026-10-19 hand-size audit found 8 firm over-sizes among 20 change-large hands. § A1.1's understand, change-small and change-large rows follow it: change-small is a change the brief already specifies, change-large one whose design or correctness the worker must work out. On the audit's 20 the 8 firm route standard and the 9 correct stay strong; 27/32 on the 09-28 sample against its labels (two additions relabelled change-small), none routed below its label's tier at 0.55 inclusive, which stays the threshold (not re-swept). Sealed held-out set B: 7/7 correct strong, 0/3 over on standard — dictated code-plus-own-test changes still route strong, a shortfall Jo accepted 2026-10-20 (`q-mvg42w7vgege0w`). At workload open, 2 of 124 replayed briefs newly skip plan-first (Jo: keep, `q-mvg45v0ez6f1mo`) and the ×3 ceiling applies to 45 instead of 62.

**Named local fallback — Laya (ruled 2026-09-28, Jo: *"let's go with your recco"*).** ConvAI's
`laya` (Apache-2.0, self-hosted, TypeSafe-wire-compatible) is the exit if TypeSafe's terms, price,
or availability change: one `models.yml` custom-provider block with `api: typesafe` pointed at a
local `laya-serve`, no code. Not adopted: measured zero-shot on the same 30 briefs it scored
10/30 against TypeSafe's 23/30 and flagged 24–30 of 30 below the 0.55 threshold
(`research/laya-vs-typesafe.md`). Revisit only with a checkpoint fine-tuned on 2.0's own labels.

### A2 · Seat → workload cutover map, overlap rule, seat retirement (P-3)

**A2.0 Unit of cutover — consequence of A1.4, not separately asked.** Workloads are task-sized,
so no 1.x seat maps to one workload. A seat maps to a **repository whose new work starts opening
as 2.0 workloads**; the cutover map is an ordered list of repositories (equivalently of the twelve
1.x seats: Lintel, Tinker, Sedge, Verge, Wren, Sluice, Galley, Levitt, Codex, Caspian, Tron,
Plumb — `seat_list` 2026-09-23). The first 2.0 workload opened on a repo is that repo's cutover
event.

**A2.1 First repository — ruled 2026-09-23.** Jo: *"this one absolutely"* — `agent-system-2.0`,
the build of 2.0 itself, moves first: the build plan runs as 2.0 workloads from the first lane
that can run. Rationale: real work, lowest stakes (no users, one seat, rollback is Plumb
continuing), and the machinery must work on itself before it touches a shipped repo (P-4).
Known blind spot: deploys, protected branches, and the reserved list never fire here, so the
**second** repository is a product repo — A2.2.

**A2.2 Cutover is one event, not a per-repo order — ruled 2026-09-23.** Jo's hypothesis: *"because
of the way 2.x lanes/seats work compared to 1.x, my hypothesis is that we will reach a condition
where 2.x is good enough and then all 1.x seats would be retired"*; Plumb's reading that it holds
with amendments; Jo: *"record that in place"*. Basis: P-5 — a lane is not repo-bound, so 2.0's
capability is one set of machinery for every repo; there is no repo-specific readiness to wait
for. The per-repo order question is withdrawn.
- **A2.1 stands as the proving ground**, not as step one of twelve: the machinery is built and
  exercised on this repo's real work.
- **Good-enough evidence** = the self-hosted build running as 2.0 workloads **plus at least one
  product-repo workload that exercised a reserved-list action under the gate** (deploys and
  protected-branch pushes never fire in this repo, so self-hosting alone cannot prove the gate).
- **Per-repo knowledge migrates in bulk before the switch**: each seat's memory and charter
  content → P-13 entries keyed by repo. Data migration, not a cutover.
- **Lintel retires at a single moment by nature** — two orchestrators overlapping is the one
  overlap that is bad in itself.
- **Retirement is dormancy, not deletion**: launchers, charters, HerdR rows stay on disk for a
  period Jo sets — **ruled 2026-09-28: 90 days from the cutover event** (Jo: *"90 days is
  fine"*); fallback is one command. Deleting 1.x is a later, separate decision. This is
  how P-3's "1.x remains rollback" survives a single-event cutover.
- The event fires when Jo says so (A2.4), with the evidence above in front of them.

**A2.3 Overlap rule — ruled 2026-09-23.** Jo: *"both may take work but the idea is to eventually
completely retire all 1.x seats"*. During overlap, 2.0 takes a repo's work by default; the 1.x
seat takes only work 2.0 cannot yet do at that step of the build (a deploy, a reserved-list
action, anything the missing machinery blocks). When the orchestrator hands work back to 1.x it
says so in the surface — a sentence in the P-13 ledger, **not a gap-list file or schema** (the
earlier "written as a gap in `MIGRATION.md`" wording was withdrawn under A2.4 the same turn: the
second write path it needed was a change to 1.x, forbidden by P-3). Mechanical guard (P-11): a
1.x seat may not touch a branch a 2.0 workload has open. End state is unambiguous: **every 1.x
seat retires**, Plumb included; overlap is a transition, not a steady state.
**A2.3 amended 2026-09-25.** The "mechanical guard (P-11)" sentence above is withdrawn. Jo: *"i
don't really care if there's a mechanical rule to keep them separate. i will simply not run a 1.x
seat while something is working on a lane."* The overlap separation is an operator rule — Jo
sequences 1.x seats and 2.0 lanes by hand, never both on one repo at once — with no detection and no
refusal. Recorded in `DESIGN-2.0.md` § Mechanical-rule list (struck row).

**A2.4 Retirement condition — ruled 2026-09-23.** Jo: *"i say so, no gap list no machinery"*
(after *"it just seems like we might have to institute a lot of machinery to even gather this
data"*). A 1.x seat retires **when Jo says so, per seat**. Evidence offered at that moment: the
observation layer's count of completed 2.0 workloads on that repo (Phoenix, T2 — a query over
spans the lane already tags with the workload name, no new machinery) and the ledger's record of
any hand-backs to 1.x. Nothing computes "ready"; no N. Rejected: mechanical retirement on an
empty gap list for N workloads (needs a 1.x write path, forbidden; measures only fallbacks the
system saw; zero for quiet repos; gameable by scope; measures capability not quality).
**A2.4 amended 2026-09-28 — all at once, not per seat.** Jo, reading `MIGRATION.md`: *"i thought
we decided it was going to be all or nothing?"* → *"that's the ruling"*. The "per seat" above was
Plumb's reading, not Jo's words. **Every 1.x seat retires at the cutover event (A2.2), on Jo's
word, in one moment** — Lintel and the eleven repo seats together, Plumb included. Evidence offered
at that moment is unchanged (Phoenix workload counts, ledger hand-backs); dormancy (A2.2) is
unchanged: every seat stays one `launch-seat --start` away as the P-3 rollback. Rejected: per-seat
retirement (twelve decisions and a long overlap for no benefit once 2.0 takes all work by default).

### A3 · Unsolicited-surface threshold (P-7c)

**Ruled 2026-09-23.** Jo: *"4 hours"*. A held thing on any open workload — a message in state
*held* (arrived with no live lane), or the workload itself open with no lane and no activity —
is pushed to Jo unsolicited once it has been held for **4 hours**. One number, applied to the
age of the oldest held thing per workload; everything younger stays queryable-only (P-8c).
Failed gates and errors surface by their own route, not this clock.

**Form of a workload with no live lane** (Plumb's reading, confirmed by Jo asking for it, same
turn): one row in the P-13 ledger — name, brief, stakes/ceiling, opened-at, last-activity-at,
slices and their states, message queue with P-7c states, lane field empty. The ledger is the
list of open workloads; "not being worked on" is the query `open AND no lane`, never a scan of
Linear or GitHub. Linear issues / projects, GitHub issues, `.projects/` specs are optional
*sources* linked on the row for P-17 resume, never the source of truth for open/closed (P-7a).
Phoenix records activity by workload name; it holds no state.

**Ledger technology: not yet decided** (Jo, same turn: *"we haven't yet decided on the actual
tech to hold the ledger for 2.x yet, correct?"* — correct). P-13 names it a Phase 5 choice, Beads
a candidate; OMP's native memory backends (`local`, `mnemopi`, `hindsight`, `sharpshooter`) are
held as candidates from the cross-lab review. It is a Session B question (Q on P-13).

### A4 · Reserved-action command list (P-7b item 3)

**Ruled 2026-09-23.** Jo: *"yes as stated"*. "Irreversible actions outside the repository" =
the 1.x `careful` enumeration — force-push, hard reset, branch or tag deletion, `rm -rf`,
`DROP` / `TRUNCATE`, production database writes, infrastructure teardown (`doctl` and kin), secret
rotation — **plus** push to a protected branch, **plus** deploy. **Not reserved:** pushes to
feature branches; merges of approved, green PRs (P-8d: no per-unit approval). The bare "remote
push" wording in P-7b is replaced by "push to a protected branch or deploy" (held decision 6,
now ruled). Enforcement is P-11's: each item is a tool call a gate must recognise; the two known
evasions — browser writes are not tool calls, shell inside `eval` reaches the gate as one opaque
string — are build requirements on the gate, not list items.

**Amended 2026-10-08 — no process from eval** (MIGRATION.md item 58; Jo: *"standing rule: deny
any reserved request that launches a command from eval or a subprocess, without asking me, and tell
the lane to use bash"*; to Ilex's "refuse outright?": *"yes, open it"*; built in
wl-muzs0ytnaet1v4). A process started from eval code (a spawn API, `subprocess`, a shell magic such
as `!cmd` or `%pip`, a nested `tool.bash`, or a `%load`-ed file that starts one) is refused
outright by P-11 row 6, not reserved: no reserved request is written and nothing reaches Jo's
needs-you list. The refusal tells the lane to run the command with the bash tool, where the gate
reads it; a reserved command run there is held for Jo with the real command in the request. Eval
code that starts no process is judged as before.

**Threat model — ruled 2026-09-29.** Jo: *"accidental misuse"*. The gates guard against a lane
of ours doing a reserved thing **by mistake or over-eager judgment**: every spelling a lane would
plausibly type while doing its job is modeled and refused (fail-closed on unmodeled forms, the
positive per-subcommand model, the cross-lab adversarial rows). **Deliberate evasion by the lane
is out of scope**: shapes whose only purpose is getting past the gate (`--orphan … --no-orphan .`,
a ledger deliberately named `magic.mgc`, `x.constructor` after a harmless open) are recorded when
found and fixed when cheap, but do not block a row, and reviews grade against this bar. Not ruled:
sandbox-grade — rows 6/10 cut to a closed command allowlist — which would push ordinary lane work
(`node -e`, `file`, `xxd`) into question rows. Reason: seven astra passes on M4 converged on
forms by pass 5 and then kept finding effect-bearing options in the long tail of allowed programs;
that tail is unbounded under a sandbox reading and the reviewer was implicitly grading against it.

**Session A closed 2026-09-23.** A1 routing, A2 cutover, A3 threshold, A4 reserved commands all
ruled. Halt point 2 reached (`briefs/phase5.md` § Halt points).

## Session B — remaining open columns

Opened 2026-09-23 (*"on to session b"*). Q5 (granularity) was ruled in Session A as A1.4.

### B1 · Slice closure: runtime artifact, reports untouched (P-8a, P-4, P-20)

**Ruled 2026-09-23.** Jo: *"yes."* A slice closes on a **runtime-produced artifact** captured by
the machinery — a test run's exit code, a diff, a screenshot, a command's output — never on the
hand's prose. The hand's report is kept as-is and is never checked by a second hand (P-8a stands).
For slices with no runnable output (the *judge* kind: a design, a ruling), the artifact is the
written output plus Jo's acceptance. This is P-20's "closed by machinery-written state" and what
P-4's gate accepts as evidence. Rejected: a second hand reviewing reports.

### B2 · Ledger tool (P-13) — ruled: homegrown SQLite

**P-19 clarified 2026-09-23.** Jo: *"for the ledger question it definitely doesn't need to only
be made out of OMP material - beads and any other 3rd party solution available to use"*. P-19
excludes Claude Code, HerdR, and the newdle plugin; it does **not** exclude third-party tools.
The ledger may be a third-party store, provided an OMP extension can read and write it and no
hosted service is mandatory. This answers the research hand's QUESTION in
`research/ledger-candidates.md` (it had assumed exclusion).

Evidence so far (`research/ledger-candidates.md`, Tinker-style receipts preserved): OMP's four
native memory backends are free-text memory, per-profile, not a ledger; OMP's own task state is
per-session; plain SQLite via `bun:sqlite` (already OMP's engine) holds the full row and answers
both queries — tested in plain Bun, not yet inside a loaded extension. Beads: runner-up pending
the wider scan. A bounded third-party scan (Beads in depth plus up to six others) is running →
`research/ledger-candidates-third-party.md`. Ruling deferred until it lands.

**Constraint added 2026-09-23.** Jo: *"while i am the only one using this machinery, some day my
colleagues might, and i don't necessarily want something as important as the ledger locked into
omp"*. The ledger is **not OMP-bound**: a non-OMP client (a CLI, another harness, a person) can
read and write it without OMP running; the data format is open (a plain file with a documented
schema, or git-tracked text); multi-user and multi-machine use is a weighted criterion, not an
afterthought. This narrows P-19 for the ledger specifically (OMP is the runtime *of the lanes*,
not the owner of the record) and extends P-15 (portable machinery) to "portable record". Plain
SQLite owned by an OMP extension is re-judged against this: the file is open, but the schema and
writer would be OMP-only unless the schema is documented and a standalone CLI exists. The
running third-party scan was steered to weight this.

**Proposed 2026-09-23 — not ruled.** The 2.0 ledger is a homegrown SQLite database: one file
outside any OMP profile; a documented schema in this repo; one TypeScript ledger module the OMP
extension imports; no custom CLI; Beads the named fallback. The ledger must hold: workload rows
(brief, stakes, lane, open/closed, last activity), slices, the four-state message queue (held /
delivered / consumed / acted-on, with the age of the oldest held message queryable — B3),
direct-instruction entries (B5), and (workload, lane-instance, time) provenance; wake is the
ledger rendered (B7). Jo's stated cost: *"it creates yet another piece of machinery for me to
maintain and that's a real cost"*, and *"everyone is using beads and it's cool and talked about
a lot"*.

**Cross-lab gaslight 2026-09-23** (Jo: *"i want to gaslight this decision - all labs"*; three
legs returned; reconciled report
`/Users/jowolff/agent-scratch/agent-system-2.0/gaslight-b2/RECONCILED.md`). Verdict
simplify-and-verify. Four defects landed 3/3 and apply to whichever engine is chosen:
1. **Writer contract.** "No custom CLI" contradicted the constraint above and B8's machinery
   list; raw `sqlite3` is a safe reader, not a safe writer. Fix: the state-order and provenance
   rules live *in the file* (`CHECK` + `BEFORE UPDATE` trigger — live-tested in `bun:sqlite` by
   one leg), or the module's operations are callable without OMP; B8's "CLI" wording follows
   whichever is chosen.
2. **Fallback trigger.** "Live concurrent multi-user writes" skips sequential transfer and
   asynchronous collaboration, and is the one case Beads meets only with a shared
   `dolt sql-server` — a hosted service, which this section forbids being mandatory. Fix: name
   the three collaboration needs separately; v1 topology stated explicitly.
3. **State locality.** v1 ledger state is local, never on a synced or network folder (SQLite
   WAL does not work over a network filesystem — sqlite.org/wal.html); path defaults under
   `$HOME`, overridable, listed in the install manifest; cross-machine is a later
   JSONL-to-git-ref export.
4. **Gate.** The loaded-extension `bun:sqlite` import is still untested; a throwaway extension
   test is a P-4 gate before any ruling.

**Disagreement handed to Jo.** Claude cleared Beads with new receipts (embedded Beads is
single-writer under a file lock, so many concurrent lanes need a `dolt sql-server` daemon even
solo; 11 upstream release tags since June); Codex and Kimi landed the exclusion as
under-evidenced (no candidate binary was ever run; the research's "Beads cannot filter
metadata" claim is contradicted by Beads source). The "Beads unmaintained" caveat is refuted
(repo pushed 2026-09-23, release 2026-09-15). Jo, 2026-09-23: *"let's go with thew recco"* —
**one bounded hand-day runs the same ledger lifecycle through both engines before B2 is ruled**
(brief: `/Users/jowolff/agent-scratch/agent-system-2.0/ledger-lifecycle/BRIEF.md`; routed via
Lintel). Ruling waits on `REPORT.md` there. Jo's preference is on record: *"i really, really
want to use beads"*; preference is a legitimate reason in this spec.

**Ruled 2026-09-24.** Jo: *"you are REALLY pushing this bun:sqlite nonsense and let me tell
you - i don't want to. and you've done a good job providing me with reasons why I SHOULD
regardless of what I want. we are going forward with your recommendation"*. **The 2.0 ledger is
a homegrown SQLite database via `bun:sqlite`**: one WAL file, local, under `$HOME` by default,
never on a synced or network folder (fix 3); schema documented in this repo; **state-order and
provenance rules live in the file** as `CHECK` constraints and triggers, so every writer — the
OMP extension's module, a second tool, a person — is bound by them (fix 1; measured:
`/usr/bin/sqlite3` was refused the illegal transition, `sqlite/logs/11-foreign-write.log`);
the TypeScript module is the writer contract and is callable without OMP; the loaded-extension
gate passed (fix 4: `bun:sqlite` works inside an OMP extension under `--profile
agent-system-2`, `ext-test/SECTION.md`). Collaboration needs named separately (fix 2): v1
topology is one machine, one user; sequential transfer and asynchronous collaboration are a
later JSONL export to a git ref; live concurrent multi-user writes are out of v1.

**Folded in from prior art** (`research/sqlite-ledger-prior-art.md`), each a design obligation
on the module, not a new decision: (a) a **lease + reclaim** primitive so a dead lane's claim can
be taken over — every agent-coordination store that claims across processes built one; (b)
`busy_timeout` set on every connection before WAL is enabled; (c) retry on **every** write path
(`BEGIN IMMEDIATE` and `COMMIT` can both return `SQLITE_BUSY`); (d) a checkpoint-starvation guard
(no long-lived readers); (e) a **second copy** — scheduled `VACUUM INTO` backup; naive `cp` of a
WAL database loses everything (`sqlite/logs/probe-naive-copy.log`). Known shortfall accepted:
the `sqlite3` CLI runs `foreign_keys=0`, so a second tool can insert an orphan — a P-11 hook
refusing raw `sqlite3` writes outside the module closes it; that gate applies symmetrically to
any engine's raw CLI, so it was not a point in the comparison.

**Rejected: Beads** (`gastownhall/beads`, formerly `steveyegge/beads`), after the measured
lifecycle (`/Users/jowolff/agent-scratch/agent-system-2.0/ledger-lifecycle/REPORT.md`) and the
upstream check (`research/beads-known-issues.md`). Not for the bypass risk — a P-11 gate cancels
that for both engines — but for two engine-level failures through the approved path: **`bd
set-state` split in 7 of 29 SIGKILLs** (event written, label not; upstream open issue #5637,
"an atomicity regression", unfixed on `main`), and **silent data loss on journal truncation with
`dolt fsck` reporting clean** (Dolt drops torn journal records by design without an error,
`journal_record.go`). Also: no state-order rule in the engine (any transition accepted, exit 0),
silent `BEADS_DIR` fallback to the cwd (#5756 open; caused one accidental `restore --force`),
hardcoded 5-minute leases (#5681), telemetry on by default, three binaries to pin. What Beads
won and 2.0 gives up: git-backed sync and history, a lease primitive out of the box, a CLI Jo
did not write, and community momentum. Jo's preference was on record and was overruled by Jo.

**Housekeeping from the comparison, defaults to apply** (`REPORT.md:14-40`): `brew uninstall
beads dolt` and quarantine `~/.beads`, `~/.config/bd`, `~/.dolt`; quarantine the four `bd init`
`.git` dirs; delete the one queued telemetry event; keep the 27 OMP-written profile paths.

**B2.1 Decision logs — ruled 2026-09-24.** Jo: *"let's go with recco"* (after asking *"will 2.0
still produce a decision log for people using the plugin?"* and *"this should make it cross
compatible with people using the plugin?"*). **The ledger is the only record.** The 1.x
decision-log / wrap-up machinery (authored prose entries, one per session) is not carried into
2.0 as a source of truth: a wrap-up is the ledger rendered, as wake is (B7). The *why* of a
ruling is a text field on the ledger row, written at ruling time, as are the `durable` and
`supersedes` flags. **For teammates:** on workload **close**, in any repo that carries the
plugin's decision-log convention, the machinery renders the workload's ledger rows into one
entry in that repo's `.ai/decision-log/` — the plugin's filename scheme
(`YYYY-MM-DD--HHMM--<engineer>--<slug>.md`), its five frontmatter scalars (`status`, `durable`,
`supersedes`, `session`, `date` — the only fields its parser reads,
`hooks/lib/parse-decision-log-frontmatter.py:25-30, :92-98`, plugin 0.2.171), its section
headings — so the plugin's session-start injection (`hooks/recent-activity.sh:164-214`) treats it
exactly as a hand-written entry. Same mirror-on-close shape as B10. ~~2.0 never reads these files
back.~~ **Amended 2026-09-28** (Jo: *"amend it following your recco"*, after *"the new machinery will be
able to both read and write decision-logs"*): **read as context, never as record** — at workload
open on a repo carrying the convention, the machinery renders the `.ai/decision-log/` entries newer
than the last 2.0 workload on that repo into the lane's brief as context (the 1.x plugin's
session-start injection, `hooks/recent-activity.sh:164-214`, is the reference shape); nothing from
them enters the ledger. The ledger stays the only record; teammates' rulings stop being invisible.
Built at M5 beside wake. Build gate (P-4): the renderer's output is checked once against the plugin's parser, which
degrades silently on malformed frontmatter rather than raising. Rejected: authored entries kept
as a human layer beside the ledger — a second source of truth that drifts, the 1.x failure the
cross-lab review found. Lost and accepted: the narrative shape of an authored entry.

### B3 · What counts as an error, and how it surfaces (P-8c)

**Ruled 2026-09-23.** Jo: *"those four things"* (after asking for alternatives and their
complexity). Exactly four things surface unsolicited, one line each in the single surface (P-6):
1. a reserved-list action waiting on Jo (P-7b);
2. a held thing past the A3 threshold (4 hours);
3. a failed gate the lane could not recover — a slice that failed its runtime artifact (B1)
   **twice** (starting number, Jo's to change); **amended 2026-10-01:** a review slice's failed review rounds are not counted here but by the review round limit (§ B4, *Amended 2026-10-01 — review round limit*), and this count stays for every other slice;
4. a lane that died — session gone, workload still open — surfaced once even if the orchestrator
   reopens it, because a vanished worker is the 1.x "seat forgot" failure Jo wants to see.
Everything else — a hand failing once, a retry, a slow slice, a ceiling cap firing, a workload
opening or closing — stays inside the lane and the ledger, queryable on demand. P-16 proposals
ride this same channel. Rejected, recorded for Session C not to re-propose: narrower (items 1–2
only — same information four hours later); broader (a second "worth knowing" digest tier —
erodes quiet-by-default, second stream to read); configurable per stakes (a policy table Jo would
have to remember exists). A tier can be added later at no cost; removing one costs trust.

**Fifth item, ruled 2026-09-23.** Jo, after noting 1.x seats *"often get stuck on prompts and we
are unaware"*: *"add 'lane waiting on a human, reserved or not' to B3's unsolicited list as a
fifth item once it's confirmed observable"*. Confirmed observable the same day (reader report
`/Users/jowolff/agent-scratch/agent-system-2.0/omp-prompt-state.md`, copied to
`research/omp-prompt-state.md`): OMP's extension API emits `tool_approval_requested` /
`tool_approval_resolved` with session, tool-call id, tool name and reason
(`pi-coding-agent/src/extensibility/extensions/types.ts:916-932`, emitted at
`extensions/wrapper.ts:285-303`); an `ask` wait is `tool_execution_start` with
`toolName === "ask"`. Not visible through hooks or the registry roster (running/idle/parked/aborted
only) — the 2.0 extension subscribes directly. A process that dies while blocked never emits
`resolved`; item 4 (lane died) is the liveness check that closes that hole.
5. a lane waiting on a human, reserved or not — surfaced when the wait begins, with what it is
   waiting on; not the four-hour clock.
   **Amended 2026-09-28** (Jo: *"taking both reccos"*): a second trigger for item 5 — a lane's
   `question` ledger row (an autonomous lane has no `ask`; the row is its escalation). Surfaced
   the moment the row is written, with the options; only that slice pauses; Jo's answer lands as
   a ledgered instruction (B5) and the slice resumes. `DESIGN-2.0.md` P-11 list, last two rows.
   **Lifecycle (gaslight G3, Jo: "yes", 2026-09-28):** a question row has a stable id linking
   the paused slice and, later, the answer instruction; every unresolved question is rendered on
   the workload row and at wake (B7) regardless of the last-N window; no answer means the
   dependent slice stays paused and unrelated slices continue — the four-hour clock (A3) does
   not apply, the question stays visible until resolved; a ledgered **withdrawal** from Jo
   cancels or replans the affected slice and never counts as approval of the unanswered choice.
The gap it closes: a lane alive but blocked on a non-reserved prompt (tool permission, `ask`,
confirm) was none of items 1–4. Companion lane rule for Session C (amended 2026-09-28, gaslight
G1): a lane opens **no blocking human prompt** — permissions are pre-granted in the profile
template and `ask` is unavailable to autonomous lanes and hands; reserved actions go through the
A4 gate (item 1); a material non-reserved choice goes through a `question` row that suspends only
dependent work (item 5). Those two are the only human waits a lane can hit; item 5's prompt-event
trigger is the safety net if a blocking prompt leaks anyway.

**Amended 2026-10-19 — standing rulings are checked before a question; notices** (`migration/items/escalation-policy.md`;
Jo, ledger input `in-mvfkupc4p9nt34` opening the escalation-policy work, and the policy draft's § 4: *"a ruling comes only
from Jo's words … The ruling check has to be code"*; plan `~/agent-scratch/agent-system-2.0/wl-mvfkv7llkp7nk0/PLAN.md`
rev 5 §§ 1–2, approved by Jo; built in wl-mvfkv7llkp7nk0). Two changes to item 5's question trigger. **Rulings
first:** `askJo` (`gates/src/rulings.ts`) is the only production path to `Ledger.raiseQuestion`. It reads the question's
kind from its option set (`questionKind`: `review-park`, `open-workload`, `merge`, `stakes`, and for a question whose
every option is a `provider/model` id the `subject` its asker declares, `lane-model` or `review-model`, refused when
missing) and checks Jo's standing rulings (`STANDING_RULINGS`): `kimi-out` (in-mv5xafhywe3w8w, ends
2026-11-01T00:00-07:00), `flow-repair` (in-mvfiyyv2kuha80), `merges` (in-mv91wdhs446ark), `models` (in-mv5qagioc4en0g,
in-mvfiu1uyldnksg) and `gates-stakes` (in-mv0novd17fre9s), each with the scope, exceptions and end its source gives;
`train-signoff` (in-mvg8clpoo9xn28) joins them under § B4, *Amended 2026-10-20 — Jo's train word is the production sign-off*.
When an active ruling covers the question, no question row is written and nothing pauses; the asker records
`ruling-applied: <ruling> kind <k> slice <sl> answer <a>`, and the lane and orchestrator tools return the ruling and
its action instead of a question id. Every other question, of kind `other` (round limit, merge train, plan, safety) or
outside a ruling's scope, is raised as before. A ruling is added only by a code change from Jo's words, and Jo's
`end-ruling <id>` ends one at once. The invariant report's `ruling-miss` lists a question raised since the ledger's
first `ruling-applied:` entry (the check's activation) that an active ruling would have decided, the runtime check for
a raise path that bypasses `askJo`. **Notices:**
something Jo is told and does not answer (a ceiling at 80 %, a ceiling stop, a plan that started on its own,
§ B6 and § B11 *Amended 2026-10-19*) is a `notice:` message to the orchestrator written by trusted tool code
(`sendNotice`, `surface/src/notice.ts`), never a `questions` row. It shows after every other needs-you line as
`notice on <workload> (nothing to answer): …`, unnumbered and not answerable, until delivery marks it delivered once.
The two ceiling notices are on fire for the batch; every other notice waits for the window. A `notice:` written by a
lane that holds or held the workload shows only as that lane's message.

### B4 · Stakes → tier cap, and review as a stakes property (P-9, P-8a, A4 "approved")

**Ruled 2026-09-23.** Jo: *"yes to your reccos"*, after *"so would every normal workload cost
fable time?"* exposed that A1.2/A1.3 had left the stakes→cap table unset.

| Stakes | Tier cap | Review before merge | Jo's part |
|---|---|---|---|
| throwaway | fast | none | none |
| normal | strong | a *judge* slice (runs on strong under the cap); merge proceeds on pass | told in one line after the merge |
| production | deep | a *judge* slice on deep, **then Jo** | Jo's `train` word on the PR is his approval of the merge: the train merges it once green with its review passed and tells him in one line after (*Amended 2026-10-20*, below); the deploy is a separate reserved one-liner (A4) |

So fable is spent only on production workloads' judge slices and on anything Jo raises. A judge
slice's closing artifact (B1) is its written verdict plus the slice's runtime artifacts; how many
failed rounds a review may take before Jo decides is the review round limit (§ B4, *Amended
2026-10-01 — review round limit*, below). Jo reviews a result the judge already passed — verdict
plus diff — never a cold diff. **A4's "approved, green PR" is defined as: the stakes-required review
passed.** Overriding stakes in one word (A1.2) is also how Jo asks for more or less review on a
workload; there is no separate review setting. Rejected: end-only (Jo sees output only at the
protected-branch / deploy boundary — never reviews the approach); front-and-end (plan approval
mandatory above a stakes level — P-12 stays optional).

Hole this closed, for the record: before this ruling nothing in `REQUIREMENTS.md` defined a
review process for workload output (`grep review|approv` 2026-09-23: no requirement), and A4's
"approved" was undefined.

**Amended 2026-10-19 — the merge train lands a normal lane's PR** (`migration/items/merge-train-auto-board.md`;
jo-issues #132; Jo, ledger input `in-mvbjiylsgdtqf4`: "it is of the utmost importance to me that agents can
merge autonomsly"; built in wl-mvbjiettjrfpxc, plan revision 6). This amends the normal row above and the
completion rule of `DESIGN-lane-launcher.md` decision 11 (on this repository a lane never merges: Jo
integrates). An autonomous normal-stakes lane on a repository the test runner serves
(`testRunner.repos`), a merge train or train fix lane excepted, never asks Jo to integrate. A
cross-lab review slice must pass before the PR is done. Once the PR is green at its head with that
review passed, the lane records `done-because:` and releases, the surface closes the workload, and
the merge train boards and lands the PR; a done line's "merged on main" is met by that hand-off. The
train tick boards a PR only when its workload is closed, was autonomous at normal stakes, carries a
holder `done-because:` newer than the tick's `train-autoboard: on` cutover row, has its newest
full-suite run green at the PR's head (a head ahead of it only by `.ai/decision-log/` commits
counts), and has its cross-lab review passed. A PR that fails a test gets a `train-board-skip:`
ledger row, no line to Jo, and Jo's `train <N>` still lands it. For these PRs the normal row's "told
in one line after the merge" no longer holds: Jo hears only of a production-stakes merge, a
conflict the owner fails twice, a red main (once per `main-red` issue), or a main protection the
tick cannot verify (named once per episode). Production-stakes and user-driven lanes keep the rule
above unchanged; production auto-boarding is a non-goal.

**Amended 2026-10-20 — Jo's train word is the production sign-off** (`migration/items/train-signoff-ruling.md`;
jo-issues #155; Jo, 2026-10-19 9:10 PM PDT: *"i dont want to be asked twice"*; Jo's standing ruling, ledger input
`in-mvg8clpoo9xn28`: *"my train word on a production-stakes PR is my merge approval. The train merges that PR once it
is green and its review passes, without asking me again, and tells me in one line after it merges."*; Jo's
`machinery` (in-mvg8ibntzpnzeo) to carry it in every train, and his `issue155` (instruction in-mvg9zz54ejepz4) to make it the
permanent rule; plan `~/agent-scratch/agent-system-2.0/wl-mvg8itbt0rz3ls/PLAN.md` §§ 1–2; built in wl-mvg8itbt0rz3ls).
This amends the production row above. Before it, a production PR needed Jo's `train <N>` to board, and then the train
asked Jo merged / skip / stop before it merged. Now Jo's `train <N>` (or `train wl-<train> <N>`) is his approval of
the merge. The mechanism is a standing ruling, `train-signoff`, in `gates/src/rulings.ts` (§ B3, *Amended 2026-10-19 —
standing rulings are checked before a question*). It decides the train lane's merged / skip / stop question, answer
`merge`, when all of these hold, read by the question tool and never taken from the lane's words: an authenticated
`train` word of Jo's named the PR; the PR is on a same-repo `wl/` branch whose workload's newest review is settled and
passed; the PR is green at its current head; and main's protection reads `ok` live. Then no question row is written,
the question tool records `ruling-applied: train-signoff kind merge slice <sl> answer merge`, and the train lane merges
at once with a merge commit pinned to the head it verified (`--match-head-commit`, never `--admin`). If any of these fails, or a
`gh` read fails, Jo is asked as before. Auto-boarding still never boards a production PR, so a PR only the train tick
boarded still asks. A question already open when this lands stays Jo's to answer. Jo's `end-ruling train-signoff`
ends the ruling at once with no code change, and from then on every production PR asks again. **One line after each
train merge:** the train tick sends Jo one notice per PR any train merged (`merged by train …`), once, naming either
his train word (production) or normal stakes. Normal-stakes train merges therefore again send the one-line notice the
normal row promises; this replaces the auto-board amendment's "no longer holds" sentence above. No notice is sent for a
PR Jo merged himself or one the train skipped.

**Amended 2026-10-01 — cross-lab review** (MIGRATION.md item 23; Jo: *"any review should happen
via a model from a lab that did not build it. if the agent building it was anthropic? we use openai
or kimi. if those are unavailable due to spend reasons or login issues i should be alerted and
given the option then to have a same lab review. i want that instituted sooner rathr than later"*;
built in wl-mupu0sx2o046io). The classifier enforces it (`classifier/extension.ts`,
`classifier/src/lab.ts`):
- **The lab rule.** A review — a judge slice, or a low-confidence brief with judge among its two
  likeliest kinds (the A1.3 pull-up reading) — runs on a model from a lab that built none of the
  workload. Labs come from one explicit provider map in `classifier/src/lab.ts` (anthropic;
  openai and openai-codex → openai; kimi-code and moonshot → kimi); a provider missing from it has no lab and
  is never counted as independent. The builders are read from the ledger, never from session
  memory: every lane's `builder-lab:` entry, the answering models of every settled non-review
  hand, the whole tier row of every hand spawned and not yet settled, and the lab of a review hand
  that changed the work. A lane with no `builder-lab:` entry, or a provider with no lab, counts as
  every lab, so the review parks rather than pass on partial history. The review's tier row is
  filtered to the other labs at spawn, and a review that answered on a builder lab is withheld. A
  review runs only after the work it reviews has settled.
- **Effective stakes for reviews.** A review dispatch runs at the higher of its brief's stakes and
  the workload's, so a production workload's review is capped at deep and fans out even when its
  brief says normal. Other dispatches keep the brief's stakes.
- **Production fan-out.** At production stakes one review becomes one hand per other available
  lab (named `<slice>--<lab>`), each pinned to its lab; together they are one review. One
  available other lab gives one hand.
- **No other lab → park, never a silent fallback.** When no lab outside the builders is usable
  (credentials, a disabled provider, spend, an outage), or every leg of a fan-out ends without an
  accepted review, the dispatch is refused and the slice parks with one question, named by a
  `review-park:` entry: **same-lab** runs this one review on the builder's lab; **wait** holds it
  until another lab is back, and the lane asks again if it is still down. A fan-out whose spawned
  legs all failed to dispatch (below) does not park: it is no round, and the review is dispatched
  again. The builder's lab is never in a review hand's fallback chain without a granted `same-lab`.
- **One dispatch per grant.** Jo's `same-lab` covers the next review dispatch of that slice only,
  spent atomically at its spawn (a `review-same-lab:` entry); the dispatch after it asks again.
  `wait` or a withdrawal grants nothing.
- **Read-only review hands.** A review hand is refused the editing tools, and the classifier
  fingerprints the lane's own work (HEAD's commit, the branch HEAD names, the index entries, and
  every tracked and untracked file's content and mode) at the hand's spawn and settle. Other refs
  are out: a lane worktree shares them with every other worktree, so a commit or fetch elsewhere is
  not the review's doing (wl-muq13bkdghblmo step 7). A review that changed the lane's work has its
  output withheld, its lab counted as a builder, and a `review-withheld:` entry that holds across a
  restart. A fix is a change slice the lane dispatches.
- **A provider that refused the login.** A hand whose every turn ended on a provider error is a
  failed dispatch: its output is withheld, its row records `refused-model-unknown`, and a review
  member's `review-round:` verdict is `failed-dispatch`, which counts as no round (a group whose
  spawned members all failed to dispatch is not a round). A 401 / 403 also writes
  `provider-refused: <provider> status <code> token <dt>`; later dispatches on that workload skip
  the provider's models until the surface writes `provider-ok: <provider>`.

**Amended 2026-10-13 — Kimi out: same-lab under Jo's standing rule** (`migration/items/kimi-out-reviews-run-same-lab.md`; Jo,
ledger input `in-mv5xafhywe3w8w`: *"Standing rule for the rest of October: when a review has no lab
left because Kimi is out, the answer is same-lab — don't ask me again, record it and proceed."*;
built in wl-mv5xay6bjp0268). A review that would park only because Kimi is out runs same-lab with
no question: at the review hand's spawn, when builder provenance is known, Kimi is not a builder
lab, no row entry is on a provider with no lab, every kimi entry of the review row is unusable (or
the row has none, under the rule's `rowOmission` flag) and a same-lab hand can run, the classifier
writes `review-same-lab-rule: in-mv5xafhywe3w8w slice <sl> token <dt> labs <lab,lab> kimi <why>`
in the transaction that writes the hand's `hand-spawn:`, in place of the park question, the
`review-park:` entry and the pause. The builder labs are tried least-involved first, for this rule
and for Jo's own `same-lab` grants. While the rule is active, a Kimi 429 carrying a quota or
suspension message also writes `provider-refused: <provider> status 429 token <dt>`, honoured only
inside the window. **End:** `KIMI_OUT_RULE.endsAt` in `classifier/src/lab.ts`, the end of
2026-10-31 America/Los_Angeles, or earlier on Jo's word by moving that constant. Every other review
park still asks Jo as above, as does every park after the end, and the review round limit is
unchanged.

**Amended 2026-10-01 — review round limit** (MIGRATION.md item 33; Jo: *"is it possible for us to
have defaults with a ceiling that i can raise? it would have to tell me how many of which type of
issues remained form the final revieww from the cap, and an estimation of how many more rounds. and
i should have the ability to stop the process at any point"*; scope: *"this applies to all
reviews"*; on stopping: *"finish first"*; built in wl-mupu0sx2o046io). It replaces the ruled
sentence "a second failed review is B3 error #3". Every review loop — judge slices, plan reviews
(B6), merge reviews — has a round limit per stakes: **throwaway 3, normal 3, production 5**,
starting numbers, Jo's to change.
- **A round** is one review dispatch of a slice; a production fan-out is one round. Every review
  hand ends its reply with a fenced `review-findings` block (each finding's severity `blocking` /
  `major` / `minor`, its kind, its title). A round passes when every hand's output was accepted and
  none reports a blocking finding; a withheld hand or a missing block fails it. A passing round
  ends the loop, and the slice's next review starts a fresh one. A round whose hand has not
  reported holds the next round while its lane is alive; once its spawning lane has a `lane-exit:`
  after its spawn, the next review dispatch records that member withheld with unknown findings
  (with a `refused-model-unknown` row and `hand-settled:`), so the round closes as failed.
  A hand's result counts wherever it reaches the lane: a `task` result, an `async-result`
  delivery, or a `wait` / `proc://` job snapshot that shows it. A job snapshot carries no start
  time, so when the lane's process has run more than one hand under that agent id, its entry
  settles and releases none of them and the output it shows is withheld (fail closed).
- **`rounds <n> [wl-…]`** at the surface sets the workload's limit, targeted like `ceiling` (bare
  with one open workload, the `wl-…` id with several, "which one?" otherwise); a stakes flip
  re-sizes it as it re-sizes the ceiling.
- **At the limit.** When the round that reaches the limit settles, the slice parks with one
  question, named by a `review-limit:` entry, carrying the final round's remaining findings by
  severity and kind, the blocking count per round, and the rounds still needed, labelled an
  estimate. **extend**: one more block of rounds for that slice. **accept**: the review counts as
  passed with those findings left, named on the slice's artifact and the PR. **stop**: no further
  round; the review has not passed; the lane reports and holds the slice for Jo.
- **`stop-reviews [wl-… | sl-…]`** stops review loops at any time: every loop on the workload, or
  the one on a slice. A review already running finishes and its remaining findings reach Jo; no
  further round starts; an open park or limit question on a stopped loop is withdrawn; nothing
  done is reverted.
- **`test-pr <wl-…> <N> [<N> …]`** at the surface binds those PR numbers of the workload's
  repository to it for a test run with no push (`migration/items/test-pr-binds-named-prs.md`): Jo's
  instruction, then the surface's `test-pr:` entry naming it. The test runner admits a bound
  same-repo open PR whatever its head branch; closed, merged and fork PRs stay refused. The workload
  is always named.

**Amended 2026-10-12 — OpenAI reviews on gpt-6-sol** (MIGRATION.md item 110; Jo, ledger inputs
`in-mv5qdfvskukmbk`: a review that routes to OpenAI runs on `openai-codex/gpt-6-sol`, never
`openai-codex/gpt-6-astra`, until the review-cost framework workload lands or Jo says otherwise;
`in-mv5qfm8910ycjk`: build it in the classifier, not in the tier rows; built in wl-mv5qd31yx9u6rk).
A production review is capped at deep (the table above), and deep's OpenAI entry is gpt-6-astra.
`reviewRow` in `classifier/src/lab.ts` gives a review on the deep tier the deep row with every entry
of a lab named in `REVIEW_ROW_FROM` (today `{ openai: "strong" }`) replaced by that lab's entries in
the named tier's row, so the OpenAI member of a fan-out, and the OpenAI entries of a single review,
run on gpt-6-sol. A lab with no entry in that row drops out of the review; it never falls back to
astra. Kimi and Anthropic entries keep the deep row.
- **Scope.** Reviews on the deep tier only; normal-stakes reviews already run on strong. A non-review
  dispatch on deep keeps the whole deep row. The tier table in `profile/config.yml` is unchanged:
  gpt-6-sol in the deep row too would put one model in two tiers, which the pull-up check in
  `classifier/src/tier-table.ts` refuses.
- **End.** When the review-cost framework workload lands, or Jo says otherwise, the `openai` entry
  of `REVIEW_ROW_FROM` is deleted and deep reviews take the deep row again.

**Amended 2026-10-12 — three-lab review panels** (MIGRATION.md item 111; Jo, opening the work:
*"okay, i would like you to have all the capabilities to perform any cross lab review that exists,
how do we get that for you?"*; plan approved by Jo in in-mv5p8baa8fykn4; built in
wl-mv5m7qvgkxhpj4). A lane runs every `skills/cross-model-review` mode (triad, quorum and its
refutation stage, refute, doubt-driven) as a **panel**: one judge hand per lab, each pinned to its
lab, then one synthesis hand (`classifier/src/panel.ts`; the lane steps are in the skill's
*From an as2 lane* section).
- **A separate, explicit dispatch.** A panel runs only from a `task` item carrying `panel: <run>`
  (then `panel-synth: <run>`) on a judge slice. No review dispatch becomes a panel, and no panel
  stands in for a review this section requires.
- **The builder's lab is in it.** A panel's members are all three labs, the builders' labs
  included; the lab rule above does not exclude a panel member, and the panel synthesis prefers a
  lab that built nothing and names a builder lab in its report when it has to use one.
- **Panel hands are reviews.** Every panel hand plans on `reviewRow`, as the gpt-6-sol amendment
  above says, so a panel's OpenAI leg runs on the review row's OpenAI entry, gpt-6.1-sol since the
  *Amended 2026-10-14* entry below.
- **Never a review round, never the plan review.** Panel members write no `review-round:` entry
  and a panel group is not counted by the review round limit; panels are bounded separately, at
  most that limit's number of panels per slice, and `stop-reviews` stops them too. `panel:` and
  `panel-synth:` are refused on the plan slice, so a panel never counts as the plan review (§ B6,
  *Amended 2026-10-01 — plan review by another lab*).
- **Ordinary builder exclusion unchanged.** Every review this section requires still runs off the
  builders' labs, with the park, fan-out and read-only rules above; a panel member's settle feeds
  the builder count exactly as a review hand's does.
- **A missing leg is never substituted.** A lab with no usable leg is recorded missing or
  excluded with its reason and named in the report; no other lab is spawned in its place, and a
  full panel means a new panel, never a single replacement leg.

**Amended 2026-10-14 — OpenAI reviews on gpt-6.1-sol** (Jo, ledger input `in-mv8qzqym1ihmv4`;
built in wl-mv71x5rwdu7eo0). The strong row's OpenAI entry in `profile/config.yml` is now
`openai-codex/gpt-6.1-sol`, replacing `openai-codex/gpt-6-sol`. Through `REVIEW_ROW_FROM` every
OpenAI review, on deep and on strong, runs gpt-6.1-sol, and so does an OpenAI lane's strong build.
Cross-lab review and the same-lab fallback are unchanged; no other row changes, so gpt-6.1-sol sits
in one tier. A lane Jo named on a model keeps that model.

### B5 · Jo steering a lane, and Jo coding manually (P-8, P-13, P-17)

**Ruled 2026-09-23.** Jo: *"yes to your reccos"* to *"what happens if i decide i want to steer or
code manually at some point?"*
- **Steering from the surface** is the normal path: a message into the lane's next turn with a
  P-7c state, so delivery and action are visible. Already covered by ruled requirements.
- **Direct instructions to a lane are ledgered.** Jo may open a lane's OMP session and talk to it
  (P-8: direct access is a choice); the lane records any such instruction as a ledger entry, same
  as a surface message, so P-13 recall and P-17 wake do not miss it. One mechanical rule (P-11).
- **"I've got X" hands the workload to Jo.** The orchestrator closes the lane; the workload stays
  open with `lane = Jo`; no slices run; the A3 clock does not run against Jo. **"X back to you"**
  reopens a lane, whose first turn is P-17-grounded on the ledger plus Jo's diff. One new lane
  state, no other machinery.
- **A side branch needs no rule**: Jo codes on their own branch, the lane continues, merge as
  anyone would.
- **Not blessed:** Jo editing in a running lane's checkout on the workload's branch — it
  recreates the shared-checkout collision the 1.x charter already recorded once
  (`.ai/plumb-seat-charter.md:67-70`). If it happens anyway, the runtime records the foreign
  diff as a ledger entry and the next slice's brief includes it; that is mitigation, not a mode.

**Amended 2026-10-19 — inbound agent channel** (`migration/items/agent-channel.md`; Jo, answering
q-mv8wcymfkx3y0w: *"notes"*, ledger input `in-mv8yzvhuwz9jwg`; plan
`/Users/jowolff/agent-scratch/agent-system-2.0/wl-mv8vx7wdj5nx1c/PLAN.md` rev 6; built in
wl-mv8vx7wdj5nx1c). Other agents reach the orchestrator through one inbound channel, never
through Jo's steering path. Each sender is configured in `profile/config.yml` under
`channel.senders[]` with an `id`, a `transport` and an `authority`; the authority belongs to the
sender, not to anything a message says. Phase 1 has one sender, `{ id: plumb, transport:
omp-mailbox, authority: notes }`, and `notes` (notes and proposals) is the only authority built.
A message is never authored as Jo: it is a `messages` row on `wl-orchestrator` with sender
`plumb`, created_by `channel:plumb` and the body prefix `channel-note from plumb:`, and the
channel writes no instruction, answer, stakes or mode flip, or ceiling change. The orchestrator
reads it as information from that sender, and replies with `orchestrator_reply` or closes it
with `orchestrator_channel_done`. A line that names a waiting needs-you row and a word that
answers it is a proposal: it renders as `#n plumb proposes <word> <target>` and carries the
target's own number, never one of its own, and only Jo's typed `n <word>` (or another word that
fits the row) applies, as Jo's ordinary row. Flip and ceiling words from a sender answer no
numbered row, so they stay notes. A sender's `from` is self-claimed, so a spoof costs a
misattributed note, never an action. Grant words wait for a phase with sender proof; phase 2
(Juno, remote, notes only) starts only after Jo's go is recorded as an instruction.

### B6 · Spec-and-plan option is offered inside the lane (P-12)

**Ruled 2026-09-23.** Jo: *"inside the lane"*. The orchestrator opens the workload and lane as
usual. If Jo said "plan it", or stakes is *production* and the orchestrator offers it in the
stakes one-liner (*"plan first? (recommended)"*), the lane's **first slice is a *judge*-kind
planning slice** whose closing artifact is the plan, which Jo approves before any *change* slice
runs. No planning happens before a workload exists — the orchestrator has no hands (P-7b/P-8)
and a plan is already a *judge* slice with a tier and an artifact (A1, B1). A plan spanning
several workloads (an epic) is a workload of its own whose output is other workloads' briefs,
which the orchestrator then opens; no new concept. Which planning practice the slice follows
(Phase 4 research) is a `DESIGN-2.0.md` choice.

**Amended 2026-10-01 — plan review by another lab** (Jo, answering the plan question of
wl-mupu0sx2o046io: *"revise: plan review too"*; built in that workload). Every plan-first plan is
reviewed by a model from another lab before it reaches Jo. The lane dispatches a review hand named
after the plan slice, with a brief asking for findings on the plan file; it is a review under § B4
(*Amended 2026-10-01 — cross-lab review*): routed off the builders' labs (for a planning lane, its
own), read-only, parked with `same-lab` / `wait` when no other lab is usable, fanned out at
production stakes, and counted against the review round limit. The lane revises on blocking
findings and reviews again; the plan question names the verdict file and the answering model.
`lane_raise_question` enforces it: on a plan-first workload whose plan is not approved, a question
on the plan slice offering `approve` is refused unless a review of the plan slice ran after the
previous plan question was resolved, was not withheld, and answered on a lab outside the builders
(or on a spent `same-lab` grant). A round-limit question answered `accept` keeps the accepted
round valid for this check. Not proven by the check: that the reviewed bytes are the file the
question names, or that blocking findings were fixed.

**Amended 2026-10-02 — plan-first by default** (MIGRATION.md item 42; Jo, 2026-10-01: *"flip"*,
and for the plan question *"yes keep it short"*; the plan-role rule is Jo's instruction
in-muq3rrz7xmkj5s; built on `wl/wl-muq22rnjcfrrpc`). At normal stakes a workload opens plan-first
unless the open-time judge answers `change-small` at confidence 0.9 or higher, or Jo says "no plan".
Everything else plans: a lower change-small, change-large at any confidence, any other kind, and a
judge that is unavailable, not wired or malformed. The one-liner names the trigger `large change`
(change-large above 0.55, as before) or `default`. Precedence: production always plans, and "no
plan" does not lift it; then Jo's plan words ("plan it", `plan: first`), which win over a "no plan"
in the same brief; then "no plan"; then the judge. "No plan" (or "no-plan", any case) is parsed from
the brief at open; the phrase quoted on its own (`"no plan"`) is a mention and does not count, while
the phrase inside a longer quote of Jo does. The orchestrator can pass `plan: none` instead.
Throwaway keeps the old rule: plan-first only on change-large above 0.55, and "no plan" lifts that
too. The ceiling is unchanged: ×3 still follows only a judged change-large above 0.55, and the
judge still runs under "no plan", so the size is what it would have been. A "no plan" said after
open does not lift a standing plan-first.
A question on the plan slice that offers `approve` carries the plan, in this order and nothing
else: the absolute path of the plan file; one `- <slice id>: <what it does>` line per proposed
slice (at least one); the `prompt-only:` lines (*Amended 2026-10-14 — requirements name their
enforcer*, below); 1 to 3 `tradeoff:` lines; one `review: <verdict>, <model>, <absolute path of
the verdict file>` line. Both paths must be existing files and every line is at most 160
characters; `lane_raise_question` refuses any other body and names the shape. Jo's needs-you line
shows that question whole, one indented line per body line; every other question keeps the
120-character cut. The plan slice is the oldest slice still open or paused, in insertion order, so
a done plan slice hands the role to the next one, as a cancelled one already did, and the next
one's approve question is shape-checked and review-gated the same way. A question is the plan
question only if it was marked when raised: `lane_raise_question` writes the control entry
`plan-question: <question id>`, as the holding lane, when it raises an approve question on the plan
slice while `plan: first` stands, and Jo's approve writes `plan: approved` only on a marked
question. A question raised before its slice held the plan role never approves the plan.

**Amended 2026-10-14 — requirements name their enforcer** (`migration/items/plan-requirements-name-their-enforcer.md`;
Jo, ledger input in-mv8vw0sx5g4d8g: *"Each plan requirement names its enforcer (test, gate row, hook,
code path) or says prompt-only and why; the plan check refuses a plan missing that, and the plan
question lists prompt-only items for Jo. Jo 10-12: nothing matters without machinery."*; built in
wl-mv8vwb04cy18n4; the plan-question gate of § B14.3, *Amended 2026-10-14 — machinery first for all
work*). When `lane_raise_question` raises the plan question it reads the plan file the question's
first line names (UTF-8, `\r\n` read as `\n`). The file holds exactly one line that is exactly
`## Requirements`; the section runs from it to the next line opening with `# ` or `## `, or to the
end of the file, and every non-blank line in it is one of two requirement lines:
`- R<n>: <requirement> => <enforcer>[; <enforcer>]…` or
`- R<n>: <requirement> => prompt-only: <why no code can enforce it>`. The line splits at its last
` => `, so the requirement text may hold arrows. `R<n>` is unique in the section. An enforcer is a
lower-case kind, `test`, `gate`, `hook` or `code`, exactly one space, then a locator that starts with
no whitespace, saying where (`gate row 6`, `code surface/src/launch.ts planQuestionProblem`);
enforcers are separated by `; `, so a locator holds no `;`, and the same enforcer twice is refused
while one kind may name two places. `prompt-only: ` (colon, one space) opens the whole enforcer part,
never mixed with an enforcer, and its reason, which may hold `; `, has at least two words. The read
is bounded: a plan file over 262144 bytes (`PLAN_FILE_MAX_BYTES`) is refused, and a path that is not
a regular file when opened is unreadable. At least one requirement line; prose, a `###` heading, a fence, a table or a
sub-bullet inside the section is refused as unparseable, since a requirement the check cannot
parse names no enforcer. The question body gains one line kind, after the slice lines and before
the `tradeoff:` lines: `prompt-only: <R id>: <the requirement, and why no code reaches it>`, one
per prompt-only requirement, the ids exactly the file's (a missing, extra or repeated id is named),
or exactly `prompt-only: none` when the file has none; the 160-character limit applies, and only the
id is checked. The needs-you line already shows the plan question whole, so these lines reach Jo
with no render change. The structural checks above run first, unchanged; then every offending
requirement is named in one refusal, then the id match, and the refusal carries the question shape
and the requirement grammar (`PLAN_REQUIREMENTS_SHAPE` in `surface/src/launch.ts`, also rendered
into a plan-first lane's first prompt and the tool's description). The check runs only at raise
time: questions raised before the change are not re-checked, and Jo's `approve` on them works as
before; a plan-first lane started before the merge keeps the old check for its session. Not
checked: that a locator exists (a test the plan will write does not exist yet) or that it really
enforces its requirement; Jo judges that from the plan, the cross-lab plan review reads it, and the
code review checks it in the diff.

**Amended 2026-10-19 — a normal plan that passes cross-lab review starts on its own, and stops before merge**
(`migration/items/escalation-policy.md`; Jo, 2026-10-19: *"yes to auto-start, stop at 100%"*, deciding the escalation
draft's decision 1, *"A normal-stakes plan that passes cross-lab review starts without Jo's `approve`. Jo gets a notice
and can stop it before merge. It never opens new work while the flow-repair gate is up."*; plan rev 5 § 3; built in
wl-mvfkv7llkp7nk0). When a lane raises the plan question (an `approve` question on the plan slice while `plan: first`
stands), `lane_raise_question` raises no question when all of these hold (`planAutoStartRound`,
`surface/extensions/lane-tools.ts`): (a) the workload is at normal stakes; (b) the passing round is the latest review
state, meaning the newest `review-loop-end:` on the plan slice is `reason pass` and no `hand-spawn: … review yes` and
no review routing on the slice came after it; the round it closes was created after the slice's last question was
resolved; and every member of that round ran, was not withheld, carries no same-lab token (no Jo grant, no Kimi-out
rule token) and answered only on labs outside the builders. Jo's `accept` at a round limit, a mixed round and any
later review all fail (b). (c) The body passes the plan-question shape check above. (d) The workload was never
halted. (e) The `flow-repair` ruling is not active (§ B3, *Amended 2026-10-19*). Then, in one write, the fixed writer
`escalation` (`ESCALATION_BY`) records `plan: approved auto <round group>`, a form valid only from that writer, which
every reader of plan approval accepts and no lane can write, and sends Jo a notice carrying the plan body: *"plan
started without your approve on <wl> (normal stakes, cross-lab review passed); it will not merge until 4 h after your
next message here; `halt <wl>` stops it"*. The lane is told to add its change slices. Auto-start never opens a
workload and never launches a lane. Production plans, and every plan while flow repair is up, still go to Jo as above.
**Stop before merge:** for such a workload `prStakes` (`surface/src/merge-train.ts`) answers `hold: <reason> until
<time|jo>`. The hold lasts until 4 h (`HOLD_HOURS`) after Jo's first typed surface message created after the notice
was delivered (the standing-workload instruction `joInputRow` writes; mirrors on other workloads do not count), and
until Jo when there is none. The train records `train-hold: pr <N> head <sha> until <…>`, leaves the PR's slices open
and moves on. The tick's `hold-expired` reason wakes it once per hold (its own `train-wake:` consumes it), and the
train re-reads `prStakes` just before `gh pr merge`. Not caught: a `halt` written in the seconds between that read and
the merge. **`halt <wl>`** writes Jo's instruction, the surface's `plan: halted <instruction>` and a `lane-stop:`
request to a live holder. `planFirst` then reads the workload as unapproved, so change slices are refused. The train
holds its PRs with no end, auto-start never fires on it again, and Jo's `approve` on its next plan question approves
it as before.

### B7 · Wake: the ledger rendered, never a hand's prose (P-17)

**Ruled 2026-09-23.** Jo: *"i think we should refer to a ledger over an agent's prose pretty
much any day."* At every P-17 trigger (compaction, restart, first lane on a workload with
history) the lane's first context is **the ledger row rendered**: brief, stakes, open slices and
their states, the last N ledger entries (decisions, hand-backs, Jo's direct instructions), and
the message queue with P-7c states. Captured continuously by machinery — nothing depends on an
agent remembering to write a handoff. **Verified read:** the lane's first turn must write one
ledger entry stating what it is resuming; the machinery refuses a second turn until it exists
(P-11: single tool call). Older history is one P-13 index query away. Rejected: a hand-written
handoff or summary as the wake source (1.x `session-handoff.md`, wrap-up prose) — the 1.x
"seats forget" failure is exactly a handoff that was not written or not read. Prose may exist
*in* the ledger as an entry's body; it is never the source of truth for state.

### B8 · Machinery vs state, and the install path (P-15)

**Ruled 2026-09-23.** Jo: *"yes"* (after *"i agree that portability of state is a separate
question"* and *"1.x has a lot of drift right now"*).

**The rule:** machinery = everything identical on every machine — the 2.0 OMP extension(s), the
four tier agent files, the classifier prompt, rule text, gates, skills, the ledger **schema and
module** (B2: rules in the file, module callable without OMP; no custom CLI), the profile *template* (settings, model-role and tier→model mapping, extension
list; no secrets) — lives in the `agent-system-2.0` repo. State = everything per-machine or
per-moment — ledger *contents*, sessions, workload briefs, checkouts, credentials, Phoenix data —
never in the repo. Classifies the two unclassed items: the per-workload brief is state; OMP's
install units are machinery the repo declares. Per-repo rules (P-5) are machinery owned by each
product repo, not by this one. Whether state *can* travel is B2's sync property, held there.

**The install path:** one script that builds the OMP profile from the template and links the
extension and agent dirs into it — "clone, run install, add your keys".

**No hand-maintained artifact table.** The script reads a **machine-read install manifest** in
the repo — one row per artifact: path, kind, destination — and that manifest *is* the machinery
table. It cannot drift from what is installed because it is what is installed; a repo artifact
under the machinery directories with no manifest row **fails install** (P-11 mechanical check);
a wrong row fails the fresh-machine install test (P-4 gate). `DESIGN-2.0.md`'s per-artifact rows
(Session C) cite manifest rows rather than restating them. Rejected: a hand-written per-class
table (drifts — the same failure seen today in `REQUIREMENTS.md` summary rows and
`briefs/phase5.md`); rule-only (leaves the ambiguous rows — profile settings vs secrets,
tier→model table, per-repo rules — to be re-reasoned each time). Cost: one manifest row per new
artifact, one build step, the fresh-machine test that P-4 requires anyway.

### B9 · Slice brief minimum fields; leaf-only (P-20)

**Ruled 2026-09-23.** Jo: *"i agree with these"*, then *"good reccos lets do em"*. A slice brief
has exactly six fields: (1) **workload id** (ledger key); (2) **task**, one paragraph; (3)
**done-condition**, stated as the runtime artifact that closes the slice (B1) — what P-4's gate
accepts; (4) **inputs**: the paths and branch the hand may touch (feeds the A2.3 branch lock and
the OQ-1 repository boundary); (5) **stakes**, inherited from the workload, never re-stated by
hand (feeds the B4 cap); (6) **ceiling share**, a number the lane sets from the workload's
remaining ceiling (P-14). Work-kind and tier are **not** fields — the classifier derives them from
(2) (A1.1, A1.3). **Leaf-only:** a slice never spawns sub-slices; a hand that finds it needs
decomposition closes its slice with a "needs split" artifact and the lane cuts new slices.
Rejected: sub-slices (hands spawning hands — the Lintel pattern Jo rejected in the cross-lab
rulings, `PREFERENCES.md` § log 2026-09-23); extra fields (every field is one the lane can fill
wrong; six is what the ruled machinery consumes).

**Dispatch identity (M3 fix round 4, triad row 12).** The brief's fields are not the whole
dispatch: the `task` call's `name` is the slice id. It must be an existing `sl-…` slice of the
brief's workload and a valid OMP agent id, `[A-Za-z0-9_-]{1,48}` (OMP renames anything else, so the
routing could not be matched); the classifier refuses a tier dispatch that breaks either, a brief
whose `slice:` line differs from `name`, and a brief whose `workload:` differs from the session's
bound `AGENT_SYSTEM_WORKLOAD_ID`.

**Amended 2026-09-28 (Jo, interactively: "Amend § B9: add `kind` and `slice`, required only while a question is open").** Two conditional fields, present only while the workload has an open `question` row (P-11 lane-raised-question row): (7) **kind**, `research` or `change` — declared, never inferred from prose, because "without making changes" in a task paragraph is the bypass the M4 review found; (8) **slice**, the `sl-…` id a `change` targets, so the gate can refuse a second `change` on a paused slice and let research through. With no open question the brief stays six fields and the gate ignores both. Built in M4 (`gates/`, review round 1, B5).

### B10 · Linear and GitHub issues (new requirement P-21)

**Ruled 2026-09-23.** Jo: *"much like 1.0, 2.x must work with both"* — *"I don't know if i made
it a clear and explicit req"*. It was not in `REQUIREMENTS.md`; recorded here as **P-21: 2.0
works with both Linear issues and GitHub issues, as 1.x does.** The tie-back: a workload row
carries an optional `source` link (a Linear issue or a GitHub issue; `.projects/` specs likewise);
on workload **open** and **close** the machinery mirrors state to the source — status plus a
one-line comment carrying the ledger summary; **nothing per slice** (a slice inherits its
workload's source through the workload id); the source is **never read for truth** (A3, P-7a:
open/closed is the ledger's query, never a scan of Linear or GitHub). Write-back is not a
reserved action (reversible, not on the A4 list). Rejected: per-slice ticket comments (the 1.x
noise pattern — a ticket carrying twelve hand reports; the ledger holds them for anyone who
asks). `REQUIREMENTS.md` gains P-21 in the pre-Session-C diff.

### B11 · The concrete ceiling (P-14)

**Ruled 2026-09-23.** Jo: *"i do run flat rate subs for kimi, claude, and codex"*, then *"yes"*.
The system's means: **three flat-rate subscriptions (Claude, Codex, Kimi) plus metered TypeSafe**
(fractions of a cent per `judge()` call, T3); **no other metered spend.** Every chat-tier call
has zero marginal cost, so the P-14 "monthly figure" is the subscriptions themselves. A workload
**ceiling** is a **nominal-dollar number at list price as OMP computes it** — the unit OMP already
emits per call — bounding the workload's share of *subscription capacity* (usage windows and
rate limits), not a bill; the orchestrator sets it by stakes (B4). **The reserved spend event
(P-7b item 2) is any spend that would cost real money beyond the subscriptions** — a metered chat
key, a paid service — plus, as already ruled, raising a ceiling once set. Rate-limit exhaustion
stays inside the lane (B3) unless it holds a thing past four hours (A3). Session C mechanical
rule to write: a tier whose provider is rate-limited falls to the same tier on another provider,
never up a tier; the tier→model table in the profile spreads tiers across the three providers
(spec names tiers, never models). Rejected: tokens (differ per tier), tier-hours (unmeasurable),
a per-provider table (three numbers Jo would have to remember).

**Amended 2026-10-14 — build fallback stays in the lane's lab** (§ A1.3, *Amended 2026-10-14 —
build hands follow the lane's lab*; `migration/items/build-hands-follow-lane-lab.md`; Jo, ledger
inputs `in-mv7hm58386f2o0` and `in-mv7hmuk0u600e8`; built in wl-mv7hiabx2ozy80). The mechanical
rule above now reads, for every hand that is not a review: a tier whose entry is unusable falls to
the same tier's next entry of the **same lab** — the lab of the spawning lane's current model —
never up a tier and never to another lab. When that lab has no usable entry in the tier, the
dispatch is refused rather than spent on another lab's subscription; loss of build failover to another
lab is the price of that guarantee. Reviews keep the cross-lab row and park rules of § B4
unchanged. The profile table still spreads every tier across the three providers: it is the
inventory each lab's lanes take their own entries from and each review takes the other labs'
entries from. Rate-limit exhaustion still stays inside the lane (B3) under the four-hour rule
(A3).

**Amended 2026-10-19 — the workload ceiling stops and tells; paired lanes are never stopped**
(`DESIGN-workload-ceiling.md` § 2, *Amended 2026-10-19*; `migration/items/escalation-policy.md`; Jo, 2026-10-19: *"yes
to auto-start, stop at 100%"*, deciding the escalation draft's decision 2, *"At 100% of a ceiling, as2 stops and sends a
notice. Jo can extend with one word. There is no automatic extension."*; Jo's paired-workload amendment
in-mvfo7nphl9xn28; plan rev 5 §§ 4–4.1; built in wl-mvfkv7llkp7nk0). The lane runner's meter raises no question at any
level. At 80 % of either half of the workload ceiling it sends Jo one notice per ceiling value, and the lane goes on.
At 100 % the lane stops (`lane-stop: … accepted ceiling`, outcome `stop`) and Jo gets one stop notice per ceiling
value (§ B3, *Amended 2026-10-19*). No ceiling extends on its own, at any stakes. Raising stays Jo's (§ B12.1 item 2).
`extend <wl>` adds one more block of the workload's own size; `ceiling <usd> [<hours>] <wl>` sets a figure. Each
writes Jo's instruction and then the `ceiling:` entry naming it. Either word relaunches an autonomous lane the ceiling
stopped, when that lane's spend is under the new value and no relaunch is already waiting. A workload whose holder is a
live by-hand lane (`as2 lane <wl>`, `launch:` cause `interactive`) is never stopped at its ceiling and puts nothing
about it on the needs-you list. That lane gets its spend against the ceiling at every turn start, and Jo gets a line
in its pane at every further 25 % of the original ceiling's dollars, past 100 % too.

### B12 · Two decisions held since the triple-check (P-7b, P-16/P-15)

**B12.1 The reserved list is five, closed by default — ruled 2026-09-23.** Jo: *"yes"* (after
*"if it is a final and fixed list, what happens when we run into a scenario that we did not
account for?"*). The five: (1) opening/closing a phase; (2) spend above a workload ceiling, and
raising one; (3) the A4 command list — `careful`'s enumeration, protected-branch push, deploy;
(4) changes to the system's own rules or machinery, including a workload's exceptions field;
(5) **production-stakes sign-off before merge** (P-4 "both", placed by B4) — in force before,
now counted; Jo's `train` word naming the PR is that sign-off (§ B4, *Amended 2026-10-20 — Jo's train word is the
production sign-off*). *Closed by default* means: the orchestrator cannot grow the list; it **may always
ask** about anything unlisted (escalating is not reserved, `PREFERENCES.md` § P-7b); additions
are Jo's ruling under item 4; per-workload extras go in the Jo-only exceptions field (P-5);
a scenario nobody foresaw costs one incident — B3 surfaces it, P-16 proposes the addition, Jo
rules. Rejected: an open-ended list (no promise to the orchestrator that "not reserved" is real);
a longer list (friction on the foreseen cases, no cover for the unforeseen one).

**B12.2 P-16 depends on P-15 — ruled 2026-09-23.** Jo: *"agreed to your recco for question 2"*.
No self-improvement proposal can be accepted until the B8 install manifest exists; accepting a
proposal *is* adding its manifest row (a hook, prose fix, or skill is machinery and lives in
the portable repo). Sequences the build: install path first, P-16 last, matching Jo's priority.
*Amended 2026-09-24 by B14.3:* acceptance is the proposal's **manifest effect** landing — a new
row, or an edit to an existing artifact (a deny rule, a prose fix) — not only a new row.

### B13 · Two operating modes; skill set small (new requirement P-22, provisional)

**Ruled 2026-09-23, provisional.** Jo: *"i like the 2 operating mode idea, but before we make
that a rule shouldn't we research whether that's a correct assumption?"*, then *"update p22 but
with the caveat that if research disproves this we might go in another direction"*. Recorded as
**P-22: agents work in both an autonomous mode and a user-driven mode, and the skill set is
sized for both — not 50+** (`JO-INPUT.md:37-38`, Jo's own words: *"I want these agents to be
able to both work in autonomous mode and user driven mode"*). **Caveat, Jo's:** the requirement
stands unless research disproves it; if it does, the direction changes. What is *not* ruled:
the repo-to-mode mapping in `JO-INPUT.md:38` (Osmani's `agent-skills` when Jo steers,
`obra/superpowers` for autonomous running). Phase 4 evidence leans against that mapping —
superpowers is the more human-gated of the two (three `<HARD-GATE>` stage approvals plus a
human-picks-executor gate, `research/phase4/research-E-planning-practice.md:76-122`) and
Osmani's `/build auto` is the one that runs task-to-task with a single human gate (`:215-218`,
`:537`) — so it goes to a bounded research question before Session C: *which of superpowers /
agent-skills / neither serves autonomous running vs user-driven steering, from source.* Session C
gains a **mode** column (which mode each kept skill serves) beside the harness-portability
column. `REQUIREMENTS.md` gains P-22 in the pre-Session-C diff.

**B13.1 "Autonomous" defined — ruled 2026-09-23.** Jo: *"your agreement is correct"*. Research
(`research/operating-modes.md`, from source) supports Jo's mapping with a scope correction:
steering → agent-skills (*"the user IS the orchestrator"*); autonomous → superpowers, but only
for **executing an already-approved plan** — before execution its HARD-GATE demands approval per
task and cannot be switched off; neither repo hands off small work with no approval step. So
P-22's **autonomous mode** means: **small work is handed off and handled with no approval step;
features execute an approved plan without pausing between tasks.** The repo mapping stands for
features; the small-work path is supplied by the lane machinery (B6: spec-and-plan is the lane's
first judge slice, by stakes), not by either repo. Rejected: autonomous = approved-plan execution
only (leaves Jo's *"give it a task and then it gets handled"*, `JO-INPUT.md:31`, unserved).
**Mode selection — ruled 2026-09-28.** Jo: *"taking both reccos"* (after *"when does a lane open
interactively, when does a lane open autonomously?"*). **Mode = who is steering.** A workload
handed to the orchestrator and left is autonomous; one where Jo opens the lane's session or says
"with me" / "plan it" is user-driven. Written on the workload row at open, shown in the stakes
one-liner (A1.2), flipped by Jo in one word; the flip is a ledgered instruction (B5). The mode
field sets `ask` availability at lane start (P-11: user-driven lanes keep `ask`; autonomous lanes
and hands lose it). **Flip semantics (gaslight G2, Jo: "yes", 2026-09-28):** a flip takes effect
before the lane's next turn; the surface shows the new mode as effective only once the lane's
tool policy matches (the build may reconfigure or restart the lane — not prescribed); pending
`question` rows survive the flip in either direction. Rejected: mode by stakes. Companion
escalation rule: B3 item 5 amendment.

### B14 · Self-improvement (P-16)

**B14.1 What is counted — ruled 2026-09-23.** Jo: *"let's follow the recco"*. P-16 counts
**only machinery-written ledger rows; nothing from prose.** The **error signal** is three row
kinds that already exist for other reasons: B3 error lines, B4 automated-gate refusals, and A1
low-confidence pull-ups. The **repetition signal** is Jo's direct lane instructions as ledgered
under B5, matched by normalized text across workloads (Jo's *"i've repeated something multiple
times"*, `PREFERENCES.md:541-543`). Costs nothing new to build: every counted thing is a row
that exists already. Rejected: transcript mining and prompt-time detection of Jo's correction
phrases (the two prose channels in `research/phase4/research-G-self-improvement.md:572`) —
same rule as B7 wake and B1 closure, the ledger over an agent's prose. Known gap, accepted: a
silent wrong answer Jo never corrected through a ledgered instruction is invisible; correction-
phrase detection may later arrive as a P-16 proposal of its own.

**B14.2 Threshold — ruled 2026-09-24.** Jo: *"taking the recco"* (after *"where are those
numbers coming from?"*). A proposal fires at **three occurrences of the same normalized
signal**. Source for three: every shipped counting system states 2–3 — *"Pattern recurs 2-3x"*,
*"makes the same mistake a second time"*, *"repeated tool-call failures"*
(`research/phase4/research-G-self-improvement.md:573`); the top of that cluster. **Left unset,
to be measured after a month of real ledger rows:** whether the three must spread across
workloads or may sit in one, and the time window. Both were first offered as "at least two
workloads, rolling 30 days" and withdrawn as unsourced when Jo asked — same rule as A1's
threshold: numbers are measured, not picked. Rejected: two (fires on coincidence); ruling all
three numbers now as provisional.

**B14.3 Proposal format and surfacing (P-8c) — ruled 2026-09-24.** Jo: *"recco agian"* (after
asking for RRSI to be researched first: *"would we also want to factor in
https://regularized-rsi.com/ once the machinery is stabilized?"*). Evidence:
`research/rrsi-and-proposal-formats.md` (seven formats compared; RRSI code at
`github.com/google-research/rrsi`). **The proposal is a hybrid:**

1. **Record: a ledger row of kind `proposal`**, columns shaped on RRSI's candidate record
   (`hypothesis, component, diff, delta_S, delta_C, accepted, outcome, S, C, bundle` —
   `rrsi/history.py:77-99`; score and cost fields **null** until 2.0 has a scorer) plus three
   2.0 fields: the triggering ledger row ids, the normalized signal key, and a
   **what-might-break** section (RRSI's corrective / preservative / transfer split), and a
   **manifest effect** field: *new row* or *edit to artifact X*. Dead proposals are kept, as
   in RRSI.
2. **Artifact: an unmerged branch in the portable repo** carrying the installable form (an
   OMP hook factory under `hooks/pre|post/` that actually fires, a prose diff, or a skill
   directory) with its P-11 enforcement class chosen cheapest-first from the ladder
   (deny-rule → ask-rule → prompt hook → pre-tool hook → post-tool hook → prose last). Cutting
   the branch is **not reserved** (B12.1 item 4): the branch is the proposal's body; Jo's merge
   is the act. RRSI likewise keeps one branch per candidate, fast-forwarded on acceptance.
3. **Surface: one line via the B3 route**, with a show command that renders the row and diff.
4. **Acceptance = merge**, under the reserved list; the install step writes `accepted` back to
   the row so the ledger stays the only record (B2.1). **B12.2 amended:** acceptance is the
   proposal's *manifest effect* landing — a new manifest row, or an edit to an existing
   artifact (a deny rule in the profile template, a prose fix) — not only a new row.
5. **Recorded from day one, cannot be backfilled:** the portable-repo commit each lane ran
   under, and a `proposal_id` on every manifest row.

**RRSI, post-stabilization.** Its leakage critic reads only the diff (`rrsi/critic.py:115-147`)
and may run on proposals now; its noise floor, cost rule, and pruning need a measured score
and cost (`selection.py:81-121`, `calibrate.py:85-107`) and switch on over the same rows once
a scorer exists — the format does not change. Whether 2.0 ever runs an *apply* loop (RRSI's
shape; P-16 is propose-only) is a decision for after the machinery is stable, held here.
Rejected: branch-only without a row (two records or none); a queue directory (second store);
surface message with inline diff (scrollback as record, the 1.x failure); Linear/GitHub issue
as the primary vehicle (needs a write-back webhook to keep the ledger true; available later
for phone/teammate acceptance); shadow-mode install (violates "never applies"; possible
post-acceptance stage). **P-16 closed.**

**Amended 2026-10-14 — machinery first for all work** (`migration/items/plan-requirements-name-their-enforcer.md`; Jo, input
in-mv61a9s52y4g00: *"anything as2 has to do is done by code that renders, gates, refuses or tests
it, and a prose instruction to a model is the fallback only where code cannot reach"*; the scope is
Jo's instructions in-mv61vrgz48tpts and in-mv61vrk3ca8q2o, as first written for PR #111; built in
wl-mv8vwb04cy18n4). Machinery first governs all work done on or with as2 or any other agent, LLM or
AI software, not only P-16 proposals: as2's own lanes, hands, gates, surface and classifier; Plumb,
Tinker and the other seats; skills, tier files, prompts and briefs; and any LLM or AI feature in a
product repo. For that work, anything the system has to do is done by code that renders, gates,
refuses or tests it; an instruction to a model is the last rung. The ladder in item 2 (deny-rule →
ask-rule → prompt hook → pre-tool hook → post-tool hook → prose last) widens to all of it: a test,
a gate, a hook or code before prose, and prose is chosen only with a stated reason. The rule is
normative for all such work; the gate built for it is narrower. It fires only on a plan question
offering `approve` (§ B6, *Amended 2026-10-14 — requirements name their enforcer*): each requirement
in the plan file names its enforcer or says `prompt-only:` and why, and the question lists the
prompt-only items for Jo. A workload without a plan gets no enforcer check, and no slice added
through `lane_add_slice` is checked. PR #111's slice-tag gate (an enforcement tag on every plan
slice line and every `lane_add_slice` task, `migration/items/plan-slices-name-their-enforcement.md`,
never merged), including the `lane_add_slice` check of Jo's in-mv61vrgxu5iuio, was superseded, not
adopted: a category tag on a slice names no enforcer a reviewer can open, its vocabulary
(`render`, `gate`, `refusal`, `test`, `prose`) would have been a second grammar on one question, and
its `tiers/lane.md` growth broke that file's size bound. Not enforced by code: whether a named
enforcer is real and covers its requirement, or whether a prompt-only reason is a good one; Jo
judges that on the plan and reviewers on the diff.

### B15 · Output types and receipt verification (new requirement P-23)

**Ruled 2026-09-24.** Jo: *"i agree with your reccomendation. verification is important - i am
not sure why we didn't enforce this in 1.x"* (after asking for research first: *"the problem we
are trying to solve is it is hard to gauge the veracity of an LLM's statements"*). Jo's
original must, `JO-INPUT.md:20`: *"all agents must obey these when communicating, hooks can
enforce them"* — it had no home in 2.0 (`research/output-types-coverage.md`: zero hits in this
spec, Session C row only). Recorded as **P-23**:

1. **Every 2.0 agent's outgoing message is labeled** per the output-types contract (CLAIM /
   CITE / GUESS / ACTION / QUESTION / PMDW, receipt per type); the contract is re-homed into the
   portable repo (P-15, P-18), one copy.
2. **Receipts are verified mechanically, not trusted.** At the lane, a program checks each
   report against OMP's own tool-call record — which already persists what is needed
   (`read` results carry `resolvedPath`, text, `startLine`, `url`/`finalUrl`; `bash` results
   carry `toolCallId`, content, exit code; `research/receipts-and-veracity.md`): a CLAIM's
   `file:line` plus a required short quote was read this session and still matches disk; a
   CITE's URL was fetched, no redirect; an ACTION's exit code matches the record; a "tests
   pass" has a test run after the last edit. Zero model calls. **The verified counts replace
   the self-reported envelope.** Hands never receive `session_stop` (`agent-session.ts:4287`),
   so the check runs at the lane over the hand's transcript.
3. **Propagation is lane machinery**: the lane injects the contract into every hand's system
   prompt; no brief field (B9 stands at six).
4. **P-11 gains a second mechanical trigger**: *"a message leaving an agent"*, beside *"a
   single tool call"*.
5. **P-8a narrowed**: a hand report whose receipts fail verification is **flagged, not
   trusted**; the check is informational at the lane, never blocking the hand.
6. **Judge models excluded** from receipt checking until OQ-1/OQ-2 (workspace text to
   TypeSafe) is ruled and a measurement exists — nothing found catches rule-7 overreach (a true
   receipt, an oversized conclusion); judges on agent traces score AUROC ≤ 0.65.

First measurable test (P-4 gate for the build): replay the check over 30 existing reports and
measure the unbacked-receipt rate; thresholds proposed by the research hand (≥ 5 % ships
verification, < 1 % labels alone), unmeasured. Rejected: labels only, as 1.x (the envelope is
self-reported and never checks that a receipt exists, let alone supports the sentence); vendor
citation APIs and entailment checks (do not catch rule 7). Prior art in 1.x:
`phantom-claim-stop.mjs` blocked a turn claiming an action with no tool call behind it — the
narrow ancestor of item 2, dead under OMP (`INVENTORY.md:362`).

**Amended 2026-09-30 — the trivial-ask path** (Jo, after the first M7 session: *"i asked it one
simple thing about changing my omp prompt and it HAS ALL OF THIS HORRIBLE OUTPUT"*; ruled as M7
finding 4). Item 1 gains one exception. A **trivial ask** is one the orchestrator answers with
words alone: no repository write, no hand, no ledger row, and no command that changes state. An
opinion, a fact the orchestrator already holds, a chat reply, and a question answered by reading
(`read`, `grep`, a read-only command: Ilex's "what's open on M7") are trivial. **Strict**, ruled
the same day on the conflict with P-11 row 15: a change Jo names, however small (`omp update`,
"change my prompt"), is a workload opened in one line and run by a lane; the orchestrator never
runs it itself (row 15 refuses mutating bash on the orchestrator). For a trivial ask the
orchestrator keeps the wake read (once per session, unchanged), opens no workload, and answers
in plain prose with no labels and no envelope, at most one question, last (P-11 row 1 still runs
and counts a question with its options as one ask). The moment the answer needs a change, a
hand, or a durable record it is not trivial: the orchestrator opens the workload then and says
so in one line. Row 3 does not flag a zero-label reply whose turn made no working call (a write
or edit, `task`, `eval`, a command that is not read-only, a ledger tool other than the wake
read); opening a workload is a working call. Homes: `tiers/orchestrator.md` § *Trivial asks*,
`contract/output-types.md` § *Scope* and § *Parent-side handling*,
`gates/src/rows/r03-receipts.ts` header.

### B16 · Interactive by default; commands as logged scripts (new requirement P-24)

**Ruled 2026-09-24.** Jo: *"i find i prefer an interactive style of working vs you just handing
me a giant md … working with me through steps rather than dumping a large scrollback or md on
me … it's currently a preference but it will become a need/requirement that if an agent passes
me commands to run - even if it's a 1 liner - it's in the form of a disposable shell script with
a logger attached"*; then, on the mechanical form: *"yes to the improvement"*. Recorded as
**P-24**:

1. **Interactive by default.** When a decision is Jo's, the agent works through it step by
   step — one ask per turn, a recommendation attached, conclusion first — and never hands over
   a large document in place of the steps. *Interactive is not chatty*: B3 and the A3 threshold
   bound how often an unsolicited turn arrives; P-24 governs the shape of a turn when one is due.
   The spec itself was built this way (one question per message, `briefs/phase5.md`).
2. **Commands handed to Jo are logged, disposable scripts** — one-liners included. The script
   lives outside every repo (`~/agent-scratch/<repo>/`), announces each step, stops on first
   failure, tees to a fixed log path; the ledger row that handed it over records the log path;
   the script's exit writes a row (exit code, log path). **The lane listens**, not the hand: the
   hand that wrote the script may be closed when Jo runs it; the lane is bound to the workload
   for its life (P-2, P-5). A non-zero exit is one of B3's error lines. One named exception
   (amended 2026-10-17, `migration/items/pair-offer-own-line.md`, the exception MIGRATION.md
   item 52 asked for): the orchestrator may give Jo the by-hand `as2 lane wl-…` line that
   continues a user-driven workload, bare, in plain text or inline code, never inside a shell
   fence. It names the lane Jo starts in his own terminal; there is no script to log.
3. **Mechanical, not prose — the OMP settings and the gate.** *Ask before acting*: a lane runs
   under `tools.approvalMode: write` with per-tool `tools.approval` overrides
   (`omp://approval-mode.md:14-30`) in the profile template (B8 machinery). *Ask as a
   structured picker*: every decision that is Jo's goes through OMP's `ask` tool — options,
   `recommended` index, "chat about this" escape (`omp://tools/ask.md:16-26`); it exists only
   when `session.hasUI`, so it is a lane-to-Jo instrument. *Plan before acting*: OMP plan mode
   / `xd://propose` where B6 puts a judge slice first. *Turn shape and script rule*: checked at
   P-23's message-leaving-an-agent gate — a turn addressed to Jo with more than one
   ask/QUESTION, or carrying a bare command instead of a script path, is refused. On the
   orchestrator (P-11 row 1) a refused reply's finalized text is replaced by one fixed marker
   line that quotes nothing from the draft, and rewritten; the draft may show while it streams,
   since OMP does not retract streamed text (amended 2026-10-07, MIGRATION.md item 37). One
   marker shows per prompt: a later hold in the same prompt (a refused rewrite) shows "…" in
   each text block instead, and still blocks with its full reason and original; the marker
   shows again after Jo's typed input or a reply that passes row 1 (amended 2026-10-08). The
   item 2 exception passes the gate: on the orchestrator, row 1 lets the bare `as2 lane wl-…`
   line through in prose and in inline code and still refuses it inside a shell fence (amended
   2026-10-17, `migration/items/pair-offer-own-line.md`, MIGRATION.md item 52).
4. Session C's C2 pass (communication rules) opens with P-24 as its governing requirement; the
   1.x prose rules in `~/.claude/CLAUDE.md` § *How to communicate with Jo* and § *Commands you
   hand to Jo to run* are re-homed (P-18) as the text behind the gate, not as the enforcement.

Rejected: keeping this as a Session C communication-rule input without a requirement number
(Jo: it is a need, not a preference); prose-only enforcement (OMP already has the settings;
the turn-shape rule rides the P-23 gate).

## Session C — keep / change / drop pass (P-10)

**Opened 2026-09-24.** Jo: *"sure let's do it"*, *"to session c"*. Disposition ledger lives in
`DESIGN-2.0.md`; batch order C2, C4, C3, C5, C6, C1, C7, C8. No hands dispatched for C2 — the
seven rows are already receipted in `INVENTORY.md` § 1.2; judgment runs on Jo's and Plumb's turns.

## Open questions

- **OQ-1 (2026-09-23, from `research/typesafe-data-terms.md`) — which entity is the Customer on
  the TypeSafe key in the 2.0 profile: Jo personally, or Newdle?** MCA §5 makes the accepting
  party warrant it holds the rights to the Input. *Personal key* → only Jo-owned repositories may
  appear in slice briefs. *Newdle key or Newdle-approved key* → Newdle repositories may too.
  Terms otherwise acceptable for repository text (no training use, MCA §4.1; retention not
  zero, US-hosted); not acceptable for secrets. Held until the key goes into a profile.
- **OQ-2 (2026-09-23, from Tinker's T3) — the TypeSafe data boundary, and it is already live.**
  Tinker's CLAIM: the TypeSafe key has been in the **default** OMP profile since 2026-09-21 10:31
  (`~/.omp/agent/agent.db` auth_credentials id=12), so every 1.x session's native `find` tool has
  been sending workspace text to TypeSafe since then (GUESS on volume; calls not counted). The
  "read the terms before the key goes into a profile" heads-up was overtaken before it was
  written. Options: (1) send real slice briefs under the standard terms as published; (2) ask
  privacy@typesafe.ai for zero-data-retention terms first and send synthetic or metadata-only
  state until answered — **recommended by the terms hand and by Tinker**; (3) send a structured
  slice summary only. The same choice governs the live `find` path. OQ-1 (whose account) is a
  sub-question of this one.
  - **2026-09-24, Jo, in Plumb's tab:** *"it's just my account"* and *"it is not a problem re
    typesafe."* Plumb's reading: OQ-1 = Jo's personal account; OQ-2 = standard published terms
    are acceptable, no zero-retention request. A measurement of what OMP actually sends to
    TypeSafe was handed to Tinker (via Lintel) before this ruling; its report lands at
    `/Users/jowolff/agent-scratch/agent-system-2.0/typesafe-usage/REPORT.md`. Judge layer of
    P-23 (§ B15 item 6) still waits on that measurement, not on these questions.
