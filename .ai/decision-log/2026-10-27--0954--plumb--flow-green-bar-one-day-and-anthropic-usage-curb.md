---
status: open
author: plumb
date: 2026-10-27
---
# Flow-green bar drops to one day; new workloads curbed for Anthropic usage, with an emergency valve

## Ruling

Jo, 2026-10-27, 9:54 AM PDT, from Jo's own surface paste (input in-mvqxe28wt05n28; Ilex recorded it as in-mvqxf8m0kwc0zk on wl-mvq4edbaf13vnk because wl-orchestrator refuses instructions and the merge-train workload had closed). Ilex can't write files or call gh, so Plumb records the ruling here and on thewolff/jo-issues#213 at Ilex's request.

1. **Flow-green exit condition is one day.** The 10/19 flow-repair-only ruling (in-mvfiyyv2kuha80; `2026-10-19--1025--ilex--flow-repair-only-until-flow-is-green.md`) now lifts on the first PDT day when all five flow signals are green at the thresholds in `/Users/jowolff/agent-scratch/agent-system-2.0/stuck-analysis/ROOT-CAUSE.md` section "## 5. Early warning: five signals to watch daily". Before this ruling the bar was three days in a row.
2. **New workloads are curbed** to save Anthropic usage (about 60% used when Jo ruled) and leave Jo room to pair on signature dataviz. Ilex opens no new workloads and launches no queued ones until Jo lifts the curb. A new-workload ask gets "queued, position N".
   - Exempt and continuing: fast checks (wl-mvq4edbaf13vnk), flaky tests (wl-mvqu69tjvpy96o), the stuck-worker detector (wl-mvq8x4pkjmx69s), routine calls (wl-mvqwn80onq9hq8), and the merge train.
3. **Emergency valve.** When Jo's own words contain "emergency", the request opens and launches at once, past both the curb and the flow-repair-only gate, at the front of the lane queue. Ilex reports in one line that the valve was used and that it spends Anthropic usage. A lane's or a seat's words never trigger it, and Ilex acts only on Jo's surface input.

## Why

- **Three days had no stated basis.** It first appears as an example in the 10/16 stuck-analysis report ("flow green 3 days", ROOT-CAUSE.md section 4.2, rule 1; the report's one question asked about "green three days running"). Jo adopted it in the 10/19 ruling. Nothing in the report argues for three over one. Jo, 2026-10-27: "yeah three days? lets make that one day."
- **The curb comes from Jo's usage report.** Jo said: "we're at 60% of anthropic right now and i still need to pair to get signature data viz going." The four running flow repairs keep going because stopping them mid-build would waste spend already made.

## How it fails

- **One green day may be luck.** A quiet day can read green without flow being fixed. The daily check keeps running after the gate lifts, and a red day afterwards is reported on #213 the same way. Re-imposing the gate is Jo's call.
- **The curb doesn't stop spend that's already running.** The four running lanes and the merge train still use Anthropic tokens. If usage climbs too fast, the least costly lane to pause is routine calls (wl-mvqwn80onq9hq8), which was still writing its plan when Jo ruled.
- **The valve could be triggered by relayed text.** That's why it is bounded to Jo's own surface input. Plumb never relays a request phrased as an emergency.

## Changes made the same day

- `.tmp/flow-signals.zsh` (Plumb's daily check, untracked) now reports "green streak N of 1 day needed".
- thewolff/jo-issues#213 comments: https://github.com/thewolff/jo-issues/issues/213#issuecomment-6448057286 (rulings 1 and 2) and https://github.com/thewolff/jo-issues/issues/213#issuecomment-6448088068 (the valve).
