<!-- Copied verbatim from /Users/jowolff/agent-scratch/agent-system-2.0/jev-profile/evidence-model-judges-1720.md, captured 2026-10-14 (Plumb). -->
# Evidence: Claude-model judges vs Jev vs codex on i-have-audhd's judge-gated rules

Measured 2026-10-14 by JevJudge. Every number here comes from files in
`/Users/jowolff/agent-scratch/jo-wolff-plugins/monitor/model-judge-run/` (Haiku and Sonnet),
`/Users/jowolff/agent-scratch/jo-wolff-plugins/monitor/jev-corpus-run/results.jsonl` (Jev), and
`/Users/jowolff/agent-scratch/orchestrator/communication-rules-fp/` (the corpus, the codex verdicts from
2026-09-21, and the human labels). These directories are mode 0700 because they hold real message bodies.

## Bottom line

**CLAIM**
No judge earns block. On the 15 human-labelled bad-news-first messages, Haiku 5.5 caught the most real
violations (3 of 5) and also raised the most false alarms (4 of 10). Sonnet 5.5 caught 2 of 5 with 1 false
alarm. Jev caught 1 of 5 with 1 false alarm. Conclusion-first has only 3 human labels, all of them
non-violations, so it cannot rank anything.

**GUESS**
These gaps come down to one or two messages each, so the ranking is not settled. For warn-only signal
collection, Haiku 5.5 is the defensible pick: it is the cheapest of the three at about $0.0002 per call,
it is the only one that caught the "nothing broke" impersonation hole (c0224), and it writes a real reason
sentence that a person can adjudicate later.

## Method

**CLAIM**
- Messages: the codex 50-message fixed-seed sample (`judge-results.json` → `sample`, mulberry32 seed
  20260921). It contains every message that the 18 human judge-rule labels cover
  (`adjudications.json` → `judge-rules`).
- Gating: the installed plugin's own master floor (200) and triggers. They fired 46 times for
  conclusion-first and 29 times for bad-news-first, the same counts the 2026-09-21 codex run recorded.
- Dispatch: the plugin's `askJudge`. Each model has its own scratch `stateDir`, because the verdict cache
  is keyed on rule + text and not on the command.
- Prompt: the plugin's own prompt, unchanged.
- Repeats: one run per judge.

**CLAIM**
The model wrapper is `/Users/jowolff/agent-scratch/jo-wolff-plugins/monitor/model-judge.ts <provider/model>`.
It sends the plugin's prompt unchanged as the only user message, with no system prompt, no tools, and
reasoning disabled. The reply goes to stdout unchanged, and `parseVerdict` takes the last JSON object from
it. The credential comes from the `agent-system-2` OMP profile.

**CLAIM**
`omp -p` was tried first and could not be used. Even with
`--no-tools --no-extensions --no-skills --no-rules --system-prompt …`, OMP still attached 261 MCP tool
schemas and the project-context block. The request came to 233,538 tokens, and Haiku rejected it with
HTTP 400 `prompt is too long: 233538 tokens > 200000 maximum`. Raw request:
`/Users/jowolff/.omp/logs/http-400-requests/1792022758034-3b469q8daw099.json` (tools 698,432 chars,
system 54,510 chars).

**CLAIM**
Model choice:
- `claude-3-haiku-20240307` returned 404 `not_found_error`.
- Among the Haiku models that answered, `claude-haiku-5-5` was cheapest per token: $0.10/M input and
  $0.50/M output, against $1/M and $5/M for `claude-haiku-4-5`, measured from each call's `usage.cost`.
- `claude-sonnet-5-5` is the Sonnet-class model in Jo's standard chain
  (`/Users/jowolff/.omp/profiles/agent-system-2/agent/config.yml:178`).

**CLAIM**
A wrapper defect was found and fixed during the run, and the first Haiku run was discarded.
- At `maxTokens: 400`, 29 of 75 Haiku 5.5 calls stopped on `length`. The visible JSON was cut off or empty,
  because Haiku 5.5 spends output tokens on reasoning even with reasoning disabled. Its catalog thinking
  levels start at `low`.
- The result was 29 `judge-unparseable` verdicts out of 75.
- The cap was raised to 4,000 and Haiku was re-run: 75 of 75 calls returned `stop` and 0 were unparseable.
- The cap-400 files are kept as `*.cap400.jsonl`.
- Sonnet's largest output was 108 tokens, so the cap never affected it, and it was not re-run.

## Results

### conclusion-first (46 triggered; 3 human labels, all FP = not a violation)

| Judge | Flagged | vs human (TP/FP/FN/TN) | Agrees with codex | Median ms* | Unparseable |
|---|---|---|---|---|---|
| Jev 1.13.0 (choice) | 7 | 0 / 3 / 0 / 0 | 42/46 | 1128 | 0 |
| Haiku 5.5 | 1 | 0 / 1 / 0 / 2 | 44/46 | 2710 | 0 |
| Sonnet 5.5 | 2 | 0 / 2 / 0 / 1 | 45/46 | 2451 | 0 |
| codex (2026-09-21) | 3 | 0 / 3 / 0 / 0 | — | 10348 | 0 |

