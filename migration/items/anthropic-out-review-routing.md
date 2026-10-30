---
title: OpenAI-lane reviews use only Codex entries until 6 AM PDT on October 31
status: building
workload: wl-mvtusij5mhwtnv
pr: 410
---
**The rule (Jo, 2026-10-29, input `in-mvtur7tlze7r5o`).** Until `2026-10-31T06:00:00-07:00` (Saturday, 6 AM PDT), reviews on the current OpenAI lane use only `openai-codex` entries in the review row. The restriction uses the lane's current lab, not the aggregate builder-lab history: it applies even when builders include both OpenAI and Anthropic. Such reviews run same-lab, with no cross-lab park question under this temporary exception. If no Codex entry is usable, refuse visibly; do not widen to Anthropic or another provider.

At the exact end instant the dated rule is inactive and ordinary review routing resumes automatically, without another code change. Builds continue to follow the lane lab as before. Tier selectors are unchanged. Deep-review OpenAI substitution remains the strong-row rule.

**Running classifier processes must restart** to pick up the routing code change. The review bootstrap is same-lab and is not independent-lab approval; a same-lab plan-review receipt does not qualify for independent-lab auto-approval.

Stable policy sources: `classifier/src/lab.ts` under `ANTHROPIC_OUT_RULE`, `reviewRow`, and `REVIEW_ROW_FROM`; `classifier/extension.ts` review dispatch and spawn revalidation; `profile/config.yml` under `Tier → model table`; `USER-GUIDE.md` under `Start a workload`.
