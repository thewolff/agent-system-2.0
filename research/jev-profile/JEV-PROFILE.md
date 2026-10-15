<!-- Copied verbatim from /Users/jowolff/agent-scratch/agent-system-2.0/jev-profile/JEV-PROFILE.md, captured 2026-10-14 (Plumb). -->
# Jev capability profile

Written 2026-10-14 by JevProfile2 (a subagent of Plumb). Every factual line carries a receipt: a URL fetched on 2026-10-14, an absolute `file:line`, or a command plus its output. Some figures were recomputed by three read-only miner subagents (JevVeracityData, JevLedgerRoutings, JevAccuracyDocs); each of those carries the miner's own receipt. Anything without a receipt is labelled GUESS. No config, ledger, or seat was touched while writing this.

## Open items first

**CLAIM**
The free-text writing-rule row is now measured (JevJudge, 2026-10-14, 422 live calls on Jo's 304-message corpus, as a two-option choice). Verdict: **weak**. Evidence: `evidence-judge-corpus-1715.md` in this folder. A comparison with Claude-model judges is running into `evidence-model-judges-1720.md`.

**CLAIM**
Five gaps the data cannot close today:
- The as2 `routings` table has no latency, token, or cost columns. A failed classification refuses the dispatch without writing a row, so Jev outages leave no trace there. Receipt: JevLedgerRoutings, `sqlite3 -readonly /Users/jowolff/.agent-system-2/ledger.db ".schema routings"`; /Users/jowolff/code/agent-system-2.0/classifier/extension.ts:1907-1910.
- No diff size is recorded, so Jev's sizing cannot be scored against how much code actually changed. The only outcome proxy is hand wall time (same receipt).
- The raw rows of the M3 gate are missing. `ls /Users/jowolff/agent-scratch/agent-system-2.0/migration/M3/gate/` shows only REPORT.md, row4-run.sh, row4-test.log, run.log and run-rep2.log (JevAccuracyDocs).
- The monitoring workload's Jev inventory has not been written yet. /Users/jowolff/agent-scratch/agent-system-2.0/wl-mv654hoqwpfhmo/PLAN.md:112-113 only lists rows to build ("Jev brief classification", "Jev receipts audit and `jev-daily/summary.py`"), and workload `wl-mv654hoqwpfhmo` is `open` in the ledger (JevAccuracyDocs, `sqlite3 -readonly`).
- Nobody has measured the accuracy of the OMP `find` tool, the pair-mode `taste` and `ambiguous` signals, or the needs-you sorter. Receipt for the pair signals: wl-mv67564rdkfvnk REPLAY.md:118 ("no labelled set"), via JevAccuracyDocs.

## 1. What Jev is

**CITE**
Jev comes from TypeSafe. It is "TypeSafe's flagship model and the first System One model". A System One model "evaluates a state and returns typed answers and probabilities" and does "not write replies, produce code, or generate explanations of their reasoning". Source: https://docs.typesafe.ai/concepts/system-one.md.

**CITE**
"Jev is **not** a drop-in replacement for the LLM behind Claude Code … It does not generate text, write code, or hold a conversation." Reach for it when code must "Route a request to one of a fixed set of destinations … Score something on a rubric … Check whether a statement is true of a document". Source: https://docs.typesafe.ai/introduction/coding-agents.md.

**CITE**
The interface is one endpoint, `POST https://api.typesafe.ai/v1/systemone`. A request carries a `state` (a string, an object, or an array) and a map of typed questions. The question types are `noul`, `choice` and `score`:
- `noul` is a yes/no question and returns P(yes).
- `choice` allows at most 255 options.
- `score` takes 2 to 10 levels.

A response carries `usage.input_tokens` and `usage.output_tokens`. Source: https://docs.typesafe.ai/api (served as api.md).

**CITE**
Versions and price:
- Models page: "Jev 1.14 is the newest Jev release, available from October 14, 2026."
- Aliases: `jev-latest` → `jev-1.13.0`, and `jev-preview` → `jev-1.14.0`. "An alias moves when a new release ships, so its answers can change without any change to your code."
- Price: $0.042 per million input tokens; "Output tokens are free."
- Context: 64k tokens per request and 32k per question. A long-context header raises both to 262k, which is "slower and less accurate".
- "Jev is not fine-tuned … the same weights serve every account." "English is the primary training language."

Source: https://docs.typesafe.ai/models.md.

**CITE**
TypeSafe's own list of weak spots for jev-1.13, from the page "Last reviewed 2026-10-02":
- literal reading;
- math and numbers, including "does not count reliably";
- date and time comparison;
- indirection;
- "Large state full of irrelevant detail" ("Jev suffers from context rot");
- adversarial content in the state;
- contradictory instructions and criteria;
- "Choice option order … leans toward the option that comes first";
- generation ("not trained to generate text").

Source: https://docs.typesafe.ai/model-jaggedness/jev-1.13.md.

**CITE**
Confidence is not probability. For a Choice, confidence = (n·p_max − 1)/(n − 1). "Calibration is measured across groups of predictions; it does not guarantee that an individual answer is correct." Sources: https://docs.typesafe.ai/confidence.md (formula in the page's demo code: `(count * peak - 1) / (count - 1)`); https://docs.typesafe.ai/concepts/system-one.md.

**CLAIM**
How OMP 18.8.6 reaches Jev:
- The `judge` role tries `typesafe/jev-latest` first, then `openrouter/~typesafe/jev-latest`, then `@tiny`, `@smol` and `@default` (/Users/jowolff/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/priority.json:99-104).
- The client posts to `/v1/systemone`, or to OpenRouter `/decisions` (/Users/jowolff/.bun/install/global/node_modules/@oh-my-pi/pi-ai/src/judgment/typesafe.ts:36-39).
- The default model is `jev-latest` (typesafe.ts:33).
- Each attempt has a 10 s timeout and the client makes up to 3 attempts, with backoff that respects `retry-after` (typesafe.ts:81-84).

**CLAIM**
OMP's catalog prices Jev at input 0.042 and output 0, and leaves the context window null (/Users/jowolff/.bun/install/global/node_modules/@oh-my-pi/pi-catalog/src/models.json, entry `typesafe/jev-latest`, read with python). Jev answers on a direct path report `usage.cost.total` = 0, so as2 derives dollars from input tokens at $0.042 per million (/Users/jowolff/code/agent-system-2.0/classifier/src/judge-ask.ts:14-19).

**CLAIM**
Both OMP profiles hold a TypeSafe credential. `sqlite3 -readonly <agent.db> "select provider,count(*) from auth_credentials group by provider"` returns `typesafe|1` for /Users/jowolff/.omp/agent/agent.db and for /Users/jowolff/.omp/profiles/agent-system-2/agent/agent.db. The default profile's /Users/jowolff/.omp/agent/config.yml sets no judge role (grep for `judge|jev|typesafe` returns nothing), so OMP's built-in judge features resolve to Jev in every default-profile session.

## 2. Every place we use Jev

### 2a. Our own call sites

| Use | File:line | Call shape | Prompt size | Timeout |
|---|---|---|---|---|
| as2 slice routing (work kind) | /Users/jowolff/code/agent-system-2.0/classifier/src/classify.ts:103-115; called at /Users/jowolff/code/agent-system-2.0/classifier/extension.ts:1904 | **choice**, 5 options (locate / understand / change-small / change-large / judge), from /Users/jowolff/code/agent-system-2.0/classifier/kind-question.json:2-11. Confidence ≤0.55 takes the higher tier of the top two (/Users/jowolff/code/agent-system-2.0/classifier/src/route.ts:38) | Question file is 903 bytes (`wc -c kind-question.json`). The state is the slice's `item.task`; its size is not recorded | No explicit timeout in classify(). It relies on OMP's 10 s × 3 attempts (typesafe.ts:81-82) and the attempt's abort signal (extension.ts:1904) |
| as2 judge pin | /Users/jowolff/code/agent-system-2.0/profile/config.yml:154-158 | `modelRoles.judge: typesafe/jev-1.13.0` with an empty fallback chain. Routing is refused if the answering model ≠ calibration's `typesafe/jev-1.13.0` (extension.ts:1907-1910; /Users/jowolff/code/agent-system-2.0/classifier/calibration.json:3) | — | — |
| as2 pair-mode signals (`askChoices`) | /Users/jowolff/code/agent-system-2.0/classifier/src/judge-ask.ts:121-153; called at extension.ts:1002 | **choice** ×2, yes/no (`taste`, `ambiguous`), from /Users/jowolff/code/agent-system-2.0/classifier/pair-signal-question.json:2-17. Counted at confidence ≥ PAIR_CONFIDENCE (/Users/jowolff/code/agent-system-2.0/surface/src/pair-suggest.ts:43, :284-285) | 1,230-byte question file. Mean 1,145 input tokens per call over 110 briefs (JevAccuracyDocs, recomputed from wl-mv67564rdkfvnk/replay/jev-results.json) | `PAIR_SIGNAL_TIMEOUT_MS = 10_000` (extension.ts:228), at most 3 attempts per workload (extension.ts:229) |
| as2 open-time brief judging | `brief-judged:` entries, read at /Users/jowolff/code/agent-system-2.0/surface/src/input.ts:838-840 (JevLedgerRoutings) | the same 5-way kind choice | not recorded | not recorded |
| Receipts audit (veracity) | /Users/jowolff/.omp/agent/extensions/receipts-audit-omp.ts is a symlink to /Users/jowolff/agent-scratch/agent-system-2.0/jev-veracity/audit/omp/receipts-audit-omp.ts (`ls -la`). It calls /Users/jowolff/agent-scratch/agent-system-2.0/jev-veracity/audit/score.ts:96-167 | **score**, 5 levels (0–4), one question `w3_score` (score.ts:64-76). Flags at level ≤2.4 (score.ts:40). Prints below 0.5 and only counts 0.5–2.4 (/Users/jowolff/agent-scratch/agent-system-2.0/jev-veracity/audit/flag.ts:40). One `judge_batch` per finished message | State is label definition + receipt + statement (score.ts:120-125). Label definitions are 281–597 chars. Round-2 receipts: median 787 chars, max 13,699. Receipt text is capped at `MAX_RECEIPT_CHARS = 24_000` (/Users/jowolff/agent-scratch/agent-system-2.0/jev-veracity/audit/mechanical.ts:412) (JevVeracityData) | 20 s wall for the whole audit, `WALL_MS` (receipts-audit-omp.ts:47), inside OMP's 30 s handler cap (/Users/jowolff/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/runner.ts:130). Library default is 10 min (score.ts:92-93, :134) |
| Plumb's open-item ranking | /Users/jowolff/agent-scratch/agent-system-2.0/plumb-rank/rank.ts:87-129, :185-244 | **mixed**: one **score** (4 levels) per goal, five **bool/noul**, one date **choice** (`deadline_day`). Combined in code with weights (rank.ts:130) | State is goals + item text (rank.ts:204). Item text is 118 / 237 / 437 chars (min / median / max, n=25, python over lists/jo-open-1610.json). GOALS.md has 5 `goal:` lines | 10-minute batch cap (rank.ts:214-220) plus OMP's 10 s × 3 per attempt |
| Ranking shadow test | /Users/jowolff/agent-scratch/agent-system-2.0/jev-rank-test/rank.ts (sealed; plumb-rank is a copy, rank.ts:3) | same as plumb-rank | 15 items | same |
| i-have-audhd judge | /Users/jowolff/.claude/plugins/marketplaces/jo-wolff-plugins/plugins/i-have-audhd/judge/ask.mjs:10-29 | **Not Jev today.** It runs a configured CLI command (the example is `codex exec`) and requires the verdict `{"violation": <boolean>, "reason": <string>}` (ask.mjs:27-29). A grep for `jev|typesafe` in the plugin returns nothing | — | Harness timeout (ask.mjs:193) |

### 2b. OMP built-ins that route to Jev when credentialed

**CLAIM**
OMP features whose judge resolves to Jev, by `purpose:` string:
- `find` (/Users/jowolff/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/tools/jfind/index.ts:92; 20 s cap at :38)
- `auto-thinking` (src/auto-thinking/classifier.ts:144)
- `unexpected-stop`, with a yes-threshold of 0.5 (src/session/unexpected-stop-classifier.ts:15-18, :79)
- `ttsr` (src/session/agent-session.ts:2989), which caps judged content at 32,000 Jev tokens because "Jev rejects a judgment branch past ~33k tokens" (src/export/ttsr.ts:59-63)
- `auto-graph` (agent-session.ts:3008)
- `memory` (src/mnemopi/backend.ts:631)
- `stats_frustration` (src/slash-commands/builtin-session.ts:198)
- git AI staging (src/git-tui/ai-stage.ts:5-6)
- the eval kernel's `judge()` and `judge_batch()` (src/prompts/tools/eval-judge.md:3-7)

**CLAIM**
Real call volume, from every OMP session file. Command: `rg -N --no-filename '"type":"model_usage".*"provider":"typesafe"' ~/.omp/agent/sessions ~/.omp/agent/seat-sessions ~/.omp/profiles/agent-system-2/agent/sessions`, deduplicated by (id, timestamp) in python. Output: 2,423 Jev attempts from 2026-09-21T17:33Z to 2026-10-14T23:57Z, $0.4481 in total.

| Purpose | n | Not `stop` | Input tokens median / p90 / max | Cost median |
|---|---|---|---|---|
| find | 2,289 | 4 ("The operation timed out.") | 5,013 / 7,543 / 12,876 | $0.0002055 |
| auto-thinking | 98 | 0 | 502 / 1,005 / 1,066 | $0.0000209 |
| judge_batch | 31 | 0 | 805 / 876 / 947 | $0.0000338 |
| judge | 5 | 0 | 681 / 681 / 681 | $0.0000286 |

**CLAIM**
That journal does not include the receipts audit, plumb-rank or the as2 classifier. All three call `runEvalJudgmentBatch` with a session that has no session manager (score.ts:111; rank.ts:197-199), and journaling needs one (/Users/jowolff/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/judgment/index.ts:117-118).

**CLAIM**
`frustration_verdicts` has 0 rows. Command: `sqlite3 -readonly /Users/jowolff/.omp/stats.db "select count(*) from frustration_verdicts"` → `0`.

## 3. Measured performance

### 3a. Sizing / routing (5-way kind choice)

**CLAIM**
The brief's figure "247 of 259 code slices change-large" is **reproduced exactly**, with one definitional correction: the unit is routing rows (hand dispatches), not distinct slices.

Command: `sqlite3 -readonly /Users/jowolff/.agent-system-2/ledger.db "select count(*), sum(kind='change-large'), sum(kind='change-small'), sum(kind in ('change-large','change-small')) from routings where created_at <= '2026-10-13T19:05:38.573Z'"` → `905 | 247 | 12 | 259`. That is 95.4% change-large.

The figure is Jo's instruction `in-mv71wv0tc0xo1s`. Counted as distinct slice_ids, the same cutoff gives 243 change-large and 12 change-small out of 255 (JevLedgerRoutings).

**CLAIM**
The ledger today: 1,151 routings, 333 change-large and 26 change-small, so 333 of 359 code rows (92.8%) are change-large. The full split is judge 761, change-large 333, understand 31, change-small 26, locate 0. Every row was answered by `typesafe/jev-1.13.0`. Change-small rose to 12 of 84 code rows (14%) on 2026-10-14 (JevLedgerRoutings, `group by kind` / `group by judge_model` / by day).

**CLAIM**
Jev is confident about change-large. 160 of 333 change-large rows sit at exactly confidence 1.00 with a one-hot distribution, and only 32 of 333 are below 0.80. On the judge label, 657 rows are exactly one-hot at 1.00 (JevLedgerRoutings, `group by kind, probabilities, confidence`).

**CLAIM**
The probabilities still carry size information. Hand wall time, from the hand-spawn to the hand-settled entry:

| Group | n | p50 | p90 |
|---|---|---|---|
| change-large with p(change-small) < 0.1 | 296 | 7.7 min | 23.6 min |
| change-large with p(change-small) ≥ 0.1 | 36 | 3.0 min | 9.0 min |
| change-small | 26 | 1.1 min | 3.1 min |

Opus ran 328 of 333 change-large hands (JevLedgerRoutings).

**GUESS**
Wall time is a proxy for size, not a measured diff, and change-small mostly ran on sonnet, so that row confounds model with size. The pattern fits a model whose top pick leans to change-large while its probabilities stay informative. That is an inference.

**CLAIM**
Labelled sample, 2026-09-23, n=30 hand-labelled briefs, recomputed from /Users/jowolff/agent-scratch/agent-system-2.0/classifier-sample/results.jsonl:
- Agreement 23/30. The baseline "always understand" scores 15/30.
- Jev picked understand 19 times against 15 hand labels, and change-large 0 times against 1 hand label.
- Confidence < 0.55 flagged 5 briefs, 4 of them wrong.

Re-measure on 2026-09-28 with the corrected question (n=32, recomputed from /Users/jowolff/code/agent-system-2.0/classifier/test/fixtures/classifier-sample-2026-09-28.jsonl):
- 21/30 on the original thirty, plus 2/2 on the new briefs.
- Below 0.55, only 2 of 7 flags were wrong.
- Five misses sat at confidence ≥ 0.87, and 4 of 30 briefs changed their pick between runs.

Doc figures that match: /Users/jowolff/code/agent-system-2.0/research/classifier-sample.md:137, :214 (JevAccuracyDocs).

**CLAIM**
Real-use grading against the files each hand wrote:
- 37 lane hands: 34 agree, 2 disagree, 1 unclear. "Always change-large" scores 29/37.
- 11 of Jo's open-time briefs: Jev 6 agree, below "always change-large" at 8/11.

Source: /Users/jowolff/agent-scratch/agent-system-2.0/typesafe-real-data/REPORT.md:7-9, :111, :159, :161. These are the doc's figures, hand tally checked by JevAccuracyDocs.

**CLAIM**
High-confidence misses driven by vocabulary:
- A brief saying "run one `judge()` call" was labelled `judge` at 0.98–0.99.
- T2Phoenix was labelled `understand` at 0.99–1.00.

Both missed in both runs (/Users/jowolff/code/agent-system-2.0/research/classifier-sample.md:11, :66-67, :150-153).

**CLAIM**
Stability on identical calls in the M3 gate:
- The kind changed on 1 of 32 briefs.
- The routed tier changed on 2 of 32.
- Confidences moved by a mean of 0.016 and a maximum of 0.06.

These are the doc's figures, because the raw rows are missing: /Users/jowolff/agent-scratch/agent-system-2.0/migration/M3/gate/REPORT.md:61-86.

**CLAIM**
Laya, the local alternative, scored 10/30, 11/30 and 6/30 on the same briefs against Jev's 23/30 (/Users/jowolff/code/agent-system-2.0/research/laya-vs-typesafe.md:23, :142-145; the doc's figures).

