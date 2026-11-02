# Involvement: how much Jo is in a workload, what decides it, and the loop that tunes it

Spec, 2026-10-28. It replaces as2's "production stakes". Jo approved the outcome on 2026-10-28, morning PDT. The ruling record is `.ai/decision-log/2026-10-28--0920--plumb--involvement-replaces-production-stakes.md`. Nothing here is built yet. Production merges are paused until it is (Jo, 2026-10-28, morning PDT).

This revision answers three rounds of an independent OpenAI review at `/Users/jowolff/agent-scratch/agent-system-2.0/involvement/REVIEW-openai.md`. § 12 maps each finding to the section that resolves it.

## 1. Top screen

**Three levels.** A workload gets a starting level when it opens. Six checkpoints across its life can raise the level. Nothing lowers it except Jo.

| Level | What happens | What can stop the work |
|---|---|---|
| **With operator** (`with-operator`) | The operator, Jo today, is in from the start. Jo steers, the plan waits for Jo, and the merge is Jo's. | Everything goes through Jo. |
| **Escalate** | The agent works alone and stops to ask Jo when it hits a named criterion (§ 4). With no hit, it merges itself and Jo gets a notice. | Every criterion, both the code checks and the recorded agent judgments. |
| **Solo** | The agent works alone, merges itself, and Jo gets a notice. | **The all-level stops only (§ 3.1)**: Jo's own boundaries, the reserved list, irreversible commands, as2 machinery and rules paths, and Newdle production paths. Other judgment criteria are recorded but don't stop it. |

The default starting level is **escalate**. A workload starts **with-operator** on Jo's words or on the open-time criteria in § 4. It starts **solo** for scratch and throwaway work, and for plans that touch only docs. A docs plan still asks at merge if its final diff touches a rules file (§ 3.1).

**Decided: the field's name.** The field is **`operatorInvolvement`** (ledger column `operator_involvement`), with the levels **`with-operator` / `escalate` / `solo`**. Jo decided this on 2026-10-28; `date` read 09:51 PDT when the decision was recorded. Jo's words: "how about operator involvement?", then "i like it - with-operator". The reason: as2 is public and runs wherever OMP runs, so the schema doesn't hard-code Jo's name. Earlier, Jo rejected "reserved", and said "production stakes" misleads because most of Jo's work goes to production.
- Also considered: `involvement` with `with-jo`, `oversight`, and `autonomy` (`paired` / `checkpointed` / `full`).

**Decided: graduation is Jo's switch.** The improver moves from "Jo approves each change" to "agents apply changes" only when Jo says so. Jo's word is recorded in the ledger as an `instructions` row. Nothing graduates automatically. Jo decided this on 2026-10-28; `date` read 10:08 PDT when the decision was recorded. Jo's words: "i think the weekly criteria runs without me after i say it does, and we use ther checks as written as guidance. but *I* am the one who flips the switch".
- **The six gates (G1–G6, § 7.5) are guidance.** Every weekly report computes each gate and shows pass, fail or `insufficient data`, with the reason for each fail. The report never permits or blocks graduation on its own.
- **Jo may flip the switch while a gate is failing.** The flip is then recorded with the list of gates failing at that moment.
- **A failure after the switch notifies Jo loudly and waits for Jo's call** (§ 7.6). This covers an overdue or failed weekly audit, missing live data, a missed ask on a protected criterion (C2, C4–C8, C10), and the tripwire.
  - Jo gets one immediate needs-you notice naming the failure and its evidence, sent loudly through as2's existing alert channels.
  - The rewriter keeps its current authority until Jo rules. Nothing drops back, and nothing is reverted, on its own.
  - Jo's call (keep running, suspend, or suspend and restore the wording that was live before the incident) is recorded in the ledger like the switch. Each incident is bound to the exact wording versions live when it fired, so `revert` names a fixed target even if more rewrites apply before Jo answers (§ 7.6).
  - Jo decided this on 2026-10-28; `date` read 10:58 PDT when the decision was recorded. Jo was asked "if the weekly criteria-rewriter fails a check after you've turned it loose, should it drop back automatically… or should a failure only notify you and wait for your call?". Jo's words: "notify and wait for my call", then "but notify me LOUDLY".

**Held until slice B10: which hosted model the improver may send ledger text to.** No local model runtime is installed, so any optimizer run sends criteria wording and ledger answers to a hosted provider (§ 6.4). Recommended: Anthropic, which already receives every lane transcript. This is held, not asked now. It blocks only B10.

---

## 2. Design facts this spec is built on

**CLAIM**
Jo approves most of what reaches them on Plumb's word. Jo, 2026-10-28, morning PDT (relayed verbatim by Plumb): "keep in mind I have SO many things to approve that I'm not reading them. I just ask you if it's a good idea and if you say so I send approve". The ledger agrees. `/Users/jowolff/agent-scratch/agent-system-2.0/escalation-policy/DRAFT.md:60`: "Jo approved 54 of the 57 such plans they answered."

**CLAIM**
The surface makes a followed recommendation the zero-effort answer, so a match can be an untouched paste. `/Users/jowolff/agent-scratch/agent-system-2.0/involvement-spec/surface/src/pending.ts:12-13`: "The word is the recorded recommendation, else the row's first option". `/Users/jowolff/agent-scratch/agent-system-2.0/recommendation-follow/REPORT.md:241-242`: the recommendation is the first option in 208 of 226 questions. Answers within 5 seconds of another answer, a proxy for a block paste, followed it 78/91 (86%). Single answers followed it 101/135 (75%).

Four consequences shape this spec:
1. **An `approve` is not Jo's judgment of the ask.** Jo's free-text messages around a decision are the labeler's primary signal (§ 6.2), for example "I don't understand why you're handing this to me". Approve and deny answers given on a recommendation are weak signals only. Jo, 2026-10-28, morning PDT: "can we record me sending messages AROUND the labeling. like 'I don't understand why you're handing this to me'".
2. **The month-one gate is really Plumb's recommendation plus Jo's one word.** So each proposed change gets an independent cross-lab review before Plumb recommends it (§ 6.4). The builder lab is Anthropic, so the reviewer is OpenAI.
3. **Jo's hand labels must be blinded.** The label audit shows Jo the case, not the agent's proposed label (§ 7.1). Otherwise the audit recreates the same recommendation-following it is meant to measure.
4. **A human gate nobody reads is a rubber stamp.**

**CLAIM**
`/Users/jowolff/code/agent-system-2.0/.tmp/escalation-research/REPORT.md:92` names the rubber-stamp risk from the OpenAI white paper: "approvals made quickly risk becoming a 'rubber stamp'". The same line quotes Codex: "fix the boundary first instead of teaching the reviewer to approve noisy escalations forever." That is the job of this spec: fewer asks, each one worth reading.

**CLAIM**
No surveyed system gates human involvement on the size of a change. `/Users/jowolff/code/agent-system-2.0/.tmp/escalation-research/REPORT.md:88`: "Irreversibility and blast radius are the main gate … They do not tie it to task difficulty." Jo's "big fix" (2026-10-28) is therefore replaced by checkable stand-ins (§ 5).

**CLAIM**
Today a PR's stakes come from its branch name, not its diff. `/Users/jowolff/code/agent-system-2.0/surface/src/merge-train.ts:233-236` (`prStakes`): a PR is production unless its head is `wl/<id>` (`WORKLOAD_BRANCH_RE`, `:195`) naming a ledger workload at normal stakes. The `gates/` ruling never sees a diff. `/Users/jowolff/code/agent-system-2.0/gates/src/rulings.ts:225` (`gates-stakes`) matches only an orchestrator stakes question whose body text mentions `gates/`. That is how #369 merged as2 machinery changes without Jo. The OpenAI review confirmed both lines (`REVIEW-openai.md:125`).

**CLAIM**
A path-list check against a PR's changed files already exists in as2. `/Users/jowolff/code/agent-system-2.0/surface/src/fast-set.ts:205-216` (`fullExceptions`) filters `changed` against `fullBeforeMerge` and the ledger schema files. The merge checkpoint in § 3 reuses that shape.

---

## 3. Six checkpoints across a workload

A **code check** is mechanical: paths, commands, counters, ledger operations or exact words. An agent can't argue its way past it. A **judgment** is an agent's decision, recorded with its reason in the ledger (§ 6.1). Every checkpoint records a decision either way, including "no criterion matched, proceeding".

