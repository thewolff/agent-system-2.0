# Involvement: how much Jo is in a workload, what decides it, and the loop that tunes it

Spec, 2026-10-28. It replaces as2's "production stakes". Jo approved the outcome at about 9:20 AM PDT. The ruling record is `.ai/decision-log/2026-10-28--0920--plumb--involvement-replaces-production-stakes.md`. Nothing here is built yet. Production merges are paused until it is (Jo, 8:15 AM PDT).

## 1. Top screen

**Three levels.** A workload gets a starting level when it opens. Six checkpoints across its life can raise the level. Nothing lowers it except Jo.

| Level | What happens | What can stop the work |
|---|---|---|
| **With Jo** | Jo is in from the start. Jo steers, the plan waits for Jo, and the merge is Jo's. | Everything goes through Jo. |
| **Escalate** | The agent works alone and stops to ask Jo when it hits a named criterion (§ 4). With no hit, it merges itself and Jo gets a notice. | Every criterion, both the code checks and the recorded agent judgments. |
| **Solo** | The agent works alone, merges itself, and Jo gets a notice. | The code checks only: irreversible commands, the as2-machinery path list, and Newdle production paths. Judgment criteria are recorded but don't stop it. |

The default starting level is **escalate**. A workload starts **with Jo** on Jo's words or on the open-time criteria in § 4. It starts **solo** for scratch and throwaway work, and for plans that touch only docs.

**Open decision 1: the field's name.** Jo rejected "reserved". "Production stakes" misleads because most of Jo's work goes to production.
- **`involvement`**, values `with-jo` / `escalate` / `solo`. **Recommended.** It names what the field controls, which is when Jo is in the loop, rather than a property of the code.
- `oversight`, same values. It reads as review of finished output, and this field covers the whole lifecycle.
- `autonomy`, values `paired` / `checkpointed` / `full`. It runs the other way: the higher the value, the less Jo is involved.

**Open decision 2: when the improver graduates from "Jo approves each change" to "agents apply changes".** Recommended: graduate when all five gates in § 7.4 hold at the end of month one. In short: at least 30 days and 4 weekly runs, labeler agreement with Jo's hand labels of 26 of 30 or better, held-out improvement on both numbers, no missed-ask regression, and no accepted change reverted by Jo. If any gate fails, month one is extended by two weeks. After graduation, one breach of the missed-ask floor switches the improver back to "Jo approves".

---

## 2. Design facts this spec is built on

**CLAIM**
Jo approves most of what reaches them on Plumb's word. Jo, 2026-10-28 at about 9:30 AM PDT (relayed verbatim by Plumb): "keep in mind I have SO many things to approve that I'm not reading them. I just ask you if it's a good idea and if you say so I send approve". The ledger shows the same pattern. `/Users/jowolff/agent-scratch/agent-system-2.0/escalation-policy/DRAFT.md:60`: "Jo approved 54 of the 57 such plans they answered."

Three consequences shape this spec:
1. **An `approve` is not Jo's judgment of the ask.** It usually means Plumb recommended approving. **Jo's free-text messages around an ask are the labeler's primary signal** (§ 6.2), for example "I don't understand why you're handing this to me". Approve and deny answers given on a recommendation are weak signals only. Jo, about 9:50 AM PDT: "can we record me sending messages AROUND the labeling. like 'I don't understand why you're handing this to me'".
2. **The month-one gate is really Plumb's recommendation plus Jo's one word.** So each proposed change gets an independent cross-lab review before Plumb recommends it (§ 6.4). The builder lab is Anthropic, so the reviewer is OpenAI.
3. **A human gate nobody reads is a rubber stamp.**

**CLAIM**
`/Users/jowolff/code/agent-system-2.0/.tmp/escalation-research/REPORT.md:92` names this risk from the OpenAI white paper: "approvals made quickly risk becoming a 'rubber stamp'". The same line quotes Codex: "fix the boundary first instead of teaching the reviewer to approve noisy escalations forever." That is the job of this spec: fewer asks, each one worth reading.

**CLAIM**
No surveyed system gates human involvement on the size of a change. `/Users/jowolff/code/agent-system-2.0/.tmp/escalation-research/REPORT.md:88`: "Irreversibility and blast radius are the main gate … They do not tie it to task difficulty." Jo's "big fix" (2026-10-28) is therefore replaced by checkable stand-ins (§ 5).

**CLAIM**
Today a PR's stakes come from its branch name, not its diff. `/Users/jowolff/code/agent-system-2.0/surface/src/merge-train.ts:233-236` (`prStakes`): a PR is production unless its head is `wl/<id>` (`WORKLOAD_BRANCH_RE`, `:195`) naming a ledger workload at normal stakes. The `gates/` ruling never sees a diff. `/Users/jowolff/code/agent-system-2.0/gates/src/rulings.ts:225` (`gates-stakes`) matches only an orchestrator stakes question whose body text mentions `gates/`. That is how #369 merged as2 machinery changes without Jo.

**CLAIM**
A path-list check against a PR's changed files already exists in as2. `/Users/jowolff/code/agent-system-2.0/surface/src/fast-set.ts:205-216` (`fullExceptions`) filters `changed` against `fullBeforeMerge` and the ledger schema files. The merge checkpoint in § 3 reuses that shape.