### 3b. Veracity: does the receipt establish the claim

**CLAIM**
Offline, round 1, 66 real items, with labels written before the run (22 not-supported / 44 supported). AUROC by question wording:
- w1 (choice): 0.854
- w2 (bool): 0.874
- w3 (score, the live one): 0.852

Under post-hoc strict labels the same wordings score 0.958, 0.953 and 0.955. Round 2, with blind locked labels (n=86: 68 overreach, 13 supported, 5 unbacked), scores 0.960, 0.962 and 0.959. Recomputed by JevVeracityData in python over /Users/jowolff/agent-scratch/agent-system-2.0/jev-veracity/results.jsonl and validation/*.jsonl.

**CLAIM**
At the live threshold (w3 ≤ 2.4), round 1 real items with pre-run labels:
- false-positive rate on supported items: 25/44;
- recall on overreach: 17/17;
- recall on unbacked: 5/5.

Round 2: 62 true positives and 1 false positive among 63 flags, with a false-positive rate of 1/13 (JevVeracityData).

**GUESS**
Round 2's precision of 0.98 mostly reflects its 85% positive base rate (73 of 86). It had only 13 negatives. This is JevVeracityData's inference, and I agree with it.

**CLAIM**
Jev leans hard toward "overreach":
- In round 1, Jev's top pick on real items was overreach 46/66 times, against 17 true overreach items.
- On supported items, Jev picked overreach 28/44 times.
- On items labelled not-supported, it picked supported 0/22 times.
- P(supported) ≤ 0.05 on 81 of 132 items.

Source: JevVeracityData, python over results.jsonl.

**CLAIM**
In the advisor trial, n=45 with hand labels written first and a 3-way choice:
- recall 7/12;
- precision 7/19;
- exact agreement 28/45.

Named misses:
- "Existing tests pass" written over a visible `fail 1` scored 0.96 supported.
- An edit that exactly matched its claim was flagged at 0.32.

Sources: /Users/jowolff/agent-scratch/agent-system-2.0/advisor-trial/jev/results.jsonl, recomputed by JevAccuracyDocs; /Users/jowolff/agent-scratch/agent-system-2.0/advisor-trial/REPORT.md:125-126.

**CLAIM**
Labelling caveat: "One person did all the labelling: me, a single model run" (/Users/jowolff/agent-scratch/agent-system-2.0/jev-veracity/REPORT.md:74). This contradicts PLAIN-SUMMARY.md:7, which says "A human sorted them". REPORT-v2.md:20 adds: "It is not a second labeller's work."

**CLAIM**
Live, /Users/jowolff/agent-scratch/agent-system-2.0/jev-veracity/validation/live-log.jsonl, 1,467 rows from 2026-10-09T03:17Z to 2026-10-14T23:55Z:
- 1,064 statements were scored by Jev.
- Total Jev cost was $0.1236.
- After the 2026-10-11 tune, 877 of 967 scored statements (90.7%) fell at level ≤ 2.4. Round 2 had predicted 78%.
- Hand-classified live precision of Jev's "reaching" flags: 3 of 8, from /Users/jowolff/agent-scratch/agent-system-2.0/jev-veracity/validation/day-1.md:121-147. That file says the 5 nitpicks came from receipt text the auditor could not see, not from Jev misreading a visible receipt.

Source: JevVeracityData, python over live-log.jsonl.

**CLAIM**
The receipt type matters. ACTION was the weakest type at w3 AUROC 0.69 before a prompt fix and 0.944 after (n=11) (/Users/jowolff/agent-scratch/agent-system-2.0/jev-veracity/PLAN.md:9; JevVeracityData recompute over validation/results-v2-actionfix.jsonl).

**CLAIM**
The authors' own conclusions:
- Read a flag as "some part of this statement is not in its receipt", not as "this statement is false" (REPORT.md:46).
- "Ready to wire in as a non-blocking advisory … not ready to be a blocking gate" (REPORT-v2.md:187).
- Results "may not transfer … to a future `jev-latest` that resolves to a version other than 1.13.0" (REPORT.md:286).

All under /Users/jowolff/agent-scratch/agent-system-2.0/jev-veracity/.

**CLAIM**
A rule-based checker replaced Jev for claim-check: "not a judge: Jev passed these exact sentences" (/Users/jowolff/code/agent-system-2.0/.ai/decision-log/2026-10-12--1354--ilex--jo-2026-10-12-open-a-normal-workload-a-behavioral-eval-that-.md:62).

### 3c. Ranking

**CLAIM**
Shadow test on 2026-10-14. Fifteen items, Jo's own order as ground truth, 105 pairs, one snapshot:

| Method | Pairwise agreement with Jo | Kendall tau | Top-5 overlap |
|---|---|---|---|
| Jev | 0.781 | 0.562 | 4/5 |
| code-only rules | 0.448 | −0.105 | 2/5 |
| oldest-first | 0.438 | −0.124 | 1/5 |

Jo's #1 item was not in Jev's top 3. The batch cost $0.001181 on `typesafe/jev-1.13.0`. Verdict line: "BUILD (first snapshot) … The design asks for a second snapshot on a different day before building." Source: /Users/jowolff/agent-scratch/agent-system-2.0/jev-rank-test/RESULT.md:3-15.

**CLAIM**
Under the four work goals, Jev ranked the ping-sound fix last of 10 (0.072) even though pings give Jo anxiety. Jo then added wellbeing as a fifth goal (/Users/jowolff/agent-scratch/agent-system-2.0/plumb-rank/GOALS.md:17).

**GUESS**
Jev ranks only against what the goals state. A priority Jo holds but has not written down cannot reach the ranking. This is an inference from one incident.

### 3d. Yes/no signals (pair mode)

**CLAIM**
110 briefs, recomputed from wl-mv67564rdkfvnk/replay/jev-results.json by JevAccuracyDocs:
- `taste` answered no 109 times and yes once.
- `ambiguous` answered yes 30 times.
- Accuracy is unmeasured: "no labelled set" (REPLAY.md:118).
- The 0.70 cut "is uncalibrated" (/Users/jowolff/code/agent-system-2.0/migration/items/pair-suggest-trigger.md:23).

### 3e. Latency and cost

**CLAIM**
Latency:
- Pair replay, 109 sequential fresh calls with 2 questions each: p50 86 ms, p90 133 ms, max 191 ms, $0.0000481 per call. No timeouts and no 429s; the replay never exercised concurrency (JevAccuracyDocs; REPLAY.md:120).
- Tinker's T3 test: `judge()` took 0.20–0.47 s across 5 calls (/Users/jowolff/agent-scratch/tinker/phase5-prereq-tests/TINKER-REPORT.md:154-160).
- Live receipts audit, whole-audit time including the mechanical check, n=685: median 225 ms, p90 929 ms, max 4,849 ms. It never hit the 20 s wall (JevVeracityData).
- `find`: 4 timeouts in 2,289 calls (section 2b command).

**CLAIM**
Cost per call:
- routing: about $0.00003 per brief ($0.001014 for 32; /Users/jowolff/code/agent-system-2.0/research/classifier-sample.md:126);
- receipts audit: median $0.0000682 per scored statement (n=668, JevVeracityData);
- find: median $0.0002055 (n=2,289, section 2b).

All metered Jev spend found adds up to under $0.60:
- $0.4481 in the OMP session journals;
- $0.1236 in the receipts-audit live log;
- small experiment batches on top.

## 4. Verdict table

| Task shape | Verdict | Evidence |
|---|---|---|
| Picking one label from a fixed set of clearly different options | **Good, with caveats** | 23/30, then 21/30 on hand labels, against a 15/30 baseline. Laya scored 10–11/30 (sections 3a and 3c of this file; research/classifier-sample.md:137; research/laya-vs-typesafe.md:23). Stable on repeat calls: kind changed on 1/32 (M3 REPORT.md:61-86). Caveats: keyword capture produces misses at 0.98–1.00 confidence (classifier-sample.md:66-67), and vendor docs report a first-option bias (https://docs.typesafe.ai/model-jaggedness/jev-1.13.md). |
| Scoring whether a receipt establishes a claim | **Good at ranking statements by risk, weak as a pass/fail gate** | AUROC 0.85–0.96 across rounds, 0.986 through the live library (JevVeracityData). It leans to "overreach": 46/66 picks against 17 true. The false-positive rate on supported items is 25/44 at the live threshold. Live, 90.7% of scored statements get flagged, and hand-checked live precision is 3/8 (validation/day-1.md:121-147). The authors say advisory, not gate (jev-veracity/REPORT-v2.md:187). Advisor trial: precision 7/19, recall 7/12. |
| Sizing work as change-small or change-large | **Weak on the label itself; the probabilities are informative** | 247 of 259 code rows were labelled change-large, reproduced exactly; 333/359 today (`sqlite3 -readonly … routings`). 160 of the change-large rows sit at confidence 1.00. On Jo's briefs Jev scored 6/11, below "always change-large" at 8/11 (typesafe-real-data/REPORT.md:159-161). Hands Jev hedged on, p(change-small) ≥ 0.1, ran 3.0 min at p50 against 7.7 min for the rest (JevLedgerRoutings). |
| Ranking items against stated goals, with atomic questions combined in code | **Good on one snapshot (n=15). A second snapshot is pending.** | Pairwise agreement 0.781 and tau 0.562 against 0.44 / −0.12 for the baselines (jev-rank-test/RESULT.md:9-15). Missed Jo's #1 in its top 3. Blind to goals nobody wrote down: the ping-sound fix ranked last (plumb-rank/GOALS.md:17). |
| Judging free-text writing rules, e.g. "does this message put its conclusion first" (i-have-audhd's judge) | **Weak (measured, small labelled set)** | Run as a 2-option choice through a wrapper (`/Users/jowolff/agent-scratch/jo-wolff-plugins/monitor/jev-judge.ts`). conclusion-first: it flagged all 3 human-confirmed false positives (0/3). bad-news-first: precision 0.50, recall 0.20 on 15 human labels; it misses bad news behind a reassuring opener (c0055 cleared at p=0.89). 69/260 and 42/162 verdicts at p<0.7. Median about 1.1 s. Labels n=18, codex-flagged only (`evidence-judge-corpus-1715.md`). |
| Yes/no signals over a workload brief (`taste`, `ambiguous`) | **Untested for accuracy** | `taste` answered no on 109 of 110. No labelled set exists (REPLAY.md:118), and the 0.70 cut is uncalibrated (pair-suggest-trigger.md:23). |
| Semantic code search (the OMP `find` tool) | **Untested for accuracy; heavily used** | 2,289 calls with 4 timeouts and no accuracy data (section 2b). |
| Counting, arithmetic, comparing dates, generating text | **Weak according to the vendor; untested by us** | https://docs.typesafe.ai/model-jaggedness/jev-1.13.md (sections on math and numbers, date and time comparison, generation). |
| Repeatability on the same input | **Good** | Veracity top pick agreed on 124/132 reruns, and the w3 flag on 130/132 (JevVeracityData). M3: kind changed on 1/32 (gate REPORT.md:61-86). |

## 5. Usage rules

**CLAIM**
1. **Use Jev only for typed decisions over a set of answers you define. Never ask it for prose, reasons, or extraction.** Receipt: https://docs.typesafe.ai/introduction/coding-agents.md ("does not generate text"). For the same reason, Jev cannot fill i-have-audhd's `{violation, reason}` verdict as written (judge/ask.mjs:27-29); at most it could supply the boolean.
2. **Read the probabilities, not just the top label, when the labels are unbalanced.** Receipt: the change-large label covers 92.8% of code rows, yet p(change-small) separates 3.0-minute hands from 7.7-minute hands (section 3a).
3. **Do not treat confidence as a correctness check.** Receipt: on 2026-09-28, five misses sat at ≥ 0.87 and 5 of 7 low-confidence flags were false (research/classifier-sample.md:214). Confidence is (n·p_max − 1)/(n − 1), not P (https://docs.typesafe.ai/confidence.md), so 0.70 confidence on a yes/no question means P ≈ 0.85 (research/laya-vs-typesafe.md:84, via JevAccuracyDocs).
4. **Use the veracity score as advisory triage, never as a blocking gate.** Receipt: the live flag rate is 90.7% and live precision 3/8 (section 3b). Advisory-not-gate is the authors' own conclusion (jev-veracity/REPORT-v2.md:187).
5. **Pin the version and refuse answers from any other model.** Receipt: the alias moves "without any change to your code", and jev-1.14 went out on 2026-10-14 as `jev-preview` (https://docs.typesafe.ai/models.md). The as2 classifier fails closed (extension.ts:1907-1910). The receipts audit and plumb-rank call `jev-latest` and accept any `typesafe/jev-*` (score.ts:43-44, :142-143; rank.ts:30-31, :233), so their thresholds would carry over to a new model without anyone noticing. Note also that `jev-1.13.0` is not in OMP's catalog, and only the response-model check enforces the pin (research/classifier-sample.md:129, via JevAccuracyDocs).
6. **Re-measure whenever the question wording changes.** Receipt: the corrected 09-28 question changed accuracy and calibration (section 3a). /Users/jowolff/code/agent-system-2.0/classifier/calibration.json:7 forbids a regenerated hash without a new sample.
7. **Keep arithmetic, counting and date comparison in code. Ask Jev for date parts as a choice.** Receipt: https://docs.typesafe.ai/model-jaggedness/jev-1.13.md. plumb-rank already follows this with a `deadline_day` choice over fixed days (rank.ts:113-123).
8. **Send only the state the question needs, and stay under 32k tokens per question.** Receipt: "context rot" and the 32k per-question limit (https://docs.typesafe.ai/models.md; jaggedness page). OMP truncates at 32,000 Jev tokens because Jev rejects branches past about 33k (src/export/ttsr.ts:59-63).
9. **Write criteria literally, and avoid trigger words for one label inside the state.** Receipt: the vendor lists "literal reading" as failure mode 1 (jaggedness page), and a brief mentioning `judge()` was labelled `judge` at 0.98–0.99 (research/classifier-sample.md:66-67).
10. **Track cost from input tokens; OMP's own cost figure can read $0.** Receipt: the direct path reports `usage.cost.total` = 0 (judge-ask.ts:14-19). The M3 gate showed $0 for a real spend of $0.001013754 (migration/M3/gate/REPORT.md:91-94, via JevAccuracyDocs).
11. **Add a nonce when you need a fresh answer.** Receipt: OMP caches by (state, model, question), and a repeat call costs 0 and returns the cached level (score.ts:11-12).

**GUESS**
12. **Check for first-option bias in multi-option choices by reordering the options.** The vendor documents this bias (jaggedness page, "Choice option order"), but none of our data tests it. In kind-question.json the first option is `locate`, which Jev never picked in 1,151 routings, so this bias does not explain the lean toward change-large.

## Addendum 2026-10-14: Jev 1.14 release

Full digest (post text, all 5 images transcribed, docs for images/box/long context): /Users/jowolff/agent-scratch/agent-system-2.0/jev-profile/jev-1-14/JEV-1-14.md

Key points for the capability card:
- `jev-latest` moves from 1.13.0 to 1.14.0 about a week after 2026-10-14 (https://typesafe.ai/blog/jev-1-14). Every measurement in this profile is 1.13.0-only; call sites on `jev-latest` will change model silently.
- Vendor's own charts (flagged "don't trust them"): intelligence 60.0 (1.14.0) vs 58.9 (1.13.0); calibration error 1.6 vs 1.8; same cost.
- New dreamer-ready (not production) features: images on 1.13+1.14 (`TypeSafe-Danger-Zone-Images: true`), `box` type on 1.14 only, long context to 262k (`TypeSafe-Danger-Zone-Long-Context: true`, slower and less accurate). All untested by us.
