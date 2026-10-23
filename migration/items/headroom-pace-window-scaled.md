---
title: Window-scaled headroom pace and budget protection
status: building
workload: wl-mv958y95fk07wg
pr: 269
---

## Scope and delivery boundary

Workload `wl-mv958y95fk07wg` replaces the fixed pace warm-up and adds measured budget protection to the [original headroom guard](headroom-guard.md). The approved plan is revision 2, **Headroom brake fix — widened plan**; the policy and operational boundaries are recorded here so they do not depend on scratch retention. The original item's workload, PR and migration number remain historical metadata. This item has no assigned migration number.

At the PR metadata snapshot, implementation, focused proof and independent production code review are complete; the outside-fence runner has not yet run. The PR's `as2/full-suite` check records the authoritative exact-head delivery result. This is not a claim of merge, installation or removal of the live workaround. The lane does not merge this production change.

## Original bug and scaled warm-up

The original guard extrapolated every window after a fixed 60-minute warm-up. At 6% used after 60 minutes of a seven-day window, `0.06 / 60 × 10080 = 10.08`: an early weekly reading looked like a projected quota overrun and could refuse OpenAI even while another lab's budget was burning faster. A first-hour threshold suitable for a five-hour window was being applied to a whole week.

The replacement starts projection at the inclusive threshold `max(60 minutes, window length × 0.2)`, implemented with `PACE_FLOOR_MIN = 60` and `PACE_WINDOW_FRACTION = 0.2`:

- A five-hour window still starts projection at 60 minutes.
- A seven-day window, including the equivalent `1w` form, starts at 2016 minutes: **33h36m**. A 6% reading at 60 or 61 minutes no longer triggers weekly projection.
- Once warm-up is reached, the existing `used / elapsed × window length` projection still refuses at projected usage `>= 1.0` unless the narrowly defined budget comparison below retains the source.
- The strict five-hour `used > 0.80` ceiling applies even during warm-up. A known seven-day window (`7d` or `1w`) with a future reset and actual usage `>= 1.0` also refuses before warm-up; an existing ordinary refusal keeps its first reason and wording. Hard source limits and actual exhaustion are never waived by the comparison exception.

Twenty percent is an approved policy choice, not a claim of statistical confidence. Existing tier/provider binding, stale or missing poll fail-open behavior and unknown/reset/expired/old-format handling remain in place. The pre-warm-up exhaustion rule does not extend to unknown-length windows, other window lengths, absent reset timestamps or passed resets. In particular, missing comparison evidence does not turn an ordinary base refusal into admission.

## Recent evidence and comparator order

Budget protection uses a common recent sample pair, not a whole-window average or different intervals chosen for each provider:

- Anchor at the newest poll, which must be no more than 15 minutes old and not in the future. Select the oldest earlier poll within 60 minutes whose span is at least 15 minutes. Both budgets use these same endpoints; without a qualifying pair there is no exception.
- Match each binding meter by `(provider, windowId, tier)`. Both endpoints need finite numeric reset timestamps within **60 seconds** of one another, with both resets still ahead of the newest endpoint. This tolerance accepts watcher reset-timestamp jitter; it does not smooth usage or rates. A larger reset jump, expired or missing reset, invalid fraction or decreasing usage supplies no rate for that meter.
- Fractions must be finite and in `[0, 1]`. Measure usage delta over the common time span; zero growth is a real zero, not missing evidence. A selector's pressure is the maximum known rate among all its binding meters, including non-refusing meters. A fast source five-hour meter cannot hide behind a softly refusing weekly meter; an unrelated tier-only meter does not bind.

Rates are **raw quota percentage points per hour**, not tokens per hour, equal capacity or equal time to exhaustion. Comparing a five-hour meter with a weekly meter intentionally can favor retaining the weekly source when the shorter-window budget burns more percentage points per hour. It is not a token-equivalent fairness metric. There is no smoothing or tie epsilon; equal rates do not qualify.

Callers supply configured budget alternatives in order, excluding unavailable entries under their existing registry, provider-disable, recorded-refusal and credential rules. Recorded quota-429 refusals remain excluded; a comparator predicted out by headroom is different and need not pass quota. Core lab identity filtering skips unknown labs and the source lab and deduplicates labs, preserving first configured occurrence. An unknown source lab cannot receive the exception. Poll-only providers do not become comparators.

Use the **first remaining configured other-lab budget**, even if its rate is unknown or slower; never skip it to find a hotter later lab. It may already be quota-out on pace or the five-hour ceiling. That makes it a budget to avoid loading, not an admitted destination. Retain the source only if both measured rates are known and that comparator's rate is strictly greater.

Every refusing source reason must be a mature seven-day-length pace projection, with actual usage below exhaustion. Any hard source limit, five-hour ceiling, other-window pace refusal or actual exhaustion blocks retention, regardless of limit order. No comparator, missing evidence, stale/future samples, reset discontinuity, ties or a slower comparator preserve the source's ordinary refusal and wording. The comparison exception is not recursive.

