---
date: 2026-10-27T13:49-07:00
engineer: Ilex
session: wl-mv74cy2uro3kzk
status: resolved
durable: false
supersedes:
workload: wl-mv74cy2uro3kzk
---

# Jo (2026-10-13, input in-mv74cb62lig2rk): "Open a normal workload: guard-replay.ts skips lane-N.jsonl RPC logs and reads transcripts line by line; whole-corpus replays run one at a time. 7-14 GB bun spikes ran the Mac out of memory. Evidence: /Users/jowolff/agent-scratch/agent-system-2.0/kitty-memory/REPORT.md"

Notes (Ilex), from REPORT.md § Addendum:
- **Cause.** Four jetsam events, at 12.72, 7.35, 13.11 and 13.93 GB, each line up with an agent-launched whole-corpus read. The Mac has 24 GiB.
  - `gates/scripts/guard-replay.ts`: `transcriptFiles` (lines 316–340) returns every `*.jsonl` under a root. `collectCalls` (line 361) runs `readFileSync(file, "utf8")`, and `parseSession` (line 271) runs `text.split("\n")`.
  - `--root ~/.agent-system-2/lanes` walks into the lane RPC logs `lane-N.jsonl`. Those make up most of the 21.95 GB of jsonl under lanes, with single files up to 1.77 GB (wl-mv5lrh0drbg0zk/lane-1.jsonl). Session transcripts are 2.99 GB in 2,349 files, the largest 0.18 GB. The first line of a lane-N.jsonl is `{"type":"ready","protocolVersion":1,…}`, an OMP RPC frame, not a transcript.
  - Event C was four guard-replay jobs plus a corpus child reading the same 2.8 GB frozen corpus at once.
- **Change (Jo's three parts).**
  1. transcriptFiles skips `/^lane-\d+\.jsonl$/` on every root, defaults included. The plan states whether any caller needs RPC logs and how they opt in, if at all.
  2. collectCalls/parseSession read line by line, streamed, with no whole-file string. Peak memory is bounded by the largest line, not the file. Output stays byte-identical to today on a fixture corpus.
  3. Whole-corpus replays run one at a time. Enforce it in machinery, for example a lock file under ~/.agent-system-2 that a second whole-corpus run waits on or refuses with a typed message. The plan says what counts as whole-corpus (no `--days`, or `--days 0`). Prompt text alone does not count.
- **Siblings.** The report also names scratch copies that share the pattern: openai-compaction-loop/scan.ts, wl-mv4rzy7en8ejuo/replay-rows.ts and wl-mv5lrh0drbg0zk/live-proof/shell-start-live.ts. These are throwaway scratch, not repo code. The plan lists any repo script with the same `readFileSync` over a corpus (search gates/, surface/, classifier/, ledger/) and fixes those too, or names them.
- **Proof.**
  - Regression tests fail before the change, proven on a separate unpacked copy: a lane-N.jsonl under a root is not read; a large synthetic transcript is parsed with peak RSS well under its size; a second concurrent whole-corpus run waits or refuses.
  - Smoke: a real `--root ~/.agent-system-2/lanes --days 0` replay with peak RSS measured (`/usr/bin/time -l`), compared with today's figure.
  - Memory safety while proving: the smoke itself must not run the Mac out of memory. Run it alone with a timeout, and abort above a stated RSS. `ulimit -v` is not available on this Mac (REPORT.md).
- **Coordinate.**
  - The monitoring workload wl-mv654hoqwpfhmo (peak-RSS metrics; its auth audit reads transcripts);
  - the local-push workload wl-mv73ymkyzgmqkg and the held-request triage wl-mv746bobfbygow, whose briefs call for guard-replay deltas;
  - the for-loop workload wl-mv65f7lqigfclc.
  Name the shared file gates/scripts/guard-replay.ts.
- MIGRATION item. Full suite via lane_full_test. Merging stays Jo's (merge commit, green-first). Cross-lab review.
- **Lane budget.** Jo holds 4 running lanes (in-mv71ja9ygqgsu8). This workload opens user-driven; its queue place is Jo's call.

done: gates/scripts/guard-replay.ts skips lane-N.jsonl RPC logs on every root, reads transcripts line by line so peak memory is bounded by the largest line rather than the file, and whole-corpus replays are serialized by machinery; same-pattern repo scripts are fixed or named; regression tests fail before the change; a real lanes-root replay shows its peak RSS before and after; a MIGRATION item records it; and the full suite is green at the PR head.
done-because: (no receipt recorded)

Rendered from the ledger by Ilex (they/them) at workload close; stakes normal, mode user-driven, opened 2026-10-13T20:14:08.262Z.

## What changed

- none

## Decisions made (and why)

- jo (surface): Jo: "Open a normal workload: guard-replay.ts skips lane-N.jsonl RPC logs and reads transcripts line by line;
 whole-corpus replays run one at a time. 7-14 GB bun spikes ran the Mac out of memory. Evidence:
 /Users/jowolff/agent-scratch/agent-system-2.0/kitty-memory/REPORT.md" — reading: gates/scripts/guard-replay.ts skips the lane-N.jsonl RPC logs and reads transcripts line by line instead of whole-file readFileSync. Whole-corpus replays run one at a time. The cause is 7–14 GB bun spikes that ran the 24 GiB Mac out of memory; evidence in /Users/jowolff/agent-scratch/agent-system-2.0/kitty-memory/REPORT.md § Addendum. Opened user-driven under the 4-lane hold; Jo has not set its queue place.
- jo (surface): withdraw wl-mv74cy2uro3kzk
- orchestrator (surface): close receipt: withdrawn by Jo (in-mvr5r8wb2tppf8): closed with no done-because: receipt
- assumption (orchestrator-surface): brief-judged: change-large confidence 0.73 judge typesafe/jev-1.13.0

## Dead ends — don't retry these

- none

## Heads-up for whoever touches this next

- none