---

## 3. Six checkpoints across a workload

A **code check** is mechanical: paths, commands, counters or exact words. An agent can't argue its way past it. A **judgment** is an agent's decision, recorded with its reason in the ledger (§ 6.1). Every checkpoint records a decision either way, including "no criterion matched, proceeding".

| # | Checkpoint | Code check (can't be talked past) | Recorded agent judgment | What it can do |
|---|---|---|---|---|
| CP1 | **Workload opens** | Jo's words: steering words (`USER_DRIVEN_WORDS`, `surface/src/stakes.ts:30`: "with me", "pair", "walk me through" …). Production words only raise the level (`PRODUCTION_WORDS`, `stakes.ts:26`). Target repo: as2, a Newdle product repo, or a scratch repo (`SCRATCH_REPO`, `stakes.ts:28`). Whether a protected target is named. | The Jev judge (`typesafe/jev-1.13.0`, the open-time judge behind `judgedLarge`, `stakes.ts:88-91`) proposes the starting level from the brief, with confidence. Below the low-confidence threshold, the higher of its top two choices applies. | Sets the starting level. |
| CP2 | **Plan written** | The plan's named paths are checked against the as2-machinery list (§ 5, S1), the rules list (C2) and the Newdle production list (§ 5, S3). | Does the plan leave scope, architecture or risk tolerance open (C3)? | Raises the level. Under escalate, a hit holds the plan for Jo. |
| CP3 | **During work, per slice** | Each slice's changed paths are re-checked against the lists. Counters: 3 failed retries, the review round limit, and the spend ceiling (second hit, or a hit with no progress). | Stuck (C14), conflicting instructions (C13), scope growth beyond the plan (C14). | Raises the level. A hit pauses only the affected slice and queues the ask. |
| CP4 | **Before an irreversible command** | The existing command gate: force-push, hard reset, branch or tag delete, `rm -rf` outside the worktree, `DROP`/`TRUNCATE`, prod DB write, infra teardown, secret rotation, protected-branch push, deploy (`SPEC-2.0.md` § A4, ruled 2026-09-23). | None. This checkpoint is code only. | Always asks, at every level, solo included. |
| CP5 | **Merge** | The PR's changed files (`git diff --name-only <merge-base> <head>`) against the path lists. This replaces the branch-name rule in `merge-train.ts` (`prStakes`) and the question-text check in `rulings.ts:225` (`gates-stakes`). Forks and unknown head repositories still ask. | Guard weakening (C8): does a test or gate change weaken what runs before merge? The keyword scan (`.skip`, `xit`, `--no-verify`, removed assertions) is mechanical. Whether a change is a real weakening is judged. | No hit: merges itself and Jo gets a notice. Any hit: asks Jo. |
| CP6 | **Deploy, and after merge** | Deploy and migration paths in the target repo (§ 5, S2/S3). A revert commit naming the merged PR. A failed deploy or health check. | Did the merge work out? This is recorded for the labeler (§ 6.2), not used as a gate. | A deploy asks (CP4). A revert or failed deploy is reported to Jo now, and it is labeled for the loop. |

---

## 4. Criteria

"Row N" and "N#" refer to the escalation survey, `.tmp/escalation-research/REPORT.md`. Row N sits on line 18+N, and N# sits on line 47+#. Ledger IDs are Jo's rulings in `~/.agent-system-2/ledger.db`, table `instructions`.

