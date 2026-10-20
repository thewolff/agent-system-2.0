---
title: Normal autonomous unnamed lanes wait for their own lab
status: building
workload: wl-mvh249u2w238jk
pr: 297
---

A normal-stakes autonomous workload with no named `lane-model:` waits when its own lab is projected out, rather than moving to another lab. Every workload recognized by `isTrainOrFix` is excluded, including normal autonomous merge trains and train-fix workloads. Production-stakes, user-driven, named-model and throwaway workloads retain their existing behavior.

## When the wait happens

The launch gate waits before spawning omp whenever the workload's home lab is known and out. A prediction from another fresh unnamed lane can supply the home if the workload has no recorded lane yet. If neither is known, omp starts once and the runner calls `get_state`; if that model is out, it sends no prompt and spends no model tokens, records an intended `waiting` outcome, and releases the lane. This is a startup check, not a dead lane.

A wait is reported once per episode with the lab and guard reason. The workload is shown as waiting, and the notice says it will launch on its home model when the guard admits that lab. A guard change, or changing the workload out of eligible wait conditions, clears the wait; a cap or unrelated launch refusal does not clear it while the lab remains out.

## Home and recovery

The workload's home is based on its recorded lane model, or on the lab it waited for before its first lane. A change to OMP's default therefore does not silently change an existing workload's home. Naming a model with `lane-model:` overrides wait eligibility; the model choice is handled by the existing named-model rules.

When the guard admits the home lab, the workload relaunches automatically through the usual launch cause and runs on that home. If OMP starts on a different model, the runner returns it to the home before the first prompt. A direct relaunch request remains pending while the lab is out and does not bypass the gate.
