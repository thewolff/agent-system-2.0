# Classifier sample — work-kind confidence on 30 real slice briefs

Written 2026-09-24T01:31:09.793062+00:00. Status: **complete** (30/30 classified, 0 errors). Output dir: `/Users/jowolff/agent-scratch/agent-system-2.0/classifier-sample/`.

## Needs you

**CLAIM**
Recommended low-confidence threshold: **0.55** (see § Threshold; the receipt is the sweep table, computed from `/Users/jowolff/agent-scratch/agent-system-2.0/classifier-sample/results.jsonl`). No spec edit made.

**GUESS**
Two of the seven disagreements sit at confidence 0.98–0.99 and no threshold catches them; both look like the brief's *vocabulary* misleading the classifier (one brief literally says "run one `judge()` call"; one says "start Phoenix … report whether OMP emits spans", which reads as observation). A threshold cannot fix those; a "does the brief change state?" hint in the instructions might. Not tested.

## Method

**ACTION**
Sources, in the order the brief named them. (1) First user message of every Plumb subagent transcript under `/Users/jowolff/.omp/agent/seat-sessions/plumb/*/*.jsonl` (29 hands across three sessions; the extraction is the `prompts` cell in this session's eval kernel — each row's `source` field in `briefs.jsonl` carries the absolute path and line). (2) The three Phase 5 prerequisite tests Plumb sent by `seat_message` at `/Users/jowolff/.omp/agent/seat-sessions/plumb/2026-09-23T23-46-38-534Z_01a0d0aa-0546-7000-91dd-fc66a43838ee.jsonl:53`, split into one brief each. (3) The ledger-lifecycle hand brief at `/Users/jowolff/agent-scratch/agent-system-2.0/ledger-lifecycle/BRIEF.md` (lines 1,12-27 as one brief; lines 38-39 as a second). (4) `ctx search --limit 20 -- "dispatch"` was run first (ctx-first gate); its hits were Newdle/orchestrator sessions and yielded no usable 2.0 brief. `briefs/*.md` and the decision-log "Heads-up" sections were read and found to duplicate the hand prompts already collected; not sampled separately.

**ACTION**
Trimming: prompts over 1500 chars were cut at the `# Acceptance` heading or the last line break before 1500 chars; nothing was rewritten. Boilerplate `Complete assignment thoroughly:` was dropped.

**ACTION**
Data-boundary exclusions (regex `shipyard/repos|newdle-|newdle\b|kitchen|data-pipelines`): `ReaderRuleTrace`, `ScoutClaudeHome`, `ScoutPlugins`, `LensOmpFloor` excluded — their text names Newdle plugin files or paths under `/Users/jowolff/code/shipyard/repos/`. "If in doubt, exclude" applied.

**CLAIM**
Hand labels were written to `briefs.jsonl` before any classifier call (file mtime precedes the first `judge_batch` job `jdgb-158b8f7d1395cceb`). Hand-label spread: {'understand': 15, 'locate': 4, 'judge': 4, 'change-small': 6, 'change-large': 1}. **change-large has one example** (the ledger-lifecycle build); the other hand briefs on this machine are research, reader, scout, and small-edit hands. No brief was invented.

**CLAIM**
Classifier: `judge_batch` from the eval kernel, one choice question, five criteria in the order locate / understand / change-small / change-large / judge with the spec definitions. Three batches of 10. Model reported by `b.status()`: `typesafe/jev-1.13.0` for all three. Cost by batch: $0.000319, $0.000351, $0.000296; total **$0.00097** for 30 briefs. Wall time per batch ≤0.4 s. Job ids: `jdgb-158b8f7d1395cceb`, `jdgb-158b8f819d15ccec`, `jdgb-158b8f81fc55cced`. The `cost` field on each `results.jsonl` row is the batch's cumulative `status().cost` at the moment that row drained, not a per-item cost.

## Confidence distribution (0.05 buckets)