| ID | Criterion | Level | Checkpoint | Mechanical or judgment | Source |
|---|---|---|---|---|---|
| C1 | Jo asked to steer ("with me", "pair", "walk me through") | with Jo | CP1 | Mechanical (words) | `stakes.ts:30` `USER_DRIVEN_WORDS`. Row 14, Claude Code: "Claude's own judgment that a condition was met does not lift it." https://code.claude.com/docs/en/permission-modes |
| C2 | A change to as2's **rules**: `PREFERENCES.md`, SPEC rulings, `gates/src/rulings.ts`, a brief's exceptions field | with Jo | CP1, CP2 | Mechanical (paths), plus judgment for briefs | `PREFERENCES.md` P-7b item 4 (:323-325): "only Jo edits it" |
| C3 | An architecture, scope or risk-tolerance choice the brief leaves open | with Jo at CP1/CP2; escalate at CP3 | CP1, CP2, CP3 | Judgment | Row 8, Gas Town: "Architectural choices that need human judgment." https://raw.githubusercontent.com/steveyegge/gastown/main/docs/design/escalation.md |
| C4 | Opening or closing a phase | with Jo | CP1 | Judgment (Jev judge) | `PREFERENCES.md` P-7b item 1 (:313) |
| C5 | An irreversible action outside the repo (the A4 command list) | escalate, at every level | CP4 | Mechanical (command gate) | `SPEC-2.0.md:259-262` (A4, ruled 2026-09-23). Row 1, Codex: "destructive actions with significant risk of irreversible damage." https://learn.chatgpt.com/docs/sandboxing/auto-review |
| C6 | Shared or customer data, or someone else's resource: Newdle production paths (S3) | escalate, at every level | CP2, CP3, CP5, CP6 | Mechanical (repo plus path) | Row 6, Claude Code: "Modifying shared infrastructure." https://code.claude.com/docs/en/permission-modes. Row 13, Atlassian SEV 1: "Customer data loss." |
| C7 | A merge that changes as2's **machinery** (path list S1, § 5) | escalate, at every level | CP5 (flagged earlier at CP2, CP3) | Mechanical (paths) | `PREFERENCES.md` P-7b item 4 (:323): "Changes to the system's own rules or machinery". Case: #369 (§ 8). |
| C8 | Weakening a guard: tests, CI, gates, fence | escalate | CP3, CP5 | Mechanical (path plus keyword), judgment for the verdict | Row 16, Claude Code: "Commenting out, deleting, or force-passing a test or assertion that guards security behavior." https://code.claude.com/docs/en/permission-modes |
| C9 | Security or credentials | escalate | CP3, CP4 | Judgment, plus the command gate for secret rotation | Row 4, Gas Town: "Unauthorized access attempts, credential exposure." (row 8 URL) |
| C10 | Spend: a second ceiling hit, a hit with no progress, or raising a ceiling | escalate | CP3 | Mechanical (counter) | Ledger `in-mvqyt4a8gezvgg` (e). `PREFERENCES.md` P-7b item 2 (:314-319) |
| C11 | An exhausted counter: 3 failed retries, or the review round limit | escalate | CP3 | Mechanical (counter) | `REPORT.md:90`: "Every system with a number uses 3 to 5." Row 9. |
| C12 | A merge conflict that both the resolver and the owner lane failed on | escalate | CP3, CP5 | Mechanical (both attempts failed) | Row 10, Amp: "a substantive conflict … checks with you before continuing." https://ampcode.com/docs/markdown/orbs/shipping |
| C13 | Conflicting instructions: two active rulings that conflict once their scopes are checked | escalate | CP3 | Judgment | Row 15. **The survey marks this trigger UNVERIFIED** (no fetched source names it). It is carried from `escalation-policy/DRAFT.md:17`. |
| C14 | Stuck, or scope growing beyond the plan | escalate | CP3 | Judgment | Row 9, Gas Town: "Stuck loops: Agent is stuck and cannot make progress". Row 7: "Ambiguous requirements". |
| C15 | A merge reverted, or a deploy or health check failed | escalate (report now) | CP6 | Mechanical (revert commit, deploy status) | Row 24, Google SRE: "urgent, actionable, and actively or imminently user-visible". https://sre.google/sre-book/monitoring-distributed-systems/ |
| C16 | Jo's intake words "prod", "deploy", "customers", "live" | Raise only, to escalate | CP1 | Mechanical (words) | `stakes.ts:26` `PRODUCTION_WORDS`. Jo-loop catalog § 2: the keyword match misses unspoken deploy-adjacent work, so it may only raise (`/Users/jowolff/agent-scratch/agent-system-2.0/jo-loop-catalog/REPORT.md:390`). |
| N1 | Ordinary GitHub writes: feature-branch push, PRs, comments, merging green PRs | solo | CP5 | Mechanical | Ledger `in-mvqyt4a8gezvgg` (c). `SPEC-2.0.md:262-263`: "Not reserved: … merges of approved, green PRs" |
| N2 | Docs, decision-log and cleanup PRs, whatever the branch name | solo | CP2, CP5 | Mechanical (paths) | N7, oversight-rig: "Cleanup, refactoring, or anything explicitly de-prioritized." https://raw.githubusercontent.com/gastownhall/gascity-packs/main/oversight-rig/agents/project-lead/project-brief.template.md |
| N3 | Scratch or throwaway work | solo | CP1 | Mechanical (`SCRATCH_REPO`, `THROWAWAY_WORDS`) | `stakes.ts:27-28` |
| N4 | Routine work, local edits, builds and tests | solo | CP3 | Mechanical | N1, Gas Town: "Regular work that can proceed without human input". N10. |
| N5 | CI failures and review findings on its own PR, below the round limit | solo | CP3 | Mechanical (counter below limit) | N12, Devin: "automatically responds to review comments and CI failures … without you in the loop." https://docs.devin.ai/essential-guidelines/instructing-devin-effectively.md |
| N6 | Transient faults (retry), a red test the branch doesn't touch, a question already answered | solo | CP3 | Mechanical | N2, N13, N3/N8 |
| N7 | First ceiling hit with progress: raise by half and tell Jo | solo (notice) | CP3 | Mechanical | Ledger `in-mvqyt4a8gezvgg` (e) |

---

## 5. "Big fix", replaced by checkable stand-ins

None of these uses line count, file count or the PR title. #331 is +2939 lines and docs only. #343 is titled "docs:" but changes a test file.

