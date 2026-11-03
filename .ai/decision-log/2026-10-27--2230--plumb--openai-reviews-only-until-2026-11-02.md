---
status: open
author: plumb
date: 2026-10-27
---

# OpenAI is for reviews only until its weekly reset (2026-11-02T18:03Z)

## Decision

Jo's ruling, ledger instruction in-mvro2xb4w0918v, 2026-10-27 at 10:22 PM PDT: "until OpenAI's weekly reset (Nov 2, 10:03 AM PST), unless I say otherwise: OpenAI is for reviews only. No lane builds on OpenAI; builder lanes run on Anthropic. And don't let the weekly pace projection hold back OpenAI reviews … only a hard limit (actually used up) stops an OpenAI review."

The machinery enforces it through one dated constant, `OPENAI_REVIEWS_ONLY_RULE` in classifier/src/lab.ts, placed beside `KIMI_OUT_RULE`. Its `endsAt` is 2026-11-02T18:03:00Z. Two callers apply it, each by naming its `use` in classifier/src/headroom.ts `decisionFor(selector, comparators, use)`:

- **Reviews (`use: "review"`).** The classifier passes this for review hands and panel hands, at both planning and spawn. An OpenAI refusal that comes only from the week-pace projection no longer skips the hand. The hand runs, and its routing note says why. These still refuse: a limit that is actually used up, an exhausted week, the 5h 80% ceiling, and a pace projection on any window other than the week. Build hands follow their lane's lab and do not change.
- **Unnamed builder lanes (`use: "unnamed-lane"`).** surface/scripts/lane.ts passes this for an unnamed lane's own model and for the model it moves to. Budget retention can no longer keep such a lane on OpenAI, and a move never picks OpenAI. An unnamed lane that resumes an OpenAI session gets moved to the strong row's Anthropic entry before its first prompt. If Anthropic is out too, the lane fails at headroom; it does not fall back to OpenAI. A lane whose model Jo named with `lane-model:` stays on that model. By-hand `as2 lane` sessions do not run the quota guard, so they do not change either.

## Expiry

The rule ends by itself: from `endsAt` on, both uses decide exactly as a call with no `use`. Ending it sooner than that ("unless I say otherwise") takes a code change. The options are to change `endsAt`, or to delete the constant along with its two callers and merge. The rule does not go through gates/src/rulings.ts `STANDING_RULINGS` / `end-ruling`, because the headroom decision has no ledger to read.

## Why no config-only route

Nothing in the installed config can enforce either half alone:

- The installed tier table (~/.omp/profiles/agent-system-2/agent/config.yml) already starts unnamed lanes on Opus (`modelRoles.default`). The 10:14 PM merge-train lane ran on OpenAI because its unnamed lane resumed an OpenAI session and budget retention kept it there. No config setting turns retention off.
- Taking OpenAI out of the strong row would also remove the OpenAI reviewer, since `REVIEW_ROW_FROM` takes it from the strong row.
- Pointing `AS2_HEADROOM_POLLS` at a missing file would let OpenAI reviews through. It would also switch off every hard limit for every lab.