**CLAIM**
From `results.jsonl`, `confidence` field (TypeSafe's own confidence; note it is not the top probability — e.g. `ProbeHaiku` has p(understand)=0.65 and confidence 0.56).

| bucket | n | histogram | agree | disagree |
|---|---|---|---|---|
| 0.40-0.45 | 4 | #### | 1 | 3 |
| 0.50-0.55 | 1 | # | 0 | 1 |
| 0.55-0.60 | 1 | # | 1 | 0 |
| 0.65-0.70 | 1 | # | 1 | 0 |
| 0.70-0.75 | 2 | ## | 2 | 0 |
| 0.75-0.80 | 1 | # | 1 | 0 |
| 0.80-0.85 | 1 | # | 0 | 1 |
| 0.85-0.90 | 1 | # | 1 | 0 |
| 0.90-0.95 | 5 | ##### | 5 | 0 |
| 0.95-1.00 | 13 | ############# | 11 | 2 |

Median confidence 0.93; 18 of 30 at ≥0.90; 5 of 30 below 0.55.

## Agreement

**CLAIM**
Hand label vs classifier choice: **23/30 agree = 76.7%**. Confusion (hand → choice): understand→understand 14, change-small→change-small 4, locate→locate 3, judge→judge 2; disagreements: judge→understand 2, change-small→understand 2, locate→understand 1, change-large→judge 1, understand→judge 1. The classifier's choices: understand 19, change-small 4, judge 4, locate 3, change-large 0.

## Every disagreement

**CLAIM**

| id | hand_label | choice | confidence | probabilities |
|---|---|---|---|---|
| T1CtxPiRoot | change-small | understand | 0.40 | understand 0.52, locate 0.32, change-small 0.11, judge 0.05 |
| LensAbolishedSeat | judge | understand | 0.42 | understand 0.54, judge 0.46 |
| LedgerThirdParty | judge | understand | 0.43 | understand 0.54, judge 0.45, change-small 0.01 |
| LedgerLifecycle | change-large | judge | 0.52 | judge 0.62, change-large 0.24, understand 0.13, change-small 0.01 |
| ScoutOmpHome | locate | understand | 0.82 | understand 0.85, locate 0.15 |
| T3TypeSafeJudge | understand | judge | 0.98 | judge 0.98, understand 0.02 |
| T2Phoenix | change-small | understand | 0.99 | understand 1.00 |

**GUESS**
Reading each: `T1CtxPiRoot` (run `ctx sources add`, report a search) — the classifier read "report" and called it understand; the hand label change-small is defensible but the brief is a test, and neither label is clearly right. `LensAbolishedSeat` and `LedgerThirdParty` — judge vs understand is the classifier's soft boundary: a comparison with a bottom line was read as research. `LedgerLifecycle` — the only change-large in the set; the classifier gave change-large 0.24 and judge 0.62 because the deliverable is a comparison table with "no recommendation". `ScoutOmpHome` (enumerate files, write rows) — read as understand at 0.82, the only high-ish-confidence miss that is plainly a locate. `T3TypeSafeJudge` — the text says `judge()`; keyword capture. `T2Phoenix` — "start Phoenix … report whether OMP emits spans" read as observation at 0.99; my change-small rests on the start-a-service step.

## Where disagreements cluster

**CLAIM**
Disagreement confidences: 0.40, 0.42, 0.43, 0.52, 0.82, 0.98, 0.99. Four of seven sit in 0.40–0.52. In the band below 0.55 there are 5 briefs and 4 are disagreements (80% error). In 0.55–0.85 there are 8 briefs and 1 disagreement (12.5%). At ≥0.85 there are 17 briefs and 2 disagreements (11.8%), both at ≥0.98 and both vocabulary-driven.

## Threshold sweep

**CLAIM**
Flag = confidence strictly below the threshold. Computed over `results.jsonl`.

| threshold | flagged (of 30) | disagreements caught | false flags | disagreements missed |
|---|---|---|---|---|
| 0.45 | 4 (13%) | 3/7 | 1 | ScoutOmpHome, LedgerLifecycle, T3TypeSafeJudge, T2Phoenix |
| 0.50 | 4 (13%) | 3/7 | 1 | ScoutOmpHome, LedgerLifecycle, T3TypeSafeJudge, T2Phoenix |
| 0.55 | 5 (17%) | 4/7 | 1 | ScoutOmpHome, T3TypeSafeJudge, T2Phoenix |
| 0.60 | 6 (20%) | 4/7 | 2 | ScoutOmpHome, T3TypeSafeJudge, T2Phoenix |
| 0.65 | 6 (20%) | 4/7 | 2 | ScoutOmpHome, T3TypeSafeJudge, T2Phoenix |
| 0.70 | 7 (23%) | 4/7 | 3 | ScoutOmpHome, T3TypeSafeJudge, T2Phoenix |
| 0.75 | 9 (30%) | 4/7 | 5 | ScoutOmpHome, T3TypeSafeJudge, T2Phoenix |
| 0.80 | 10 (33%) | 4/7 | 6 | ScoutOmpHome, T3TypeSafeJudge, T2Phoenix |
| 0.85 | 11 (37%) | 5/7 | 6 | T3TypeSafeJudge, T2Phoenix |
| 0.90 | 12 (40%) | 5/7 | 7 | T3TypeSafeJudge, T2Phoenix |

## Threshold

**CLAIM**
Recommended: **0.55**. Reasoning: it is the knee of the sweep — at 0.55 the classifier flags 5 of 30 briefs (17%), catches 4 of the 7 disagreements, and produces 1 false flag (the 0.42-confidence `LedgerCandidates`, a judge/understand tie the classifier resolved correctly). Raising the threshold to 0.85 flags 11 briefs (37%) to catch one more disagreement (`ScoutOmpHome` at 0.82); the two remaining misses at 0.98/0.99 are unreachable by any threshold. Lowering to 0.50 loses `LedgerLifecycle` (0.52), the only change-large in the sample, which is the kind the spec most needs routed correctly.

**GUESS**
n=30 with one change-large and four judge examples is thin for the judge/understand and change-large boundaries — the two boundaries where all the low-confidence disagreements live. The 0.55 number is a measured knee on this sample, not a calibrated estimate; a second sample of 30 drawn from hands that *build* things (none exist yet on this machine for 2.0) would move the change-large row and might move the knee.

## Files

- `/Users/jowolff/agent-scratch/agent-system-2.0/classifier-sample/briefs.jsonl` — 30 rows (id, source, text, hand_label)
- `/Users/jowolff/agent-scratch/agent-system-2.0/classifier-sample/results.jsonl` — 30 rows (id, hand_label, choice, confidence, probabilities, cost, model)
- `/Users/jowolff/agent-scratch/agent-system-2.0/classifier-sample/PROGRESS.md` — last written after batch 3
- `/Users/jowolff/agent-scratch/agent-system-2.0/classifier-sample/REPORT.md` — this file

## § Re-measurement 2026-09-28

Written 2026-09-28 by the `Recalibrate` research hand (Jo: *"Re-measure now"*). Status: **complete** (32/32 classified, 0 errors). The 09-23 sections above are unchanged and describe the superseded question. Output dir: `/Users/jowolff/agent-scratch/agent-system-2.0/migration/M3/recalibrate/` (`results.jsonl`, `briefs-additions.jsonl`, `analysis.txt`, `REPORT.md`).

### Method

**CLAIM**
Question under measurement: the live `classifier/kind-question.json`, the S1-corrected text (change-small = single file with a mechanical check; change-large = more than one file, or no mechanical check; SPEC-2.0.md:37-38). Identity as `classify.ts` computes it (`questionSha256`, sha256 of canonical JSON): `5a72c35cf68f238f5bca23065dbb5e244afecd76a10cc6283a81e44578c16550`. The 09-23 question was `47616267…`. Recorded byte-for-byte as `classifier/test/fixtures/kind-question-2026-09-28.json`.

**CLAIM**
Briefs: the same 30 as 09-23 with their 09-23 hand labels, unchanged (text and label match `classifier/test/fixtures/classifier-sample-30.jsonl` 30/30), plus two **additions** from the M3 review's S1 finding, labelled before any call: `AddTwoFileMechanical` (rename a constant across `route.ts` and its test; `bun test` checks it) and `AddOneFileUncheckable` (rewrite a tier file's opening paragraph; nothing checks it). Both hand-labelled **change-large** per SPEC-2.0.md:37-38.