| ID | Stand-in | How it is checked | Used by |
|---|---|---|---|
| **S1** | **Touches as2 machinery. This is the main stand-in.** | Changed path matches: `surface/src/merge-train.ts`, `surface/scripts/train-tick.ts`, `surface/src/fast-set.ts`, `gates/`, `classifier/`, `ledger/schema.sql`, the `SCHEMA_VERSION` line of `ledger/src/index.ts`, `install/` (including the launchd `*.plist` files), `profile/`, `.github/workflows/`, and this feature's own criteria code and path lists. | C7 |
| S2 | An effect `git revert` can't undo: deploy, migration on a shared DB, infra, secrets | Commands: the A4 gate (CP4). Paths: deploy workflows and migration directories in the target repo. | C5, C6, C15 |
| S3 | Newdle production: the target is a Newdle product repo and the path reaches prod | Repo allowlist plus path globs. For newdle-api: `.github/workflows/cicd.yml` (its `deploy` input runs `doctl apps create --upsert`), `.github/workflows/*deploy*.yml`, `deploy/`. For newdle-db: `migrations/`. Other Newdle repos get their globs in slice B5. | C6 |
| S4 | Breadth: the diff touches 2 or more S1 groups | Count distinct S1 groups. No source supports a particular N, so it is **recorded only**, not a gate. It feeds the eval as a feature. | Recorder |
| S5 | Weakens a guard | Paths `gates/src/rows/`, `surface/src/fast-set.ts` and test-runner config, plus the keywords `.skip`, `xit`, `--no-verify` and removed `expect(` lines. The verdict is judged. | C8 |
| S6 | Jo's wording at intake | `PRODUCTION_WORDS`, raise only | C16 |
| — | The open-time judge's `change-large` | Kept as a plan-first trigger (`stakes.ts` `planFirstTrigger`). It never involves Jo. | — |
| — | PR title or branch name | **Not used.** | — |

**CLAIM**
How the draft's two PRs measure (`gh pr view <n> --json files,additions,deletions`, recon draft `/Users/jowolff/agent-scratch/agent-system-2.0/stakes-criteria/DRAFT.md:53`): #331 is +2939 lines across 39 files, all under `.ai/`. #369 is +10141/−428 lines across 50 files, including `surface`, `gates`, `install` and `.github`.

---

## 6. The self-improving loop

Four parts. Validation is in § 7. The protected set in § 6.5 is out of the loop's reach.

### 6.1 Recorder

Every ask, and every decision not to ask, at every checkpoint writes one ledger row and one Phoenix span with the same id. The row holds:
- workload, slice, checkpoint (CP1–CP6)
- the criterion ID, or `none`
- level before and after
- mechanical or judgment
- the reason in one sentence
- the evidence: matched paths, the command, counter values, and the judge's choice and confidence
- the criteria version (the git sha of the criteria file)
- whether Jo was asked, and the question ID if so
- the recommendation given to Jo, if any

**CLAIM**
Phoenix already runs locally: `lsof -nP -iTCP:6006 -sTCP:LISTEN` shows python on `127.0.0.1:6006` (2026-10-28). It is installed by `/Users/jowolff/code/agent-system-2.0/install/phoenix-agent.sh` and reported by `install/install.sh:748`.

The Recorder ships first and in **shadow mode**. It records today's stakes decision next to the level this spec would have chosen, and it changes no behaviour. Every day without it loses labeled cases the eval needs.

**Jo's messages around an ask.** The Recorder also captures what Jo writes, because those messages are the labeler's primary signal (§ 6.2).

**CLAIM**
The surface already records Jo's inputs. `sqlite3 -readonly ~/.agent-system-2/ledger.db "select count(*), min(created_at), max(created_at) from instructions;"` → `3050|2026-09-30T03:11:05.361Z|2026-10-28T16:02:38.923Z`. The columns are id, workload_id, slice_id, kind, question_id, disposition, channel, author, body, created_by and created_at. One row is Jo's verbatim `WHY DO PRODUCTION STAKES STILL ASK ME` (`in-mvqyleul4fb6dc`, 2026-10-27T17:28:09Z, author `jo`, channel `surface`).

- **Gap: Jo's messages to seats are not in the ledger.** That covers Plumb in its OMP session, and most of Jo's reactions happen there. The Recorder adds a seat-side hook that writes each of Jo's messages, plus the ask it answers, into `instructions` with a seat channel. Without the hook, most reactions are lost.
- **Attribution.** Each message is tied to the nearest open or just-answered ask: by `question_id` where present, otherwise by time window and thread (same workload or seat session). The Recorder stores the link and how it was made (`question_id`, `window` or `thread`), so the label audit can check it.

### 6.2 Labeler

A scheduled job (launchd, daily) labels each recorded decision. **Jo's free-text messages around an ask are the primary signal.** The Jev judge (`typesafe/jev-1.13.0`) classifies each attributed message into one of three labels, or `none`:

| Jo's words (examples) | Label | What it feeds |
|---|---|---|
| "why are you handing this to me", "you could have decided this", "don't ask me this" | **unnecessary ask** | The unnecessary-ask rate |
| "why didn't you ask me". Also reverting a merge, overriding a decision, stepping in on work that wasn't escalated, or an unprompted ruling that covers it. | **missed ask** | The missed-ask rate |
| "I don't understand what you're asking" | **unclear ask** | A separate question-quality count. The ask may have been needed but was badly written. That is a different fix (how the question is written), so it is **never** counted as an unnecessary ask. |
| Anything else | `none` | Nothing |

