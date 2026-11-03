---
title: one loud alert path for every event that needs Jo
status: building
workload: wl-mw0vs9uc3xqtka
pr: 445
---
One alert pass, `surface/scripts/alert-tick.ts`, owns every Jo-directed alert. It runs every 5 minutes from the train tick, outside any LLM, and the writers of the urgent events (the runner in `surface/scripts/lane.ts`, the classifier in `classifier/extension.ts`) kick it at once. Plan: `/Users/jowolff/agent-scratch/agent-system-2.0/wl-mw0vs9uc3xqtka/PLAN.md`. Guide: `USER-GUIDE.md`, section 3 (Jo's words `urgent`, `asap`, `calm`, `ack`) and section 4 (the ALERT line).

**What it replaces.** Four separate paths, each with its own machinery:

- The train ladder (`TRAIN_ALERT_LADDER`, `trainAlertRecords`, `trainAlertActions` in `surface/src/merge-train.ts` and step 5 of `surface/scripts/train-tick.ts`).
- The quota move popup worker (`spawnMoveAlert`, `lane.ts move-alert`, and its train-tick supervisor in `surface/src/quota-move-alert.ts`). That file keeps `recordQuotaMove`, the `quota-move:` NOW message and the parsers.
- Main-red issue filing (`mainRedPass` in `surface/scripts/train-tick.ts`).
- Land-first stop issue filing (`landingPass`). Both keep writing their state rows; the issue calls move to the alert pass.

**Events it carries** (sources in `surface/src/alert-sources.ts`): ceiling stops, lane deaths, a released lane whose process is still alive, main red (including land-first stops), failed nightly chaos reports, parked workloads (reserved request, prompt wait or open question), merge-train questions, quota moves, and the quota-watch rules (`surface/src/quota-watch.ts`).

**Ladder** (`ALERT_LADDER` in `surface/src/alert-path.ts`; levels and timings are the old train ladder's, the notification is replaced by a silent stay-up popup):

| level | when | channels |
|---|---|---|
| 1 | at raise | needs-you `ALERT` line, jo-issues issue |
| 2 | 4 h after level 1 was sent | @thewolff comment, `loud` label, LOUD line, popup |
| 3 | 8 h after level 1 was sent | comment, `critical` label, popup again |

**Urgent starts at level 2.** A workload is urgent when Jo's newest word on it is `urgent` or `asap` (`urgencyOf`), or, with no word, when the Jo input its brief cites says asap or urgent. Its alerts start at level 2; level 1's channels still run first in the same pass. Quota moves and quota alerts also start at level 2.

**Jo's words** (`surface/src/input.ts`): `urgent <wl>`, `asap <wl>`, `calm <wl>` (clears urgency), and `ack <wl|key>`, which acks every open alert of a workload or one alert key.

**Jo's issue #49 is folded in.** `surface/src/quota-watch.ts` ports the active loop of Plumb's quota watcher (`omp usage` polls into `polls.jsonl`, thresholds, fast-burn, three failed polls). Each firing rule is a `quota:<key>:<rule>` alert.

**Superseded.** Production workload wl-mv8y56eo1egjcw lifted a separate alert module, which is the fifth path this work forbids; Ilex closes it as superseded. Its plan file stays as the record.

**Outside the path, on purpose** (`surface/test/alert-boundary.test.ts` pins the boundary):

- The doctor popup (`surface/src/doctor.ts`): it reports the tick, the ledger or ctx being down, exactly when a ledger-backed pass cannot run.
- The CEILING ALARM file line: the fallback when the ceiling hit's ledger write fails. It still feeds the ceiling source, so it escalates whenever the ledger is readable.
- The branch-protection and promotion notices from train-tick: operational notices, not events in Jo's list.

After the merge, Jo does this:

1. Re-run `bash install/install.sh` from his own Terminal.
2. Remove Plumb's quota watcher so two writers never feed `polls.jsonl`: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.agent-system-2.quota-watch.plist`, then `rm ~/Library/LaunchAgents/com.agent-system-2.quota-watch.plist`. Until the plist is gone, the quota step only logs that the old watcher is installed.