**ACTION**
Classifier: OMP's `judge_batch`, driven host-side because the measuring hand had no eval tool — `runEvalJudgmentBatch` in `@oh-my-pi/pi-coding-agent/src/eval/judgment-batch-bridge.ts` (OMP 18.3.0), whose items call `judge.judge({ state, questions })`, the same request `classify.ts` makes. `questions` = the question file's object (one choice question `kind`, criteria in the order locate / understand / change-small / change-large / judge); `state` = the brief text. Profile `agent-system-2`, judge role set to `typesafe/jev-1.13.0`. Three batches of ten plus one of two, per-item rows appended to disk as they drained, 20-minute cap. Runner: `…/recalibrate/run-batch.ts`.

**CLAIM**
Every answer reports model `typesafe/jev-1.13.0` (the runner cancels a batch on any other). Jobs and bridge-reported cost: `jdgb-1591e526c4f2a16e` $0.000317394, `jdgb-1591e52f260de9ed` $0.000349566, `jdgb-1591e5335dd44050` $0.000294588, `jdgb-1591e5379ece2b1a` (additions) $0.000052206; total **$0.001014** for 32 judgments (4 judge_batch runs, 0 failed items, so 0 retries). Wall time ≤0.2 s per batch. All 32 answers pass `classify()`'s answer checks and `route()`.

**CLAIM**
The judge role's `typesafe/jev-1.13.0` pin does not resolve in OMP's catalog: the resolved chain is `typesafe/jev-latest` (explicit=false), because the `typesafe` catalog holds only `jev-latest` and `jev-preview`. The versioned model is enforced by the response, not the request.

**CITE**
https://docs.typesafe.ai/models.md (fetched 2026-09-28): "`jev-latest` | `jev-1.13.0`"; "The response's `model` field reports the versioned ID that answered". The extension's check that the answering model is the calibrated one (`classifier/extension.ts`, the `S4` comment in the `tool_call` handler) is therefore the pin that holds.