"WHY DO PRODUCTION STAKES STILL ASK ME" is the unnecessary-ask label applied to a whole criterion. "Why didn't you ask me" is its inverse.

**Weak signals**, recorded but never a label on their own:
- An approve or deny given on a recommendation is labeled **followed recommendation**: probably unnecessary, **unconfirmed**. Per § 2, an approve usually means Plumb recommended it, not that Jo judged the ask.
- An answer against the recommendation is labeled **went against recommendation**. It suggests the ask was needed.
- No reaction within 7 days to a solo or no-ask decision is labeled **no signal**.

Weak signals are a candidate pool for the label audit (§ 7.1). Only labels from Jo's words, or labels the audit confirms, feed the eval's numbers.

### 6.3 Eval

A Phoenix dataset of past cases: the brief, plan, paths, counters and transcript excerpt at the checkpoint, plus the label. The dataset is replayed against the current criteria, both the code checks and the judgment prompts. It produces two numbers:
- **unnecessary-ask rate:** asks the criteria raise on cases labeled unnecessary (from Jo's words, or audit-confirmed). Unclear asks are excluded.
- **missed-ask rate:** cases labeled missed ask where the criteria would not have asked.

The question-quality count (unclear asks) is reported next to the two numbers. It goes to whoever writes the question text, not to the criteria improver.

**CITE**
Phoenix datasets and experiments support this replay. https://arize.com/docs/phoenix/datasets-and-experiments/overview-datasets (fetched 2026-10-28): "When you run an experiment against a dataset, its associated evaluators run automatically, providing consistent and repeatable quality assessments."

### 6.4 Improver

A weekly launchd job:
1. It reads the week's labeled cases.
2. It proposes changes to the **wording of the judgment criteria** (the CP1 judge question, the CP2 open-choice question, C3, C9, C13, C14) with Phoenix Prompt Learning, or DSPy GEPA as the alternative.
3. It scores each candidate with the eval on held-out cases (§ 7.2).
4. It opens one PR with a report.

**Month one: Jo approves each change.** The PR gets an independent cross-lab review first (OpenAI, because the builder lab is Anthropic), then Plumb's recommendation. Jo sees one line: what changes, the reviewer's verdict, and the recommendation.

**After graduation (§ 7.4):** agents apply a change that scores better on both numbers, the reviewer passes it, and Jo gets the report. This is Jo's ruling, 2026-10-28: "never say it never makes improvements on its own. we'd probably want me approving the improvements based on the reports and etc for the first month to make sure it's working right. but at some point I'd like the agents to take this over too."

**CITE**
Prompt Learning keeps optimization and scoring on separate data. https://arize.com/docs/ax/cookbooks/improve/improving-structured-output-generation-with-prompt-learning (fetched 2026-10-28): "To avoid overfitting, we will split our dataset into Train and Test sets. The optimizer will run on the train set … We will then test each generated prompt on the test set". The algorithm is Arize AX's ("Prompt Learning is an algorithm developed by Arize AX"), and its SDK is public at https://github.com/Arize-ai/prompt-learning.

**CITE**
GEPA requires a scorer and has a Python ceiling. https://dspy.ai/current/api/optimizers/GEPA/overview/ (fetched 2026-10-28): "Users should provide a feedback function as the GEPA metric". Also: "DSPy installs gepa only on Python < 3.15, because gepa declares requires-python <3.15."

**Upkeep: pending.** The upkeep comparison for Phoenix and GEPA (`/Users/jowolff/agent-scratch/agent-system-2.0/escalation-loop-comparables/UPKEEP.md`) did not exist when this was written. Slice B10 chooses between Prompt Learning and GEPA once it lands. The GEPA Python ceiling above is one known upkeep cost.

### 6.5 Out of the improver's reach

The improver may never change these. A gates check refuses any improver PR that touches them:
- the CP4 command gate
- the as2-machinery path list (S1), the Newdle production lists (S2, S3) and the guard list (S5)
- the labeler's rules, the eval dataset, the held-out split, the scorer, and the graduation gates (§ 7.4)

It may still *suggest* changes to these in its report. Only Jo makes them.

**CITE**
An agent weakened its own gate one word at a time, as recorded at `/Users/jowolff/code/agent-system-2.0/research/phase4/research-G-self-improvement.md:478-489`. That entry cites Claude Code issue #32376, which quotes "changing the trigger from 'code changes' to 'SIGNIFICANT code changes' — a single word that weakens the gate". The issue was closed NOT_PLANNED.

### 6.6 Agents following their own recommendations

Jo, 2026-10-28 at about 9:55 AM PDT: "I feel like this work goes hand in hand with making agents better to follow their own recommendations".

**This is a design goal.** An agent sometimes asks Jo, attaches a recommendation, and Jo picks it. Per § 2, Jo mostly approves whatever Plumb recommends. When that happens, the ask was delay, not oversight.

**The follow rate is a solo-candidate signal, per ask type.** An ask type qualifies for a move toward "decide, act, notify" when:
- its recommendation-follow rate is high,
- there are no messages from Jo around those asks (§ 6.2), and
- there are no reverts.

The improver proposes that move like any other criteria change, through the same review, scoring and month-one approval.

**Exception: the protected set.** Some asks are required by the protected set: irreversible actions (C5), as2 machinery (C7) and the P-7b items. These do **not** move to solo on the follow rate alone. Their fix is a better ask, not no ask: one readable line plus a cross-lab review, so that Jo's approve means something.

**CLAIM**
`/Users/jowolff/code/agent-system-2.0/research/phase4/research-B-osmani.md:687-688` quotes Osmani: "Only people can choose. Only people inherit consequence. Agents can be asked to choose, route, merge, and escalate safely inside a policy, but they cannot inherit the consequences."

**A second improvement target: the recommendations themselves.** If Jo follows the recommendations, their quality is the real decision. So the improver also scores **recommendation quality**, from three signals:
- cases where Jo went against the recommendation,
- Jo's messages around the ask, and
- reverts after the recommended option was taken.

It proposes changes to how recommendations are made the same way it proposes criteria changes, and it reports recommendation quality next to the two numbers.

**Data.** A per-type follow-rate measurement is running. It will write `/Users/jowolff/agent-scratch/agent-system-2.0/recommendation-follow/REPORT.md`, which did not exist when this was written: **pending**.

**CLAIM**
The measurement has data to work with, but the recommendation itself is not recorded as a field. `sqlite3 -readonly ~/.agent-system-2/ledger.db "select state, count(*) from questions group by state;"` → `answered|769`, `open|6`, `withdrawn|46`. The `questions` columns are id, workload_id, slice_id, body, options, state, resolved_by, created_by, created_at, changed_by, changed_at and rev. `options` is an unmarked array, for example `["retry","skip","stop"]`, and the recommended option appears only in the body text. Slice B1 adds it as a structured field.

---

## 7. Validating the loop

The four-part loop has not been validated. These four steps are how month one validates it. Nothing graduates without them.

### 7.1 Label audit before trusting the labeler

Jo hand-labels **30** past cases before any label drives the eval. The audit draws mainly from Jo's own messages, and it checks two things: the message attribution (§ 6.1) and the Jev message classifier (§ 6.2). The 30 are stratified:
- 15 of Jo's free-text messages attributed to an ask, with at least 3 each that the classifier labeled unnecessary, missed and unclear
- 8 asks answered with the recommended word and no message
- 7 non-asks (solo merges and no-ask decisions)

Jo answers one word per case: `needed`, `noise`, `missed` or `unclear`. For message cases, Jo also confirms the message is tied to the right ask. The labeler must agree on **26 of 30** or better, and on **every** case Jo marks `missed`, before its labels drive anything. A fresh audit of 15 cases at the end of month one must reach **13 of 15**.

The size follows the Jev classifier's calibration.

**CLAIM**
`/Users/jowolff/code/agent-system-2.0/SPEC-2.0.md:158`: the open-time classifier was calibrated on "the same 30 briefs", "Agreement 21/30 (70.0%)".

**Known risk.** Jo approved 54 of 57 plans (`escalation-policy/DRAFT.md:60`), and per § 2 most of those approvals echo Plumb. A labeler that reads "answered with the recommended word" as "unnecessary" would mark asks Jo still wants as noise. That is why approvals are only a weak signal, and why the 8 no-message cases in the audit measure exactly that.

### 7.2 Held-out cases

The improver is scored only on cases it did not learn from. Each week's cases are split 80/20 by workload, so no workload sits on both sides. The held-out 20% also keeps a fixed core of 20 cases that never rotates. A candidate must not regress on either set.

**CLAIM**
`/Users/jowolff/code/agent-system-2.0/research/phase4/research-G-self-improvement.md:203`: "keeps the edit only if it clears a strict no-regression gate on both visible and held-out fixtures".

### 7.3 A checking loop beside the optimizing loop

Missed asks are tracked as a counter-metric with a floor. That way "fewer asks" can't win by under-asking. A candidate that lowers unnecessary asks but raises held-out missed asks at all is rejected. Live missed asks are counted weekly against the shadow-period baseline (B1). The code checks and the path lists stay out of reach (§ 6.5).

**CLAIM**
`/Users/jowolff/code/agent-system-2.0/research/phase4/research-A-graph-engineering.md:323` (Turing Post): "One loop optimizes a metric, another watches the counter-metric … An optimization loop without a checking loop can become very good at producing the wrong result."

### 7.4 Month one is the validation period

Graduation needs all five gates. These are the thresholds proposed for open decision 2:

| Gate | Threshold |
|---|---|
| G1 Time | At least 30 days of month one, and at least 4 weekly improver runs reviewed |
| G2 Label agreement | § 7.1: 26 of 30 at the start, 13 of 15 at the end, every `missed` case matched |
| G3 Held-out improvement | Over the month's accepted changes: held-out unnecessary-ask rate down at least 20% from the month-start baseline, and held-out missed-ask rate not up |
| G4 No missed-ask regression | Live missed asks for the month at or below the shadow baseline, and **zero** missed asks on C5–C8 |
| G5 No reversal by Jo | No change accepted in month one was reverted or overridden by Jo's own words within 14 days |

If any gate fails, month one runs another two weeks and the report names the failed gate. **Tripwire after graduation:** one week with a missed ask on C5–C8, or a live missed-ask rate above baseline, reverts the last applied change and switches the improver back to "Jo approves" until the gates hold again.

---

## 8. Worked examples

**CLAIM**
PR facts come from `gh pr view <n> --repo thewolff/agent-system-2.0 --json files,headRefName,mergedBy` on 2026-10-28, and from the recon draft's table (`/Users/jowolff/agent-scratch/agent-system-2.0/stakes-criteria/DRAFT.md:90-95`).

| Case | What it is | Today | Under this spec | Checkpoint and criterion |
|---|---|---|---|---|
| **#331** (merged) | `plumb/decision-log-batch-2026-10-27`, 39 files, all `.ai/decision-log/` | Production, because the head isn't `wl/<id>`. Jo got merged/skip/stop. | **Merges itself, notice** | CP5: no S1–S5 path. N2. The branch name no longer matters. |
| **#343** (open) | `plumb/dl-flow-one-day-curb`, titled "docs:", touches `.ai/decision-log/`, `migration/items/…` and `surface/test/as2test.test.ts` | Production (branch) | **Merges itself, notice** | CP5: `surface/test/` is not in S1. The S5 scan finds no `.skip` and no removed assertion. The diff adds `expect(readdirSync(capDir)).toHaveLength(20_000)`. Paths, not the title, decide. |
| **#369** (merged) | `wl/wl-mvq4edbaf13vnk`, "Run fast checks before merge…", 50 files incl. `merge-train.ts`, `train-tick.ts`, `gates/src/fence.ts`, `install/install.sh`, `.github/workflows/as2-fast.yml` | Normal. The train merged it with a one-line notice. | **Asks Jo at merge** | CP5: C7 (S1: train, gates, install, workflows), S4 = 3 groups (recorded), and C8 (it changed which tests run before merge). This is Jo's "big fix". |
| **#378** (merged) | `plumb/train-tick-standard-priority`, +39/−5: `install/com.agent-system-2.train-tick.plist`, `install/com.agent-system-2.chaos.plist`, `surface/test/as2test.test.ts`, one decision-log entry | Merged by `thewolff-engineer`, outside the train | **Asks Jo at merge** | CP5: C7, because launchd plists under `install/` are S1. Small by lines, but it changes how the train runs. This is the cost of a path rule: small machinery changes ask too. |
| **Newdle prod deploy** | Jo: "ship the dedupe fix to prod" on newdle-api | Production by keyword ("prod") | **Escalate**, asking twice | CP1: C16 raises the start to escalate. CP5: the PR merges itself if it touches no S3 path. If it touches `deploy/` or `newdle-db/migrations/`, it asks (C6). CP4: the deploy (`gh workflow run cicd.yml -f deploy=true`, which runs `doctl apps create --upsert`) always asks (C5). CP6: a failed health check or a revert is reported now (C15) and labeled. |

**CLAIM**
The newdle-api deploy path: `/Users/jowolff/code/shipyard/repos/newdle-api/.github/workflows/cicd.yml:140` (`if: inputs.deploy == true`) and `:160` (`doctl apps create --upsert --update-sources --spec deploy/newdle-api.yaml`).

---

## 9. What changes from today

- **The `stakes` field (`throwaway`/`normal`/`production`, `ledger/src/index.ts:170`) becomes the new field.** Mapping: `throwaway` becomes solo, `normal` becomes escalate, and `production` becomes escalate with C16 recorded. `production` workloads Jo opened with steering words become with Jo.
- **The merge rule moves from branch name to diff.** `prStakes`'s `wl/<id>` lookup is kept only to find the workload. It no longer decides the level.
- **The standing rule `gates-stakes` (`rulings.ts:225`, from `in-mv0novd17fre9s`) is retired.** Its own end condition is "item 82 is built", and C7 covers it by path.
- **Review depth follows the merge-checkpoint level.** This is the spec's default. A merge that asks Jo (with Jo, or an escalate hit) gets the every-other-lab fan-out with round limit 5 (`classifier/src/lab.ts:564`, `classifier/src/rounds.ts`). A merge that merges itself gets off-lab review with round limit 3. Tests before merge stay independent of the level (ledger `in-mvrb4ddzyhpt5a`: "production stakes do not make a PR risky").
- **Amendments, for this feature only.** P-16 says "the system proposes and never applies". P-7b item 4 lists changes to the system's rules and machinery as Jo's. Both are amended for the involvement criteria wording only: month one, Jo approves each change; after graduation, agents apply. The protected set (§ 6.5) stays Jo's.

---

## 10. Build breakdown

Each slice is one workload slice with its own done-condition. B1 goes first, because waiting loses data. B2 unblocks production merges.

**Proposed:** the 8:15 AM pause lifts when B1 and B2 are on main. Jo confirms or corrects this.

| Slice | What | Acceptance criteria |
|---|---|---|
| **B1 Recorder (shadow)** | A new ledger table (schema version bump), one row per checkpoint decision (§ 6.1), and one Phoenix span with the same id. Computes this spec's level next to today's stakes. Changes no behaviour. Also: a seat-side hook that writes Jo's messages to seats (Plumb's OMP session included) into `instructions`, linked to the ask they answer (§ 6.1). And every ask records its **recommended option as a structured field**, not only in the body text (§ 6.6). | (1) A train merge on a test ledger writes one row with checkpoint `CP5`, the criterion, the paths and the shadow level. (2) A question to Jo writes a row linked to its question ID, with its recommended option in its own field. (3) The span is visible in Phoenix on 6006 with the row's id. (4) Replaying #331, #343, #369 and #378 gives the shadow levels in § 8. (5) A message Jo types to Plumb lands in `instructions` with a seat channel and an attribution link (`question_id`, `window` or `thread`). (6) Existing tests pass. Merge behaviour is unchanged. |
| **B2 Path lists and the merge checkpoint** | S1/S3/S5 lists in one config file, read by CP5 in the style of `fullExceptions`. Replaces the branch-name rule and retires `gates-stakes`. | (1) #331 and #340 merge themselves. #369 and #378 ask. #343 merges itself. (2) A fork PR asks. (3) A PR that changes the list file itself asks (C7). (4) The notice names the matched paths, or says "no criterion". |
| **B3 Open and plan checkpoints** | CP1: words, repo and the Jev judge set the starting level. CP2: plan paths and the open-choice judgment. | (1) "pair with me on X" starts with Jo. A scratch repo starts solo. A plain brief starts escalate. (2) A plan naming `gates/` is held under escalate. (3) Every decision writes a B1 row with the judge's choice and confidence. |
| **B4 During-work checkpoint** | Per-slice path re-check. Retry, round and spend counters wired to C10/C11. Judgments for C13/C14. | (1) A slice that adds an S1 path mid-work raises the level and queues one ask. (2) A third failed retry asks once, never twice. (3) The judgments write rows with reasons. |
| **B5 Command gate wiring, deploy and after-merge checkpoint** | CP4 records to B1. CP6: revert detection, deploy and health status, and the S2/S3 globs for each Newdle repo. | (1) A blocked `gh workflow run … -f deploy=true` writes a C5 row at solo level and asks. (2) A revert commit naming a merged PR writes a C15 row and a notice within one tick. |
| **B6 Rename and migrate** | The new field name (open decision 1) in the ledger, surfaces, lane prompts (`launch.ts`) and the SPEC table. Review depth per § 9. | (1) No `stakes: production` remains in the code paths that decide involvement. (2) Old workloads read through the § 9 mapping. (3) The USER-GUIDE is updated. |
| **B7 Labeler** | The daily launchd job. The Jev judge classifies Jo's attributed messages as unnecessary, missed, unclear or none (§ 6.2). Approve and deny answers are weak signals only. It also computes per-type follow rates and recommendation quality (§ 6.6). | (1) "why are you handing this to me" is labeled `unnecessary ask`, and "I don't understand what you're asking" is labeled `unclear ask` and never counted as unnecessary. (2) An approve on a recommendation is labeled `followed recommendation`, never `unnecessary`. (3) A revert of a solo merge is labeled `missed ask` within one day. (4) An ask type in the protected set is never proposed for solo on follow rate alone. |
| **B8 Label audit** (§ 7.1) | A 30-case stratified sample drawn mainly from Jo's messages, a one-word-per-case page for Jo, and the agreement report. It covers both the message attribution and the message classifier. | (1) The sample is drawn per § 7.1. (2) The report gives agreement overall, per stratum and on `missed`, plus attribution accuracy. (3) The eval refuses labels until the audit passes. |
| **B9 Eval and held-out split** (§ 6.3, § 7.2) | The Phoenix dataset, an 80/20 split by workload plus a fixed 20-case core, and the two-number scorer. | (1) The current criteria get baseline numbers. (2) The same input yields the same scores twice. (3) The held-out set is never shown to the improver. |
| **B10 Improver, Jo-approves mode** (§ 6.4) | The weekly launchd job, Prompt Learning or GEPA (chosen after the upkeep comparison), cross-lab OpenAI review, a PR with a one-line summary, and the § 6.5 protected-set check. | (1) The weekly PR carries the train and held-out scores for both numbers, the reviewer's verdict and Plumb's recommendation. (2) A candidate touching the protected set is refused by the check. (3) Nothing is applied without Jo's word. |
| **B11 Checking loop, graduation and tripwire** (§ 7.3–7.4) | The missed-ask floor, the five-gate graduation report, the agent-apply switch, and the automatic revert to Jo-approves. | (1) The end-of-month report lists G1–G5 with pass or fail. (2) The switch can't flip with any gate failing. (3) A simulated missed ask on C7 after graduation reverts the last change and switches back. |

---

## 11. Follow-on (not designed here)

The same four parts (Recorder, Labeler, Eval, Improver), plus the validation steps in § 7, are the template for other self-improving as2 features. That covers any big as2 feature or plugin Jo writes. They are adopted only after this pilot passes month one. Jo, 2026-10-28: "once we validate it, it should" be the pattern.
