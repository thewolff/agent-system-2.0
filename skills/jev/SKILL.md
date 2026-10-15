---
name: jev
description: Jev capability card — what TypeSafe's typed-answer judge is good, weak and untested at, measured on jev-1.13.0. Read it before any Jev use — eval `judge()` / `judge_batch()`, a `typesafe/jev-*` model, OMP's `judge` model role, or writing or changing a classifier question or a Jev confidence threshold.
---

# jev — what Jev is good, weak and untested at

<!-- owned: agent-system 2.0, skill jev (workload wl-mv8s8swjr478qo). Built only from Plumb's measured Jev profile (2026-10-14), committed verbatim under research/jev-profile/; every figure on this card names its file and section heading there. -->

Every figure below points to its evidence in the agent-system 2.0 checkout under `research/jev-profile/`,
by file and section heading: `JEV-PROFILE.md § 3a` is the heading `3a. …` of that file;
`JEV-1-14.md` is `research/jev-profile/jev-1-14/JEV-1-14.md`. Check the cited section before you lean on
a number.

## Version — read this first

**Every measurement on this card is of `jev-1.13.0` only. None of it is evidence for `jev-1.14.0`.**

- Today `jev-latest` → `jev-1.13.0`. `jev-1.14.0` shipped 2026-10-14 as `jev-preview`, and `jev-latest`
  moves to 1.14.0 about 2026-10-21 ("in a week", https://typesafe.ai/blog/jev-1-14). Every call on
  `jev-latest` changes model then, silently, with no code change — OMP's default `judge` role included.
  (`JEV-PROFILE.md § Addendum 2026-10-14: Jev 1.14 release`; `JEV-1-14.md § 1`, `§ 3`)
- The vendor keeps 1.13.0 "for a while", with 60 days' notice before deprecation, and says to send the
  version ID, not the alias, once you have tuned thresholds against it. (`JEV-1-14.md § 1`, `§ 3`)
- Pin scope in as2, exactly: the profile pins `modelRoles.judge: typesafe/jev-1.13.0` with an empty
  fallback chain (`profile/config.yml`). **Only as2 slice routing refuses an answer from another model**
  (`classifier/extension.ts`, checked against `classifier/calibration.json`'s judge model). Open-time brief
  judging (`surface/extensions/workload.ts`) and pair `askChoices` (`classifier/src/judge-ask.ts`) take the
  answer from whatever the `judge` role resolves to and do not check the model.
- The vendor published 1.14 comparison charts under its own banner "Please don't trust them". Those numbers
  live in `JEV-1-14.md § 2`; they are the vendor's, not ours, and we have not measured them. Re-measure on
  1.14.0 before moving a pin or a threshold. (`JEV-1-14.md § 2`, `§ 4`)

## What Jev is, and is not

- TypeSafe's "System One" model: it evaluates a `state` and returns **typed answers and probabilities**.
  One endpoint, `POST https://api.typesafe.ai/v1/systemone`; question types `noul` (yes/no, returns
  P(yes)), `choice` (at most 255 options), `score` (2 to 10 levels).
- It writes no prose, no code, no reasons, and extracts nothing: "not a drop-in replacement for the LLM
  behind Claude Code … It does not generate text, write code, or hold a conversation."
- Confidence is not probability: for a choice it is (n·p_max − 1)/(n − 1), and calibration "does not
  guarantee that an individual answer is correct."
- Limits: 64k tokens per request, 32k per question. Strongest in English.
- OMP's `judge` role tries `typesafe/jev-latest`, then `openrouter/~typesafe/jev-latest`, then `@tiny`,
  `@smol`, `@default` — so without a pin and an empty fallback, a chat model can answer. Each attempt
  times out at 10 s; up to 3 attempts.

Docs: https://docs.typesafe.ai/concepts/system-one.md, https://docs.typesafe.ai/introduction/coding-agents.md,
https://docs.typesafe.ai/api, https://docs.typesafe.ai/models.md, https://docs.typesafe.ai/confidence.md,
https://docs.typesafe.ai/model-jaggedness/jev-1.13.md. (`JEV-PROFILE.md § 1. What Jev is`)

## Verdicts (jev-1.13.0)

### Good

| Task shape | Headline figure | Evidence |
|---|---|---|
| Picking one label from a fixed set of clearly different options | 23/30 (2026-09-23), then 21/30 (2026-09-28) on hand labels, against 15/30 for "always understand". Caveats: keyword capture gives misses at 0.98–1.00 confidence; the vendor documents a first-option bias | `JEV-PROFILE.md § 3a`, `§ 4` |
| Ranking statements by receipt risk (the veracity score read as a ranking) | AUROC 0.85–0.96 across offline rounds | `JEV-PROFILE.md § 3b`, `§ 4` |
| Ranking items against stated goals, atomic questions combined in code | Pairwise agreement 0.781, tau 0.562, against 0.44 / −0.12 for the baselines — **one snapshot, n=15, 2026-10-14; a second snapshot is pending**. Missed Jo's #1 in its top 3; on a later list an item Jo asked to prioritise ranked 21/24. **GUESS (inference from one incident)**: blind to goals nobody wrote down — not measured | `JEV-PROFILE.md § 3c`, `§ 4`; `evidence-rank-1710.md § Jev ranking evidence, 2026-10-14 17:05 PDT (Plumb)` |
| Repeatability on the same input | Kind changed on 1/32 briefs (M3 gate); veracity top pick agreed on 124/132 reruns, the flag on 130/132 | `JEV-PROFILE.md § 3a`, `§ 4` |

### Weak

| Task shape | Headline figure | Evidence |
|---|---|---|
| Sizing work as change-small vs change-large (the label) | 333/359 code routings labelled change-large (ledger, 2026-10-14), 160 of them at confidence 1.00; on Jo's briefs 6/11, below "always change-large" at 8/11. The probabilities are informative: hands with p(change-small) ≥ 0.1 ran 3.0 min at p50 against 7.7 min | `JEV-PROFILE.md § 3a`, `§ 4` |
| Veracity as a pass/fail gate | Live flag rate 90.7 % after the 2026-10-11 tune; hand-checked live precision 3/8; false-positive rate on supported items 25/44 at the live threshold. The authors' verdict: advisory, not gate | `JEV-PROFILE.md § 3b`, `§ 4` |
| Free-text writing rule: bad-news-first (2026-10-14) | 1/5 true positives: precision 0.50, recall 0.20 on 15 human labels; misses bad news behind a reassuring opener | `evidence-judge-corpus-1715.md § Jev as a free-text writing-rule judge: measured 2026-10-14 (JevJudge, Plumb hand)`; `evidence-model-judges-1720.md § bad-news-first` |
| Free-text writing rule: conclusion-first (2026-10-14) | Flagged all 3 human-confirmed false positives (0/3) — 3 labels, a separate denominator; never add it to the row above | `evidence-judge-corpus-1715.md § Jev as a free-text writing-rule judge: measured 2026-10-14 (JevJudge, Plumb hand)`; `evidence-model-judges-1720.md § conclusion-first` |
| Counting, arithmetic, comparing dates, generating text | **Vendor-documented, untested by us** | https://docs.typesafe.ai/model-jaggedness/jev-1.13.md; `JEV-PROFILE.md § 1`, `§ 4` |

Claude Haiku 5.5 and Sonnet 5.5 on the same writing-rule labels: no judge earns block.
(`evidence-model-judges-1720.md § Bottom line`)

### Untested

| Task shape | What exists | Evidence |
|---|---|---|
| Pair-mode `taste` / `ambiguous` yes/no signals | No labelled set; `taste` answered no on 109/110 briefs; the 0.70 cut is uncalibrated | `JEV-PROFILE.md § 3d`, `§ 4` |
| OMP `find` (semantic code search) | 2,289 calls, 4 timeouts, no accuracy data | `JEV-PROFILE.md § 2b`, `§ 4` |
| First-option bias in our own choice questions | Vendor-documented; none of our data tests it | `JEV-PROFILE.md § 5` (rule 12) |
| The needs-you sorter | Not measured | `JEV-PROFILE.md § Open items first` |
| Images (header `TypeSafe-Danger-Zone-Images: true`; 1.13 and 1.14) | Vendor-labelled dreamer-ready, not production; untested by us. The vendor's own models table still lists input as "Text" | `JEV-1-14.md § 1`, `§ 3` |
| The `box` question type (1.14 only, needs the images header) | Vendor-labelled dreamer-ready, not production; untested by us. Always returns a box — no "not found" answer | `JEV-1-14.md § 1`, `§ 3` |
| Long context to 262k (header `TypeSafe-Danger-Zone-Long-Context: true`; 1.13 and 1.14) | Vendor-labelled dreamer-ready, not production, "slower and less accurate"; untested by us. The stated limit stays 64k per request / 32k per question | `JEV-1-14.md § 1`, `§ 3` |

## Usage rules

From `JEV-PROFILE.md § 5. Usage rules`; each rule's receipt is there.

1. Use Jev for typed decisions over answers you define; send prose, reasons and extraction to a text model.
2. Read the probabilities, not just the top label, when the labels are unbalanced.
3. Read confidence as a group-level signal, never as a correctness check on one answer: misses sat at ≥ 0.87, and 0.70 confidence on a yes/no question means P ≈ 0.85.
4. Use the veracity score as advisory triage; keep it out of blocking gates.
5. Pin the version and refuse answers from any other model: the alias moves, and only the response-model check enforces a pin.
6. Re-measure whenever the question wording changes; `classifier/calibration.json` forbids a regenerated hash without a new sample.
7. Keep arithmetic, counting and date comparison in code; ask Jev for date parts as a choice.
8. Send only the state the question needs, and stay under 32k tokens per question.
9. Write criteria literally, and keep words that name one label out of the state.
10. Track cost from input tokens; OMP's own cost figure can read $0.
11. Add a nonce when you need a fresh answer: OMP caches by (state, model, question).
12. **GUESS** — check for first-option bias in multi-option choices by reordering the options (vendor-documented, untested by us).

## Cost and latency

- Cost: $0.042 per million input tokens, output free; about $0.00003 per routing call, median $0.0000682 per receipts-audit statement, median $0.0002055 per `find` call. (`JEV-PROFILE.md § 1`, `§ 3e`)
- Latency: p50 86 ms, p90 133 ms over 109 sequential pair-replay calls (concurrency never exercised); OMP's client allows 10 s × 3 attempts per call. (`JEV-PROFILE.md § 3e`, `§ 1`)