## Decision API and routing boundaries

The reason-only `outFor` API is replaced, without a compatibility alias, by:

```typescript
Headroom.decisionFor(selector, comparators?: readonly string[]): HeadroomDecision
// HeadroomDecision = { out: string | null; retained: string | null }
```

With no comparators, `decisionFor(selector)` returns the base decision. Both fields null means ordinary admission; a non-null `out` is the ordinary refusal. Exceptional source admission has `out: null` and a non-null `retained` explanation containing the base weekly refusal, comparator selector, both measured quota-point/hour rates and sample span. Core owns the policy and lab filtering; callers supply available alternatives in configured order rather than parsing refusal strings.

Hands append retained explanations to existing `routingNote` diagnostics; lanes use existing stderr diagnostics. Retention is not a quota skip and does not mark the source provider refused or charge a `headroom-skip`. No new reserved control prefix is introduced. Existing actual-model spawn/start records still identify the model used.

Budget comparison is **not spawn authorization**:

- Same-lab builds keep their legal lane-lab row; budget comparators come from the configured tier row without widening legal spawn choices.
- Reviews and panels retain their builder exclusions, pins, grants and independent-review restrictions. Their configured budget alternatives do not authorize a forbidden review leg.
- A named lane remains exactly on its named source model; retention never calls `set_model` to substitute a different model. Unnamed lanes can likewise retain the original source rather than displace work onto a faster-burning budget.
- Lanes use the installed strong row as ordered counterfactual budgets, not a claim that each comparator is a verified runnable fallback. If that row cannot be read, no exception is available; a named lane explains the missing comparison through stderr, ordinary source admission still works and an out source keeps its refusal.
- Actual unnamed-lane moves retain the existing strong-row order and confirmed `set_model` / `get_state` sequence. **Destination checks use base-only `decisionFor(candidate)`**, without comparators. A quota-out benchmark or a destination that could itself earn a retention exception is not thereby admitted as a move destination.

## Observed proof and pending delivery

These are lane proof receipts at the PR metadata snapshot:

- `bun test classifier/test/headroom.test.ts`: **110 pass, 0 fail**, including exhaustion before weekly warm-up.
- `bun test classifier/test/crosslab.test.ts`: **104 pass, 0 fail**.
- Actual-helper scratch smoke: the old helper refused the 6%-at-60-minutes weekly case with projection **10.08**; the new helper admitted it before the scaled weekly warm-up.
- In the mature weekly smoke, source usage **0.21** projected to **1.05**. The new helper retained that source against Claude burning **32.31 quota points/hour**, versus source **2.31**, and returned the retained explanation.
- The same actual-helper smoke reported ordinary refusal with a slower target budget and refusal of a hard-out source. The quota-out comparator at **0.87** usage was itself refused; serving as a budget benchmark did not admit it. This helper result is not proof of the runner's actual-move integration.

The smoke establishes those observed cases, not every integration path. At the PR metadata snapshot, `surface/test/lane-headroom-script.test.ts` has **not yet run**. Independent Anthropic production review passed after both delivery blockers were fixed; the scoped compatibility behavior for non-week/no-reset exhaustion remains documented above. Outside-fence full-suite proof, including changed-file-alone runner coverage, is reported by the PR's exact-head check, not inferred from focused passes. No PR landing or live-checkout completion is asserted here.

## Plumb handoff — after merge, before pull

This is a pending **Plumb-owned action after the PR merges**, not a terminal task for Jo. The lane routes the merged replacement commit and this item to Plumb. In this order, Plumb:

1. Removes **only** the live checkout's uncommitted `PACE_MIN = 10080` stopgap and its associated comment, **before pulling** the merged replacement. Preserve every unrelated dirty change; do not revert the whole file or checkout. Do not replace the workaround with another fixed one-week guard.
2. Pulls the merged replacement, whose policy uses `PACE_FLOOR_MIN = 60` plus `PACE_WINDOW_FRACTION = 0.2` and the new `decisionFor` API. The old `PACE_MIN` export/alias is not part of the replacement.
3. Smokes `decisionFor` in the live checkout and returns a receipt identifying the pulled commit and observed guard behavior: early-week admission, mature weekly refusal without a qualifying faster budget, measured retention when one qualifies, and hard-source refusal. This is a requested operational receipt, not a claim that the smoke has run.

This lane does not touch the dirty live checkout. Stopgap removal, pull and live smoke remain uncompleted until Plumb supplies the commit/behavior receipt. Their absence must not be rewritten as an installed or fully delivered claim.

## Rollback

Revert this change's PR to reverse the committed window-scaled and comparison behavior. That repository rollback does not restore or undo an uncommitted live-checkout edit. Reversing Plumb's stopgap removal is a separate Plumb action and decision, preserving unrelated live edits; neither the lane nor this document claims it has happened.