| # | Checkpoint | Code check (can't be talked past) | Recorded agent judgment | What it can do |
|---|---|---|---|---|
| CP1 | **Workload opens** | Jo's words: steering words (`USER_DRIVEN_WORDS`, `surface/src/stakes.ts:30`: "with me", "pair", "walk me through" …). Production words only raise the level (`PRODUCTION_WORDS`, `stakes.ts:26`). Target repo: as2, a Newdle product repo, or a scratch repo (`SCRATCH_REPO`, `stakes.ts:28`). Whether a protected target is named. Jo's explicit boundaries in the brief, including its reserved-list exceptions. | The Jev judge (`typesafe/jev-1.13.0`, the open-time judge behind `judgedLarge`, `stakes.ts:88-91`) proposes the starting level from the brief, with confidence. Below the low-confidence threshold, the higher of its top two choices applies. | Sets the starting level. |
| CP2 | **Plan written** | The plan's named paths are checked against the machinery list (S1), the rules list (S7) and the Newdle production list (S3). | Does the plan leave scope, architecture or risk tolerance open (C3)? | Raises the level. Under escalate, a hit holds the plan for Jo. An all-level hit (§ 3.1) holds it at every level. |
| CP3 | **During work, per slice** | Each slice's changed paths are re-checked against S1, S3, S5 and S7. Counters: 3 failed retries, the review round limit, and the spend ceiling. Ledger operations: `phase.open` and `phase.close` always ask. `ceiling.raise` asks except for N7's first raise by half with progress (§ 3.1). | Stuck (C14), conflicting instructions (C13), scope growth beyond the plan (C14). | Raises the level. A hit pauses only the affected slice and queues the ask. |
| CP4 | **Before an irreversible command** | The existing command gate: force-push, hard reset, branch or tag delete, `rm -rf` outside the worktree, `DROP`/`TRUNCATE`, prod DB write, infra teardown, secret rotation, protected-branch push, deploy (`SPEC-2.0.md` § A4, ruled 2026-09-23). | None. This checkpoint is code only. | Always asks, at every level, solo included. |
| CP5 | **Merge** | The PR's changed files (`git diff --name-only <merge-base> <head>`) against S1, S3, S5 and S7. This replaces the branch-name rule in `merge-train.ts` (`prStakes`) and the question-text check in `rulings.ts:225` (`gates-stakes`). Forks and unknown head repositories still ask. **The check runs from main's copy of the lists and the checker, never from the PR's own copy.** | Guard weakening (C8): does a test or gate change weaken what runs before merge? The keyword scan (`.skip`, `xit`, `--no-verify`, removed assertions) is mechanical. Whether a change is a real weakening is judged. A diff that declares a phase done (C4). | No hit: merges itself and Jo gets a notice. Any hit: asks Jo. |
| CP6 | **Deploy, and after merge** | Deploy and migration paths in the target repo (S2, S3). A revert commit naming the merged PR. A failed deploy or health check. | Was the revert or failure an involvement miss, or a defect in otherwise allowed work? This is adjudicated for the labeler (§ 6.2), not used as a gate. | A deploy asks (CP4). A revert or failed deploy is reported to Jo now (C15) and queued for adjudication. |

### 3.1 All-level stops (precedence rule)

These stop the work at **every** level, solo included. They take precedence over every solo criterion (N1–N7) and every docs-only default:
1. **Jo's explicit boundaries** for this workload: steering words, a protected target named in the brief, and the brief's reserved-list exceptions.
2. **Every item still on the P-7b reserved list** (`PREFERENCES.md:313-325`):
   - **Item 1, opening or closing a phase (C4).** No phase record exists in code today: `grep -rniE phase` over `surface/src`, `gates/src` and `ledger/src` finds only unrelated uses. Slice B3 adds ledger operations `phase.open` and `phase.close`, which always ask. A diff that declares a phase done is a recorded judgment at CP5.
   - **Item 2, spend above a ceiling, or raising one (C10).** The first ceiling hit with progress is allowed to raise by half and tell Jo, at every level: N7, authorized by ledger ruling `in-mvqyt4a8gezvgg` (e), which the review also inspected (`REVIEW-openai.md:20`). A second hit, a hit with no progress, or any other raise asks.
   - **Item 3, irreversible actions (C5).**
   - **Item 4, rules and machinery (C2, C7).** This is narrowed only by the improver exception in § 6.5.
3. **Newdle production paths (C6).**

---

## 4. Criteria

"Row N" and "N#" refer to the escalation survey, `.tmp/escalation-research/REPORT.md`. Row N sits on line 18+N, and N# sits on line 47+#. Ledger IDs are Jo's rulings in `~/.agent-system-2/ledger.db`, table `instructions`. "All levels" means the criterion is an all-level stop (§ 3.1).

| ID | Criterion | Level | Checkpoint | Mechanical or judgment | Source |
|---|---|---|---|---|---|
| C1 | Jo asked to steer ("with me", "pair", "walk me through") | with-operator | CP1 | Mechanical (words) | `stakes.ts:30` `USER_DRIVEN_WORDS`. Row 14, Claude Code: "Claude's own judgment that a condition was met does not lift it." https://code.claude.com/docs/en/permission-modes |
| C2 | A change to as2's **rules** (S7): `PREFERENCES.md`, `SPEC-2.0.md`, `gates/src/rulings.ts`, a brief's exceptions field | with-operator at CP1/CP2; asks at all levels at CP3/CP5 | CP1, CP2, CP3, CP5 | Mechanical (paths), plus judgment for brief text | `PREFERENCES.md` P-7b item 4 (:323-325): "only Jo edits it" |
| C3 | An architecture, scope or risk-tolerance choice the brief leaves open | with-operator at CP1/CP2; escalate at CP3 | CP1, CP2, CP3 | Judgment | Row 8, Gas Town: "Architectural choices that need human judgment." https://raw.githubusercontent.com/steveyegge/gastown/main/docs/design/escalation.md |
| C4 | Opening or closing a phase | all levels | CP1 (judge), CP3 (`phase.open`/`phase.close` op), CP5 (judgment) | Mechanical at the operation, judgment on a diff | `PREFERENCES.md` P-7b item 1 (:313) |
| C5 | An irreversible action outside the repo (the A4 command list) | all levels | CP4 | Mechanical (command gate) | `SPEC-2.0.md:259-262` (A4, ruled 2026-09-23). Row 1, Codex: "destructive actions with significant risk of irreversible damage." https://learn.chatgpt.com/docs/sandboxing/auto-review |
| C6 | Shared or customer data, or someone else's resource: Newdle production paths (S3) | all levels | CP2, CP3, CP5, CP6 | Mechanical (repo plus path) | Row 6, Claude Code: "Modifying shared infrastructure." https://code.claude.com/docs/en/permission-modes. Row 13, Atlassian SEV 1: "Customer data loss." |
| C7 | A merge that changes as2's **machinery** (S1) | all levels | CP5 (flagged earlier at CP2, CP3) | Mechanical (paths) | `PREFERENCES.md` P-7b item 4 (:323): "Changes to the system's own rules or machinery". Case: #369 (§ 8). |
| C8 | Weakening a guard: tests, CI, gates, fence | escalate | CP3, CP5 | Mechanical (path plus keyword), judgment for the verdict | Row 16, Claude Code: "Commenting out, deleting, or force-passing a test or assertion that guards security behavior." https://code.claude.com/docs/en/permission-modes |
| C9 | Security or credentials | escalate | CP3, CP4 | Judgment, plus the command gate for secret rotation | Row 4, Gas Town: "Unauthorized access attempts, credential exposure." (row 8 URL) |
| C10 | Spend: a second ceiling hit, a hit with no progress, or any ceiling raise other than N7 | all levels | CP3 | Mechanical (counter and `ceiling.raise` op) | Ledger `in-mvqyt4a8gezvgg` (e). `PREFERENCES.md` P-7b item 2 (:314-319) |
| C11 | An exhausted counter: 3 failed retries, or the review round limit | escalate | CP3 | Mechanical (counter) | `REPORT.md:90`: "Every system with a number uses 3 to 5." Row 9. |
| C12 | A merge conflict that both the resolver and the owner lane failed on | escalate | CP3, CP5 | Mechanical (both attempts failed) | Row 10, Amp: "a substantive conflict … checks with you before continuing." https://ampcode.com/docs/markdown/orbs/shipping |
| C13 | Conflicting instructions: two active rulings that conflict once their scopes are checked | escalate | CP3 | Judgment | Row 15. **The survey marks this trigger UNVERIFIED** (no fetched source names it). It is carried from `escalation-policy/DRAFT.md:17`. |
| C14 | Stuck, or scope growing beyond the plan | escalate | CP3 | Judgment | Row 9, Gas Town: "Stuck loops: Agent is stuck and cannot make progress". Row 7: "Ambiguous requirements". |
| C15 | A merge reverted, or a deploy or health check failed | report now, at every level | CP6 | Mechanical (revert commit, deploy status) | Row 24, Google SRE: "urgent, actionable, and actively or imminently user-visible". https://sre.google/sre-book/monitoring-distributed-systems/ |
| C16 | Jo's intake words "prod", "deploy", "customers", "live" | Raise only, to escalate | CP1 | Mechanical (words) | `stakes.ts:26` `PRODUCTION_WORDS`. Jo-loop catalog § 2: the keyword match misses unspoken deploy-adjacent work, so it may only raise (`/Users/jowolff/agent-scratch/agent-system-2.0/jo-loop-catalog/REPORT.md:390`). |
| N1 | Ordinary GitHub writes: feature-branch push, PRs, comments, merging green PRs | solo | CP5 | Mechanical | Ledger `in-mvqyt4a8gezvgg` (c). `SPEC-2.0.md:262-263`: "Not reserved: … merges of approved, green PRs" |
| N2 | Docs, decision-log and cleanup PRs, whatever the branch name, **unless the final diff touches S7** | solo | CP2, CP5 | Mechanical (paths) | N7, oversight-rig: "Cleanup, refactoring, or anything explicitly de-prioritized." https://raw.githubusercontent.com/gastownhall/gascity-packs/main/oversight-rig/agents/project-lead/project-brief.template.md |
| N3 | Scratch or throwaway work | solo | CP1 | Mechanical (`SCRATCH_REPO`, `THROWAWAY_WORDS`) | `stakes.ts:27-28` |
| N4 | Routine work, local edits, builds and tests | solo | CP3 | Mechanical | N1, Gas Town: "Regular work that can proceed without human input". N10. |
| N5 | CI failures and review findings on its own PR, below the round limit | solo | CP3 | Mechanical (counter below limit) | N12, Devin: "automatically responds to review comments and CI failures … without you in the loop." https://docs.devin.ai/essential-guidelines/instructing-devin-effectively.md |
| N6 | Transient faults (retry), a red test the branch doesn't touch, a question already answered | solo | CP3 | Mechanical | N2, N13, N3/N8 |
| N7 | First ceiling hit with progress: raise by half and tell Jo | notice, at every level | CP3 | Mechanical | Ledger `in-mvqyt4a8gezvgg` (e) |