### Agreement

**CLAIM**
Hand label vs choice: **21/30 = 70.0%** on the original thirty; **2/2** on the additions; **23/32 = 71.9%** overall. Confusion on the thirty (hand → choice): understand→understand 13, locate→locate 3, judge→judge 3, change-small→change-small 2; misses: change-small→change-large 2, change-small→understand 2, understand→change-large 1, understand→judge 1, judge→understand 1, locate→understand 1, change-large→judge 1. Choices on the thirty: understand 17, judge 5, change-large 3, locate 3, change-small 2 (09-23: change-large 0).

### Every disagreement

**CLAIM**

| id | hand_label | choice | confidence | probabilities |
|---|---|---|---|---|
| ResearchSelfImprove | understand | change-large | 0.38 | change-large 0.51, understand 0.47, change-small 0.02 |
| LensAbolishedSeat | judge | understand | 0.51 | understand 0.60, judge 0.29, change-large 0.10, change-small 0.01 |
| LedgerLifecycle | change-large | judge | 0.55 | judge 0.64, change-large 0.29, understand 0.05, change-small 0.02 |
| T1CtxPiRoot | change-small | understand | 0.65 | understand 0.72, locate 0.14, change-small 0.07, judge 0.06, change-large 0.01 |
| ScoutOmpHome | locate | understand | 0.87 | understand 0.90, locate 0.07, change-large 0.03 |
| T3TypeSafeJudge | understand | judge | 0.99 | judge 0.99, understand 0.01 |
| XlabFixes | change-small | change-large | 0.99 | change-large 0.99, change-small 0.01 |
| VocabReword | change-small | change-large | 1.00 | change-large 1.00 |
| T2Phoenix | change-small | understand | 1.00 | understand 1.00 |

The additions agree: `AddOneFileUncheckable` change-large 0.96 (change-large 0.97, change-small 0.03); `AddTwoFileMechanical` change-large 0.73 (change-large 0.79, change-small 0.21).

**CLAIM**
`VocabReword` and `XlabFixes` each edit two files (`PREFERENCES.md` and `REQUIREMENTS.md`; their brief text names both), which SPEC-2.0.md:37-38 rules change-large. The 09-23 hand labels, kept unchanged here, call them change-small.

**GUESS**
Those two labels followed the 09-23 question's "a handful of files" wording, so these two "misses" are the corrected question applying the ruled taxonomy. Relabelled per the SPEC (not done — the brief keeps the labels) the thirty would read 23/30 for 09-28 and 21/30 for 09-23. The threshold is unaffected: both sit at 0.99–1.00, above every threshold swept.

**GUESS**
`ResearchSelfImprove` ("Write `research/phase4/research-G-self-improvement.md`") flipped to change-large because the new change-large criterion says "write anything that no test or diff can mechanically check", and a research brief writes a report file no test checks; understand's "without writing to it" does not carve that out. Change-large mass on the 15 hand-understand briefs went from mean 0.000 to 0.065 (ResearchSelfImprove 0.51, TypeSafeTerms 0.29). A criterion edit would need another sample; not tested.

### Confidence distribution (0.05 buckets, original thirty)

**CLAIM**

| bucket | n | histogram | agree | disagree |
|---|---|---|---|---|
| 0.20-0.25 | 1 | # | 1 | 0 |
| 0.30-0.35 | 1 | # | 1 | 0 |
| 0.35-0.40 | 2 | ## | 1 | 1 |
| 0.45-0.50 | 1 | # | 1 | 0 |
| 0.50-0.55 | 2 | ## | 1 | 1 |
| 0.55-0.60 | 1 | # | 0 | 1 |
| 0.60-0.65 | 2 | ## | 2 | 0 |
| 0.65-0.70 | 2 | ## | 1 | 1 |
| 0.75-0.80 | 1 | # | 1 | 0 |
| 0.85-0.90 | 3 | ### | 2 | 1 |
| 0.90-0.95 | 2 | ## | 2 | 0 |
| 0.95-1.00 | 12 | ############ | 8 | 4 |

Median 0.87 (09-23: 0.93); 14 of 30 at ≥0.90 (09-23: 18); 7 of 30 below 0.55 (09-23: 5). With the additions (0.73, 0.96): 0.70-0.75 and 0.95-1.00 gain one each.

### Threshold sweep

**CLAIM**
Flag = confidence strictly below the threshold, over the original thirty, same columns as 09-23. The rightmost column is new: briefs whose routed tier (higher-of-top-two when flagged, `route()` rules, no stakes cap) sits below the tier of their hand label.