**CLAIM**
Per-message verdicts on the labelled messages (V = flagged, - = cleared):
- c0095 FP: every judge flagged it.
- c0148 FP: Jev V, Haiku -, Sonnet -, codex V.
- c0285 FP: Jev V, Haiku -, Sonnet V, codex V.

**GUESS**
n=3, and there are no positive labels, so precision, recall and any ranking are uncallable. The one
consistent signal is that every judge flags c0095, which is a receipt-first `ACTION` opener that the human
called compliant.

### bad-news-first (29 triggered; 15 human labels: 5 TP, 10 FP)

| Judge | Flagged | vs human (TP/FP/FN/TN) | Precision | Recall | Agrees with codex | Median ms* | Unparseable |
|---|---|---|---|---|---|---|---|
| Jev 1.13.0 (choice) | 2 | 1 / 1 / 4 / 9 | 0.50 | 0.20 | 16/29 | 1083 | 0 |
| Haiku 5.5 | 9 | 3 / 4 / 2 / 6 | 0.43 | 0.60 | 19/29 | 4132 | 0 |
| Sonnet 5.5 | 5 | 2 / 1 / 3 / 9 | 0.67 | 0.40 | 15/29 | 2493 | 0 |
| codex (2026-09-21) | 15 | 5 / 10 / 0 / 0 | 0.33 | 1.00† | — | 12002 | 0 |

**CLAIM**
Verdicts on the 5 real violations (TP):
- c0053: every judge flagged it.
- c0055 (production anomaly behind "nothing is broken"): only codex flagged it.
- c0117 (auth-droplet risk behind "Nothing needs you"): only codex flagged it.
- c0224 (impersonation hole behind "Nothing broke"): Haiku and codex flagged it.
- c0296 (provenance commit not landed): Haiku, Sonnet and codex flagged it.

**CLAIM**
Verdicts on the 10 false alarms (FP):
- Haiku flagged c0014, c0044, c0095 and c0099.
- Sonnet flagged c0019.
- Jev flagged c0044.
- All three cleared c0085, c0086, c0223, c0255 and c0271.

**GUESS**
† The labels only exist where codex said "violation", so on the labelled set codex has FN=0 and TN=0 by
construction. Its recall of 1.00 is an artifact of how the set was chosen, not a measurement. The same bias
caps what can be learned about the other judges: no message codex cleared was ever human-labelled, so
nobody knows how many real violations all four judges missed. With 5 positives, one message moves recall
by 0.20. The Haiku-vs-Sonnet-vs-Jev differences (3, 2 and 1 TPs) are within one or two messages and are
not callable. Run-to-run variance was not measured.

### Agreement between judges on all 75 (rule, message) jobs

**CLAIM**
Haiku agreed with Sonnet on 66/75, Haiku with Jev on 62/75, and Sonnet with Jev on 65/75.

### Latency and cost per call

**CLAIM**
\* "Median ms" in the tables is `askJudge` wall time, which includes bun startup and the registry load. Its
maximum was Jev 1,730, Haiku 5,499 and Sonnet 4,504, all inside the plugin's 20 s (OMP) and 30 s
(Claude Code) deadlines. Model-only figures from the usage logs (`usage-*.jsonl`):

| Judge | Median model ms | Max model ms | Median in / out tokens | Mean cost per call | Total for 75 |
|---|---|---|---|---|---|
| Haiku 5.5 (cap 4000) | 2306 | 4762 | 1307 / 283 | $0.000189 | $0.0142 |
| Sonnet 5.5 | 1714 | 3694 | 1306 / 70 | $0.006561 | $0.4921 |
| Jev 1.13.0 | not logged by the wrapper | — | — | not logged | — |

**GUESS**
Sonnet 5.5's cost is driven by a 1-hour prompt-cache write on every call (`cttl.ephemeral1h` in the usage
log), which never pays off because every prompt is different. That inference comes from the usage fields
and was not tested. Jev's per-call cost was not captured in this run; JEV-PROFILE.md gives Jev costs for
other uses only.

## Recommendation

**GUESS**
- **Block: no judge.** Every judge here, codex included, would block compliant messages: c0095 is flagged
  by all four. The labelled set is too small to show that any judge does better than that.
- **Warn-only collection: Haiku 5.5, through model-judge.ts.** It is the cheapest per call, it caught the
  most real buried bad news (3 of 5, including c0224, which Jev and Sonnet both cleared), and its
  free-text reason makes a later adjudication cheap. The cost is 4 of 10 false alarms on the labelled
  negatives, which lands in warnings.log and blocks nothing.
- **Before anyone arms block:** human-label a sample of the messages codex CLEARED, so that recall is
  measurable, then re-run all three judges with repeats.

## Files

**CLAIM**
- Wrapper: `/Users/jowolff/agent-scratch/jo-wolff-plugins/monitor/model-judge.ts`
- Harness: `/Users/jowolff/agent-scratch/jo-wolff-plugins/monitor/model-judge-run/run.mjs`
- Verdicts: `results-anthropic_claude-haiku-5-5.jsonl`, `results-anthropic_claude-sonnet-5-5.jsonl`, plus
  `results-anthropic_claude-haiku-5-5.cap400.jsonl` from the discarded run.
- Usage: the matching `usage-*.jsonl` files.
