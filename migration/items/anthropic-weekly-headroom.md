---
title: Anthropic weekly headroom advisory and warning
status: building
workload: wl-mvr67h2tbqkvv3
pr: 370
---

## Scope and delivery boundary

This item records the Anthropic weekly headroom policy implemented by workload `wl-mvr67h2tbqkvv3`, PR #370. Delivery is pending: this item does not claim that the PR is merged, installed or live. The PR's exact-head full-suite check is the delivery verification record.

Anthropic weekly projected pace is advisory rather than a dispatch refusal. Actual weekly exhaustion remains a refusal, including before pace warm-up. Existing five-hour pace and exhaustion protections remain unchanged. Other labs retain their existing weekly pace behavior, as do non-weekly Anthropic windows and tier/model binding.

The runtime warning helper and its test are registered in `install/manifest.tsv`; installation retains the manifest-or-fail coverage guard.

## Shared weekly warning

At a fresh observation of at least 70% usage on the shared Anthropic weekly meter, the surface enqueues one one-line warning for Jo for that weekly window. The warning is informational, not a question or dispatch refusal. The shared meter is the tier-null Anthropic 7-day meter (including its equivalent `1w` representation); a tier-specific meter such as Fable's is not the warning source. The weekly pace exception does not waive tier-specific actual exhaustion.

Deduplication is durable across polls, usage dips, delivery states and restarts: the sent notice remains the marker, and a ledger transaction checks all message states before enqueueing. Reset timestamps within 60 seconds are treated as the same window to tolerate polling jitter; a later weekly window can warn again. The warning is based on the newest fresh, non-future, unexpired shared meter observation with a known reset. Missing, stale or invalid data does not generate a warning.

A warning reset must be representable as a JavaScript Date. Malformed finite reset values outside that range cannot generate a warning or interrupt existing needs-you rendering; the snapshot check does not change dispatch admission.

Warning delivery depends on the orchestrator surface running and receiving a fresh qualifying observation. If it is stopped during that time, it can notify on a later fresh qualifying poll after restart; it is not an independent background watcher and does not promise a warning while the surface is stopped.

## Rollback

Revert this workload's PR to restore the prior Anthropic weekly pace refusal and remove the weekly warning integration. Existing durable warning messages remain ledger history; rollback does not erase them. This document makes no claim that rollback or delivery has occurred.