| threshold | flagged (of 30) | disagreements caught | false flags | disagreements missed | under-served |
|---|---|---|---|---|---|
| 0.45 | 4 (13%) | 1/9 | 3 | LensAbolishedSeat, VocabReword, ScoutOmpHome, LedgerLifecycle, T2Phoenix, T3TypeSafeJudge, T1CtxPiRoot, XlabFixes | 1 (LensAbolishedSeat) |
| 0.50 | 5 (17%) | 1/9 | 4 | LensAbolishedSeat, VocabReword, ScoutOmpHome, LedgerLifecycle, T2Phoenix, T3TypeSafeJudge, T1CtxPiRoot, XlabFixes | 1 (LensAbolishedSeat) |
| 0.55 | 7 (23%) | 2/9 | 5 | VocabReword, ScoutOmpHome, LedgerLifecycle, T2Phoenix, T3TypeSafeJudge, T1CtxPiRoot, XlabFixes | 0 |
| 0.60 | 8 (27%) | 3/9 | 5 | VocabReword, ScoutOmpHome, T2Phoenix, T3TypeSafeJudge, T1CtxPiRoot, XlabFixes | 0 |
| 0.65 | 10 (33%) | 3/9 | 7 | VocabReword, ScoutOmpHome, T2Phoenix, T3TypeSafeJudge, T1CtxPiRoot, XlabFixes | 0 |
| 0.70 | 12 (40%) | 4/9 | 8 | VocabReword, ScoutOmpHome, T2Phoenix, T3TypeSafeJudge, XlabFixes | 0 |
| 0.75 | 12 (40%) | 4/9 | 8 | VocabReword, ScoutOmpHome, T2Phoenix, T3TypeSafeJudge, XlabFixes | 0 |
| 0.80 | 13 (43%) | 4/9 | 9 | VocabReword, ScoutOmpHome, T2Phoenix, T3TypeSafeJudge, XlabFixes | 0 |
| 0.85 | 13 (43%) | 4/9 | 9 | VocabReword, ScoutOmpHome, T2Phoenix, T3TypeSafeJudge, XlabFixes | 0 |
| 0.90 | 16 (53%) | 5/9 | 11 | VocabReword, T2Phoenix, T3TypeSafeJudge, XlabFixes | 0 |

**CLAIM**
With the two additions the flag counts are identical up to 0.70 (neither is below 0.73) and one higher from 0.75; the disagreement set is the same nine. On the 09-23 question the under-served column is 0 at every threshold.

### Threshold

**CLAIM**
Recommended: **0.55 — it still holds.** It is the lowest threshold with no under-served brief: at 0.50, `LensAbolishedSeat` (hand judge, read understand at 0.51) routes to standard instead of deep. By the 09-23 count criterion alone the knee is 0.60 (+1 flag for +1 catch from 0.55; every later catch costs 2 or more flags), but the one catch it adds is `LedgerLifecycle` at exactly 0.55, which routes to deep with or without the flag (choice judge; top two judge / change-large). Routed tiers at 0.55 and 0.60 are identical on all 32 briefs (`tiers-diff.ts`: 0 differences), so the sample cannot tell them apart and 0.55 needs no code or spec number change.

