---
date: 2026-10-19T12:58-07:00
engineer: Ilex
session: wl-mvfj0wfsz5vn5s
status: resolved
durable: false
supersedes:
workload: wl-mvfj0wfsz5vn5s
---

# Jo (2026-10-19, ruling recorded as in-mvfiztvfi7ez28 on wl-mvbcjadqgblr7k, input in-mvfiyyv2kuha80): "Write this ruling to the decision log and https://github.com/thewolff/jo-issues/issues/132." The ruling: flow-repair only until flow is green. Open only workloads that fix flow (started-work cap with a real queued state; relaunch of dead lanes with a retry counter; close-check fixes #223 and the merged-never-run case; the Plumb-to-Ilex channel; the monitoring/invariant timer PR #70 wl-mv654hoqwpfhmo; merge-train auto-boarding). Every other new ask is queued and Jo is told "queued, position N". Approved workloads and ones with a lane keep running. Exit: the five daily flow signals in /Users/jowolff/agent-scratch/agent-system-2.0/stuck-analysis/ROOT-CAUSE.md section 5 all green three days in a row at the thresholds written there; Ilex reports the numbers daily at noon PDT; the gate lifts only on that measured condition. Task: (1) add a decision-log entry under .ai/decision-log/ in agent-system-2.0 quoting the ruling verbatim from the ledger instruction row, on branch wl/<id> with a PR; (2) post the same ruling as a comment on thewolff/jo-issues#132 and record the comment URL. Nothing else; no code changes. plan: none

done: The flow-repair ruling is in an agent-system-2.0 decision-log entry on an open PR and in a comment on thewolff/jo-issues#132, both URLs recorded in done-because.
done-because: Jo's flow-repair ruling is quoted verbatim (byte-diffed against instruction row in-mvfiyyv2kuha80) in .ai/decision-log/2026-10-19--1025--ilex--flow-repair-only-until-flow-is-green.md, commit 401faaa on wl/wl-mvfj0wfsz5vn5s, open PR https://github.com/thewolff/agent-system-2.0/pull/242 (full suite green at 401faaa: tr-0mvfmkpzfgo1mwe, 5257 pass / 0 fail / 94 skip). The same ruling is posted on thewolff/jo-issues#132: https://github.com/thewolff/jo-issues/issues/132#issuecomment-6273172053. No code changes. Jo integrates PR #242.

Rendered from the ledger by Ilex (they/them) at workload close; stakes normal, mode autonomous, opened 2026-10-19T17:26:49.912Z.

## What changed

- sl-ruling-dlog: Add .ai/decision-log/ entry quoting Jo's flow-repair ruling verbatim (instruction row in-mvfiyyv2kuha80 / in-mvfiztvfi7ez28), commit on wl/wl-mvfj0wfsz5vn5s, push, open PR — artifact: commit 401faaa on wl/wl-mvfj0wfsz5vn5s (.ai/decision-log/2026-10-19--1025--ilex--flow-repair-only-until-flow-is-green.md, quote diffed byte-equal vs in-mvfiyyv2kuha80); bun test surface/test/decision-log.test.ts → 9 pass 0 fail; pushed; PR https://github.com/thewolff/agent-system-2.0/pull/242 open (gh pr create GraphQL error twice, created via REST gh api)
- sl-ruling-issue: Post the same verbatim ruling as a comment on thewolff/jo-issues#132 and record the comment URL — artifact: gh issue comment 132 -R thewolff/jo-issues --body-file $AS2_SCRATCH/comment.md → https://github.com/thewolff/jo-issues/issues/132#issuecomment-6273172053 (quote diffed byte-equal against instructions.body of in-mvfiyyv2kuha80)
- sl-full-mvfj0wfsz5vn5s-1: full suite outside the fence at PR #242 — artifact: test-run tr-0mvfmkpzfgo1mwe: green at 401faaa9739223d9c69e345f6eb5f431d9760b6c on PR #242; full 5257/0/94; alone: none; /Users/jowolff/.agent-system-2/test-runs/tr-0mvfmkpzfgo1mwe

## Decisions made (and why)

- assumption (orchestrator-surface): brief-judged: change-large confidence 0.91 judge typesafe/jev-1.13.0
- assumption (classifier): pair-exposure: lane-mvfj0wfsz5vn5s-1 on
- assumption (classifier): pair-signal: taste no 1 ambiguous no 0.54 judge typesafe/jev-1.13.0 tokens 899 cost 0.000037758
- assumption (lane-mvfj0wfsz5vn5s-1): builder-lab: anthropic lane lane-mvfj0wfsz5vn5s-1 model anthropic/claude-opus-5-5
- assumption (lane-mvfj0wfsz5vn5s-1, sl-ruling-dlog): artifact-command: bun test surface/test/decision-log.test.ts
- assumption (lane-mvfj0wfsz5vn5s-1, sl-ruling-dlog): First run of bun test surface/test/decision-log.test.ts failed on a 5000 ms timeout in the property test "byte budget at open > invariant" (6276 ms; temp-dir fixtures, does not read the repo's .ai/decision-log/); immediate rerun on the same tree passed 9/0 in 4.71 s. Treated as a timing flake under load, not caused by the doc-only commit 401faaa.
- assumption (lane-mvfj0wfsz5vn5s-1, sl-full-mvfj0wfsz5vn5s-1): tr-0mvfj4n94k6e1bw ended `error: full: timeout` (0 pass / 0 fail, 20 min after prepare) at 401faaa, a commit touching only .ai/decision-log/. No code to fix; requested rerun tr-0mvfjviqr9pohei on the same sha and slice.
- assumption (classifier): pair-exposure: lane-mvfj0wfsz5vn5s-2 on
- assumption (lane-mvfj0wfsz5vn5s-2): builder-lab: anthropic lane lane-mvfj0wfsz5vn5s-2 model anthropic/claude-opus-5-5
- assumption (lane-mvfj0wfsz5vn5s-2, sl-full-mvfj0wfsz5vn5s-1): tr-0mvfjviqr9pohei ended in preflight error "_as2test account is missing or its user and group ids differ". Checked after: `id _as2test` → uid=600 gid=600; `dscl . -read /Users/_as2test` → UniqueID 600, PrimaryGroupID 600; `/Groups/_as2test` PrimaryGroupID 600. Account present and consistent now, so the dscl read likely failed transiently [GUESS(inference)]. Requesting a third run on the same sha; if it errors again, raising a question.

## Dead ends — don't retry these

- none

## Heads-up for whoever touches this next

- message msg-mvfj3i8d45wav4 [delivered] not acted on: artifact-failed: `bun test surface/test/decision-log.test.ts` exited 1 (tool call toolu_01W4upFPiJ35uwkEY2Pnfz7E)
- message msg-mvfj3plb17mxvk [delivered] not acted on: artifact-passed: `bun test surface/test/decision-log.test.ts` exited 0 (tool call toolu_013fySSPCMAjuVD1TEoC999P)
- message msg-mvfmf1g2gfz7k0 [delivered] not acted on: lane-died: lane-mvfj0wfsz5vn5s-1: lease lapsed 2026-10-19T19:01:39.247Z
