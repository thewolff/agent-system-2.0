---
status: open
author: plumb
date: 2026-10-28
---

# The OpenAI-reviews-only rule is withdrawn early

## Decision

Jo withdrew the rule on 2026-10-28 at 3:24 AM PDT: "let any lane open on it". OpenAI's weekly meter had reset to 98% remaining.

Any lane may run on OpenAI again. Plain quota headroom decides for every caller, as it did before PR #377: review hands and panel hands are refused for an OpenAI week-pace projection like any other hand, and unnamed builder lanes may stay on or move onto OpenAI.

This supersedes the time-boxed rule from ledger instruction in-mvro2xb4w0918v and PR #377 (`.ai/decision-log/2026-10-27--2230--plumb--openai-reviews-only-until-2026-11-02.md`), which was due to end on 2026-11-02T18:03Z.

## How it was removed

As that entry's Expiry section allowed, the rule was deleted rather than left to expire. Gone: `OPENAI_REVIEWS_ONLY_RULE` in classifier/src/lab.ts; the `HeadroomUse` type, `underRule` and the `use` parameter in classifier/src/headroom.ts; the `"review"` arguments in classifier/extension.ts; the `"unnamed-lane"` arguments and the `AGENT_SYSTEM_LANE_RULE_CLOCK_MS` rule clock in surface/scripts/lane.ts; classifier/test/openai-reviews-only.test.ts and its install/manifest.tsv row; and the rule's cases in classifier/test/crosslab.test.ts and surface/test/lane-headroom-script.test.ts. Each file is back to its content before PR #377.