**CLAIM**
The corrected question makes the flag less precise: at 0.55, 5 of 7 flags are false (09-23: 1 of 5), and over-served briefs (routed above the hand label's tier) rise from 3 to 10 of 30. The new false flags are correct answers at lower confidence: `ScoutSkills` locate 0.72→0.24 and `ScoutSeatHomes` 0.71→0.50 (both pulled fast→strong), `Phase5Agenda` change-small 0.68→0.33 and `ExtSqliteTest` 0.78→0.45 (both standard→strong), `LedgerThirdParty` judge 0.36.

**GUESS**
The cost of that is more strong-tier spawns for locate and single-file work, not wrong work; production B9 briefs name their files and checks explicitly, so the locate/change-small confidence drop may not carry over. n=30+2 with three change-large and four judge labels is still thin; the P-16 month-one re-measure from ledger pull-ups stands.

### Paired comparison, same thirty briefs

**CLAIM**

| measure (30 briefs, hand labels unchanged) | 09-23 question `47616267…` | 09-28 question `5a72c35c…` |
|---|---|---|
| agreement | 23/30 (76.7%) | 21/30 (70.0%) |
| paired: both agree / 09-23 only / 09-28 only / neither | 20 / 3 / 1 / 6 | (same pairs) |
| same choice on both | 26/30 | 26/30 |
| median confidence; ≥0.90; <0.55 | 0.93; 18; 5 | 0.87; 14; 7 |
| change-large chosen | 0 | 3 |
| flagged at 0.55 / of them disagreements / false flags | 5 / 4 / 1 | 7 / 2 / 5 |
| under-served at 0.55 / over-served at 0.55 | 0 / 3 | 0 / 10 |
| cost (30 briefs) | $0.000966 | $0.000962 |

**CLAIM**
The four briefs whose choice changed: `ResearchSelfImprove` understand 0.93 → change-large 0.38, `VocabReword` change-small 0.98 → change-large 1.00, `XlabFixes` change-small 1.00 → change-large 0.99 (these three agree only on 09-23), `LedgerThirdParty` understand 0.43 → judge 0.36 (agrees only on 09-28). The six missed by both: `LensAbolishedSeat`, `ScoutOmpHome`, `LedgerLifecycle`, `T1CtxPiRoot`, `T2Phoenix`, `T3TypeSafeJudge` — the two vocabulary-driven misses at 0.98–1.00 are unchanged, as the 09-23 section predicted a threshold could not fix them.

### Files

- `classifier/test/fixtures/kind-question-2026-09-28.json` — the measured question, byte-for-byte
- `classifier/test/fixtures/classifier-sample-2026-09-28.jsonl` — 32 recorded rows (meta line carries the question sha256 and job ids); the offline replay (`classifier/test/replay.test.ts`) answers from it
- `classifier/calibration.json` — now names this question, judge, and sample; the 09-23 record is kept under `superseded`
- `/Users/jowolff/agent-scratch/agent-system-2.0/migration/M3/recalibrate/results.jsonl` — 32 raw rows as drained (job, batch, cumulative batch cost, model, raw answer)

## § Re-measurement 2026-10-20

Written 2026-10-20 by hand `sl-rs-docs` of workload `wl-mvg2ntsbcm6fwg` (right-size build hands; plan approved by Jo). Status: **complete**, with one shortfall Jo accepted (§ Held-out). The 09-23 and 09-28 sections above are unchanged and describe superseded questions. Plan directory: `/Users/jowolff/agent-scratch/agent-system-2.0/wl-mvg2ntsbcm6fwg/` (`PLAN.md`, `DEFINE.md`, `HELDOUT-A-v3.md`, `HELDOUT-B-v4f3.md`, `OPEN-IMPACT.md`, `audit-briefs.jsonl`, `HOLDOUT-A.jsonl`, `HOLDOUT-B.jsonl`, `probe-2026-10-20.json`).

### Why

**CLAIM**
The 09-28 question keyed the two change kinds on file count and a mechanical check: change-small "write to a single file, where a test or a diff mechanically checks the result", change-large "write to more than one file, or write anything that no test or diff can mechanically check". Every multi-file write and every prose write therefore went to change-large and the strong tier. The hand-size audit of 2026-10-19 (`/Users/jowolff/code/agent-system-2.0/.tmp/hand-size-audit.md`, § Sample) read 20 of that day's change-large hands and found 8 firm over-sizes (6 docs-only slices whose text a plan dictated, rows 1 5 9 13 16 20; 2 smoke runs that write no repository file, rows 10 17), 3 soft (rows 3 11 14: one function to an exact spec, tests only for fully specified behaviour, a mechanical mirror of an existing word) and 9 correct (rows 2 4 6 7 8 12 15 18 19).

**GUESS**
The audit's over/correct calls are its author's reading of difficulty from the brief text; it did not run any brief on the standard tier (the audit's own note under its table). The labels below inherit that.

### Method

**CLAIM**
Question under measurement: the new `classifier/kind-question.json`, text "v4f3" (instructions and keys unchanged; only the five criteria strings differ). Identity as `classify.ts` computes it (`questionSha256`, sha256 of canonical JSON): `2c0d088658c5318797d72b0a71f0011fa3694f688cc094c206ee9493b37d3f89`; the file's own sha256 is `5b74aa66f35fc25e2b3fb1b408cbb1637a05a3cc251a8e7334592e8c57e96e83`. The 09-28 question was `5a72c35c…`.

**ACTION**
Classifier: OMP's `judge_batch` from the eval tool, live on `typesafe/jev-1.13.0`, one batch per candidate text, `questions` = the question file's object with only `criteria` replaced, `state` = the brief text. Routing reimplements `classifier/src/route.ts`: the kind's tier, the 0.55 inclusive pull-up to the higher tier of the two most probable kinds, then the stakes cap of each brief's routing row. Every batch reported cost 0 and 0 failed items (`DEFINE.md`, round 1 four batches, round 2 fifteen).

**CLAIM**
Briefs: (1) the audit's 20, each the hand's dispatched `task` text, its first user message minus OMP's `Complete assignment thoroughly:\n\n` prefix (`audit-briefs.jsonl`); (2) the 32 rows of the 09-28 sample with their 09-28 labels, except `AddTwoFileMechanical` (a constant renamed in `route.ts` and its test) and `AddOneFileUncheckable` (a tier file's opening paragraph rewritten), both relabelled change-small before any draw; (3) two held-out sets drawn from change-large routings outside the audit's 20 and labelled blind by a separate hand from the brief text only, before any answer under a new text existed (`PLAN.md` § 3, sl-rs-holdout): `over` (standard would do) or `correct` (strong needed). Set A has 20 briefs (14 correct, 6 over), set B 10 (7 correct, 3 over), no brief in both. The audit 20 take the label the audit implies: firm docs and soft → change-small, firm smoke → understand, correct → change-large.

**CLAIM**
Fidelity: the 09-28 question, re-judged live on the audit corpus, answered change-large on all 20, matching the 20 ledger routing rows within 0.05 confidence (`PLAN.md` § 2). The plan's first review matched all 20 corpus texts to the lanes' original `task` tool arguments. Three held-out texts end with a paragraph beginning "Findings block (agent-system 2.0 review round limit)" that `classifier/extension.ts` appends after `classify()`; it was cut before judging, so the judged text is the text the classifier saw.

**CLAIM**
Bars per draw (`DEFINE.md` § Bars): the 8 firm route standard or lower with their stakes; the 6 docs rows answer change-small and the 2 smoke rows understand or locate; the 9 correct route strong; on the 32 no brief routes below its label's tier, `ReaderLoadTrace`, `ScoutSeatHomes` and `ScoutSkills` answer locate, and `AddTwoFileMechanical` answers change-small and routes standard. Held-out: every `correct` brief routes strong (R12), and at least two thirds of the `over` briefs route standard or lower (R14).

### Criteria, old → new

**CLAIM**
What each criterion now says, against the 09-28 text:

- **locate** — was "find where something is"; now also "list what exists", and names an inventory table written to a report file as a locate deliverable.
- **understand** — still "read and report on a surface without writing to it"; now says a smoke run or check that executes things but writes no repository file, only scratch files or its report, is understand.
- **change-small** — was one file plus a mechanical check. Now keyed on whether the brief already specifies the change, so the worker carries it out rather than works it out: a rename or contained edit to one module and its own tests; a new self-contained pure function nothing calls yet, in its own new file, whose signature and rules the brief or a named plan spells out, plus its own test file; a mechanical mirror of an existing pattern; or a docs-only edit to any number of prose files whose content the brief or a named plan dictates.
- **change-large** — was more than one file, or anything no test or diff checks. Now keyed on code whose design or correctness the worker must work out, even when the brief lists the steps: new behaviour across several source modules or a new module existing modules call or render; a shared format or schema and every reader of it; tests that fix an interface others build to; a new committed end-to-end test file that boots real installed programs; deciding case by case what tests should prove; or any fix to concurrency, timing (time windows, clocks, timeouts, retries), process handling, security or authority enforcement, performance, or replay and identity logic, however few files it touches.
- **judge** — now also names a report that critiques a document, design or decision for what it breaks, contradicts or leaves undefined.

### Texts tried

**CLAIM**
Round 1 (`DEFINE.md`): probe draft v2 failed (`ScoutSkills` drifted to understand 0.41; `LensAbolishedSeat`, labelled judge, answered understand 0.76 and routed standard). v3 passed every tuning bar on three draws, then failed held-out set A: R12 14/14, R14 3/6 against a bar of 4/6 (`HELDOUT-A-v3.md`; misses `sl-kimi-parse` change-large 0.57, `sl-queue-surface` change-large 0.47, `sl-fd-check` change-large 0.82). Set A became tuning data under the plan's rule, and the held-out bars moved to sealed set B. Round 2 tried twelve texts (v4a–v4g2) changing only change-small and change-large; seven passed both the tuning bars and set A. v4f3 was chosen as the only one, besides v4g1, on which every audit correct row answers change-large above 0.55, and over v4g1 for its wider margins and shorter change-small (`DEFINE.md` § Choice of v4f3).

### Results

**CLAIM**
Audit 20 under v4f3 (`DEFINE.md`, v4f3 draw 1 `jdgb-15ad2062e4bda035`): 8/8 firm route standard (the 6 docs rows answer change-small, the 2 smoke rows understand); 9/9 correct route strong, each answering change-large above 0.55 (lowest 0.61, rows 2 and 15); 3/3 soft route standard.

**CLAIM**
The 32 against their labels (the 09-28 labels, two additions relabelled change-small): **27/32** agree. The five misses: `ReaderAuthorityDiff` understand → judge 0.31, `T3TypeSafeJudge` understand → judge 0.81, `T1CtxPiRoot` change-small → understand 0.92, `T2Phoenix` change-small → understand 1.00, `ExtSqliteTest` change-small → understand 0.71. Choices: understand 16, judge 6, change-small 5, locate 4, change-large 1. At 0.55 inclusive, 4 are flagged low-confidence (`ReaderAuthorityDiff`, `Phase5Agenda` change-small 0.33, `LedgerThirdParty` judge 0.42, `LedgerLifecycle` change-large 0.39); only `LedgerLifecycle` is pulled up, strong → deep (`route()` sets `pullUp` only when the tier changes); none routes below its label's tier, and 3 route above it (`ReaderAuthorityDiff` and `T3TypeSafeJudge` to deep, `LedgerLifecycle` to deep). Computed from the v4f3 table in `DEFINE.md`. v4f3 changes no choice on the audit 20 or the 32 relative to v3.

**CLAIM**
Held-out set A under v4f3 (tuning data by then): R12 14/14, R14 4/6. Sealed set B, opened only after v4f3 was frozen (`HELDOUT-B-v4f3.md`, batch `jdgb-15ad2108e53da03a`): R12 **7/7** correct route strong; R14 **0/3** over route standard, against a bar of 2/3. The three misses are dictated code-plus-own-test briefs that still route strong: `sl-kimi-tests` change-large 0.59 (a read-only audit plus one parser test file, every assertion dictated), `sl-byhand-context` change-large 0.70 (a launcher argv/env change the plan dictates, plus its own test file), `sl-queue-fix-r1` change-large 0.91 (a review fix whose design the brief dictates). v3 on set B, for comparison only, routes the same three strong.

**CLAIM**
Jo accepted this shortfall on 2026-10-20 (question `q-mvg42w7vgege0w`): on set B, 0 of 3 `over` briefs reach standard, and all 7 `correct` stay strong.

**GUESS**
Getting those briefs to standard pulls correct briefs down with them: the round-2 change-small clauses aimed at them (red tests, one function, docs alongside a small code change) flipped correct set-A briefs to standard (`DEFINE.md` § Set-A label notes). No wording tried reached 5 of set A's 6 `over` briefs while keeping every audit correct row above 0.55.

### Threshold

**CLAIM**
Not re-swept: every bar was measured at 0.55 inclusive, the value `route.ts` uses, and at that value no brief on the 32, the audit 20 or either held-out set routes below its label's tier. The threshold stays 0.55.

### Jev determinism

**CLAIM**
Repeat draws of the same text returned identical answers on every row, every time: v3 draws 2–4, v4f3 draws 1–3, and the three v3 draws on set A, where draws 2 and 3 added trailing whitespace to defeat TypeSafe's cache (`DEFINE.md` § Draws; `HELDOUT-A-v3.md`). The plan's "three consecutive draws" therefore measures no draw-to-draw variance; one draw is the measurement.

### Workload-open impact

**CLAIM**
The same question judges workload briefs at open (`surface/extensions/workload.ts`, `classify(brief, …, loadKindQuestion())`): at normal stakes plan-first is skipped only for change-small ≥ 0.9, and the ×3 ceiling follows change-large > 0.55. `OPEN-IMPACT.md` replayed the stored `workloads.brief` of the 124 normal and throwaway workloads opened since 2026-10-05 (109 normal, 15 throwaway) under the 09-28 and the new question, one draw each (batches `jdgb-15ad216455bda042`, `jdgb-15ad21645b3da043`). Plan-first: 104 → 102, two normal workloads newly skip it (`wl-mv669tp6yous5c` change-small 0.46 → 1.00; `wl-mvbjieaki04kcg` change-large 0.60 → change-small 0.97); none newly plans. ×3 ceiling: 62 → 45 (29 lose it, 12 gain it). 42 workloads flip at least one of the two, all at normal stakes.

**CLAIM**
Jo answered **keep** for the two plan-first flips (question `q-mvg45v0ez6f1mo`).

**CLAIM**
The replay is not a replay of recorded open decisions: of the workloads with a parseable recorded `brief-judged:` entry, 57 differ from the 09-28 question's answer today (4 in kind, 53 in confidence only) (`OPEN-IMPACT.md` § Fidelity check).

**GUESS**
Those differences most likely come from whichever question text was live at each open rather than from judge noise, given the determinism above; `OPEN-IMPACT.md` did not test it.

### Files

- `classifier/test/fixtures/kind-question-2026-10-20.json` — the measured question, byte-for-byte
- `classifier/test/fixtures/classifier-sample-2026-10-20.jsonl` — 82 recorded rows from one batch, `jdgb-15ad234df0d18da7` (meta line carries the question sha256, the file sha256, judge model and batch id): the 32, the audit 20 with their audit class, routing id and stakes, and held-out sets A (20) and B (10) with their blind labels; the offline replay (`classifier/test/replay.test.ts`) answers from it
- `classifier/calibration.json` — now names this question, judge and sample; the 09-28 record moves under `superseded`
- `/Users/jowolff/agent-scratch/agent-system-2.0/wl-mvg2ntsbcm6fwg/DEFINE.md`, `HELDOUT-A-v3.md`, `HELDOUT-B-v4f3.md`, `OPEN-IMPACT.md` — every text tried, per-draw tables, batch ids