---

## 5. "Big fix", replaced by checkable stand-ins

None of these uses line count, file count or the PR title. #331 is +2939 lines and docs only. #343 is titled "docs:" but changes a test file.

| ID | Stand-in | How it is checked | Used by |
|---|---|---|---|
| **S1** | **Touches as2 machinery. This is the main stand-in.** | Changed path matches one of eight **groups**: `train` (`surface/src/merge-train.ts`, `surface/scripts/train-tick.ts`, `surface/src/fast-set.ts`), `gates` (`gates/`), `classifier` (`classifier/`), `ledger-schema` (`ledger/schema.sql`, the `SCHEMA_VERSION` line of `ledger/src/index.ts`), `install` (`install/`, including the launchd `*.plist` files), `profile` (`profile/`), `workflows` (`.github/workflows/`), `involvement` (this feature's policy file, path lists, enforcement code and protection check, § 6.5). **The criteria-wording file is not in S1.** Its changes go through the improver exception (§ 6.5). | C7 |
| S2 | An effect `git revert` can't undo: deploy, migration on a shared DB, infra, secrets | Commands: the A4 gate (CP4). Paths: deploy workflows and migration directories in the target repo. | C5, C6, C15 |
| S3 | Newdle production: the target is a Newdle product repo and the path reaches prod | Repo allowlist plus path globs. For newdle-api: `.github/workflows/cicd.yml` (its `deploy` input runs `doctl apps create --upsert`), `.github/workflows/*deploy*.yml`, `deploy/`. For newdle-db: `migrations/`. Other Newdle repos get their globs in slice B5. | C6 |
| S4 | Breadth: the number of distinct S1 groups the diff touches | Count of the S1 group keys above. No source supports a particular threshold, so it is **recorded only**, not a gate. It feeds the eval as a feature. | Recorder |
| S5 | Weakens a guard | Paths `gates/src/rows/`, `surface/src/fast-set.ts` and test-runner config, plus the keywords `.skip`, `xit`, `--no-verify` and removed `expect(` lines. The verdict is judged. | C8 |
| S6 | Jo's wording at intake | `PRODUCTION_WORDS`, raise only | C16 |
| **S7** | Touches as2's **rules** | `PREFERENCES.md`, `SPEC-2.0.md`, `gates/src/rulings.ts`, and any write to a brief's reserved-list exceptions field. It takes precedence over N2's docs-only default. | C2 |
| — | The open-time judge's `change-large` | Kept as a plan-first trigger (`stakes.ts` `planFirstTrigger`). It never involves Jo. | — |
| — | PR title or branch name | **Not used.** | — |

**CLAIM**
How the draft's two PRs measure (`gh pr view <n> --json files,additions,deletions`, recon draft `/Users/jowolff/agent-scratch/agent-system-2.0/stakes-criteria/DRAFT.md:53`): #331 is +2939 lines across 39 files, all under `.ai/`. #369 is +10141/−428 lines across 50 files, including `surface`, `gates`, `install` and `.github`.

---

## 6. The self-improving loop

Four parts. Validation is in § 7. The authorized change surface and the protected set are in § 6.5.

### 6.1 Recorder

Every ask, and every decision not to ask, at every checkpoint writes one **decision row** in the ledger and one Phoenix span with the same id. The row holds:
- workload, slice, checkpoint (CP1–CP6)
- the criterion ID, or `none`
- level before and after
- mechanical or judgment
- the reason in one sentence
- the evidence: matched paths, the command, counter values, and the judge's choice and confidence
- the criteria version (the git sha of the wording and policy files)
- linked PR number and deploy run, where they exist
- whether Jo was asked, and the question ID if so
- the **recommended option as its own field**
- whether **Jo edited the pre-filled answer line or sent it untouched**, and whether the answer arrived within 5 seconds of another answer

**CLAIM**
Phoenix already runs locally: `lsof -nP -iTCP:6006 -sTCP:LISTEN` shows python on `127.0.0.1:6006` (2026-10-28). It is installed by `/Users/jowolff/code/agent-system-2.0/install/phoenix-agent.sh` and reported by `install/install.sh:748`.

The Recorder ships first and in **shadow mode**. It records today's stakes decision next to the level this spec would have chosen, and it changes no behaviour. Every day without it loses labeled cases the eval needs.

**Jo's messages.** The Recorder also captures what Jo writes, because those messages are the labeler's primary signal (§ 6.2).

**CLAIM**
The surface already records Jo's inputs. `sqlite3 -readonly ~/.agent-system-2/ledger.db "select count(*), min(created_at), max(created_at) from instructions;"` → `3050|2026-09-30T03:11:05.361Z|2026-10-28T16:02:38.923Z`. The columns are id, workload_id, slice_id, kind, question_id, disposition, channel, author, body, created_by and created_at. One row is Jo's verbatim `WHY DO PRODUCTION STAKES STILL ASK ME` (`in-mvqyleul4fb6dc`, 2026-10-27T17:28:09Z, author `jo`, channel `surface`).

- **Gap: Jo's messages to seats are not in the ledger.** That covers Plumb in its OMP session, and most of Jo's reactions happen there. The Recorder adds a seat-side hook that writes each of Jo's messages into `instructions` with a seat channel. Without the hook, most reactions are lost.
- **Attribution to decisions, not only to asks.** A message links to one or more **candidate targets**: a decision row (including no-ask and solo-merge decisions), a question, a PR or a deploy run. The link records how it was made: explicit `question_id`, a PR or workload named in the text, or thread plus time window. Each link carries a confidence.
- **Ambiguous messages stay unresolved.** When more than one candidate is plausible, the message is stored with every candidate and the state `unresolved`. Unresolved messages never feed the eval until the label audit (§ 7.1) adjudicates them. The Recorder never forces the nearest ask.

### 6.2 Labeler

A scheduled job (launchd, daily) labels each decision row. **Jo's free-text messages are the primary signal.** The Jev judge (`typesafe/jev-1.13.0`) classifies each resolved message into one of three labels, or `none`:

| Jo's words (examples) | Label | What it feeds |
|---|---|---|
| "why are you handing this to me", "you could have decided this", "don't ask me this" | **unnecessary ask** | The unnecessary-ask rate |
| "why didn't you ask me", an override, stepping in on work that wasn't escalated, or an unprompted ruling covering a decision that didn't ask | **missed ask** | The missed-ask rate |
| "I don't understand what you're asking" | **unclear ask** | A separate question-quality count. The ask may have been needed but was badly written. That is a different fix (how the question is written), so it is **never** counted as an unnecessary ask. |
| Anything else | `none` | Nothing |

"WHY DO PRODUCTION STAKES STILL ASK ME" is the unnecessary-ask label applied to a whole criterion. "Why didn't you ask me" is its inverse.

**Reverts and failed deploys are outcome signals, not automatically missed asks.** A revert (C15) is first recorded as `outcome: reverted`. Then it is adjudicated with one question: did a criterion require an ask before the action that was taken without one?
- **Yes:** it is a **missed ask**, attributed to that criterion, **whatever Jo would have answered**. A required ask that was skipped is a policy miss, even if Jo would have approved. "Would asking have changed the decision?" is recorded only as a severity note. It never clears the miss.
- **No:** a defect in work that was allowed to proceed. It is labeled `implementation defect` or `deploy failure`, kept out of the missed-ask rate and kept out of the tripwire.

The same rule holds outside reverts. Any decision row where a code check or protected criterion required an ask and none was made is a missed ask on that criterion, whether or not anything went wrong.

Adjudication is a recorded agent judgment that the label audit samples. Until adjudicated, a revert counts toward neither rate.

**Weak signals**, recorded but never a label on their own:
- An approve or deny given on a recommendation is labeled **followed recommendation**: unconfirmed. Per § 2, the answer line is pre-filled with the recommendation and the recommendation is listed first in 208 of 226 cases. An untouched paste is indistinguishable from agreement unless the Recorder's `edited` flag says otherwise.
- An answer against the recommendation is labeled **went against recommendation**. It suggests the ask was needed.
- No reaction within 14 days to a solo or no-ask decision is labeled **no signal**. No signal is **not** evidence the decision was right. Silent under-asking is measured only by the recurring audit of non-asks (§ 7.1).

Weak signals generate candidates for the audit. They never count as labels.

### 6.3 Eval

A Phoenix dataset of past cases: the brief, plan, paths, counters and transcript excerpt at the checkpoint, plus the label. The dataset is replayed against a stated criteria version (code checks plus judgment wording).

**Unit and maturity.** The unit is one decision row, deduplicated to one per workload × checkpoint × criterion. A case enters the dataset only when it is **mature**: 14 days have passed since the decision, any revert is adjudicated, any message attribution is resolved, and its label comes from Jo's words, an adjudication, or an audit.

**The two numbers:**
- **Unnecessary-ask rate.** Numerator: replayed asks on cases whose label is `unnecessary`. Denominator: all replayed asks on mature labeled cases. Unclear asks are excluded from both.
- **Missed-ask rate.** Numerator: cases labeled `missed` (or audit-labeled `needed`) where the replay does not ask. Denominator: all mature cases labeled `missed` or `needed`. It is reported overall **and** as an absolute count per protected criterion.

**Protected criteria: C2, C4, C5, C6, C7, C8 and C10.** These are the all-level stops plus guard weakening (C8). C8 is listed by name because S1 does not cover every test file: `surface/test/` is outside S1 (#343, § 8). Each protected criterion gets its own coverage floor (§ 7.1), its own no-regression count (§ 6.4), the zero-live-miss rule (G5) and the tripwire (§ 7.6). A rise on one protected criterion is never offset by a fall elsewhere.

**Insufficient data fails closed.** If either denominator is under 20, or any protected criterion has fewer than 3 audited cases, the result is `insufficient data`. No candidate can be accepted on it, and no gate can pass on it.

The question-quality count (unclear asks) is reported next to the two numbers. It goes to whoever writes the question text, not to the criteria improver.

**CITE**
Phoenix datasets and experiments support this replay. https://arize.com/docs/phoenix/datasets-and-experiments/overview-datasets (fetched 2026-10-28): "When you run an experiment against a dataset, its associated evaluators run automatically, providing consistent and repeatable quality assessments."

### 6.4 Improver

A weekly launchd job:
1. It reads the **training** set's mature labeled cases (§ 7.2).
2. It proposes changes to the **criteria-wording file only** (§ 6.5).
3. A **trusted scorer**, separate from the proposer, scores each candidate on the **selection** set. The proposer gets back one aggregate pass or fail per candidate and never sees selection cases or per-case scores. Each week is capped at 8 candidates scored against the selection set.
4. It opens one PR with a report.

A candidate is acceptable when, on the selection set:
- the unnecessary-ask rate is lower than the current wording's,
- the missed-ask rate is not higher (equal is allowed, which covers a baseline of zero), and
- no protected criterion's missed count rises.

**Month one: Jo approves each change.** The PR gets an independent cross-lab review first (OpenAI, because the builder lab is Anthropic), then Plumb's recommendation. Jo sees one line: what changes, the reviewer's verdict, and the recommendation.

**After Jo flips the switch (§ 7.5):** agents apply an acceptable change that the cross-lab reviewer passes, through the exception in § 6.5, and Jo gets the report. This is Jo's ruling, 2026-10-28: "never say it never makes improvements on its own. we'd probably want me approving the improvements based on the reports and etc for the first month to make sure it's working right. but at some point I'd like the agents to take this over too." Jo's later ruling the same day makes the switch Jo's alone: "*I* am the one who flips the switch".

**Optimizer: DSPy with GEPA. Phoenix stays as the trace and dataset store.** The upkeep comparison landed after the first draft.

**CLAIM**
`/Users/jowolff/agent-scratch/agent-system-2.0/escalation-loop-comparables/UPKEEP.md:118` on Phoenix plus Prompt Learning: "not recommendable as the optimizer. Phoenix fails the essential workflow on its own. Phoenix plus the Prompt Learning SDK is unknown on privacy and carries upkeep warnings: no releases, zero active maintainers in the window". `:192` on DSPy with GEPA: "passes every essential gate for this use, on the condition that Jo approves a model destination. This is the documented fit, not a tried one."

**CITE**
GEPA learns from a scored metric with written feedback. https://dspy.ai/current/api/optimizers/GEPA/overview/ (fetched 2026-10-28): "Users should provide a feedback function as the GEPA metric". Also: "DSPy installs gepa only on Python < 3.15, because gepa declares requires-python <3.15."

**Conditions carried into B10:**
- **Turn on DSPy's restricted pickle cache.** CVE-2025-69872 in diskcache is still open as DSPy issue #10663 (`UPKEEP.md:174`, `:256`).
- **Never use `dspy.Local`.** Issue #10664: it binds an unauthenticated server to 0.0.0.0 (`UPKEEP.md:174`).
- **Get Jo's approval of the model destination** (the held item in § 1). `UPKEEP.md:9-12`: no local model runtime is installed (`ollama`, `lms`, `llama-server` and `mlx_lm.generate` were all not found).
- **Set `PHOENIX_ALLOW_EXTERNAL_RESOURCES=false`** in the Phoenix plist. `UPKEEP.md:14-17`: it defaults to on and fetches fonts, a runtime and an update check. The UPKEEP report grades this "worth knowing, not on fire".

### 6.5 The improver's authorized change surface, and what it can't touch

**Three artifacts, kept separate:**

| Artifact | What it holds | Who may change it |
|---|---|---|
| **Criteria-wording file** | The text of the judgment questions only: the CP2 open-choice question, and the wording for C3, C9, C13 and C14. Each entry is a question string. No levels, no routing, no thresholds. | After Jo flips the switch, agents, through the exception below. Before that, Jo. |
| **Policy file** | Levels, the criterion-to-level map, the all-level stops (§ 3.1), the path lists S1–S7, counter thresholds, the CP1 judge question (it also decides C4), the C4 wording, and the eval's rules, splits and gates (§ 7) | Jo only |
| **Enforcement code** | The checkpoint checks, the protection check, the exception check, the trusted scorer, and how each is invoked and configured | Jo only (S1 `involvement` group) |

**The exception (machine-checked).** An improver PR may merge without Jo only when **all** of these hold:
1. Jo has flipped the switch, recorded as an `instructions` row in main's ledger, and no later Jo call has suspended it (§ 7.6). An open failure notice does not remove authority; only Jo's recorded call does.
2. The diff touches the criteria-wording file and nothing else.
3. Every changed entry is one of the enumerated judgment questions.
4. The PR adds no entries, removes no entries and renames no entries.
5. The trusted scorer's verdict on the selection set is `acceptable`.
6. The cross-lab reviewer passes it.

Conditions 1–5 are evaluated by **main's copy** of the exception check and scorer, against main's ledger state, never the candidate's. Any other improver PR asks Jo under C7. The exception applies to every edit of the wording file, whoever opens the PR.

**Out of reach, always:** the CP4 command gate, the policy file, S1–S7, the labeler's rules, the eval dataset and splits, the scorer, the graduation gates, Jo's switch records, and the protection and exception checks plus their invocation and configuration. The improver may *suggest* changes to these in its report. Only Jo makes them.

**CITE**
An agent weakened its own gate one word at a time, as recorded at `/Users/jowolff/code/agent-system-2.0/research/phase4/research-G-self-improvement.md:478-489`. That entry cites Claude Code issue #32376, which quotes "changing the trigger from 'code changes' to 'SIGNIFICANT code changes' — a single word that weakens the gate". The issue was closed NOT_PLANNED.

### 6.6 Agents following their own recommendations

Jo, 2026-10-28, morning PDT: "I feel like this work goes hand in hand with making agents better to follow their own recommendations".

**This is a design goal.** An agent sometimes asks Jo, attaches a recommendation, and Jo picks it. When that happens, the ask was delay, not oversight.

**CLAIM**
The measured follow rates (`/Users/jowolff/agent-scratch/agent-system-2.0/recommendation-follow/REPORT.md:7-13`, per-question rows in `questions.jsonl` beside it):
- 226 of 769 answered questions state a recommendation in their text. Jo followed it 179 times (79%), picked another option 39 times, and answered off the menu 8 times.
- **High follow, by type:** other lane questions 74/83, test red/timeout 17/21, orchestrator operations 61/78, merge sign-off 12/16.
- **No recommendation in text:** plan approval (190), ceilings (114), review round limits (70 of 77), merge-train failed-twice (17 of 17).
- **Ceilings are the counter-example.** The question marks `stop` as "the default", and Jo overrode it with `extend` 63 of 114 times.

**The follow rate generates candidates. It is never evidence that removing an ask is safe.** An ask type becomes a *candidate* for "decide, act, notify" when its follow rate is high, its answers are often edited (not pastes), and there are no messages from Jo around it. The proposal then needs the same proof as any change: the recurring non-ask audit (§ 7.1) must show the type's solo decisions were not missed asks. Moving an ask type to solo changes the policy file, so it is **always Jo's call**, before and after graduation.

**Exception: the protected set.** Some asks are required by the all-level stops (§ 3.1). These do **not** move to solo on any follow rate. Their fix is a better ask, not no ask: one readable line plus a cross-lab review, so that Jo's approve means something.

**CLAIM**
`/Users/jowolff/code/agent-system-2.0/research/phase4/research-B-osmani.md:687-688` quotes Osmani: "Only people can choose. Only people inherit consequence. Agents can be asked to choose, route, merge, and escalate safely inside a policy, but they cannot inherit the consequences."

**Recommendation quality: report-only.** The improver reports it, but never applies a change to it, before or after graduation. Jo's amendment covers the criteria wording only (§ 9), so a change to how recommendations are made is a proposal to Jo under P-16.

The report shows, per ask type:
- the rate Jo answered against the recommendation, counting only edited answers
- Jo's messages around the ask
- adjudicated reverts after the recommended option was taken

A followed recommendation is not counted as a correct one.

**First target: the ceiling default.** Jo extended 63 of 114 times against a recorded `stop` default. The improver's first report proposes a different ceiling recommendation to Jo, for example "extend by half when there is progress", for Jo to rule on.

---

## 7. Validating the loop

The four-part loop has not been validated. These steps are how month one validates it. They produce the guidance Jo uses to decide on graduation. Nothing graduates without Jo's recorded word (§ 7.5). A gate with missing data reports `insufficient data`, never a pass.

### 7.1 Blinded, recurring label audits

**Blinded.** Jo labels from the case itself (the decision, the evidence, Jo's messages if any, the outcome). Jo never sees the agent's proposed label or the recommendation the agent made at the time. Jo answers one word per case: `needed`, `noise`, `missed` or `unclear`. For message cases, Jo also confirms or corrects the attribution, including resolving `unresolved` messages.

**Start audit (before any label drives the eval): 30 cases, sampled at random within strata, not from the classifier's output.**
- 10 of Jo's free-text messages (any classifier label, including `none`)
- 8 asks answered with no message, at least half of them untouched pastes
- 12 non-asks: solo merges and no-ask decisions, with at least one from each S1 group and each protected criterion where cases exist

The labeler and adjudicator must agree on at least **26 of 30**, and on **every** case Jo marks `missed`.

**Recurring audit, weekly through month one and after graduation: 12 cases**
- 6 asks and 6 non-asks, drawn at random, blinded
- at least 4 of the 6 non-asks drawn from decisions with no message and `no signal`, which is where silent under-asking hides

Agreement must stay at or above 10 of 12 per week. A `missed` found here is a missed ask for every metric. A weekly audit is **due** 7 days after the previous one closed, and **overdue** after 8. After Jo flips the switch, a missing, overdue or failed audit sends Jo a loud notice and waits for Jo's call (§ 7.6). It does not suspend anything on its own.

**Coverage floor.** For G3 (§ 7.5), each protected criterion (C2, C4, C5, C6, C7, C8, C10) needs at least 3 audited cases, counting asks and non-asks. Where too few real cases exist, the shortfall is listed and G3 reports fail.

**CLAIM**
The size follows the Jev classifier's calibration. `/Users/jowolff/code/agent-system-2.0/SPEC-2.0.md:158`: the open-time classifier was calibrated on "the same 30 briefs", "Agreement 21/30 (70.0%)".

**Known risk.** Jo approved 54 of 57 plans (`escalation-policy/DRAFT.md:60`), and pastes followed the recommendation 86% of the time (§ 2). A labeler that reads "answered with the recommended word" as "unnecessary" would mark asks Jo still wants as noise. That is why approvals are only a weak signal, and why the blinded audit samples untouched pastes on purpose.

### 7.2 Three data sets

Mature cases are split by workload, so no workload sits in two sets.

**Exposure history.** Every assignment of a workload to a set (training, selection or sealed) is written to an **append-only exposure history**: workload, set, date. Entries are never edited or deleted. A workload counts as **exposed** once it has any entry, even after it is moved out of that set. Mature workloads with no entry wait in an **unassigned fresh pool**.

| Set | Share | Used for | Who sees it |
|---|---|---|---|
| **Training** | 60% | The proposer learns from it | Proposer |
| **Selection** | 20% | The trusted scorer accepts or rejects candidates (§ 6.4) | Scorer only. The proposer gets one aggregate pass or fail per candidate. |
| **Sealed graduation test** | 20%, frozen at the end of week 2 of month one | One evaluation only, for the readiness report at the end of month one (§ 7.5). A failed evaluation consumes it, and the next readiness check builds a fresh one (§ 7.5). | Scorer only, once |

**Selection exposure is capped.** After 16 candidate evaluations, or 4 weeks, whichever comes first, the selection set is retired into training and replaced from fresh mature cases.

**After Jo flips the switch, each change is validated on fresh cases.** An agent-applied change is confirmed on the next 4 weeks' prospective cases, audited per § 7.1. The sealed test is never reused for optimization.

**CLAIM**
`/Users/jowolff/code/agent-system-2.0/research/phase4/research-G-self-improvement.md:203`: "keeps the edit only if it clears a strict no-regression gate on both visible and held-out fixtures".

### 7.3 A checking loop beside the optimizing loop

Missed asks are a counter-metric with a floor, so "fewer asks" can't win by under-asking:
- A candidate that lowers unnecessary asks but raises missed asks, overall or on any protected criterion, is rejected.
- The recurring non-ask audit (§ 7.1) is the independent check on silent under-asking.
- The code checks and the policy file stay out of reach (§ 6.5).

**CLAIM**
`/Users/jowolff/code/agent-system-2.0/research/phase4/research-A-graph-engineering.md:323` (Turing Post): "One loop optimizes a metric, another watches the counter-metric … An optimization loop without a checking loop can become very good at producing the wrong result."

### 7.4 Baseline

The baseline is the Recorder's shadow window: at least 14 days with the criteria version frozen. It is measured with the same unit, maturity rule and denominators as § 6.3. Live rates are compared per 100 decision rows over windows of equal length. If there is no baseline, every comparison is `insufficient data`.

### 7.5 Month one is the validation period

**Graduation is Jo's switch** (Jo, 2026-10-28; § 1). The improver moves to "agents apply" only on Jo's word, recorded as an `instructions` row in the ledger. The six gates below are **guidance**:
- Every weekly report computes each gate and shows pass, fail or `insufficient data`, with the reason for each fail.
- The report never permits or blocks graduation on its own.
- When Jo flips the switch, the switch record lists every gate failing at that moment, so a flip against failing gates stays visible.

| Gate | Threshold | Reports fail when |
|---|---|---|
| G1 Time | At least 30 days of month one, and at least 4 weekly improver runs reviewed by Jo | Fewer runs |
| G2 Label agreement | Start audit 26/30 with every `missed` matched. Every weekly audit 10/12 or better. | Any audit missing or below threshold |
| G3 Coverage | Every protected criterion has at least 3 audited cases; both § 6.3 denominators are at least 20 | Under either floor |
| G4 Sealed-test result | One evaluation on the sealed test of the month-start wording against the current wording, both versions frozen. The unnecessary-ask rate must fall by at least 20% relative. The missed-ask rate must not rise. No protected criterion (C2, C4, C5, C6, C7, C8, C10) may gain a missed ask, even if another loses one. | Scorer failure, insufficient data |
| G5 Live missed asks | Live missed asks per 100 decisions at or below the § 7.4 baseline, and **zero** live missed asks on any protected criterion (C2, C4, C5, C6, C7, C8, C10) | No baseline, or unadjudicated reverts in the window |
| G6 Settled changes | Every accepted change, including the latest, has completed a 14-day watch with no revert or override by Jo's own words | Any change still inside its watch |

If any gate fails at the end of month one, the report names the failed gate and the reason, and the improver stays in "Jo approves" until Jo says otherwise. Plumb's recommendation to Jo follows the gates: recommend flipping only when all six pass.

**Re-checking after a failed sealed-test evaluation.** A sealed test is evaluated once, so a failed evaluation consumes it. The next readiness check builds a fresh one. That check produces guidance for Jo's next decision, not an automatic graduation:
1. The consumed sealed set moves into training, and the exposure history records the move. It is never evaluated against for graduation again.
2. The proposer learns only that the evaluation failed and which gate failed. It never gets per-case or per-criterion sealed scores.
3. **From the moment the evaluation fails, every newly mature workload goes to the unassigned fresh pool.** None is assigned to training or selection until the fresh set is frozen.
4. The fresh sealed set is drawn **only** from workloads with no entry in the exposure history: never in training, selection or any earlier sealed set, and so never seen by the proposer. It is frozen when drawn. A workload that was trained on and later removed from training is still exposed, and it is rejected.
5. The fresh set needs the same support as § 6.3: both denominators at least 20, and every protected criterion with at least 3 audited cases. If the pool falls short, G4 reports `insufficient data` while more cases mature and are audited, and nothing is evaluated.
6. Once the set is frozen, the next weekly report re-checks G1–G6. G4 is one evaluation of the frozen month-start wording against the frozen current wording, on the fresh set. The result goes to Jo as guidance.

The same procedure builds the fresh test that informs Jo's call after a failure notice (§ 7.6).

### 7.6 After Jo flips the switch: failure notices and Jo's call

Agent-apply authority holds while Jo's switch record stands and no later Jo call has suspended it. The exception check (§ 6.5, condition 1) reads both from main's ledger before every autonomous application.

**Failures that notify Jo:**
- **Evidence missing or failing:** an overdue weekly audit, an audit below 10 of 12, or live comparison data unavailable (no § 7.4 baseline, or a revert unadjudicated for more than 7 days).
- **Confirmed regression (tripwire):** any adjudicated or audited missed ask on a protected criterion (C2, C4, C5, C6, C7, C8, C10), or a live missed-ask rate per 100 decisions above baseline over an equal-length window.

**What a failure does:** it notifies, then waits. Jo's ruling, 2026-10-28: "notify and wait for my call", "but notify me LOUDLY".
- The improver raises **one** needs-you question per failure. It names the failure, the evidence (audit score and date, the missed case and its criterion, or the rate against baseline) and the incident record below.
- **Each incident is bound to fixed versions when it fires.** The **incident record** is written once and never edited:
  - the **incident version**: the criteria version live when the failure fired (the wording-file git sha, as in § 6.1);
  - the **restore target**: the wording version live just before the agent-applied change that the failure is attributed to. For an audit or live-data failure with no single attributed change, it is the wording version live at the start of the window the failure covers. The record names which rule chose it;
  - the **initial incident diff**: the diff from the incident version back to the restore target, as it stood when the failure fired.
- **Rewrites keep applying while the question is open**, per Jo's ruling. Each one is added to the incident's **intervening chain** (version, PR and time). The chain is **append-only**: entries are added as rewrites land and never edited or removed. It is kept separate from the incident record. The question's text shows the chain, so Jo sees whether anything landed after the failure.
- The **recovery diff** is computed when Jo answers: the diff from the version then live back to the restore target. It covers the initial incident diff plus every change in the chain so far.
- The answer words are:
  - `keep`: authority unchanged; the incident is closed.
  - `suspend`: back to Jo approving each change; every version stays in place.
  - `revert`: suspend, then restore the restore target. **Jo's `revert` is the explicit authorization for the recovery diff as shown at answer time**, including every change in the intervening chain, because those changes were built on the failing version.
- **If the recovery grows after Jo answers, it waits for Jo again.** The `revert` answer authorizes only the chain as it stood when Jo answered. If another change lands between Jo's answer and the restore, no rollback happens. The question is re-raised with the larger chain, and Jo authorizes it again.
- A second failure of the same kind while the question is open adds its evidence to that question rather than raising another. Its restore target is recorded too, and the question shows the earlier of the two targets as the one `revert` uses.
- **Until Jo answers, nothing is suspended or reverted automatically.** The rewriter keeps its authority, and applied changes stay in place. The tripwire's revert is one of Jo's options, not an automatic step; that is the spec's reading of "wait for my call". The rewriter keeps applying changes while an incident is open, so continued use of the incident version is not contained; the loud notice informs Jo but does not limit exposure. A rewriting hold during an open incident would need Jo's ruling and is not part of this spec.
- Jo's answer is recorded as an `instructions` row, the same way as the switch. It records the incident it answers, the chain as it stood at answer time, and the recovery diff it authorized.
- After `suspend` or `revert`, weekly PRs keep opening and each one waits for Jo's word. Agent-apply returns only on a new switch instruction from Jo. The weekly report gives G1–G6 (on a fresh sealed test after a tripwire, § 7.5 re-check procedure) as guidance.

**How the notice is loud.** It uses only alert channels as2 already has:

| Channel | What exists today | Receipt |
|---|---|---|
| **Needs-you list, on fire** | A question named by a `now: <q-…> <category>` control entry from the escalation author is tagged `NOW (<category>): ` with state `now`. A `now` question goes out on its own poll rather than waiting for the batch window, and it still comes through while Jo is away (`brb`). The notice uses category `guard`. | `/Users/jowolff/agent-scratch/agent-system-2.0/involvement-spec/gates/src/rulings.ts:333` (`NOW_CATEGORIES`), `/Users/jowolff/agent-scratch/agent-system-2.0/involvement-spec/surface/src/errors.ts:653-654` (the tag), `/Users/jowolff/agent-scratch/agent-system-2.0/involvement-spec/surface/src/batch.ts:64-66` (`onFire`), `/Users/jowolff/agent-scratch/agent-system-2.0/involvement-spec/surface/src/batch.ts:32` (`AWAY_NOTICE`: "on-fire items still come through") |
| **macOS notification with sound** | `osascript -e 'display notification … sound name "Glass"'` | `/Users/jowolff/agent-scratch/agent-system-2.0/involvement-spec/surface/scripts/train-tick.ts:1522-1527` (`realNotify`) |
| **Issue on Jo's issues repo, mentioning Jo** | An issue on `thewolff/jo-issues` with label `as2-train`. Re-sends comment `@thewolff` and add the labels `loud`, then `critical`. | `/Users/jowolff/agent-scratch/agent-system-2.0/involvement-spec/surface/src/merge-train.ts:1623-1627` |
| **LOUD needs-you line** | At ladder levels 2 and 3 the line is prefixed `LOUD` (then `LOUD, critical`) with how long it has gone unacknowledged | `/Users/jowolff/agent-scratch/agent-system-2.0/involvement-spec/surface/src/errors.ts:665-671` |
| **Repeats** | The send ladder: level 1 at raise, level 2 after 4 h, level 3 after 8 h. "Nothing is sent after level 3." Closing the issue acknowledges it and stops re-sends. | `/Users/jowolff/agent-scratch/agent-system-2.0/involvement-spec/surface/src/merge-train.ts:1630-1639` (`TRAIN_ALERT_LADDER`) |

**What the involvement notice uses:**
1. A `NOW (guard)` needs-you question, on fire from its first poll.
2. At raise, all three of: the jo-issues issue mentioning Jo, the macOS notification with sound, and the needs-you question.
3. Re-sends on the existing ladder's 4 h and 8 h schedule, with the LOUD line.

**When the notice stops: Jo's recorded call, not the issue.** On the train, closing the jo-issues issue acknowledges the alert and stops re-sends. For an involvement incident, closing the issue does **not** answer the incident and does **not** stop the schedule. Only a `keep`, `suspend` or `revert` instruction for that incident stops it. If the issue is closed with no call recorded, the next scheduled send reopens it (or files a new issue linked to the closed one) and comments `@thewolff`.

**How re-sends get past the surface's deduplication.**

**CLAIM**
`/Users/jowolff/agent-scratch/agent-system-2.0/involvement-spec/surface/src/delivery.ts:20` keys each needs-you line by `kind:workloadId:rowId`, and `:27-36` skips a line whose identity and `state` match the last delivery. A NOW question keeps `state: "now"` as its evidence changes or its LOUD prefix appears, so an unchanged question would not be delivered again.

B11 handles this for involvement notices only:
- **Every scheduled send is its own occurrence.** Each one (raise, 4 h, 8 h, then every 8 h) gets a durable occurrence id: the incident id plus the send's sequence number.
- **The occurrence id is the line's delivery state token.** It is separate from its NOW urgency, which stays `now`. A new occurrence is a new state, so the line is delivered again.
- **Retries reuse the occurrence id.** Retrying a send that failed does not create a new occurrence.
- **New evidence is its own occurrence.** When a later failure adds evidence to an open question, that is a new occurrence too, so it is delivered at once.
- **Each channel repeats per occurrence:** the needs-you line, the macOS notification and the `@thewolff` comment.
- **The train is unchanged.** Its alerts keep their current dedupe and acknowledgement rules.

**What doesn't exist today, and is built in B11:**
- **The ladder is train-only.** It runs on merge-train questions (`trainAlertActions`, `merge-train.ts:1730`), so B11 generalizes it to involvement notices.
- **No macOS notification or `@thewolff` mention at raise.** The ladder sends the macOS notification only at levels 2 and 3 (`train-tick.ts:41-42`), and the level-1 issue body does not mention Jo. B11 adds both at level 1 for involvement notices, because Jo asked for loud.
- **Nothing sorts a NOW line to the top of the needs-you list.** `grep -rnE 'state === "now"'` over `surface/src` finds only the on-fire check in `batch.ts:66`; no rule orders NOW lines first. B11 adds that ordering.
- **No repeat after 8 hours.** The ladder stops at level 3. B11 repeats level 3 every 8 hours until Jo's call is recorded. That interval is this spec's proposal.
- **No per-occurrence delivery token, and issue closure counts as acknowledgement.** These are the two items above.

---

## 8. Worked examples

**CLAIM**
PR facts come from `gh pr view <n> --repo thewolff/agent-system-2.0 --json files,headRefName,mergedBy` on 2026-10-28, and from the recon draft's table (`/Users/jowolff/agent-scratch/agent-system-2.0/stakes-criteria/DRAFT.md:90-95`).

| Case | What it is | Today | Under this spec | Checkpoint and criterion |
|---|---|---|---|---|
| **#331** (merged) | `plumb/decision-log-batch-2026-10-27`, 39 files, all `.ai/decision-log/` | Production, because the head isn't `wl/<id>`. Jo got merged/skip/stop. | **Merges itself, notice** | CP5: no S1, S3, S5 or S7 path. N2. The branch name no longer matters. |
| **#343** (open) | `plumb/dl-flow-one-day-curb`, titled "docs:", touches `.ai/decision-log/`, `migration/items/…` and `surface/test/as2test.test.ts` | Production (branch) | **Merges itself, notice** | CP5: `surface/test/` is not in S1. The S5 scan finds no `.skip` and no removed assertion. The diff adds `expect(readdirSync(capDir)).toHaveLength(20_000)`. Paths, not the title, decide. |
| **#369** (merged) | `wl/wl-mvq4edbaf13vnk`, "Run fast checks before merge…", 50 files incl. `merge-train.ts`, `train-tick.ts`, `gates/src/fence.ts`, `install/install.sh`, `.github/workflows/as2-fast.yml` | Normal. The train merged it with a one-line notice. | **Asks Jo at merge** | CP5: C7 (S1 groups `train`, `gates`, `install`, `workflows`, so S4 = 4, recorded) and C8 (it changed which tests run before merge). This is Jo's "big fix". |
| **#378** (merged) | `plumb/train-tick-standard-priority`, +39/−5: `install/com.agent-system-2.train-tick.plist`, `install/com.agent-system-2.chaos.plist`, `surface/test/as2test.test.ts`, one decision-log entry | Merged by `thewolff-engineer`, outside the train | **Asks Jo at merge** | CP5: C7, because launchd plists under `install/` are S1. Small by lines, but it changes how the train runs. This is the cost of a path rule: small machinery changes ask too. |
| **Newdle prod deploy** | Jo: "ship the dedupe fix to prod" on newdle-api | Production by keyword ("prod") | **Escalate**, asking twice | CP1: C16 raises the start to escalate. CP5: the PR merges itself if it touches no S3 path. If it touches `deploy/` or `newdle-db/migrations/`, it asks (C6). CP4: the deploy (`gh workflow run cicd.yml -f deploy=true`, which runs `doctl apps create --upsert`) always asks (C5). CP6: a failed health check or a revert is reported now (C15), then adjudicated: a bug in an allowed change is a defect, not a missed ask. |
| **Docs plan that grows a rules edit** | A solo docs workload whose final diff also edits `PREFERENCES.md` | Depends on the branch | **Asks Jo at merge** | CP5: S7 hit, C2, an all-level stop that takes precedence over N2. |

**CLAIM**
The newdle-api deploy path: `/Users/jowolff/code/shipyard/repos/newdle-api/.github/workflows/cicd.yml:140` (`if: inputs.deploy == true`) and `:160` (`doctl apps create --upsert --update-sources --spec deploy/newdle-api.yaml`).

---

## 9. What changes from today

- **The `stakes` field (`throwaway`/`normal`/`production`, `ledger/src/index.ts:170`) becomes `operatorInvolvement` (ledger column `operator_involvement`).** Mapping: `throwaway` becomes `solo`, `normal` becomes `escalate`, and `production` becomes `escalate` with C16 recorded. `production` workloads Jo opened with steering words become `with-operator`.
- **The merge rule moves from branch name to diff.** `prStakes`'s `wl/<id>` lookup is kept only to find the workload. It no longer decides the level.
- **The standing rule `gates-stakes` (`rulings.ts:225`, from `in-mv0novd17fre9s`) is retired.** Its own end condition is "item 82 is built", and C7 covers it by path.
- **Review depth follows the merge-checkpoint level.** This is the spec's default. A merge that asks Jo (`with-operator`, an escalate hit, or an all-level stop) gets the every-other-lab fan-out with round limit 5 (`classifier/src/lab.ts:564`, `classifier/src/rounds.ts`). A merge that merges itself gets off-lab review with round limit 3. Tests before merge stay independent of the level (ledger `in-mvrb4ddzyhpt5a`: "production stakes do not make a PR risky").
- **Amendments, for this feature only, and only for the criteria-wording file.**
  - P-16 says "the system proposes and never applies". P-7b item 4 lists changes to the system's rules and machinery as Jo's.
  - Both are amended for the criteria-wording file (§ 6.5) only: month one, Jo approves each change; after Jo flips the switch (§ 7.5), agents apply changes through the machine-checked exception.
  - Everything else, including the policy file, the path lists, ask types moving to solo, and how recommendations are made, stays under P-16 and P-7b as written.

---

## 10. Build breakdown

Each slice is one workload slice with its own done-condition. B1 goes first, because waiting loses data. B2 unblocks production merges.

**Proposed:** Jo's production-merge pause (2026-10-28, morning PDT) lifts when B1 and B2 are on main. Jo confirms or corrects this.

| Slice | What | Acceptance criteria |
|---|---|---|
| **B1 Recorder (shadow)** | A new ledger table of decision rows (schema version bump) per § 6.1, with one Phoenix span per row. Computes this spec's level next to today's stakes. Changes no behaviour. Also: a seat-side hook for Jo's messages to seats (Plumb's OMP session included), multi-candidate attribution with an `unresolved` state, the recommended option as its own field, and the `edited` and paste-burst flags on answers. | (1) A train merge on a test ledger writes one row with checkpoint `CP5`, the criterion, the paths, the S4 group count and the shadow level. (2) A question to Jo writes a row with its question ID and its recommended option in its own field. (3) An answer sent untouched from the pending block is stored with `edited = false`. (4) The span is visible in Phoenix on 6006 with the row's id. (5) Replaying #331, #343, #369 and #378 gives the shadow levels in § 8, and #369 gives S4 = 4. (6) A message Jo types to Plumb lands in `instructions` with a seat channel. (7) A message during a solo merge with no question, while two unrelated asks are open, links to the solo-merge decision row, or is stored `unresolved` with all three candidates. It never links to the nearest ask by default. (8) Existing tests pass. Merge behaviour is unchanged. |
| **B2 Path lists and the merge checkpoint** | S1/S3/S5/S7 lists in the policy file, read by CP5 in the style of `fullExceptions`, run from main's copy. Replaces the branch-name rule and retires `gates-stakes`. | (1) #331 and #340 merge themselves. #369 and #378 ask. #343 merges itself. (2) A fork PR asks. (3) A PR that changes the policy file or the checker asks (C7), and the check that runs is main's, not the PR's. (4) A docs-only plan whose final diff edits `PREFERENCES.md` or `SPEC-2.0.md` asks at every level (C2 over N2). (5) The notice names the matched paths, or says "no criterion". |
| **B3 Open and plan checkpoints, and phase operations** | CP1: words, repo, Jo's boundaries and the Jev judge set the starting level. CP2: plan paths and the open-choice judgment. The `phase.open` and `phase.close` ledger operations. | (1) "pair with me on X" starts `with-operator`. A scratch repo starts solo. A plain brief starts escalate. (2) A plan naming `gates/` is held at every level. (3) A solo workload calling `phase.close` asks Jo. (4) Every decision writes a B1 row with the judge's choice and confidence. |
| **B4 During-work checkpoint** | Per-slice path re-check against S1/S3/S5/S7. Retry, round and spend counters wired to C10/C11, with the `ceiling.raise` operation. Judgments for C13/C14. | (1) A slice that adds an S1 or S7 path mid-work raises the level and queues one ask. (2) A third failed retry asks once, never twice. (3) A solo workload's first ceiling hit with progress raises by half and sends a notice. Its second hit asks. (4) The judgments write rows with reasons. |
| **B5 Command gate wiring, deploy and after-merge checkpoint** | CP4 records to B1. CP6: revert detection, deploy and health status, the adjudication queue, and the S2/S3 globs for each Newdle repo. | (1) A blocked `gh workflow run … -f deploy=true` writes a C5 row at solo level and asks. (2) A revert commit naming a merged PR writes a C15 row, a notice and an adjudication item within one tick. |
| **B6 Rename and migrate** | The field `operatorInvolvement` (ledger column `operator_involvement`, levels `with-operator` / `escalate` / `solo`) in the ledger, surfaces, lane prompts (`launch.ts`) and the SPEC table. Review depth per § 9. | (1) No `stakes: production` remains in the code paths that decide involvement. (2) Old workloads read through the § 9 mapping. (3) The USER-GUIDE is updated. |
| **B7 Labeler and adjudicator** | The daily launchd job. The Jev judge classifies Jo's resolved messages (§ 6.2). Reverts are adjudicated. Per-type follow rates and the recommendation-quality report (§ 6.6). | (1) "why are you handing this to me" is labeled `unnecessary ask`. "I don't understand what you're asking" is labeled `unclear ask` and never counted as unnecessary. (2) An approve on a recommendation is labeled `followed recommendation`, never `unnecessary`. (3) A reverted solo merge whose change no criterion covered is labeled `implementation defect`, not `missed ask`. A reverted solo merge that touched an S1 path the check missed is labeled `missed ask` on C7. (4) A C7 merge made without an ask is labeled `missed ask` even when the severity note says Jo would have approved. (5) Unresolved messages produce no label. (6) A protected ask type is never proposed for solo. |
| **B8 Label audits** (§ 7.1) | The blinded start audit, the weekly 12-case audit and the coverage report, on a one-word-per-case page for Jo. | (1) Jo's page never shows the agent's label or the recommendation made at the time. (2) The samples are drawn per § 7.1, including `none` and `no signal` non-asks. (3) The eval refuses labels until the start audit passes. (4) Coverage is reported per protected criterion, and shortfalls are listed. |
| **B9 Eval, data sets and scorer** (§ 6.3, § 7.2, § 7.4) | The Phoenix dataset, the training, selection and sealed sets, the trusted scorer with denominators and maturity, and the shadow baseline. | (1) The current wording gets baseline numbers, or `insufficient data`. (2) The same input yields the same scores twice. (3) The proposer process can't read the selection or sealed sets. (4) The 17th selection evaluation is refused until the set is replaced. (5) A candidate where C8 gains one missed ask and another criterion loses one, leaving the overall rate unchanged, is rejected. |
| **B10 Improver, Jo-approves mode** (§ 6.4–6.5) | The weekly launchd job on DSPy with GEPA, with the § 6.4 conditions met. Cross-lab OpenAI review, a PR with a one-line summary, and the protection and exception checks run from main. **Prerequisite:** Jo's approval of the model destination. | (1) The weekly PR carries both numbers, the protected-criterion counts, the reviewer's verdict and Plumb's recommendation. (2) A candidate that edits the policy file, changes a level, adds a wording entry, or disables the protection check is refused, and the refusal comes from main's copy of the check. (3) Nothing is applied without Jo's word. (4) DSPy's cache is in restricted-pickle mode. |
| **B11 Checking loop, graduation guidance, Jo's switch, failure notices and tripwire** (§ 7.3–7.6) | The missed-ask floor, the weekly G1–G6 guidance report with one sealed-test evaluation, the append-only exposure history and the unassigned fresh pool, the fresh-test re-check, Jo's switch as a ledger `instructions` row (recording the gates failing at flip time), the agent-apply path through the § 6.5 exception, prospective confirmation, and the failure notice with Jo's call (`keep` / `suspend` / `revert`) recorded as an `instructions` row. **Incident records (§ 7.6):** the incident record (incident version, restore target and initial incident diff), written once when the failure fires; the append-only intervening chain; and the recovery diff, computed at Jo's answer. `revert` restores the restore target only for the chain Jo authorized. **Loud-notice build items (§ 7.6):** generalize the train's send ladder to involvement notices; send the macOS notification and the `@thewolff` mention at level 1; sort NOW lines to the top of the needs-you list; repeat level 3 every 8 h until Jo's call is recorded; give each scheduled send a durable occurrence id used as its delivery state token; don't treat issue closure as an answer. | (1) Every weekly report lists G1–G6 with pass, fail or `insufficient data`, and the reason for each fail. (2) With all six gates passing and no Jo switch instruction, the improver stays in Jo-approves. (3) With a Jo switch instruction while G4 fails, the improver moves to agents-apply, and the switch record lists G4 as failing. (4) A simulated missed ask on C7 or C8 after the switch raises one `NOW (guard)` question with the evidence, and nothing is reverted until Jo answers `revert`. (5) The sealed test is evaluated once and then locked. A failed evaluation builds a fresh sealed set only from workloads with no exposure-history entry, or reports `insufficient data` if support is short. (6) A workload that was assigned to training, then removed from training, is rejected as a sealed-test candidate, and its history entry can't be deleted. (7) After the switch, an overdue weekly audit, or one scoring 9 of 12, sends exactly one notice. Authority is unchanged, and the next improver change still applies, until Jo's recorded call. Jo's `suspend` moves the improver to Jo-approves. (8) At raise, the notice produces a jo-issues issue mentioning `@thewolff`, a macOS notification with sound, and a NOW line at the top of the needs-you list. Without an answer, it re-sends at 4 h and 8 h and then every 8 h, and stops once Jo's call is recorded. (9) Wording version A applies; a failure attributed to A fires (incident version A, restore target the version before A); rewrite B applies while the question is open; the question shows B in the chain; Jo answers `revert`; the wording returns to the version before A, and the recorded instruction lists A and B. (10) As in (9), but rewrite C lands after Jo's `revert` and before the restore: nothing is rolled back, and the question is re-raised listing A, B and C. (11) Closing the jo-issues issue without a recorded call does not stop the schedule: the next send reopens it and comments `@thewolff`. (12) An already-delivered NOW question that receives new evidence is delivered again in the same surface session. (13) The 16 h and 24 h sends are each delivered in the same surface session, and a failed send that is retried is delivered once. |

---

## 11. Follow-on (not designed here)

The same four parts (Recorder, Labeler, Eval, Improver), plus the validation in § 7, are the template for other self-improving as2 features. That covers any big as2 feature or plugin Jo writes. They are adopted only after this pilot passes month one. Jo, 2026-10-28: "once we validate it, it should" be the pattern.

---

## 12. Cross-lab review: findings and resolutions

Source: `/Users/jowolff/agent-scratch/agent-system-2.0/involvement/REVIEW-openai.md`. Round 1 reviewed commit `422bef49`. Round 2, under "## Round 2 (99347881)", reviewed `99347881`. Round 3, under "## Round 3 (c84907ae)", reviewed `c84907ae`. All three returned request-changes. Round 2 resolved findings 1, 3, 5, 6 and 8–10, partly resolved findings 2, 4 and 7, and added the R2 rows. Round 3 resolved R2-B1, R2-B2, findings 2 and 4 and the mandatory-ask clarification, and added R3-B1.

| # | Finding | Resolved in |
|---|---|---|
| 1 | Solo didn't preserve every reserved item. Phase closure had no action-time check, and C10 at solo was contradictory. | § 3.1 precedence rule. C4 `phase.*` operations and C10 at all levels with N7 allowed. B3 (3), B4 (3). |
| 2 | The counter-metric couldn't see silent under-asking | § 6.2 (no signal is not evidence), § 7.1 blinded recurring non-ask audits and coverage floor, § 6.6 (follow rate generates candidates only). Round 2: a missing or failed audit is acted on (§ 7.6, B11 (7)). After round 3, Jo ruled that it notifies Jo loudly and waits for Jo's call instead of suspending automatically. |
| 3 | The held-out core was reused for selection | § 7.2: three sets, a capped and retired selection set, a sealed one-time graduation test, prospective confirmation |
| 4 | Gates weren't computable | § 6.3 unit, maturity, denominators, fail-closed. § 7.4 baseline. § 7.5 G1–G6 with fail conditions, "equal is allowed" for missed asks. Round 2: C8 restored to the protected set (§ 6.3, G4, G5, § 7.6, B9 (5)). The fresh-test re-check is defined (§ 7.5). After round 3, Jo made graduation Jo's switch, so the gates are computed weekly as guidance (§ 7.5). |
| 5 | Graduated edits collided with C7 | § 6.5: wording, policy and enforcement are separate, with a machine-checked exception run from main. S1 `involvement` group. B10 (2). |
| 6 | Recommendation optimization exceeded the amendment | § 6.6: report-only, proposals go to Jo. § 9 amendment wording. |
| 7 | A revert was mislabeled as a missed ask | § 6.2 adjudication. B7 (3). Round 2: a skipped required ask is a missed ask whatever Jo would have answered (§ 6.2, B7 (4)). |
| 8 | Attribution missed asks that never happened | § 6.1 decision-row targets, multiple candidates, `unresolved`. B1 (7). |
| 9 | No merge-time coverage for rule documents | S7, C2 at CP3/CP5 over N2. § 8 last row. B2 (4). |
| 10 | S4 count | S1 group keys defined. #369 is S4 = 4. |
| R2-B1 | Graduated authority survived a missing or failed audit | § 7.6: a missing or failed audit raises a loud failure notice. B11 (7). After round 3, Jo ruled "notify and wait for my call", so authority changes only on Jo's recorded call, not automatically. |
| R2-B2 | C8 dropped from the protected floor | § 6.3 protected list names C8. § 7.1 coverage, G4, G5, § 7.6 tripwire. B9 (5), B11 (4). |
| R2 clarification | Sealed-test retry after a failed attempt | § 7.5 re-check procedure, § 7.2 table. B11 (5). After round 3, the re-check feeds Jo's decision; it no longer graduates anything by itself. |
| R3-B1 | Retry sealed set could include workloads the proposer trained on | § 7.2 append-only exposure history and unassigned fresh pool. § 7.5 re-check steps 1, 3–5 draw only from never-exposed workloads, and report `insufficient data` when support is short. B11 (5), (6). |
| Loud-A1 | `revert` was a moving target while rewrites continued (`REVIEW-openai-loud.md`, blocking) | § 7.6: the incident record (incident version, restore target, initial incident diff), written once; the append-only intervening chain; the recovery diff computed at Jo's answer. Jo's `revert` authorizes the chain shown at answer time, and a longer chain re-asks. No automatic hold or rollback. B11 (9), (10). Round 2 approved (`REVIEW-openai-loud.md:65-104`), with the incident diff and recovery diff now named separately. |
| Loud-B1 | Issue closure and once-per-state delivery would stop the repeats (`REVIEW-openai-loud.md`, should-fix) | § 7.6: only Jo's recorded call stops the schedule. Each scheduled send has a durable occurrence id used as its delivery state token, and the train is unchanged. B11 (11)–(13). |
