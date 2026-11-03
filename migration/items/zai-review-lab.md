---
title: Z.ai GLM as a review lab, with a balance-empty park
status: building
workload: wl-mw148irbq33zt5
pr: none
---
Z.ai GLM joins cross-lab review as a third lab (plan `/Users/jowolff/agent-scratch/agent-system-2.0/wl-mw148irbq33zt5/PLAN.md`, normal stakes). Reviews only: builds stay on the lane's lab. SPEC-2.0.md § B4, *Amended 2026-11-03 — Z.ai as a review lab*.

**What changed.**
- `zai` is a lab in `classifier/src/lab.ts` (`REVIEW_ONLY_LABS`); the profile rows add `zai/glm-5.3-flash`, `zai/glm-5.3-flashx` and `zai/glm-5.3` to fast, standard and strong, and a deep review takes strong's `zai/glm-5.3`.
- Panels stay three-lab (anthropic, openai, kimi).
- A Z.ai HTTP 429 with code 1113 (insufficient balance) writes a classifier-owned `zai-balance:` entry. A review no model answered parks with one `review-park:` question naming the balance; a review the in-hand fallback answered stands, with one notice per workload. A plain 429 keeps the re-dispatch path.

**Measure (plan "How it fails" (c): GLM reviews that find nothing).** After the first five reviews that ran on zai, Jo sees their blocking-finding rate and decides keep or drop. Query, across every workload: take the `review-round:` entries whose token's `hand-settled:` routing row ran a `zai/` model, oldest first, and read the blocking count each one carries. Rate = blocking findings across the first five such rounds, per round. The lane asks the orchestrator, by `lane_message`, to put this check before Jo once five such reviews exist.
