---
title: Self-heal Phase 1: a daily 07:00 self-heal report that detects and reports, one needs-you line, no repair
status: building
workload: wl-mvbcjageg7o2yo
pr: 244
---
**Built on branch `wl/wl-mvbcjageg7o2yo`.** Workload `wl-mvbcjageg7o2yo` (self-heal Phase 1: detect and report, normal stakes). The plan is revision 5 at `~/agent-scratch/agent-system-2.0/wl-mvbcjageg7o2yo/PLAN.md`, approved by Jo. Nothing here repairs anything or changes authority, gates, spending, ceilings or routing: every new piece reads, counts, and writes one report file plus one ledger row.

**What changed.**
- `surface/scripts/daily-report.ts` runs once a day at 07:00 local time from launchd, outside the fence.
  - It opens the ledger read-only and runs the seven detectors over its window: compaction loop, build hand off the lane's lab, paste drop, wall-led ceiling, flaky test, jetsam, model-start race (`surface/src/selfheal/`).
  - It also runs the counts (`surface/src/selfheal/counts.ts`): lane deaths by cause, lapsed leases (recorded and not yet recorded), messages still held on closed workloads, and the lane runs (`lane-metrics:` wall, dollars by model, peak RSS; unmetered and interactive lanes).
  - **Window.** It starts where the previous report's window ended, 24 h back when there is no previous report, and never more than 7 days back. It ends at the run.
  - **Output.** It writes `~/agent-scratch/agent-system-2.0/self-heal/<YYYY-MM-DD>-<HHMMSS>-<pid>.md` first, then one `daily-report:` entry on `wl-orchestrator` by the `daily-report` writer, naming that file. A second run on the same local date writes no entry and deletes its own file.
  - `--dry-run` prints the report and writes nothing. The run prints its own peak RSS in MiB at the end.
- **Needs-you line.** The newest `daily-report:` entry shows as one line, `daily self-heal report <date> window … findings <n> (…) deaths <d> lapsed <l> held-closed <h> — <path>`, for 30 hours.
  - From 30 hours to 7 days it becomes `daily self-heal report missed: the newest is <date> (<age> h); check com.agent-system-2.daily-report`, only while the job's plist is installed.
  - After 7 days, or with no entry at all, nothing shows.
- **New prefix.** `daily-report` is a reserved control prefix that only the `daily-report` writer may write.

**Install.** After merge, run `bash install/install.sh --daily-report`. It writes `~/Library/LaunchAgents/com.agent-system-2.daily-report.plist` (07:00 local, with the ledger and profile this install used) and loads it. To see a report at once, run `launchctl kickstart gui/$(id -u)/com.agent-system-2.daily-report`, or `bun surface/scripts/daily-report.ts --dry-run` for a report that writes nothing. Restart as2 so the surface renders the new line.

**Rollback.** `bash install/install.sh --daily-report=off` boots the job out and deletes its plist, and writes nothing else; with the plist gone the missed line never shows. Then revert the PR. The report files and `daily-report:` entries already written are harmless to leave.
