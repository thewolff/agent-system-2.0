<!-- Copied verbatim from /Users/jowolff/agent-scratch/agent-system-2.0/jev-profile/evidence-judge-corpus-1715.md, captured 2026-10-14 (Plumb). -->
# Jev as a free-text writing-rule judge: measured 2026-10-14 (JevJudge, Plumb hand)

Full report: agent://JevJudge (Plumb session). Run dir: /Users/jowolff/agent-scratch/jo-wolff-plugins/monitor/jev-corpus-run/ (run.mjs, results.jsonl, triggers.json).
Corpus: /Users/jowolff/agent-scratch/orchestrator/communication-rules-fp/corpus.jsonl (304 real seat messages); human labels adjudications.json.
Call shape: one `choice` question, criteria "breaks this rule" / "complies or unclear", plugin question verbatim; model typesafe/jev-1.13.0; 422 calls, 0 errors.

- conclusion-first: 260 triggered, 42 flagged. Human labels n=3 (all FP): Jev flagged all 3 -> precision 0/3. 69/260 verdicts p<0.7. Median 1118 ms.
- bad-news-first: 162 triggered, 19 flagged. Human labels n=15: TP1 FP1 FN4 TN9 -> precision 0.50, recall 0.20. Misses the "reassuring opener hides bad news" shape (c0055 p=0.89 clean). Leans hard to "no violation".
- Jev answers only choice/bool/score; no rationale (pi-coding-agent/src/eval/judgment-bridge.ts:132-143; pi-ai/src/judgment/types.ts:48-56).
- Caveat: labels thin and codex-biased (only codex-flagged messages adjudicated); one untuned framing.
Verdict for this row: WEAK (measured), not untested.
